export async function middleware({ request, env, next }) {
  if (new URL(request.url).pathname !== '/read') return next();
  const supplied = request.headers.get('authorization') || '';
  if (!/^[a-f0-9]{64}$/.test(env.ECHO_ORIGIN_KEY || '') || supplied !== `Bearer ${env.ECHO_ORIGIN_KEY}`) return new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'private, no-store' } });
  return next();
}
export const config = { matcher: ['/read'] };
