import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const rawPlugin = {
  name: 'raw-source',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, args => ({ path: fileURLToPath(new URL('../src/' + args.path.replace('./', '').replace('?raw', ''), import.meta.url)), namespace: 'raw' }));
    build.onLoad({ filter: /.*/, namespace: 'raw' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }));
  },
};

export async function bundle() {
  await mkdir('dist', { recursive: true });
  const common = { bundle: true, target: 'es2022', platform: 'browser', plugins: [rawPlugin], loader: { '.png': 'base64' }, legalComments: 'none', charset: 'utf8' };
  await build({ ...common, entryPoints: ['src/edgeone.mjs'], outfile: 'dist/edgeone.js', format: 'iife' });
  await build({ ...common, entryPoints: ['src/worker.mjs'], outfile: 'dist/worker.mjs', format: 'esm' });
  await build({ ...common, entryPoints: ['src/handler.mjs'], outfile: 'dist/handler.mjs', format: 'esm' });
}

if (process.argv[1]?.endsWith('build.mjs')) { await bundle(); console.log('Built EdgeOne edge function and local runtime.'); }
