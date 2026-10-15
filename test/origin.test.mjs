import test from 'node:test';
import assert from 'node:assert/strict';
import { createOriginServer } from '../origin/server.mjs';
test('browser service refuses unauthenticated reads and forwards only bounded binary output', async () => {
  let calls = 0;
  const secret = 'c'.repeat(64);
  const server = createOriginServer({ secret, reader: { async read() { calls++; return { bytes: Buffer.from([77, 90]), start: 0, end: 1, size: 99, etag: '"current"' }; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/read', { method: 'POST' })).status, 401); assert.equal(calls, 0);
    const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/read', { method: 'POST', headers, body: 'invalid' })).status, 400); assert.equal(calls, 0);
    const response = await fetch(base + '/read', { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 206); assert.equal(response.headers.get('etag'), '"current"');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.of(77, 90)); assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
