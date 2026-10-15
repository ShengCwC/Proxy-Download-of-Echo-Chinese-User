import { downloadVerified } from '/transfer.js';
const $ = id => document.getElementById(id);
let currentEntry = '';
let expiresAt = 0;
let mirrorMode = false;
let busy = false;
let countdown;
let transferController;
$('year').textContent = new Date().getFullYear();

function status(message, kind = '') {
  $('status').hidden = !message;
  $('status').className = `status ${kind}`;
  $('status').textContent = message;
}

function setBusy(value) {
  busy = value;
  $('resolve-button').disabled = value;
  $('import-button').disabled = value;
  $('retry').disabled = value;
}

function setEntry(value) {
  try {
    const u = new URL(value);
    if (u.origin !== 'https://dl.echo.ac' || u.search || u.hash || !/^\/[A-Za-z0-9_-]{6,128}={0,2}$/.test(u.pathname)) return;
    currentEntry = u.href;
    $('entry').value = currentEntry;
    $('original').href = currentEntry;
    $('fallback-links').hidden = false;
  } catch { /* Backend reports invalid input. */ }
}

function updateExpiry() {
  if (mirrorMode) return;
  const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  $('expiry').textContent = remaining ? `临时地址剩余约 ${remaining} 秒，请及时开始下载。` : '临时地址已过期，请重新获取。';
  if (!remaining) {
    $('download').removeAttribute('href');
    $('download').setAttribute('aria-disabled', 'true');
    clearInterval(countdown);
  }
}

async function prepare(input, imported = false) {
  if (busy) return;
  setBusy(true);
  $('ready').hidden = true;
  clearInterval(countdown);
  status(imported ? '正在检查临时下载地址…' : '正在连接 Echo，获取新的下载地址…', 'busy');
  if (!imported) {
    currentEntry = '';
    $('fallback-links').hidden = true;
    setEntry(input);
  }
  try {
    const response = await fetch('/api/mirror', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: input, ...(imported && currentEntry ? { entry: currentEntry } : {}) }),
    });
    const result = await response.json();
    if (!response.ok) {
      status(result.message || '暂时无法获取下载地址，请稍后重试。', 'error');
      if (result.code === 'CF_CHALLENGE') {
        $('assist').open = true;
        status('Echo 要求浏览器验证。请打开官方页面并复制 click here 的链接，本站即可读取专属文件名并下载镜像。也可以直接下载左侧的通用镜像文件。', 'error');
      }
      if (result.code === 'DOWNLOAD_NOT_FOUND') $('assist').open = true;
      return;
    }
    if (result.entry) setEntry(result.entry);
    $('filename').textContent = result.filename;
    $('download').href = result.download;
    $('download').dataset.size = result.size;
    $('download').dataset.sha256 = result.sha256;
    $('download').dataset.filename = result.filename;
    $('download').removeAttribute('aria-disabled');
    $('copy-link').hidden = !currentEntry;
    expiresAt = result.expiresAt;
    mirrorMode = result.delivery === 'mirror';
    $('ready').hidden = false;
    $('signed-url').value = '';
    status('');
    if (mirrorMode) $('expiry').textContent = `已校验镜像 · ${result.snapshot.slice(0, 10)} 同步 · ${(result.size / 1048576).toFixed(1)} MiB。文件名取自官方地址，镜像不受原地址两分钟时效限制。`;
    else { updateExpiry(); countdown = setInterval(updateExpiry, 1000); }
  } catch {
    status('网络连接中断，请检查网络后重新获取。', 'error');
  } finally { setBusy(false); }
}

$('resolve-form').addEventListener('submit', event => { event.preventDefault(); prepare($('entry').value.trim()); });
$('import-form').addEventListener('submit', event => { event.preventDefault(); prepare($('signed-url').value.trim(), true); });
$('retry').addEventListener('click', () => { if (currentEntry) prepare(currentEntry); });
$('download').addEventListener('click', event => {
  if (mirrorMode) { acceleratedDownload(event); return; }
  if (!mirrorMode && Date.now() >= expiresAt) {
    event.preventDefault();
    if (currentEntry) prepare(currentEntry);
    else { status('地址已过期，请回到官方页面获取新的文件地址。', 'error'); $('assist').open = true; }
  }
});

