import { DownloadError } from './echo.mjs';
import manifest from './mirror-manifest.json' with { type: 'json' };

export const mirror = manifest;
export function mirrorName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}\.exe$/i.test(value) || value.includes('..')) throw new DownloadError('INVALID_FILENAME', '文件名无效，请从官方页面重新复制链接。', 400, 'file');
  return value;
}
export function mirrorInfo(filename = 'echo.exe', data = mirror) {
  return { delivery: 'mirror', filename: mirrorName(filename), expiresAt: null, snapshot: data.publishedAt, sha256: data.sha256, size: data.size, download: `/mirror/${data.sha256}/${encodeURIComponent(filename)}` };
}
function failure() { return new DownloadError('MIRROR_UNAVAILABLE', '镜像文件暂时无法读取，请重试或使用官方直连。', 502, 'file'); }
export function rangeOf(value, size) {
  if (!value) return [0, size - 1];
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2])) return null;
  const a = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const b = m[1] ? (m[2] ? Math.min(size - 1, Number(m[2])) : size - 1) : size - 1;
  return Number.isSafeInteger(a) && Number.isSafeInteger(b) && a >= 0 && a <= b && a < size && (m[1] || Number(m[2]) > 0) ? [a, b] : null;
}

async function source(request, range, data, fetcher) {
  let current = data.url;
  for (let hop = 0; hop < 3; hop++) {
    // Pass the native body directly through EdgeOne. Materializing/hash-checking
    // the entire file here exceeds its 200 ms CPU budget. Verify at publication
    // and with the full end-to-end smoke check instead.
    const response = await fetcher(current, {
      headers: { ...(range ? { Range: range } : {}), 'Accept-Encoding': 'identity', Accept: 'application/octet-stream' },
      redirect: 'manual', ...(request.signal ? { signal: request.signal } : {}),
      eo: { timeoutSetting: { connectTimeout: 15000, readTimeout: 120000, writeTimeout: 15000 } },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    const next = new URL(location || '', current);
    if (next.protocol !== 'https:' || next.port || next.username || next.password || !['github.com', 'release-assets.githubusercontent.com'].includes(next.hostname)) throw failure();
    current = next.href;
  }
  throw failure();
}

export async function downloadMirror(request, filename, { data = mirror, fetcher = fetch, cache, waitUntil } = {}) {
  mirrorName(filename);
  const etag = `"sha256-${data.sha256}"`;
  const modified = new Date(data.publishedAt).toUTCString();
  const ifRange = request.headers.get('if-range');
  const range = !ifRange || ifRange === etag || ifRange === modified ? request.headers.get('range') : null;
  const bounds = rangeOf(range, data.size);
  if (!bounds) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${data.size}`, 'Accept-Ranges': 'bytes' } });
  const [start, end] = bounds;
  const headers = new Headers({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${filename}"`, 'Accept-Ranges': 'bytes', ETag: etag, 'Last-Modified': modified, 'X-Echo-Mirror-SHA256': data.sha256, 'X-Echo-Mirror-Date': data.publishedAt, 'Content-Length': String(end - start + 1) });
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${data.size}`);
  if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
  // A versioned internal cache never contains PINs or individual filenames.
  // EdgeOne rejects Cache API keys that match the function's own trigger
  // ("forbidden cdn cache"). Use the immutable public origin URL, as in its
  // documented Cache API example, rather than recursively targeting this host.
  const key = new Request(data.url);
  const lookup = new Request(key.url, { headers: range ? { Range: `bytes=${start}-${end}` } : {} });
  let response;
  let hit = false;
  if (cache) {
    try {
      response = await cache.match(lookup);
      hit = response?.status === (range ? 206 : 200) && (!range || response.headers.get('content-range') === `bytes ${start}-${end}/${data.size}`);
      if (!hit) { await response?.body?.cancel(); response = null; }
    } catch { /* EdgeOne returns 504 for expired/evicted entries. */ }
  }
  if (!response) {
    response = await source(request, range ? `bytes=${start}-${end}` : null, data, fetcher);
    const type = response.headers.get('content-type') || '';
    const length = response.headers.get('content-length');
    if (response.status !== (range ? 206 : 200) || !response.body || /html|json|xml|text\//i.test(type) || (length && Number(length) !== end - start + 1) || (range && response.headers.get('content-range') !== `bytes ${start}-${end}/${data.size}`) || (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity')) {
      await response.body?.cancel(); throw failure();
    }
    if (!range && cache && waitUntil) {
      // Cache.put rejects 206. Keep the full native stream and let the runtime
      // perform the tee/cache transfer, rather than copying the binary in JS.
      let cachedResponse = response.clone();
      const cachedHeaders = new Headers({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.size), 'Cache-Control': 'public, max-age=604800', ETag: etag, 'Last-Modified': modified });
      try {
        for (const [name, value] of cachedHeaders) cachedResponse.headers.set(name, value);
        for (const name of ['set-cookie', 'vary', 'content-disposition', 'cdn-cache-control', 'surrogate-control']) cachedResponse.headers.delete(name);
      } catch { cachedResponse = new Response(cachedResponse.body, { headers: cachedHeaders }); }
      waitUntil(cache.put(key, cachedResponse).catch(() => {}));
    }
  }
  headers.set('X-Echo-Mirror-Cache', hit ? 'hit' : 'miss');
  return new Response(response.body, { status: range ? 206 : 200, headers });
}
