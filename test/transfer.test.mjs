import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { downloadVerified, prepareVerified } from '../src/transfer.mjs';
const bytes = Uint8Array.from({ length: 1093 }, (_, i) => i % 256);
const sha256 = createHash('sha256').update(bytes).digest('hex');
function fixture(corrupt = false) {
  return async (_, init) => {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
    const part = bytes.slice(+start, +end + 1);
    if (corrupt) part[0] ^= 1;
    return new Response(part, { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` } });
  };
}
const options = { url: 'https://proxy.test/mirror', size: bytes.length, sha256, chunkSize: 128, concurrency: 3 };
test('parallel transfer reconstructs non-overlapping ranges and verifies the complete file', async () => {
  let progress = 0;
  const blob = await downloadVerified({ ...options, fetcher: fixture(), onProgress: n => { assert.ok(n >= progress); progress = n; } });
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes); assert.equal(progress, bytes.length);
});
test('parallel transfer refuses corruption and a server ignoring Range', async () => {
  await assert.rejects(downloadVerified({ ...options, fetcher: fixture(true) }), /HASH_MISMATCH/);
  await assert.rejects(downloadVerified({ ...options, fetcher: async () => new Response(bytes) }), /INVALID_RANGE_RESPONSE/);
});
test('parallel transfer rejects invalid manifests and observes cancellation', async () => {
  await assert.rejects(downloadVerified({ ...options, size: 1 }), /INVALID_MANIFEST/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(downloadVerified({ ...options, signal: controller.signal, fetcher: async (_, init) => { init.signal.throwIfAborted(); } }));
});

test('a gateway HTML error is not reported as an official version update', async () => {
  await assert.rejects(downloadVerified({ url: 'https://proxy.test/api/chunk', sourceUrl: 'https://builds.echo.ac/echo.exe?test', size: 32, etag: '"current"', maxRetries: 0, fetcher: async () => new Response('<h1>Timeout</h1>', { status: 504 }) }), /ORIGIN_UNREACHABLE/);
});

const liveBytes = Uint8Array.from({ length: 1024 * 1024 + 33 }, (_, i) => i === 0 ? 77 : i === 1 ? 90 : i % 256);
const liveOptions = { url: 'https://proxy.test/api/chunk', sourceUrl: 'https://builds.echo.ac/echo.exe?test', size: liveBytes.length, etag: '"current"', retryDelayMs: 0 };
function liveResponse(start, end, body = liveBytes.slice(start, end + 1)) {
  return new Response(body, { status: 206, headers: { etag: '"current"', 'content-range': `bytes ${start}-${end}/${liveBytes.length}` } });
}

test('a failed large range shrinks and recovers without repeating successful ranges or counting partial data', async () => {
  const calls = [], progress = [];
  let retries = 0;
  const blob = await downloadVerified({ ...liveOptions, chunkSize: 1024 * 1024, concurrency: 1, onRetry: () => { retries++; }, onProgress: n => progress.push(n), fetcher: async (_, init) => {
    const { start, end } = JSON.parse(init.body); calls.push([start, end]);
    // Deliberately truncate the first request; later, smaller parts must overwrite it.
    return liveResponse(start, end, calls.length === 1 ? liveBytes.slice(start, start + 11) : undefined);
  } });
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), liveBytes);
  assert.equal(retries, 1);
  assert.deepEqual(calls, [[0, 1048575], [0, 524287], [524288, 1048575], [1048576, 1048608]]);
  assert.deepEqual(progress, [524288, 1048576, 1048609, 1048609]);
});

test('network errors, origin JSON failures, rate limits and platform HTML timeouts recover', async () => {
  for (const problem of [new TypeError('Failed to fetch'), Response.json({ code: 'ORIGIN_UNREACHABLE' }, { status: 503 }), Response.json({ code: 'UPSTREAM_RATE_LIMIT' }, { status: 429 }), new Response('platform timeout', { status: 504 })]) {
    let calls = 0;
    const blob = await downloadVerified({ ...liveOptions, concurrency: 1, fetcher: async (_, init) => {
      if (++calls === 1) { if (problem instanceof Error) throw problem; return problem; }
      const { start, end } = JSON.parse(init.body); return liveResponse(start, end);
    } });
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), liveBytes);
    assert.ok(calls > 1);
  }
});

test('version changes, denial, expired links and challenges stop immediately even on HTTP 503', async () => {
  for (const code of ['VERSION_CHANGED', 'LINK_EXPIRED', 'UPSTREAM_DENIED', 'CF_CHALLENGE']) {
    let calls = 0;
    await assert.rejects(downloadVerified({ ...liveOptions, concurrency: 1, fetcher: async () => { calls++; return Response.json({ code }, { status: 503 }); } }), new RegExp(code));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(downloadVerified({ ...liveOptions, concurrency: 1, fetcher: async (_, init) => {
    calls++; const { start, end } = JSON.parse(init.body);
    const response = liveResponse(start, end); response.headers.set('etag', '"changed"'); return response;
  } }), /VERSION_CHANGED/);
  assert.equal(calls, 1);
});

test('retries are bounded; expired requests never fetch; cancellation interrupts retry backoff', async () => {
  let calls = 0;
  await assert.rejects(downloadVerified({ ...liveOptions, chunkSize: 32, concurrency: 1, maxRetries: 2, fetcher: async () => { calls++; throw new TypeError('offline'); } }), /ORIGIN_UNREACHABLE/);
  assert.equal(calls, 3);
  await assert.rejects(downloadVerified({ ...liveOptions, expiresInMs: 0, fetcher: async () => { throw new Error('must not fetch'); } }), /LINK_EXPIRED/);
  const controller = new AbortController();
  await assert.rejects(downloadVerified({ ...liveOptions, signal: controller.signal, retryDelayMs: 10000, concurrency: 1, onRetry: () => controller.abort(), fetcher: async () => { throw new TypeError('offline'); } }), /CANCELLED/);
});

test('a stalled range has an individual deadline and can recover', async () => {
  let calls = 0;
  const blob = await downloadVerified({ ...liveOptions, attemptTimeoutMs: 25, concurrency: 1, fetcher: async (_, init) => {
    if (++calls === 1) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    const { start, end } = JSON.parse(init.body); return liveResponse(start, end);
  } });
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), liveBytes);
});

test('the individual deadline covers a stalled response body and failed partial bytes are discarded', async () => {
  let calls = 0;
  const blob = await downloadVerified({ ...liveOptions, attemptTimeoutMs: 25, concurrency: 1, fetcher: async (_, init) => {
    const { start, end } = JSON.parse(init.body);
    if (++calls !== 1) return liveResponse(start, end);
    return liveResponse(start, end, new ReadableStream({ start(stream) {
      stream.enqueue(Uint8Array.of(255, 255));
      init.signal.addEventListener('abort', () => stream.error(init.signal.reason), { once: true });
    } }));
  } });
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), liveBytes);
});

test('a terminal error aborts and settles all sibling requests before returning', async () => {
  let active = 0;
  await assert.rejects(downloadVerified({ ...liveOptions, chunkSize: 512 * 1024, fetcher: async (_, init) => {
    const { start } = JSON.parse(init.body);
    if (start === 0) return Response.json({ code: 'VERSION_CHANGED' }, { status: 409 });
    active++;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => { active--; reject(init.signal.reason); }, { once: true }));
  } }), /VERSION_CHANGED/);
  assert.equal(active, 0);
});

test('prepare retries temporary errors but never retries an expired signature', async () => {
  let calls = 0;
  const result = await prepareVerified({ sourceUrl: liveOptions.sourceUrl, fetcher: async () => ++calls === 1 ? new Response('gateway', { status: 502 }) : Response.json({ size: 99 }) });
  assert.deepEqual(result, { size: 99 }); assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(prepareVerified({ sourceUrl: liveOptions.sourceUrl, fetcher: async () => { calls++; return Response.json({ code: 'LINK_EXPIRED' }, { status: 410 }); } }), /LINK_EXPIRED/);
  assert.equal(calls, 1);
});

test('a new valid link resumes only missing bytes of the same pinned object', async () => {
  let checkpoint;
  const completed = [], resumed = [];
  try {
    await downloadVerified({ ...liveOptions, chunkSize: 512 * 1024, concurrency: 1, fetcher: async (_, init) => {
      const { start, end } = JSON.parse(init.body);
      if (start > 0) return Response.json({ code: 'LINK_EXPIRED' }, { status: 410 });
      completed.push([start, end]); return liveResponse(start, end);
    } });
    assert.fail('must pause');
  } catch (error) { assert.equal(error.message, 'LINK_EXPIRED'); checkpoint = error.resume; }
  assert.equal(checkpoint.received, 512 * 1024);
  let calls = 0;
  await assert.rejects(downloadVerified({ ...liveOptions, etag: '"new-version"', resume: checkpoint, fetcher: async () => { calls++; } }), /VERSION_CHANGED/);
  assert.equal(calls, 0);
  const blob = await downloadVerified({ ...liveOptions, sourceUrl: 'https://builds.echo.ac/echo.exe?fresh-signature', expiresInMs: 120000, resume: checkpoint, fetcher: async (_, init) => {
    const { start, end, url } = JSON.parse(init.body);
    assert.match(url, /fresh-signature/); resumed.push([start, end]); return liveResponse(start, end);
  } });
  assert.deepEqual(completed, [[0, 524287]]);
  assert.deepEqual(resumed, [[524288, 1048608]]);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), liveBytes);
});