async function acceleratedDownload(event) {
  if (!globalThis.crypto?.subtle || !globalThis.ReadableStream || !globalThis.AbortController) return;
  event.preventDefault();
  if (transferController) return;
  const link = event.currentTarget;
  const target = link.href;
  const name = link.dataset.filename || 'echo.exe';
  const size = Number(link.dataset.size);
  const sha256 = link.dataset.sha256;
  transferController = new AbortController();
  const task = transferController;
  $('transfer').hidden = false;
  $('transfer-cancel').hidden = false;
  $('transfer-direct').href = target;
  $('transfer-direct').hidden = true;
  $('transfer-progress').value = 0;
  $('transfer-message').textContent = '正在准备加速下载…';
  for (const id of ['generic-download', 'download']) $(id).setAttribute('aria-disabled', 'true');
  let lastUpdate = 0;
  try {
    const blob = await downloadVerified({ url: target, size, sha256, signal: task.signal, onProgress(received, total, phase) {
      if (performance.now() - lastUpdate < 100 && received !== total) return;
      lastUpdate = performance.now();
      const percent = Math.floor(received / total * 100);
      $('transfer-progress').value = percent;
      $('transfer-message').textContent = phase === 'verifying' ? '文件已接收，正在校验完整性…' : `正在加速下载 ${percent}% · ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB`;
    } });
    const objectUrl = URL.createObjectURL(blob);
    const save = document.createElement('a');
    save.href = objectUrl; save.download = name; document.body.append(save); save.click(); save.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    $('transfer-message').textContent = '下载与哈希校验完成，已交给浏览器保存。请保留官方文件名。';
  } catch (error) {
    $('transfer-message').textContent = task.signal.aborted ? '下载已取消。' : error.message === 'HASH_MISMATCH' ? '文件哈希不一致，已阻止保存。请使用官方直连。' : '并行下载中断，可重试或使用浏览器直接下载。';
    $('transfer-direct').hidden = task.signal.aborted || error.message === 'HASH_MISMATCH';
  } finally {
    $('transfer-cancel').hidden = true;
    transferController = null;
    for (const id of ['generic-download', 'download']) $(id).removeAttribute('aria-disabled');
  }
}
$('generic-download').addEventListener('click', acceleratedDownload);
$('transfer-cancel').addEventListener('click', () => transferController?.abort());
$('copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.origin + new URL(currentEntry).pathname);
    $('copy-link').textContent = '已复制加速入口';
  } catch { status('浏览器未允许复制。你可以将原链接的域名替换为本站域名。'); }
});

// Runs only when a user explicitly invokes their bookmark on the Echo page.
// Reads the visible download link; it never reads cookies or solves challenges.
const returnBase = location.origin;
const bookmarkCode = `(function(){if(location.hostname!=='dl.echo.ac'){alert('请在 Echo 官方下载页面使用此书签。');return;}var a=document.getElementById('dlURL');if(!a||!a.href){alert('请先完成官方页面验证，等待 click here 下载链接出现。');return;}location.href=${JSON.stringify(returnBase + '/')}+'#import='+encodeURIComponent(a.href)+'&entry='+encodeURIComponent(location.href);})();`;
$('bookmark').href = 'javascript:' + encodeURIComponent(bookmarkCode);
$('bookmark').addEventListener('click', event => { event.preventDefault(); status('请将“带回 Echo 下载地址”拖到书签栏，再到 Echo 官方下载页面点击该书签。'); });

if (location.hash.startsWith('#import=')) {
  const values = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname);
  if (values.get('entry')) setEntry(values.get('entry'));
  prepare(values.get('import') || '', true);
} else if (location.pathname !== '/' && /^\/[A-Za-z0-9_-]{6,128}={0,2}$/.test(location.pathname)) {
  setEntry('https://dl.echo.ac' + location.pathname);
  prepare(currentEntry);
}
