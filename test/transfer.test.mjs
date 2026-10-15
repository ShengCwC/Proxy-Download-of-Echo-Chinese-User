import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { downloadVerified } from '../src/transfer.mjs';
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
