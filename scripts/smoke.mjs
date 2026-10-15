import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mirror, mirrorInfo } from '../src/mirror.mjs';
import { downloadVerified } from '../src/transfer.mjs';

const base = new URL(process.env.BASE_URL || 'https://dl.echo.screenshare.cn');
const entry = process.env.ECHO_TEST_ENTRY;
const parallel = process.argv.includes('--parallel');
const useMirror = parallel || process.argv.includes('--mirror');
const health = await fetch(new URL('/health', base), { signal: AbortSignal.timeout(20000) });
if (!health.ok || (await health.json()).ok !== true) throw new Error('Gateway health check failed');
console.log(JSON.stringify({ check: 'health', ok: true }));
if (!entry && !useMirror) {
  console.log('Set ECHO_TEST_ENTRY to test a real authorized download. Links are never printed.');
  process.exit(0);
}
const resolved = entry ? await fetch(new URL(useMirror ? '/api/mirror' : '/api/resolve', base), {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: entry }), signal: AbortSignal.timeout(40000),
}) : new Response(JSON.stringify(mirrorInfo()));
const result = await resolved.json();
if (!resolved.ok) {
  console.log(JSON.stringify({ check: 'resolve', ok: false, status: resolved.status, code: result.code }));
  process.exit(1);
}
const target = new URL(result.download, base);
if (target.origin !== base.origin || !target.pathname.startsWith(useMirror ? '/mirror/' : '/download/')) throw new Error('Unexpected download destination');
const started = performance.now();
if (parallel) {
  const cache = { hit: 0, miss: 0 };
  const blob = await downloadVerified({ url: target, size: mirror.size, sha256: mirror.sha256, fetcher: async (...args) => {
    const response = await fetch(...args);
    const state = response.headers.get('x-echo-mirror-cache');
    if (state in cache) cache[state]++;
    return response;
  } });
  await mkdir('.local', { recursive: true });
  await writeFile('.local/verified-download.exe', new Uint8Array(await blob.arrayBuffer()));
  console.log(JSON.stringify({ check: 'parallel-download', ok: true, bytes: blob.size, sha256: mirror.sha256, cache, seconds: Number(((performance.now() - started) / 1000).toFixed(2)) }));
  process.exit(0);
}
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
const expected = process.env.EXPECTED_SHA256?.toLowerCase() || (useMirror ? mirror.sha256 : undefined);
const expectedSize = download.headers.get('content-length');
const ok = (!expected || sha256 === expected) && (!expectedSize || Number(expectedSize) === bytes) && (!useMirror || bytes === mirror.size);
console.log(JSON.stringify({ check: 'download', ok, bytes, sha256, cache: download.headers.get('x-echo-mirror-cache'), seconds: Number(((performance.now() - started) / 1000).toFixed(2)) }));
if (!ok) process.exitCode = 1;
