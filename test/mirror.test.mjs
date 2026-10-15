import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { downloadMirror, mirrorInfo, mirrorName } from '../src/mirror.mjs';

const bytes = Uint8Array.from([77, 90, ...Array.from({ length: 35 }, (_, i) => i)]);
const data = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, publishedAt: '2026-10-15T07:00:00.000Z', url: 'https://github.com/test/repo/releases/download/test/echo.exe' };
const request = (headers = {}, method = 'GET') => new Request('https://proxy.test/mirror/file.exe', { headers, method });
function setup({ redirect = null, cacheFailure = false, wrongLength = false, wrongRange = false, html = false } = {}) {
  let calls = 0;
  const saved = new Map();
  const tasks = [];
  const cache = {
    async match(key) {
      if (cacheFailure) throw new Error('504');
      const item = saved.get(key.url);
      if (!item) return undefined;
      if (!key.headers.get('range')) return new Response(item.bytes, { headers: item.headers });
      const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(key.headers.get('range'));
      return new Response(item.bytes.slice(+a, +b + 1), { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${data.size}` } });
    },
    async put(key, response) { if (cacheFailure) throw new Error('413'); saved.set(key.url, { bytes: new Uint8Array(await response.arrayBuffer()), headers: response.headers }); },
  };
  const fetcher = async (url, init) => {
    calls++;
    assert.equal(init.headers.Cookie, undefined); assert.equal(init.headers.Authorization, undefined);
    if (redirect) return new Response(null, { status: 302, headers: { location: redirect } });
    if (html) return new Response('<html>failure</html>', { headers: { 'content-type': 'text/html' } });
    const range = init.headers.Range;
    const [, a, b] = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : [null, 0, data.size - 1];
    const out = bytes.slice(+a, +b + 1);
    return new Response(out, { status: range ? 206 : 200, headers: { ...(range ? { 'content-range': wrongRange ? 'bytes 0-1/37' : `bytes ${a}-${b}/${data.size}` } : {}), 'content-length': String(wrongLength ? 1 : out.length), 'content-type': 'application/octet-stream' } });
  };
  return { options: { data, fetcher, cache, waitUntil: task => tasks.push(task) }, finish: () => Promise.all(tasks), calls: () => calls, saved };
}

test('mirror keeps complete native body; different filenames share only the binary cache', async () => {
  const s = setup();
  const first = await downloadMirror(request(), 'echo-one.exe', s.options);
  assert.equal(first.headers.get('x-echo-mirror-cache'), 'miss');
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), bytes);
  await s.finish();
  const second = await downloadMirror(request(), 'echo-two.exe', s.options);
  assert.equal(second.headers.get('x-echo-mirror-cache'), 'hit');
  assert.match(second.headers.get('content-disposition'), /echo-two.exe/);
  assert.deepEqual(new Uint8Array(await second.arrayBuffer()), bytes);
  assert.equal(s.calls(), 1); assert.equal(s.saved.size, 1);
  assert.deepEqual([...s.saved.keys()], [data.url]);
  assert.ok([...s.saved.keys()].every(key => !key.includes('echo-one') && !key.includes('echo-two')));
});

test('cold and cached ranges, suffixes, and If-Range preserve a fixed version', async () => {
  for (const warm of [false, true]) {
    const s = setup();
    if (warm) { await (await downloadMirror(request(), 'echo.exe', s.options)).arrayBuffer(); await s.finish(); }
    for (const [range, a, b] of [['bytes=6-19', 6, 19], ['bytes=-3', 34, 36], ['bytes=35-', 35, 36], ['bytes=0-999', 0, 36]]) {
      const r = await downloadMirror(request({ Range: range }), 'echo.exe', s.options);
      assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), `bytes ${a}-${b}/${data.size}`);
      assert.deepEqual(new Uint8Array(await r.arrayBuffer()), bytes.slice(a, b + 1));
    }
    const full = await downloadMirror(request({ Range: 'bytes=1-3', 'If-Range': '"other"' }), 'echo.exe', s.options);
    assert.equal(full.status, 200); assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes);
    await s.finish();
    if (warm) assert.equal(s.calls(), 1);
  }
});

test('HEAD and invalid ranges do not fetch, malformed filenames are rejected', async () => {
  const s = setup();
  const head = await downloadMirror(request({}, 'HEAD'), 'echo.exe', s.options);
  assert.equal(await head.text(), ''); assert.equal(head.headers.get('content-length'), String(data.size));
  for (const range of ['bytes=99-', 'bytes=2-1', 'bytes=-0', 'bytes=0-1,4-5']) {
    const r = await downloadMirror(request({ Range: range }), 'echo.exe', s.options);
    assert.equal(r.status, 416); assert.equal(r.headers.get('content-disposition'), null);
  }
  assert.equal(s.calls(), 0);
  for (const name of ['../echo.exe', 'a.exe\r\nX:test', 'a/b.exe', 'test.html']) assert.throws(() => mirrorName(name));
});

test('untrusted redirects, HTML, wrong lengths and wrong partial ranges never become downloads', async () => {
  for (const bad of [{ redirect: 'http://127.0.0.1/private' }, { html: true }, { wrongLength: true }]) {
    const s = setup(bad);
    await assert.rejects(downloadMirror(request(), 'echo.exe', s.options), { code: 'MIRROR_UNAVAILABLE' });
    assert.equal(s.saved.size, 0);
  }
  await assert.rejects(downloadMirror(request({ Range: 'bytes=2-6' }), 'echo.exe', setup({ wrongRange: true }).options), { code: 'MIRROR_UNAVAILABLE' });
});

test('cache failures preserve streaming and EdgeOne requests may have no signal property', async () => {
  const s = setup({ cacheFailure: true });
  const r = await downloadMirror({ headers: new Headers(), method: 'GET' }, 'echo.exe', s.options);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), bytes); await s.finish();
  assert.equal(mirrorInfo('echo.exe', data).expiresAt, null);
});

test('native stream cancellation reaches the source when no cache fill is requested', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } });
  const r = await downloadMirror(request(), 'echo.exe', { data, fetcher: async () => new Response(body, { headers: { 'content-length': String(data.size) } }) });
  await r.body.cancel(); assert.equal(cancelled, true);
});
