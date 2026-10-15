import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const base = new URL(process.env.BASE_URL || 'https://dl.echo.screenshare.cn');
const entry = process.env.ECHO_TEST_ENTRY;
const health = await fetch(new URL('/health', base), { signal: AbortSignal.timeout(20000) });
if (!health.ok || (await health.json()).ok !== true) throw new Error('Gateway health check failed');
console.log(JSON.stringify({ check: 'health', ok: true }));
if (!entry) {
  console.log('Set ECHO_TEST_ENTRY to test a real authorized download. Links are never printed.');
  process.exit(0);
}
const resolved = await fetch(new URL('/api/resolve', base), {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: entry }), signal: AbortSignal.timeout(40000),
});
const result = await resolved.json();
if (!resolved.ok) {
  console.log(JSON.stringify({ check: 'resolve', ok: false, status: resolved.status, code: result.code }));
  process.exit(1);
}
const target = new URL(result.download, base);
if (target.origin !== base.origin || !target.pathname.startsWith('/download/')) throw new Error('Unexpected download destination');
const started = performance.now();
const download = await fetch(target, { signal: AbortSignal.timeout(300000) });
if (download.status !== 200 || !download.headers.get('content-type')?.includes('application/octet-stream')) {
  await download.body?.cancel();
  console.log(JSON.stringify({ check: 'download', ok: false, status: download.status }));
  process.exit(1);
}
await mkdir('.local', { recursive: true });
let bytes = 0;
const hash = createHash('sha256');
await pipeline(Readable.fromWeb(download.body), new Transform({
  transform(chunk, _, done) { bytes += chunk.length; hash.update(chunk); done(null, chunk); },
}), createWriteStream('.local/verified-download.exe'));
const sha256 = hash.digest('hex');
const expected = process.env.EXPECTED_SHA256?.toLowerCase();
const expectedSize = download.headers.get('content-length');
const ok = (!expected || sha256 === expected) && (!expectedSize || Number(expectedSize) === bytes);
console.log(JSON.stringify({ check: 'download', ok, bytes, sha256, seconds: Number(((performance.now() - started) / 1000).toFixed(2)) }));
if (!ok) process.exitCode = 1;
