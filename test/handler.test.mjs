import test from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from '../scripts/build.mjs';
import { encodeTicket } from '../src/echo.mjs';
await bundle();
const { createHandler } = await import('../dist/handler.mjs');
const NOW = Date.UTC(2026, 9, 15, 6, 0);
function signed(date = '20261015T060000Z') {
  return 'https://builds.echo.ac/echo.exe?' + new URLSearchParams({ 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': 'test', 'X-Amz-Date': date, 'X-Amz-Expires': '120', 'X-Amz-SignedHeaders': 'host', 'X-Amz-Signature': 'a'.repeat(64), 'response-content-disposition': 'attachment; filename="echo-test.exe"' });
}
const post = (path, body, headers = {}) => new Request('https://proxy.test' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('resolve and download form a complete byte-preserving flow with no shared cache', async () => {
  const handle = createHandler({ now: () => NOW, fetcher: async url => url.startsWith('https://dl.echo.ac/') ? new Response(`<a id="dlURL" href="${signed()}">click</a>`, { headers: { 'content-type': 'text/html' } }) : new Response(Uint8Array.from([77, 90, 0, 255]), { headers: { 'content-type': 'application/octet-stream', 'content-length': '4' } }) });
  const resolved = await handle(post('/api/resolve', { url: 'https://dl.echo.ac/example-token' }));
  assert.equal(resolved.status, 200);
  const result = await resolved.json();
  const file = await handle(new Request('https://proxy.test' + result.download));
  assert.equal(file.status, 200);
  assert.match(file.headers.get('cache-control'), /no-store/);
  assert.equal(file.headers.get('cdn-cache-control'), 'no-store');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [77, 90, 0, 255]);
});
test('import never treats syntax or timestamps as authorization: origin rejects forged signature', async () => {
  let calls = 0;
  const handle = createHandler({ now: () => NOW, fetcher: async () => { calls++; return new Response('denied', { status: 403 }); } });
  const imported = await handle(post('/api/import', { url: signed() }));
  assert.equal(imported.status, 403);
  assert.equal((await imported.json()).code, 'UPSTREAM_DENIED');
  assert.equal(calls, 1);
  const response = await handle(new Request('https://proxy.test/download/' + encodeTicket({ url: signed() })));
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('content-disposition'), null);
  assert.equal(calls, 2);
});
test('import probes the file and detects file challenges before showing a download button', async () => {
  const handle = createHandler({ now: () => NOW, fetcher: async () => new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } }) });
  const response = await handle(post('/api/import', { url: signed() }));
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.stage, 'file'); assert.equal(result.download, undefined);
});
test('production HTTP redirects to HTTPS while local development stays available', async () => {
  const handle = createHandler();
  const response = await handle(new Request('http://dl.echo.screenshare.cn/example-token'));
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), 'https://dl.echo.screenshare.cn/example-token');
  assert.equal((await handle(new Request('http://127.0.0.1:4173/'))).status, 200);
});
test('challenge returns actionable JSON; file challenge returns an HTML recovery page', async () => {
  const handle = createHandler({ now: () => NOW, fetcher: async () => new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } }) });
  const response = await handle(post('/api/resolve', { url: 'https://dl.echo.ac/example-token' }));
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'CF_CHALLENGE');
  const file = await handle(new Request('https://proxy.test/download/' + encodeTicket({ url: signed(), entry: 'https://dl.echo.ac/example-token' })));
  assert.equal(file.status, 503);
  assert.equal(file.headers.get('content-disposition'), null);
  assert.match(await file.text(), /官方直连下载/);
});
test('expired full requests refresh once; expired ranges do not silently combine versions', async () => {
  let calls = 0;
  const handle = createHandler({ now: () => NOW, fetcher: async url => { calls++; return url.startsWith('https://dl.echo.ac/') ? new Response(`<a id="dlURL" href="${signed()}">click</a>`, { headers: { 'content-type': 'text/html' } }) : new Response(Uint8Array.from([77, 90]), { headers: { 'content-type': 'application/octet-stream' } }); } });
  const url = 'https://proxy.test/download/' + encodeTicket({ url: signed('20261015T050000Z'), entry: 'https://dl.echo.ac/example-token' });
  const full = await handle(new Request(url));
  assert.equal(full.status, 200); await full.arrayBuffer(); assert.equal(calls, 2);
  calls = 0;
  const partial = await handle(new Request(url, { headers: { range: 'bytes=1-' } }));
  assert.equal(partial.status, 410); assert.equal(calls, 0);
});
test('API refuses cross-site submissions, bad content types, and oversized bodies', async () => {
  const handle = createHandler({ fetcher: async () => { throw new Error('must not fetch'); } });
  assert.equal((await handle(post('/api/import', { url: signed() }, { Origin: 'https://evil.test' }))).status, 403);
  assert.equal((await handle(post('/api/import', { url: signed() }, { 'Content-Type': 'text/plain' }))).status, 415);
  assert.equal((await handle(post('/api/import', { url: 'x'.repeat(10000) }))).status, 400);
});
test('HTML, assets and HEAD are available without upstream access', async () => {
  const handle = createHandler({ fetcher: async () => { throw new Error('must not fetch'); } });
  for (const path of ['/', '/example-token', '/app.js', '/style.css', '/icon.svg', '/health']) {
    const response = await handle(new Request('https://proxy.test' + path));
    assert.equal(response.status, 200); assert.ok(response.headers.has('content-security-policy'));
  }
  const head = await handle(new Request('https://proxy.test/', { method: 'HEAD' }));
  assert.equal(await head.text(), '');
});

test('mirror import uses expired official URL only as filename metadata without contacting blocked origin', async () => {
  const handle = createHandler({ now: () => NOW, fetcher: async () => { throw new Error('must not contact Echo'); } });
  const response = await handle(post('/api/mirror', { url: signed('20261015T050000Z') }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.delivery, 'mirror'); assert.equal(result.expiresAt, null);
  assert.equal(result.filename, 'echo-test.exe'); assert.match(result.download, /^\/mirror\/[a-f0-9]{64}\/echo-test.exe$/);
  assert.equal((await handle(post('/api/mirror', { url: signed().replace('builds.echo.ac', 'evil.test') }))).status, 400);
  assert.equal((await handle(new Request('https://proxy.test/mirror/' + '0'.repeat(64) + '/echo.exe'))).status, 404);
});
