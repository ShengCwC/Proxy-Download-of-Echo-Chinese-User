import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DownloadError } from '../src/echo.mjs';

export function createOriginServer({ reader, secret }) {
  if (!/^[a-f0-9]{64}$/.test(secret || '')) throw new Error('Set ECHO_ORIGIN_KEY to 32 random bytes encoded as hex');
  const key = Buffer.from(secret);
  return http.createServer({ requestTimeout: 60000, headersTimeout: 10000, maxHeaderSize: 8192 }, async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') || '');
    if (supplied.length !== key.length || !timingSafeEqual(supplied, key)) return json(401, { code: 'UNAUTHORIZED' });
    if (req.method === 'GET' && req.url === '/health') return json(200, { ok: true, version: '2.0.0', mode: 'live-browser' });
    if (req.method !== 'POST' || req.url !== '/read') return json(404, { code: 'NOT_FOUND' });
    if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { code: 'INVALID_BODY' });
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 8192) { json(413, { code: 'INVALID_BODY' }); return; }
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return json(400, { code: 'INVALID_BODY' }); }
      const result = await reader.read(input, controller.signal);
      const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': result.bytes.length, 'Content-Range': `bytes ${result.start}-${result.end}/${result.size}`, ETag: result.etag };
      if (result.lastModified) headers['Last-Modified'] = result.lastModified;
      res.writeHead(206, headers); res.end(result.bytes);
    } catch (error) {
      if (res.destroyed) return;
      const safe = error instanceof DownloadError ? error : { status: 502, code: 'ORIGIN_FAILED', message: '浏览器回源未完成。' };
      json(safe.status, { code: safe.code, message: safe.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const secret = process.env.ECHO_ORIGIN_KEY;
  if (!/^[a-f0-9]{64}$/.test(secret || '')) throw new Error('ECHO_ORIGIN_KEY is required');
  const { createBrowserReader } = await import('./browser.mjs');
  const reader = await createBrowserReader();
  const server = createOriginServer({ reader, secret });
  server.listen(Number(process.env.PORT || 9000), '0.0.0.0', () => console.log('Echo browser origin ready'));
  const stop = () => { server.close(); void reader.close().finally(() => process.exit(0)); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
