import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { rawPlugin } from '../scripts/build.mjs';
await mkdir('_generated', { recursive: true });
await build({ bundle: true, entryPoints: ['../src/handler.mjs'], outfile: '_generated/handler.mjs', format: 'esm', target: 'es2022', platform: 'browser', plugins: [rawPlugin], loader: { '.png': 'base64' }, legalComments: 'none', charset: 'utf8' });
const { createHandler } = await import('./_generated/handler.mjs');
const handle = createHandler();
for (const [route, path] of [['/', 'index.html'], ['/style.css','style.css'], ['/app.js','app.js'], ['/transfer.js','transfer.js'], ['/assets/logo-light.png','assets/logo-light.png'], ['/assets/favicon-light.png','assets/favicon-light.png'], ['/robots.txt','robots.txt']]) {
  await mkdir('dist/' + path.split('/').slice(0,-1).join('/'), { recursive: true });
  const response = await handle(new Request('https://dl.echo.screenshare.cn' + route));
  await writeFile('dist/' + path, new Uint8Array(await response.arrayBuffer()));
}
await writeFile('dist/404.html', '<!doctype html><title>页面不存在</title><a href="/">返回 Echo 下载首页</a>');
