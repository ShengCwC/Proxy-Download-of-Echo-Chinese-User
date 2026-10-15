import { DownloadError, parseSigned, readLimited } from './echo.mjs';
import { validateRead, inspectRange, liveError } from './live-protocol.mjs';
import { page, style } from './site.mjs';
import logo from '../public/assets/logo-light.png';
import favicon from '../public/assets/favicon-light.png';
import client from './client.js?raw';
import transfer from './transfer.mjs?raw';

const VERSION = '2.0.0';
const SECURITY = {
  'Cache-Control': 'private, no-store, max-age=0', 'CDN-Cache-Control': 'no-store', 'Surrogate-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'X-Echo-Proxy-Version': VERSION,
};
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }); }
function secure(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

export function createHandler({ fetcher = fetch, now = () => Date.now(), originUrl, originKey } = {}) {
  async function readOrigin(input, signal) {
    if (!originUrl || !/^[a-f0-9]{64}$/.test(originKey || '')) throw liveError('ORIGIN_NOT_CONFIGURED', '实时下载线路尚未配置。', 503);
    const target = new URL('/read', originUrl);
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && target.hostname === '127.0.0.1')) throw liveError('ORIGIN_NOT_CONFIGURED', '实时下载线路配置无效。', 503);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 50000);
    try {
      if (signal?.aborted) controller.abort();
      const response = await fetcher(target.href, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${originKey}` },
        body: JSON.stringify(input), redirect: 'manual', signal: controller.signal,
        eo: { timeoutSetting: { connectTimeout: 10000, readTimeout: 50000, writeTimeout: 15000 } },
      });
      if (response.status !== 206) {
        let error;
        try { error = JSON.parse(await readLimited(response, 4096)); } catch { /* No upstream body is reflected. */ }
        const messages = {
          CF_CHALLENGE: '官方文件服务要求额外验证，未使用旧文件替代。请重新获取官方链接。',
          LINK_EXPIRED: '官方链接已过期，请复制新的完整地址。',
          UPSTREAM_DENIED: '官方拒绝了此链接，请获取新的完整下载地址。',
          VERSION_CHANGED: '官方文件已更新，请获取新链接后重新下载。',
          ORIGIN_BUSY: '下载线路繁忙，请稍后重试。',
          UPSTREAM_RATE_LIMIT: '官方请求较多，请稍后重试。',
        };
        if (messages[error?.code]) throw liveError(error.code, messages[error.code], error.code === 'VERSION_CHANGED' ? 409 : error.code === 'LINK_EXPIRED' || error.code === 'UPSTREAM_DENIED' ? 410 : error.code === 'UPSTREAM_RATE_LIMIT' ? 429 : 503);
        throw liveError('ORIGIN_UNREACHABLE', '实时下载线路未能完成请求，请重新获取链接。');
      }
      let metadata;
      try { metadata = inspectRange(response.status, response.headers, input); }
      catch (error) { await response.body?.cancel(); throw error; }
      return { response, metadata };
    } catch (error) {
      if (error instanceof DownloadError) throw error;
      throw liveError('ORIGIN_UNREACHABLE', '实时下载线路连接中断，请重新获取链接。');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  return async function handle(request) {
    const url = new URL(request.url);
    let response;
    try {
      if (url.hostname === 'dl.echo.screenshare.cn' && url.protocol === 'http:') {
        url.protocol = 'https:'; return secure(new Response(null, { status: 308, headers: { Location: url.href } }));
      }
      if (['/api/prepare', '/api/chunk'].includes(url.pathname)) {
        if (request.method !== 'POST') return secure(json({ code: 'METHOD_NOT_ALLOWED' }, 405));
        const origin = request.headers.get('origin');
        if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') throw liveError('INVALID_ORIGIN', '请从本站下载页面操作。', 403);
        if (!request.headers.get('content-type')?.startsWith('application/json')) throw liveError('INVALID_BODY', '请求格式不正确。', 415);
        let input;
        try { input = JSON.parse(await readLimited(request, 8192)); }
        catch { throw liveError('INVALID_BODY', '请求内容无效或过长。', 400); }
        const prepare = url.pathname === '/api/prepare';
        const data = validateRead(prepare ? { url: input?.url, start: 0, end: 31 } : input, now());
        if (!prepare && !data.etag) throw liveError('VERSION_REQUIRED', '请先确认官方版本。', 400);
        const { response: part, metadata } = await readOrigin(data, request.signal);
        if (prepare) {
          const bytes = new Uint8Array(await part.arrayBuffer());
          if (bytes.length !== 32 || bytes[0] !== 77 || bytes[1] !== 90) throw liveError('INVALID_FILE_RESPONSE', '官方返回的内容不是 Windows 程序。');
          parseSigned(data.url, now(), 5000);
          response = json({ ...metadata, filename: data.filename, expiresAt: data.expiresAt, checkedAt: new Date(now()).toISOString(), delivery: 'live', download: '/api/chunk' });
        } else {
          const headers = new Headers({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.end - data.start + 1), 'Content-Range': `bytes ${data.start}-${data.end}/${metadata.size}`, ETag: metadata.etag, 'X-Echo-Delivery': 'live' });
          response = new Response(part.body, { status: 206, headers });
        }
      } else if (url.pathname.startsWith('/mirror/') || ['/api/mirror', '/api/import', '/api/resolve'].includes(url.pathname) || url.pathname.startsWith('/download/')) {
        response = json({ code: 'LEGACY_ROUTE_REMOVED', message: '请回到首页，提交有效的 builds.echo.ac 完整文件地址以下载官方当前版本。' }, 410);
      } else if (!['GET', 'HEAD'].includes(request.method)) response = json({ code: 'METHOD_NOT_ALLOWED' }, 405);
      else if (url.pathname === '/health') response = json({ ok: true, version: VERSION, mode: 'live-browser', configured: Boolean(originUrl && /^[a-f0-9]{64}$/.test(originKey || '')), cache: 'no-store' });
      else if (url.pathname === '/') response = new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      else if (url.pathname === '/style.css') response = new Response(style, { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
      else if (url.pathname === '/app.js') response = new Response(client, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
      else if (url.pathname === '/transfer.js') response = new Response(transfer, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
      else if (['/assets/logo-light.png', '/assets/favicon-light.png', '/icon.svg', '/favicon.ico'].includes(url.pathname)) response = new Response(Uint8Array.from(atob(url.pathname === '/assets/logo-light.png' ? logo : favicon), c => c.charCodeAt(0)), { headers: { 'Content-Type': 'image/png' } });
      else if (url.pathname === '/robots.txt') response = new Response('User-agent: *\nDisallow: /\n');
      else response = json({ code: 'NOT_FOUND' }, 404);
    } catch (error) {
      const safe = error instanceof DownloadError ? error : liveError('REQUEST_FAILED', '下载未完成，请重新获取官方链接。');
      response = json({ code: safe.code, message: safe.message }, safe.status);
    }
    if (request.method === 'HEAD') { await response.body?.cancel(); response = new Response(null, { status: response.status, headers: response.headers }); }
    return secure(response);
  };
}
