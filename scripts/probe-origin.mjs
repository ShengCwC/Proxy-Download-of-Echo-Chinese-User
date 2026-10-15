// One-off reachability check. No PINs, signed URLs, cookies, or CAPTCHA interaction.
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';

const target = 'https://builds.echo.ac/echo.exe';
await mkdir('.local/origin-probe', { recursive: true });
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
  const result = { checkedAt: new Date().toISOString(), target, browser: await browser.version(), ...lastResponse, title, text, navigationError, challenge: lastResponse?.cfMitigated === 'challenge' || /just a moment|attention required/i.test(title) };
  await page.screenshot({ path: '.local/origin-probe/browser.png', fullPage: true });
  await writeFile('.local/origin-probe/result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
