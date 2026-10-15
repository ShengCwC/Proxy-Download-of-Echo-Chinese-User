const $ = id => document.getElementById(id);
let currentEntry = '';
let expiresAt = 0;
let busy = false;
let countdown;
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
    const response = await fetch(imported ? '/api/import' : '/api/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: input, ...(imported && currentEntry ? { entry: currentEntry } : {}) }),
    });
    const result = await response.json();
    if (!response.ok) {
      status(result.message || '暂时无法获取下载地址，请稍后重试。', 'error');
      if (result.code === 'CF_CHALLENGE') $('assist').open = result.stage !== 'file';
      if (result.code === 'DOWNLOAD_NOT_FOUND') $('assist').open = true;
      return;
    }
    if (result.entry) setEntry(result.entry);
    $('filename').textContent = result.filename;
    $('download').href = result.download;
    $('download').removeAttribute('aria-disabled');
    $('copy-link').hidden = !currentEntry;
    expiresAt = result.expiresAt;
    $('ready').hidden = false;
    $('signed-url').value = '';
    status('');
    updateExpiry();
    countdown = setInterval(updateExpiry, 1000);
  } catch {
    status('网络连接中断，请检查网络后重新获取。', 'error');
  } finally { setBusy(false); }
}

$('resolve-form').addEventListener('submit', event => { event.preventDefault(); prepare($('entry').value.trim()); });
$('import-form').addEventListener('submit', event => { event.preventDefault(); prepare($('signed-url').value.trim(), true); });
$('retry').addEventListener('click', () => { if (currentEntry) prepare(currentEntry); });
$('download').addEventListener('click', event => {
  if (Date.now() >= expiresAt) {
    event.preventDefault();
    if (currentEntry) prepare(currentEntry);
    else { status('地址已过期，请回到官方页面获取新的文件地址。', 'error'); $('assist').open = true; }
  }
});
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
