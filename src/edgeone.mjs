import { createHandler } from './handler.mjs';
addEventListener('fetch', event => {
  const config = typeof env === 'undefined' ? {} : env;
  event.respondWith(createHandler({ originUrl: config.ECHO_ORIGIN_URL, originKey: config.ECHO_ORIGIN_KEY })(event.request));
});
