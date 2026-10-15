// Explicit opt-in integration test: valid URLs arrive only through a temporary
// CI secret, and are never included in logs, assertions, artifacts or filenames.
import { randomBytes, createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { createBrowserReader } from '../origin/browser.mjs';
import { createOriginServer } from '../origin/server.mjs';
import { bundle } from './build.mjs';
import { downloadVerified } from '../src/transfer.mjs';
await bundle();
const { createHandler } = await import('../dist/handler.mjs');
const sourceUrl = process.env.ECHO_PROBE_URL;
if (!sourceUrl) throw new Error('Supply the temporary ECHO_PROBE_URL secret');
const reader = await createBrowserReader();
const secret = randomBytes(32).toString('hex');
const server = createOriginServer({ reader, secret });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const handler = createHandler({ originUrl: `http://127.0.0.1:${server.address().port}`, originKey: secret });
const request = (path, body) => new Request('https://test.invalid' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
try {
  const started = performance.now();
  const prepared = await handler(request('/api/prepare', { url: sourceUrl }));
  const info = await prepared.json();
  if (prepared.status !== 200) throw new Error(`Prepare failed: ${info.code}`);
  const changed = await handler(request('/api/chunk', { url: sourceUrl, size: info.size, etag: '"deliberately-wrong-version"', start: 0, end: 31 }));
  if (changed.status !== 409) throw new Error(`Changed-version check failed: ${changed.status}`);
  let sha256;
  const blob = await downloadVerified({ ...info, url: 'https://test.invalid/api/chunk', sourceUrl, fetcher: (url, init) => handler(new Request(url, init)), onDigest: digest => { sha256 = digest; } });
  const buffer = Buffer.from(await blob.arrayBuffer());
  if (createHash('sha256').update(buffer).digest('hex') !== sha256) throw new Error('Digest mismatch');
  const result = { checkedAt: info.checkedAt, size: blob.size, etag: info.etag, lastModified: info.lastModified, sha256, versionChangeRejected: true, seconds: Number(((performance.now() - started) / 1000).toFixed(2)), mode: 'live-browser-edge-handler-parallel-client' };
  await mkdir('.local/live-origin-test', { recursive: true });
  await writeFile('.local/live-origin-test/result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await reader.close(); }
