import { createHandler } from './handler.mjs';
export default { fetch: (request, env, ctx) => createHandler({ cache: caches.default })(request, { waitUntil: task => ctx.waitUntil(task) }) };
