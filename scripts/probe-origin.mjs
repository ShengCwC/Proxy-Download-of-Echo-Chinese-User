// One-off reachability check. Never logs signed URLs or cookies; no CAPTCHA interaction.
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';

const target = 'https://builds.echo.ac/echo.exe';
await mkdir('.local/origin-probe', { recursive: true });
const raw = await fetch(target, { headers: { Range: 'bytes=0-31' }, signal: AbortSignal.timeout(20000) });
const direct = { status: raw.status, type: raw.headers.get('content-type'), cfMitigated: raw.headers.get('cf-mitigated') };
await raw.body?.cancel();
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: false,
  args: ['--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  let lastResponse;
  page.on('response', response => {
    if (response.url() === target) lastResponse = { status: response.status(), type: response.headers()['content-type'], cfMitigated: response.headers()['cf-mitigated'] || null };
  });
  let navigationError;
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(error => { navigationError = error.message.split('\n')[0]; });
  for (let attempt = 0; attempt < 6; attempt++) {
    if (lastResponse && lastResponse.cfMitigated !== 'challenge') break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  const title = await page.title();
  const text = await page.evaluate(() => document.body?.innerText.slice(0, 700) || '');
  let signedFile;
  if (process.env.ECHO_PROBE_URL) {
    const signed = new URL(process.env.ECHO_PROBE_URL);
    if (signed.origin !== 'https://builds.echo.ac' || signed.pathname !== '/echo.exe') throw new Error('Unexpected source');
    const rawFile = await fetch(signed, { headers: { Range: 'bytes=0-31' }, signal: AbortSignal.timeout(20000) });
    const directFile = { status: rawFile.status, type: rawFile.headers.get('content-type'), cfMitigated: rawFile.headers.get('cf-mitigated') };
    await rawFile.body?.cancel();
    const started = performance.now();
    const browserFile = await page.evaluate(async url => {
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(60000) });
      const metadata = { status: response.status, type: response.headers.get('content-type'), cfMitigated: response.headers.get('cf-mitigated'), etag: response.headers.get('etag'), modified: response.headers.get('last-modified') };
      if (!response.ok || !metadata.type?.includes('application/octet-stream')) { await response.body?.cancel(); return metadata; }
      const bytes = await response.arrayBuffer();
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
      return { ...metadata, size: bytes.byteLength, sha256, pe: new Uint8Array(bytes)[0] === 77 && new Uint8Array(bytes)[1] === 90 };
    }, signed.href).catch(error => ({ error: error.name }));
    signedFile = { direct: directFile, browser: browserFile, seconds: Number(((performance.now() - started) / 1000).toFixed(2)) };
  }
  const result = { checkedAt: new Date().toISOString(), target, direct, browser: await browser.version(), ...lastResponse, title, text, navigationError, signedFile, challenge: lastResponse?.cfMitigated === 'challenge' || /just a moment|attention required/i.test(title) };
  await page.screenshot({ path: '.local/origin-probe/browser.png', fullPage: true });
  await writeFile('.local/origin-probe/result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
