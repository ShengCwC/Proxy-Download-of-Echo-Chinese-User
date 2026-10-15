import { createHandler } from '../../_generated/handler.mjs';
export async function onRequest(context) {
  return createHandler({ originUrl: new URL(context.request.url).origin, originKey: context.env.ECHO_ORIGIN_KEY })(context.request);
}
