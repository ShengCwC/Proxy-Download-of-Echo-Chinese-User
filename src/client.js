import { downloadVerified } from '/transfer.js';
const $ = id => document.getElementById(id);
let task;
$('year').textContent = new Date().getFullYear();
function status(message, kind = '') { $('status').hidden = !message; $('status').className = `status ${kind}`; $('status').textContent = message; }
const errors = {
  VERSION_CHANGED: '官方文件在下载过程中更新了。已停止保存，请复制新的完整地址后重新下载。',
  LINK_EXPIRED: '链接已过期，请回到官方页面复制新的 builds 地址。',
  UPSTREAM_DENIED: '官方拒绝了此链接，请复制新的完整地址。',
  CF_CHALLENGE: '官方文件服务要求额外验证。本次未取得文件，也没有使用旧快照替代。',
  ORIGIN_BUSY: '下载线路繁忙，请稍后重试。',
};
async function download(input) {
  if (task) return;
  task = new AbortController();
  const controller = task;
  $('download-button').disabled = true;
  $('ready').hidden = true;
  $('transfer').hidden = false;
  $('transfer-cancel').hidden = false;
  $('transfer-progress').value = 0;
  $('transfer-message').textContent = '正在连接官方文件源…';
  $('fallback-links').hidden = true;
  status('');
  try {
    const target = new URL(input);
    if (target.origin !== 'https://builds.echo.ac' || target.pathname !== '/echo.exe') throw new Error('INVALID_SOURCE');
    $('original').href = input;
    $('fallback-links').hidden = false;
    const prepared = await fetch('/api/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: input }), signal: controller.signal });
    const info = await prepared.json();
    if (!prepared.ok) { status(info.message || '无法读取官方文件，请重新获取链接。', 'error'); return; }
    $('ready').hidden = false;
    $('filename').textContent = info.filename;
    $('version').textContent = `官方版本标识：${info.etag}`;
    $('checked-at').textContent = `本次回源：${new Date(info.checkedAt).toLocaleString()} · ${(info.size / 1048576).toFixed(1)} MiB`;
    $('digest').textContent = '下载完成后显示本次文件 SHA-256。';
    let digest;
    let lastUpdate = 0;
    const blob = await downloadVerified({ url: info.download, sourceUrl: input, size: info.size, etag: info.etag, signal: controller.signal, onDigest(value) { digest = value; }, onProgress(received, total, phase) {
      if (performance.now() - lastUpdate < 100 && received !== total) return;
      lastUpdate = performance.now();
      const percent = Math.floor(received / total * 100);
      $('transfer-progress').value = percent;
      $('transfer-message').textContent = phase === 'verifying' ? '文件已接收，正在计算本次文件指纹…' : `正在实时下载 ${percent}% · ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB`;
    } });
    const objectUrl = URL.createObjectURL(blob);
    const save = document.createElement('a');
    save.href = objectUrl; save.download = info.filename; document.body.append(save); save.click(); save.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    $('digest').textContent = digest;
    $('transfer-message').textContent = '下载完成，所有分段版本一致，已交给浏览器保存。';
    status('已取得本次官方链接对应的文件。请保留完整文件名。');
    $('signed-url').value = '';
    $('fallback-links').hidden = true;
    $('original').removeAttribute('href');
  } catch (error) {
    status(controller.signal.aborted ? '下载已取消。' : error.message === 'INVALID_SOURCE' ? '请粘贴完整的 https://builds.echo.ac/echo.exe?… 地址，包含问号后的所有参数。' : errors[error.message] || '下载中断，未保存不完整文件。请获取新的官方地址后重试。', 'error');
  } finally {
    if ($('status').classList.contains('error') || !$('status').textContent) $('transfer-message').textContent = '本次下载未完成。';
    $('download-button').disabled = false;
    $('transfer-cancel').hidden = true;
    task = undefined;
  }
}
$('download-form').addEventListener('submit', event => { event.preventDefault(); download($('signed-url').value.trim()); });
$('transfer-cancel').addEventListener('click', () => task?.abort());
// Optional return bookmark passes the signed URL in the fragment, never a query.
if (location.hash.startsWith('#import=')) {
  const input = new URLSearchParams(location.hash.slice(1)).get('import');
  history.replaceState(null, '', '/');
  $('signed-url').value = input || '';
  if (input) download(input);
}
