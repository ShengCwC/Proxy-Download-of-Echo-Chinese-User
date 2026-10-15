import test from 'node:test';
import assert from 'node:assert/strict';
import { relay } from '../src/relay.mjs';

test('mainland relay excludes private routes, cookies, authorization and query strings', async () => {
  let called = false;
  const fetcher = async (url, init) => {
    called = true;
    assert.equal(new URL(url).pathname, '/api/chunk');
    assert.equal(new URL(url).search, '');
    assert.equal(init.headers.get('authorization'), null);
    assert.equal(init.headers.get('cookie'), null);
    assert.equal(init.headers.get('origin'), 'https://dl.echo.screenshare.cn');
    return new Response(Uint8Array.of(77, 90, 255), { status: 206, headers: { 'Content-Range': 'bytes 0-2/99', ETag: '"v"', 'Set-Cookie': 'test=1' } });
  };
  for (const path of ['/read', '/read/', '/ingest', '/native', '/mirror/current']) {
    assert.equal((await relay(new Request('https://dl.echo.screenshare.cn'+path), fetcher)).status, 404);
  }
  assert.equal(called, false);
  const response = await relay(new Request('https://dl.echo.screenshare.cn/api/chunk?secret=no', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://dl.echo.screenshare.cn', Cookie: 'session=test', Authorization: 'Bearer test' }, body: '{}' }), fetcher);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('etag'), '"v"');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.of(77, 90, 255));
});
