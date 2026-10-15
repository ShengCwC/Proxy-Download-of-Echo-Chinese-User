import { DownloadError, parseEntry, parseSigned, resolveEntry, encodeTicket, decodeTicket, downloadFile, readLimited } from './echo.mjs';
import { page, style } from './site.mjs';
import { mirror, mirrorInfo, downloadMirror } from './mirror.mjs';
import logo from '../public/assets/logo-light.png';
import favicon from '../public/assets/favicon-light.png';
import client from './client.js?raw';
import transfer from './transfer.mjs?raw';

const VERSION = '1.3.0';
const SECURITY = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Surrogate-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function secure(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY)) headers.set(key, value);
  headers.set('X-Echo-Proxy-Version', VERSION);
  return new Response(response.body, { status: response.status, headers });
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra } });
}
function escape(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

function errorPage(error, entry) {
  const home = entry ? new URL(entry).pathname : '/';
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>下载暂未开始 · Echo 下载加速</title><link rel="stylesheet" href="/style.css"></head><body><main class="shell"><section class="card"><span class="step">ECHO DOWNLOAD</span><h2>下载暂未开始</h2><p class="status error">${escape(error.message)}</p><a class="primary" href="${escape(home)}">返回下载页，重新获取 <span>↗</span></a>${entry ? `<p class="hint"><a href="${escape(entry)}" rel="noopener noreferrer">使用 Echo 官方直连下载 ↗</a></p>` : '<p class="hint">如果刚才粘贴了临时文件地址，请回到 Echo 官方页面获取新地址。</p>'}<p class="hint">错误标识：${escape(error.code)}</p></section></main></body></html>`, { status: error.status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...(error.code === 'CF_CHALLENGE' ? { 'Retry-After': '60' } : {}) } });
}

export function createHandler({ fetcher = fetch, now = () => Date.now(), cache } = {}) {
  return async function handle(request, context = {}) {
    const url = new URL(request.url);
    if (url.hostname === 'dl.echo.screenshare.cn' && url.protocol === 'http:') {
      url.protocol = 'https:';
      return secure(new Response(null, { status: 308, headers: { Location: url.href } }));
    }
    let entry;
    let response;
    try {
      if (!['GET', 'HEAD', 'POST'].includes(request.method)) return secure(json({ code: 'METHOD_NOT_ALLOWED', message: '不支持此请求方式。' }, 405, { Allow: 'GET, HEAD, POST' }));
      if (url.pathname === '/health') response = json({ ok: true, version: VERSION, cache: 'versioned-mirror', mirror: { sha256: mirror.sha256, size: mirror.size, publishedAt: mirror.publishedAt } });
      else if (url.pathname === '/style.css' && request.method !== 'POST') response = new Response(style, { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
      else if (url.pathname === '/app.js' && request.method !== 'POST') response = new Response(client, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
      else if (url.pathname === '/transfer.js' && request.method !== 'POST') response = new Response(transfer, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
      else if (['/assets/logo-light.png', '/assets/favicon-light.png', '/icon.svg', '/favicon.ico'].includes(url.pathname) && request.method !== 'POST') response = new Response(Uint8Array.from(atob(url.pathname === '/assets/logo-light.png' ? logo : favicon), c => c.charCodeAt(0)), { headers: { 'Content-Type': 'image/png' } });
      else if (url.pathname === '/robots.txt') response = new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain' } });
      else if (['/api/resolve', '/api/import', '/api/mirror'].includes(url.pathname)) {
        if (request.method !== 'POST') return secure(json({ code: 'METHOD_NOT_ALLOWED', message: '请通过下载页提交链接。' }, 405, { Allow: 'POST' }));
        const origin = request.headers.get('origin');
        if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') throw new DownloadError('INVALID_ORIGIN', '请从本站下载页面操作。', 403);
        if (!request.headers.get('content-type')?.startsWith('application/json')) throw new DownloadError('INVALID_BODY', '请求格式不正确。', 415);
        let input;
        try { input = JSON.parse(await readLimited(request, 8192)); }
        catch { throw new DownloadError('INVALID_BODY', '请求内容无效或过长。', 400); }
        if (!input || typeof input.url !== 'string') throw new DownloadError('INVALID_BODY', '请输入下载链接。', 400);
        let result;
        if (url.pathname === '/api/mirror') {
          // This public snapshot is independent of upstream authorization. An
          // imported URL supplies only a filename, never permission or bytes.
          let filename;
          if (input.url.trim().startsWith('https://builds.echo.ac/')) filename = parseSigned(input.url.trim(), now(), 0, { metadataOnly: true }).filename;
          else {
            entry = parseEntry(input.url);
            filename = (await resolveEntry(entry, { fetcher, now: now(), signal: request.signal })).filename;
          }
          response = json({ ...mirrorInfo(filename), ...(entry ? { entry } : {}) });
          return secure(response);
        } else if (url.pathname === '/api/resolve') {
          entry = parseEntry(input.url);
          result = await resolveEntry(entry, { fetcher, now: now(), signal: request.signal });
        } else {
          entry = input.entry ? parseEntry(input.entry) : undefined;
          result = { ...parseSigned(input.url.trim(), now(), 5000), ...(entry ? { entry } : {}) };
          // Check the real origin before announcing readiness. A signed-looking
          // URL alone cannot establish either authorization or reachability.
          const probe = await downloadFile(result, new Request(request.url, { method: 'HEAD' }), { fetcher, now: now(), signal: request.signal });
          if (probe.status !== 200) throw new DownloadError('FILE_UNAVAILABLE', 'Echo 暂时无法提供该文件，请使用官方直连。', 502, 'file');
          parseSigned(result.url, now(), 5000);
        }
        response = json({ filename: result.filename, expiresAt: result.expiresAt, entry: result.entry, download: '/download/' + encodeTicket({ url: result.url, ...(result.entry ? { entry: result.entry } : {}) }) });
      } else if (url.pathname.startsWith('/mirror/')) {
        if (request.method === 'POST') return secure(json({ code: 'METHOD_NOT_ALLOWED', message: '请使用下载链接。' }, 405, { Allow: 'GET, HEAD' }));
        const match = /^\/mirror\/([a-f0-9]{64})\/([^/]+)$/.exec(url.pathname);
        if (!match || match[1] !== mirror.sha256) throw new DownloadError('MIRROR_VERSION_UNKNOWN', '镜像版本已变更，请回到首页重新下载。', 404, 'file');
        response = await downloadMirror(request, decodeURIComponent(match[2]), { fetcher, cache, waitUntil: context.waitUntil });
      } else if (url.pathname.startsWith('/download/')) {
        if (request.method === 'POST') return secure(json({ code: 'METHOD_NOT_ALLOWED', message: '请使用下载链接。' }, 405, { Allow: 'GET, HEAD' }));
        const data = decodeTicket(url.pathname.slice('/download/'.length));
        entry = data.entry;
        try {
          response = await downloadFile(data, request, { fetcher, now: now(), signal: request.signal });
        } catch (error) {
          // Refresh at most once, before any bytes are sent. Never refresh a
          // range silently: the build may have changed since the partial file.
          if (!entry || request.headers.has('range') || !['LINK_EXPIRED', 'UPSTREAM_DENIED'].includes(error.code)) throw error;
          const fresh = await resolveEntry(entry, { fetcher, now: now(), signal: request.signal });
          response = await downloadFile(fresh, request, { fetcher, now: now(), signal: request.signal });
        }
      } else if (request.method !== 'POST' && (url.pathname === '/' || /^\/[A-Za-z0-9_-]{6,128}={0,2}$/.test(url.pathname))) {
        response = new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      } else response = json({ code: 'NOT_FOUND', message: '页面不存在。' }, 404);
    } catch (error) {
      const safe = error instanceof DownloadError ? error : new DownloadError('REQUEST_FAILED', '请求未能完成，请稍后重试。', 502);
      response = url.pathname.startsWith('/download/') || url.pathname.startsWith('/mirror/') ? errorPage(safe, entry) : json({ code: safe.code, message: safe.message, stage: safe.stage }, safe.status, safe.status === 429 || safe.code === 'CF_CHALLENGE' ? { 'Retry-After': '60' } : {});
    }
    if (request.method === 'HEAD') {
      await response.body?.cancel();
      response = new Response(null, { status: response.status, headers: response.headers });
    }
    return secure(response);
  };
}
