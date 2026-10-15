import { createHandler } from './handler.mjs';
export default { fetch: (request, env) => createHandler({ originUrl: env.ECHO_ORIGIN_URL, originKey: env.ECHO_ORIGIN_KEY })(request) };
