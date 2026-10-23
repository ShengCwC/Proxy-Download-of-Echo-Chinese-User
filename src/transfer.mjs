const TRANSIENT = new Set(['ORIGIN_BUSY', 'ORIGIN_UNREACHABLE', 'UPSTREAM_UNREACHABLE', 'UPSTREAM_TIMEOUT', 'UPSTREAM_RATE_LIMIT', 'REQUEST_FAILED']);
const TERMINAL = new Set(['VERSION_CHANGED', 'LINK_EXPIRED', 'UPSTREAM_DENIED', 'CF_CHALLENGE']);
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 520, 522, 524]);
const checkpoints = new WeakSet();
function failure(code, retryable = false) { return Object.assign(new Error(code), { retryable }); }

async function checkResponse(response, expected) {
  if (response.status === expected) return;
  let code;
  try {
    if (response.headers.get('content-type')?.startsWith('application/json')) {
      const reader = response.body?.getReader();
      let text = '';
      try {
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          if (text.length + value.byteLength > 4096) break;
          text += new TextDecoder().decode(value);
        }
        code = JSON.parse(text).code;
      } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
    } else await response.body?.cancel();
  } catch { /* Only known codes are surfaced, never upstream response text. */ }
  if (TERMINAL.has(code)) throw failure(code);
  if (TRANSIENT.has(code)) throw failure(code, true);
  if (RETRY_STATUS.has(response.status)) throw failure('ORIGIN_UNREACHABLE', true);
  throw failure('INVALID_RANGE_RESPONSE');
}

async function attempt(signal, timeoutMs, action) {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(failure('UPSTREAM_TIMEOUT', true)), timeoutMs);
  try { return await action(controller.signal); }
  catch (error) {
    if (signal.aborted) throw signal.reason;
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof TypeError || error?.name === 'NetworkError') throw failure('ORIGIN_UNREACHABLE', true);
    throw error;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

async function backoff(signal, delayMs) {
  signal.throwIfAborted();
  if (!delayMs) return;
  await new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delayMs);
    signal.addEventListener('abort', abort, { once: true });
  });
}

// Preparation is a read-only range request, so transient failures can be retried.
export async function prepareVerified({ url = '/api/prepare', sourceUrl, signal, fetcher = fetch, onRetry = () => {} }) {
  const active = signal || new AbortController().signal;
  for (let n = 0; ; n++) {
    try {
      return await attempt(active, 55000, async current => {
        const response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: sourceUrl }), signal: current, cache: 'no-store' });
        if (!response.ok) {
          if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
            const data = await response.json();
            throw failure(TERMINAL.has(data.code) ? data.code : 'INVALID_SOURCE');
          }
          await checkResponse(response, 200);
        }
        return response.json();
      });
    } catch (error) {
      if (active.aborted || !error.retryable || n >= 2) throw error;
      onRetry({ attempt: n + 1, code: error.message });
      await backoff(active, 350 * 2 ** n);
    }
  }
}

