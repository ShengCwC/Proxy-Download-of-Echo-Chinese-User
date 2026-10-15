import puppeteer from 'puppeteer-core';
import { inspectRange, validateRead, liveError } from '../src/live-protocol.mjs';

// No login profile, copied cookies, CAPTCHA interaction or saved installers.
// Each range comes from the supplied official signed URL in an isolated context.
export async function createBrowserReader({ executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome', noSandbox = process.env.CHROME_NO_SANDBOX === '1' } = {}) {
  const browser = await puppeteer.launch({ executablePath, headless: false, args: ['--disable-dev-shm-usage', ...(noSandbox ? ['--no-sandbox'] : [])] });
  let active = 0;
  return {
    close: () => browser.close(),
    async read(input, signal) {
      const data = validateRead(input);
      if (active >= 6) throw liveError('ORIGIN_BUSY', '下载线路繁忙，请稍后重试。', 503);
      active++;
      let context;
      let timer;
      const close = () => context?.close().catch(() => {});
      try {
        signal?.throwIfAborted();
        context = await browser.createBrowserContext();
        signal?.addEventListener('abort', close, { once: true });
        signal?.throwIfAborted();
        timer = setTimeout(close, 45000);
        const page = await context.newPage();
        await page.setRequestInterception(true);
        page.on('request', request => {
          const url = new URL(request.url());
          if (url.origin === 'https://builds.echo.ac' && url.pathname === '/echo.exe' && request.method() === 'GET') void request.continue().catch(() => {});
          else void request.abort().catch(() => {});
        });
        // A same-origin XML error is expected for the unsigned bootstrap URL.
        const initial = await page.goto('https://builds.echo.ac/echo.exe', { waitUntil: 'domcontentloaded', timeout: 20000 });
        if (!initial || initial.headers()['cf-mitigated'] === 'challenge') throw liveError('CF_CHALLENGE', '官方文件服务要求额外验证，未使用旧文件替代。', 503);
        const metadata = await page.evaluate(async ({ url, start, end, etag }) => {
          const headers = { Range: `bytes=${start}-${end}` };
          if (etag) headers['If-Match'] = etag;
          const response = await fetch(url, { headers, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000) });
          window.echoReadResponse = response;
          return { status: response.status, headers: Object.fromEntries(response.headers) };
        }, data);
        const version = inspectRange(metadata.status, metadata.headers, data);
        const encoded = await page.evaluate(async expected => {
          const reader = window.echoReadResponse.body.getReader();
          const output = new Uint8Array(expected);
          let offset = 0;
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (offset + value.length > expected) throw new Error('SIZE_MISMATCH');
              output.set(value, offset); offset += value.length;
            }
            if (offset !== expected) throw new Error('SIZE_MISMATCH');
            const parts = [];
            for (let n = 0; n < output.length; n += 16384) parts.push(String.fromCharCode(...output.subarray(n, n + 16384)));
            return btoa(parts.join(''));
          } finally { await reader.cancel().catch(() => {}); }
        }, data.end - data.start + 1);
        const bytes = Buffer.from(encoded, 'base64');
        if (data.start === 0 && (bytes[0] !== 77 || bytes[1] !== 90)) throw liveError('INVALID_FILE_RESPONSE', '官方响应不是有效的 Windows 程序。');
        return { bytes, ...version, start: data.start, end: data.end };
      } catch (error) {
        if (error.code) throw error;
        throw liveError('ORIGIN_UNREACHABLE', '浏览器回源连接中断，请重新获取下载地址。');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', close);
        await close();
        active--;
      }
    },
  };
}
