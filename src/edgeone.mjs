import { createHandler } from './handler.mjs';
const handle = createHandler();
addEventListener('fetch', event => event.respondWith(handle(event.request)));
