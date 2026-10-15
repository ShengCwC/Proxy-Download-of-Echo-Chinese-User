export async function downloadVerified({ url, size, sha256, etag, sourceUrl, signal, onProgress = () => {}, onDigest = () => {}, fetcher = fetch, chunkSize = 4 * 1024 * 1024, concurrency = 4 }) {
  const live = typeof sourceUrl === 'string';
  if (!Number.isSafeInteger(size) || size < 2 || size > 200 * 1024 * 1024 || (live ? !/^"[\x21\x23-\x7e]{1,200}"$/.test(etag || '') : !/^[a-f0-9]{64}$/.test(sha256))) throw new Error('INVALID_MANIFEST');
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 4 * 1024 * 1024 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new Error('INVALID_MANIFEST');
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(() => controller.abort(), 600000);
  const output = new Uint8Array(size);
  let next = 0;
  let received = 0;
  async function worker() {
    while (next * chunkSize < size) {
      const start = next++ * chunkSize;
      const end = Math.min(size - 1, start + chunkSize - 1);
      const response = await fetcher(url, { ...(live ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: sourceUrl, etag, size, start, end }) } : { headers: { Range: `bytes=${start}-${end}` } }), signal: controller.signal, cache: 'no-store' });
      if (live && response.status !== 206 && response.headers.get('content-type')?.startsWith('application/json')) {
        const error = await response.json();
        throw new Error(['VERSION_CHANGED', 'LINK_EXPIRED', 'UPSTREAM_DENIED', 'CF_CHALLENGE', 'ORIGIN_BUSY'].includes(error.code) ? error.code : 'DOWNLOAD_FAILED');
      }
      if (live && response.headers.get('etag') !== etag) { await response.body?.cancel(); throw new Error('VERSION_CHANGED'); }
      if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${size}` || !response.body) { await response.body?.cancel(); throw new Error('INVALID_RANGE_RESPONSE'); }
      const reader = response.body.getReader();
      let offset = start;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!(value instanceof Uint8Array) || offset + value.byteLength > end + 1) throw new Error('INVALID_FILE_SIZE');
          output.set(value, offset); offset += value.byteLength; received += value.byteLength;
          onProgress(received, size);
        }
        if (offset !== end + 1) throw new Error('INCOMPLETE_RANGE');
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
    }
  }
  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (controller.signal.aborted) throw new Error('CANCELLED');
    onProgress(size, size, 'verifying');
    const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', output)), b => b.toString(16).padStart(2, '0')).join('');
    if (controller.signal.aborted) throw new Error('CANCELLED');
    if (sha256 && actual !== sha256) throw new Error('HASH_MISMATCH');
    if (live && (output[0] !== 77 || output[1] !== 90)) throw new Error('INVALID_FILE_RESPONSE');
    onDigest(actual);
    return new Blob([output], { type: 'application/octet-stream' });
  } catch (error) { controller.abort(); throw error; }
  finally { clearTimeout(deadline); signal?.removeEventListener('abort', abort); }
}
