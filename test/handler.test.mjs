import test from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from '../scripts/build.mjs';
import { inspectRange, validateRead, CHUNK_SIZE } from '../src/live-protocol.mjs';
import { downloadVerified } from '../src/transfer.mjs';
await bundle();
const { createHandler } = await import('../dist/handler.mjs');
const NOW = Date.UTC(2026, 9, 15, 6, 0);
const secret = 'b'.repeat(64);
function signed(date = '20261015T060000Z') {
  return 'https://builds.echo.ac/echo.exe?' + new URLSearchParams({ 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': 'test', 'X-Amz-Date': date, 'X-Amz-Expires': '120', 'X-Amz-SignedHeaders': 'host', 'X-Amz-Signature': 'a'.repeat(64), 'response-content-disposition': 'attachment; filename="echo-test.exe"' });
}
const post = (path, body, headers = {}) => new Request('https://proxy.test' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const bytes = Uint8Array.from({ length: 99 }, (_, i) => i === 0 ? 77 : i === 1 ? 90 : i);
function fixture(etag = '"current"') {
  return async (url, init) => {
    assert.equal(url, 'https://origin.test/read');
    assert.equal(init.headers.Authorization, `Bearer ${secret}`);
    const { start, end } = JSON.parse(init.body);
    return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, ETag: etag } });
  };
}
const config = { now: () => NOW, originUrl: 'https://origin.test', originKey: secret };
test('each submission contacts the live origin; full transfer preserves current bytes and filename', async () => {
  let calls = 0;
  const handle = createHandler({ ...config, fetcher: (...args) => { calls++; return fixture()(...args); } });
  const first = await handle(post('/api/prepare', { url: signed() }));
  assert.equal(first.status, 200); assert.match(first.headers.get('cache-control'), /no-store/);
  const info = await first.json();
  assert.equal(info.delivery, 'live'); assert.equal(info.filename, 'echo-test.exe'); assert.equal(info.etag, '"current"');
  await handle(post('/api/prepare', { url: signed() })); assert.equal(calls, 2);
  let digest;
  const blob = await downloadVerified({ url: 'https://proxy.test/api/chunk', sourceUrl: signed(), etag: info.etag, size: info.size, chunkSize: 32, fetcher: (url, init) => handle(new Request(url, init)), onDigest: value => { digest = value; } });
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes); assert.match(digest, /^[a-f0-9]{64}$/);
});
test('changed versions, forged signatures and CF challenges never fall back to a snapshot', async () => {
  const input = { url: signed(), start: 0, end: 31, etag: '"previous"', size: bytes.length };
  let handle = createHandler({ ...config, fetcher: fixture() });
  assert.equal((await handle(post('/api/chunk', input))).status, 409);
  for (const [code, status] of [['CF_CHALLENGE', 503], ['UPSTREAM_DENIED', 410]]) {
    handle = createHandler({ ...config, fetcher: async () => new Response(JSON.stringify({ code }), { status }) });
    const failed = await handle(post('/api/prepare', { url: signed() }));
    assert.equal(failed.status, status); assert.equal((await failed.json()).code, code);
  }
  assert.equal((await handle(post('/api/mirror', { url: signed() }))).status, 410);
  assert.equal((await handle(new Request('https://proxy.test/mirror/old/file.exe'))).status, 410);
});
test('expired addresses and unsafe targets do not reach the browser origin', async () => {
  const handle = createHandler({ ...config, fetcher: async () => { throw new Error('must not fetch'); } });
  assert.equal((await handle(post('/api/prepare', { url: signed('20261015T050000Z') }))).status, 410);
  assert.equal((await handle(post('/api/prepare', { url: signed().replace('builds.echo.ac', 'evil.test') }))).status, 400);
  assert.equal((await handle(post('/api/prepare', { url: 'https://dl.echo.ac/example-token' }))).status, 400);
  assert.equal((await handle(post('/api/chunk', { url: signed(), start: 0, end: 31 }))).status, 400);
});
test('API refuses cross-site submissions, malformed bodies, excess ranges and unpinned requests', async () => {
  const handle = createHandler(config);
  assert.equal((await handle(post('/api/prepare', {}, { origin: 'https://evil.test' }))).status, 403);
  assert.equal((await handle(post('/api/prepare', {}, { 'Content-Type': 'text/plain' }))).status, 415);
  assert.equal((await handle(post('/api/prepare', { url: 'a'.repeat(9000) }))).status, 400);
  assert.throws(() => validateRead({ url: signed(), start: 0, end: CHUNK_SIZE }, NOW), /分段范围/);
  assert.throws(() => validateRead({ url: signed(), start: 1, end: 31 }, NOW), /官方当前版本/);
  assert.throws(() => validateRead({ url: signed(), start: 0, end: 31, size: 99, etag: 'W/"weak"' }, NOW), /版本信息/);
});
test('upstream protocol rejects HTML, ignored Range and different file lengths', () => {
  const input = validateRead({ url: signed(), start: 0, end: 31, size: 99, etag: '"current"' }, NOW);
  const headers = { 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-31/99', etag: '"current"' };
  assert.equal(inspectRange(206, headers, input).size, 99);
  assert.throws(() => inspectRange(200, headers, input));
  assert.throws(() => inspectRange(206, { ...headers, 'content-type': 'text/html' }, input));
  assert.throws(() => inspectRange(206, { ...headers, 'content-range': 'bytes 0-31/100' }, input), /官方文件已更新/);
  assert.throws(() => inspectRange(412, headers, input), /官方文件已更新/);
});
test('HTML, branding, HEAD and health never fetch upstream or leak configuration', async () => {
  const handle = createHandler({ ...config, fetcher: async () => { throw new Error('must not fetch'); } });
  for (const path of ['/', '/app.js', '/style.css', '/assets/logo-light.png', '/health']) {
    const response = await handle(new Request('https://proxy.test' + path)); assert.equal(response.status, 200);
    assert.equal((await handle(new Request('https://proxy.test' + path, { method: 'HEAD' }))).body, null);
  }
  const html = await (await handle(new Request('https://proxy.test/'))).text();
  assert.ok(html.includes('实时加速下载')); assert.ok(!html.includes('generic-download'));
  const health = await (await handle(new Request('https://proxy.test/health'))).text();
  assert.ok(!health.includes(secret)); assert.ok(!health.includes('origin.test'));
  assert.equal((await handle(new Request('http://dl.echo.screenshare.cn/'))).status, 308);
});
