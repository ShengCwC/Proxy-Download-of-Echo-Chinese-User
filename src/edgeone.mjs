import { createHandler } from './handler.mjs';
const handle = createHandler({ cache: caches.default });
addEventListener('fetch', event => event.respondWith(handle(event.request, { waitUntil: task => event.waitUntil(task) })));
