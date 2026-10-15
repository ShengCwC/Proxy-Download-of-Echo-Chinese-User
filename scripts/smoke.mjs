import { mkdir, writeFile } from 'node:fs/promises';
import { downloadVerified } from '../src/transfer.mjs';
const base = new URL(process.env.BASE_URL || 'https://dl.echo.screenshare.cn');
const health = await fetch(new URL('/health', base), { signal: AbortSignal.timeout(20000) });
const state = await health.json();
if (!health.ok || !state.ok || state.mode !== 'live-browser' || !state.configured) throw new Error('Live browser origin is not configured on this deployment');
console.log(JSON.stringify({ check: 'health', ok: true, version: state.version }));
const sourceUrl = process.env.ECHO_TEST_URL;
if (!sourceUrl) { console.log('Set ECHO_TEST_URL to a fresh full builds URL for a real download. URLs are never logged.'); process.exit(0); }
const started = performance.now();
const prepared = await fetch(new URL('/api/prepare', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: sourceUrl }), signal: AbortSignal.timeout(55000) });
const info = await prepared.json();
if (!prepared.ok) throw new Error(`Prepare failed: ${info.code}`);
if (info.download !== '/api/chunk' || info.delivery !== 'live') throw new Error('Unexpected download route');
let sha256;
const blob = await downloadVerified({ ...info, url: new URL(info.download, base).href, sourceUrl, onDigest: digest => { sha256 = digest; } });
await mkdir('.local', { recursive: true });
await writeFile('.local/verified-download.exe', new Uint8Array(await blob.arrayBuffer()));
console.log(JSON.stringify({ check: 'live-full-download', size: blob.size, sha256, etag: info.etag, checkedAt: info.checkedAt, seconds: Number(((performance.now() - started) / 1000).toFixed(2)) }));
