// The existing mainland EdgeOne domain forwards to the independently deployed
// Makers application. Private origin credentials stay in Makers environment vars.
const APP = 'https://echo-origin.screenshare.cn';
export async function relay(request, fetcher = fetch) {
  const incoming = new URL(request.url);
  if (incoming.protocol === 'http:') { incoming.protocol = 'https:'; return Response.redirect(incoming.href, 308); }
  if (!['GET', 'HEAD', 'POST'].includes(request.method)) return new Response(null, { status: 405 });
  const publicPaths = new Set(['/', '/style.css', '/app.js', '/transfer.js', '/assets/logo-light.png', '/assets/favicon-light.png', '/robots.txt', '/health', '/api/prepare', '/api/chunk']);
  if (!publicPaths.has(incoming.pathname)) return Response.json({ code: 'NOT_FOUND' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const target = new URL(APP);
  target.pathname = incoming.pathname;
  // All download inputs are POST JSON. Query strings are never forwarded or cached.
  const headers = new Headers();
  for (const name of ['content-type', 'origin', 'sec-fetch-site']) if (request.headers.has(name)) headers.set(name, request.headers.get(name));
  let response;
  try {
    response = await fetcher(target.href, { method: request.method, headers, ...(request.method === 'POST' ? { body: request.body } : {}), redirect: 'manual', eo: { timeoutSetting: { connectTimeout: 10000, readTimeout: 60000, writeTimeout: 15000 } } });
  } catch {
    return Response.json({ code: 'ORIGIN_UNREACHABLE', message: '下载连接中断，请重新获取官方链接。' }, { status: 502, headers: { 'Cache-Control': 'private, no-store' } });
  }
  const result = new Headers(response.headers);
  for (const name of ['set-cookie', 'makers-conversation-id', 'makers-run-id', 'eo-pages-inner-scf-status', 'eo-pages-inner-status-intercept']) result.delete(name);
  result.set('Cache-Control', 'private, no-store');
  result.set('CDN-Cache-Control', 'no-store');
  result.set('X-Echo-Relay', 'edgeone-makers');
  result.set('X-Content-Type-Options', 'nosniff');
  result.set('Referrer-Policy', 'no-referrer');
  result.set('X-Frame-Options', 'DENY');
  result.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  return new Response(response.body, { status: response.status, headers: result });
}
if (typeof addEventListener === 'function') addEventListener('fetch', event => event.respondWith(relay(event.request)));

