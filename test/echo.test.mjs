import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEntry, parseSigned, extractDownload, resolveEntry, downloadFile, encodeTicket, decodeTicket, readLimited } from '../src/echo.mjs';

export const NOW = Date.UTC(2026, 9, 15, 6, 0);
export function signed(overrides = {}) {
  const p = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': 'test/20261015/auto/s3/aws4_request',
    'X-Amz-Date': '20261015T060000Z', 'X-Amz-Expires': '120', 'X-Amz-SignedHeaders': 'host',
    'X-Amz-Signature': 'a'.repeat(64), 'response-content-disposition': 'attachment; filename="echo-example-abcdef-m.exe"',
    'response-content-type': 'application/octet-stream', ...overrides,
  });
  return 'https://builds.echo.ac/echo.exe?' + p;
}
const entry = 'https://dl.echo.ac/example-token';
const html = url => new Response(`<a href="${url.replaceAll('&', '&amp;')}" id="dlURL">click here</a>`, { headers: { 'content-type': 'text/html' } });
const binary = (bytes = [77, 90, 1, 2], options = {}) => new Response(Uint8Array.from(bytes), { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), ...options.headers }, status: options.status || 200 });

test('entry parsing allows only the exact HTTPS Echo host and one token', () => {
  assert.equal(parseEntry(entry), entry);
  assert.equal(parseEntry('example-token'), entry);
  for (const url of ['http://dl.echo.ac/example-token', 'https://dl.echo.ac.evil.test/example-token', 'https://evil.test@dl.echo.ac/example-token', 'https://dl.echo.ac/example-token?next=evil', 'https://dl.echo.ac/%2e%2e/abc', 'https://127.0.0.1/abcdef', '//dl.echo.ac/abcdef']) assert.throws(() => parseEntry(url));
});
test('signed URLs retain exact encoding, filename and expiry', () => {
  const url = signed().replaceAll('+', '%20');
  const data = parseSigned(url, NOW);
  assert.equal(data.url, url);
  assert.equal(data.expiresAt, NOW + 120000);
  assert.equal(data.filename, 'echo-example-abcdef-m.exe');
});
test('reject unsafe signed URL targets, duplicate parameters and invalid dates', () => {
  for (const url of [signed().replace('builds.echo.ac', 'localhost'), signed().replace('/echo.exe?', '/other.exe?'), signed() + '&X-Amz-Expires=999', signed({ 'X-Amz-Date': '20260231T060000Z' }), signed({ 'X-Amz-Expires': '0' }), signed({ 'response-content-disposition': 'attachment; filename="../evil.exe"' })]) assert.throws(() => parseSigned(url, NOW));
  assert.throws(() => parseSigned(signed(), NOW + 120000), { code: 'LINK_EXPIRED' });
});
test('extract anchor or JSON string without executing page scripts', () => {
  const url = signed();
  assert.equal(extractDownload(`<a href='${url.replaceAll('&', '&#38;')}' class='download' id='dlURL'>Download</a>`), url);
  assert.equal(extractDownload(`window.location = ${JSON.stringify(url).replaceAll('&', '\\u0026')};`), url);
  assert.throws(() => extractDownload('<script>globalThis.pwned = true;</script>'));
});
test('resolver follows only validated redirects', async () => {
  let count = 0;
  const data = await resolveEntry(entry, { now: NOW, fetcher: async () => ++count === 1 ? new Response(null, { status: 302, headers: { location: '/second-token' } }) : html(signed()) });
  assert.equal(data.entry, entry);
  assert.equal(count, 2);
  await assert.rejects(resolveEntry(entry, { now: NOW, fetcher: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }) }));
});
test('Cloudflare challenges are identified by header or page without retrying', async () => {
  for (const response of [new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } }), new Response('<title>Just a moment...</title>', { status: 200, headers: { 'content-type': 'text/html' } })]) {
    let count = 0;
    await assert.rejects(resolveEntry(entry, { now: NOW, fetcher: async () => { count++; return response; } }), { code: 'CF_CHALLENGE' });
    assert.equal(count, 1);
  }
});
test('tickets carry no proxy authorization and cannot target arbitrary hosts', () => {
  const ticket = encodeTicket({ url: signed(), entry });
  assert.equal(decodeTicket(ticket).url, signed());
  assert.throws(() => decodeTicket('%%invalid'));
  assert.throws(() => decodeTicket(encodeTicket({ url: signed(), entry: 'https://evil.test/abc' })));
});
test('full download preserves bytes and filename and omits client secrets', async () => {
  let seen;
  const response = await downloadFile({ url: signed() }, new Request('https://proxy.test/download', { headers: { Cookie: 'private', Authorization: 'secret' } }), { now: NOW, fetcher: async (url, init) => { seen = { url, init }; return binary(); } });
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [77, 90, 1, 2]);
  assert.match(response.headers.get('content-disposition'), /echo-example-abcdef-m.exe/);
  assert.equal(seen.init.headers.Cookie, undefined);
  assert.equal(seen.init.headers.Authorization, undefined);
  assert.equal(seen.init.redirect, 'manual');
});
test('partial and suffix ranges preserve correct 206 semantics', async () => {
  for (const range of ['bytes=2-3', 'bytes=-2', 'bytes=2-']) {
    const request = new Request('https://proxy.test/download', { headers: { Range: range, 'If-Range': '"version1"' } });
    const response = await downloadFile({ url: signed() }, request, { now: NOW, fetcher: async (_, init) => {
      assert.equal(init.headers.Range, range);
      assert.equal(init.headers['If-Range'], '"version1"');
      return binary([1, 2], { status: 206, headers: { 'content-range': 'bytes 2-3/4' } });
    } });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 2);
  }
});
test('reject multi-range, mismatched ranges, compressed data, and fake binary HTML', async () => {
  await assert.rejects(downloadFile({ url: signed() }, new Request('https://proxy.test/file', { headers: { range: 'bytes=0-1,3-4' } }), { now: NOW }), { code: 'INVALID_RANGE' });
  await assert.rejects(downloadFile({ url: signed() }, new Request('https://proxy.test/file', { headers: { range: 'bytes=2-3' } }), { now: NOW, fetcher: async () => binary([77, 90], { status: 206, headers: { 'content-range': 'bytes 0-1/4' } }) }), { code: 'INVALID_PARTIAL_RESPONSE' });
  await assert.rejects(downloadFile({ url: signed() }, new Request('https://proxy.test/file'), { now: NOW, fetcher: async () => binary([60, 104, 116, 109, 108]) }), { code: 'NOT_A_FILE' });
  await assert.rejects(downloadFile({ url: signed() }, new Request('https://proxy.test/file'), { now: NOW, fetcher: async () => binary(undefined, { headers: { 'content-encoding': 'gzip' } }) }), { code: 'UNEXPECTED_ENCODING' });
});
test('HEAD uses a GET range with the original GET signature', async () => {
  const response = await downloadFile({ url: signed() }, new Request('https://proxy.test/file', { method: 'HEAD' }), { now: NOW, fetcher: async (_, init) => {
    assert.equal(init.method, 'GET'); assert.equal(init.headers.Range, 'bytes=0-0');
    return binary([77], { status: 206, headers: { 'content-range': 'bytes 0-0/100' } });
  } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '100');
  assert.equal(response.body, null);
});
test('416 response retains unsatisfied range, never becomes an attachment error', async () => {
  const response = await downloadFile({ url: signed() }, new Request('https://proxy.test/file', { headers: { range: 'bytes=100-' } }), { now: NOW, fetcher: async () => new Response('<Error/>', { status: 416, headers: { 'content-type': 'application/xml', 'content-range': 'bytes */4' } }) });
  assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), 'bytes */4');
});
test('reader bounds page size and cancels rejected response', async () => {
  let canceled = false;
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)); }, cancel() { canceled = true; } });
  await assert.rejects(readLimited(new Response(body), 512), { code: 'UPSTREAM_TOO_LARGE' });
  assert.equal(canceled, true);
});
test('stream cancellation reaches upstream without buffering the installer', async () => {
  let canceled = false;
  let pulled = 0;
  const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(Uint8Array.from([77, 90, 0, 0])); }, cancel() { canceled = true; } });
  const response = await downloadFile({ url: signed() }, new Request('https://proxy.test/file'), { now: NOW, fetcher: async () => new Response(body, { headers: { 'content-type': 'application/octet-stream' } }) });
  assert.ok(pulled < 10);
  await response.body.cancel();
  assert.equal(canceled, true);
});
