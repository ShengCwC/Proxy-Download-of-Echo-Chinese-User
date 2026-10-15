import http from 'node:http';
import { Readable } from 'node:stream';
import { bundle } from './build.mjs';
await bundle();
const { createHandler } = await import('../dist/handler.mjs');
const handler = createHandler();
const host = '127.0.0.1';
const port = Number(process.env.PORT || 4173);
const server = http.createServer(async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  try {
    const request = new Request(`http://${host}:${port}${req.url}`, { method: req.method, headers: req.headers, ...(req.method === 'POST' ? { body: Readable.toWeb(req), duplex: 'half' } : {}), signal: controller.signal });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) res.end();
    else {
      const stream = Readable.fromWeb(response.body);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    }
  } catch { if (!res.headersSent) res.writeHead(502); res.end('Request failed'); }
});
server.listen(port, host, () => console.log(`Local: http://${host}:${port}`));
