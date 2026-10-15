import { createHandler } from './handler.mjs';
const handle = createHandler();
export default { fetch: request => handle(request) };
