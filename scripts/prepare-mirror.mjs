import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const source = args.find(a => !a.startsWith('--'));
if (!source) throw new Error('Usage: node scripts/prepare-mirror.mjs <browser-downloaded.exe> [--publish]');
if (process.platform !== 'win32') throw new Error('Publish on Windows so the official Authenticode signature can be verified.');
const file = resolve(source);
const sig = JSON.parse(execFileSync('pwsh.exe', ['-NoProfile', '-Command', "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:ECHO_MIRROR_SOURCE; @{status=$s.Status.ToString(); subject=$s.SignerCertificate.Subject} | ConvertTo-Json -Compress"], { env: { ...process.env, ECHO_MIRROR_SOURCE: file }, encoding: 'utf8' }));
if (sig.status !== 'Valid' || !/(?:^|, )CN=Inspect Element Ltd(?:,|$)/.test(sig.subject)) throw new Error('Expected a valid Inspect Element Ltd Authenticode signature.');
const bytes = await readFile(file);
if (bytes.length < 1024 * 1024 || bytes.length > 200 * 1024 * 1024 || bytes[0] !== 77 || bytes[1] !== 90) throw new Error('Unexpected executable size or format.');
const hash = b => createHash('sha256').update(b).digest('hex');
const sha256 = hash(bytes);
const tag = `echo-mirror-${sha256.slice(0,16)}`;
const repo = 'ShengCwC/Proxy-Download-of-Echo-Chinese-User';
const manifest = { sha256, size: bytes.length, publishedAt: new Date().toISOString(), signer: 'Inspect Element Ltd', url: `https://github.com/${repo}/releases/download/${tag}/echo.exe` };
await mkdir('.local/publish', { recursive: true });
await copyFile(file, '.local/publish/echo.exe');
await writeFile('.local/publish/SHA256SUMS', `${sha256}  echo.exe\n`);
await writeFile('.local/publish/notes.md', `Verified Echo Windows binary snapshot\n\nRetrieved through a real browser from the official builds.echo.ac/echo.exe download on ${manifest.publishedAt}. Authenticode: valid, Inspect Element Ltd.\n\nSHA-256: ${sha256}\nSize: ${bytes.length} bytes.\n\nThe binary is unchanged. No user PIN, filename, signed URL, browser cookie or account credential is included in these assets. This is a dated mirror snapshot, not a claim of automatic upstream freshness.\n`);
if (args.includes('--publish')) {
  execFileSync('gh', ['release', 'create', tag, '.local/publish/echo.exe', '.local/publish/SHA256SUMS', '--repo', repo, '--title', `Echo binary snapshot ${manifest.publishedAt.slice(0,10)}`, '--notes-file', '.local/publish/notes.md', '--latest=false'], { stdio: 'inherit' });
  const release = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/releases/tags/${tag}`], { encoding: 'utf8' }));
  const asset = release.assets.find(a => a.name === 'echo.exe');
  if (!asset || asset.size !== bytes.length || asset.digest !== `sha256:${sha256}`) throw new Error('Published asset digest does not match. Do not deploy.');
}
await writeFile('src/mirror-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ sha256, size: bytes.length, published: args.includes('--publish') }));