export async function downloadVerified({ url, size, sha256, etag, sourceUrl, expiresInMs, expiresAt, resume, signal, onProgress = () => {}, onDigest = () => {}, onRetry = () => {}, fetcher = fetch, chunkSize = 4 * 1024 * 1024, concurrency = 4, maxRetries = 3, retryDelayMs = 350, attemptTimeoutMs = 55000 }) {
  const live = typeof sourceUrl === 'string';
  if (!Number.isSafeInteger(size) || size < 2 || size > 200 * 1024 * 1024 || (live ? !/^"[\x21\x23-\x7e]{1,200}"$/.test(etag || '') : !/^[a-f0-9]{64}$/.test(sha256))) throw failure('INVALID_MANIFEST');
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 4 * 1024 * 1024 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 6 || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5 || !Number.isFinite(retryDelayMs) || retryDelayMs < 0 || !Number.isFinite(attemptTimeoutMs) || attemptTimeoutMs <= 0) throw failure('INVALID_MANIFEST');
  if (resume && (!checkpoints.has(resume) || resume.size !== size || resume.etag !== etag || resume.sha256 !== sha256)) throw failure('VERSION_CHANGED');
  const controller = new AbortController();
  const abort = () => controller.abort(failure('CANCELLED'));
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(() => controller.abort(failure('DOWNLOAD_TIMEOUT')), 600000);
  // Prefer the server's remaining lifetime, which does not depend on the user's clock.
  const lifetime = expiresInMs ?? (expiresAt === undefined ? Infinity : expiresAt - Date.now());
  const expiry = performance.now() + lifetime;
  const state = resume || { size, etag, sha256, output: new Uint8Array(size), completed: [], received: 0 };
  checkpoints.add(state);
  const output = state.output;
  const jobs = [];
  let cursor = 0;
  for (const [start, end] of [...state.completed, [size, size]].sort((a, b) => a[0] - b[0])) {
    while (cursor < start) { const last = Math.min(start - 1, cursor + chunkSize - 1); jobs.push([cursor, last]); cursor = last + 1; }
    cursor = end + 1;
  }
  let next = 0;
  let received = state.received;
  if (received) onProgress(received, size);
  function checkActive() {
    controller.signal.throwIfAborted();
    if (live && performance.now() >= expiry) throw failure('LINK_EXPIRED');
  }
  async function readRange(start, end, retries = 0) {
    checkActive();
    try {
      const bytes = await attempt(controller.signal, attemptTimeoutMs, async current => {
        const response = await fetcher(url, { ...(live ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: sourceUrl, etag, size, start, end }) } : { headers: { Range: `bytes=${start}-${end}` } }), signal: current, cache: 'no-store' });
        await checkResponse(response, 206);
        if (live && response.headers.get('etag') !== etag) { await response.body?.cancel(); throw failure('VERSION_CHANGED'); }
        if (response.headers.get('content-range') !== `bytes ${start}-${end}/${size}` || !response.body) { await response.body?.cancel(); throw failure('INVALID_RANGE_RESPONSE'); }
        const reader = response.body.getReader();
        const part = new Uint8Array(end - start + 1);
        let offset = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!(value instanceof Uint8Array) || offset + value.byteLength > part.length) throw failure('INVALID_FILE_SIZE');
            part.set(value, offset); offset += value.byteLength;
          }
          if (offset !== part.length) throw failure('INCOMPLETE_RANGE', true);
          return part;
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      });
      controller.signal.throwIfAborted();
      // Count only complete, validated ranges. Failed attempts never inflate progress.
      output.set(bytes, start); received += bytes.length;
      state.completed.push([start, end]); state.received = received;
      onProgress(received, size);
    } catch (error) {
      if (controller.signal.aborted || !error.retryable || retries >= maxRetries) throw error;
      checkActive();
      onRetry({ start, end, attempt: retries + 1, code: error.message });
      await backoff(controller.signal, Math.min(3000, retryDelayMs * 2 ** retries));
      // Smaller ranges reduce origin latency and memory pressure on a troubled route.
      if (live && end - start + 1 > 512 * 1024) {
        const middle = Math.floor((start + end) / 2);
        await readRange(start, middle, retries + 1);
        await readRange(middle + 1, end, retries + 1);
      } else await readRange(start, end, retries + 1);
    }
  }
  async function worker() {
    while (next < jobs.length) { const [start, end] = jobs[next++]; await readRange(start, end); }
  }
  const workers = Array.from({ length: concurrency }, worker);
  try {
    await Promise.all(workers);
    controller.signal.throwIfAborted();
    onProgress(size, size, 'verifying');
    const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', output)), b => b.toString(16).padStart(2, '0')).join('');
    controller.signal.throwIfAborted();
    if (sha256 && actual !== sha256) throw failure('HASH_MISMATCH');
    if (live && (output[0] !== 77 || output[1] !== 90)) throw failure('INVALID_FILE_RESPONSE');
    onDigest(actual);
    return new Blob([output], { type: 'application/octet-stream' });
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled(workers);
    if (live && state.received > 0 && (error.retryable || ['LINK_EXPIRED', 'DOWNLOAD_TIMEOUT'].includes(error.message))) error.resume = state;
    throw error;
  } finally { clearTimeout(deadline); signal?.removeEventListener('abort', abort); }
}
