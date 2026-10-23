import { downloadVerified, prepareVerified } from '/transfer.js';
const $ = id => document.getElementById(id);
let task;
let pending;
$('year').textContent = new Date().getFullYear();
function status(message, kind = '') { $('status').hidden = !message; $('status').className = `status ${kind}`; $('status').textContent = message; }
const errors = {
  VERSION_CHANGED: '官方文件在下载过程中更新了。已停止保存，请复制新的完整地址后重新下载。',
  LINK_EXPIRED: '链接已过期，请回到官方页面复制新的 builds 地址。',
  UPSTREAM_DENIED: '官方拒绝了此链接，请复制新的完整地址。',
  CF_CHALLENGE: '官方文件服务要求额外验证。本次未取得文件，也没有使用旧快照替代。',
  ORIGIN_BUSY: '下载线路繁忙，请稍后重试。',
  ORIGIN_UNREACHABLE: '下载线路暂时无法连接，自动重试后仍未恢复。请稍后重新获取链接再试。',
  UPSTREAM_UNREACHABLE: '暂时无法连接官方文件源，请稍后重新获取链接再试。',
  UPSTREAM_TIMEOUT: '下载线路持续超时，自动重试后仍未恢复。请重新获取链接再试。',
  UPSTREAM_RATE_LIMIT: '官方暂时限制了请求频率，请稍后重新获取链接再试。',
  DOWNLOAD_TIMEOUT: '本次下载用时过长，请重新获取官方链接后重试。',
  INVALID_RANGE_RESPONSE: '下载线路返回的分段信息不正确，已停止保存。请重新获取链接后重试。',
  INCOMPLETE_RANGE: '下载分段多次传输不完整，已停止保存。请重新获取链接后重试。',
  HASH_MISMATCH: '文件完整性校验未通过，已停止保存。请重新下载。',
};
async function download(input) {
  if (task) return;
  task = new AbortController();
  const controller = task;
  $('download-button').disabled = true;
  $('ready').hidden = !pending;
  $('transfer').hidden = false;
  $('transfer-cancel').hidden = false;
  $('transfer-cancel').textContent = '取消';
  $('transfer-progress').value = pending ? Math.floor(pending.received / pending.size * 100) : 0;
  $('transfer-message').textContent = '正在连接官方文件源…';
  $('fallback-links').hidden = true;
  status('');
  try {
    const target = new URL(input);
    const entry = target.origin === 'https://dl.echo.ac';
    if (!entry && (target.origin !== 'https://builds.echo.ac' || target.pathname !== '/echo.exe')) throw new Error('INVALID_SOURCE');
    $('original').href = input;
    $('fallback-links').hidden = false;
    const prepare = () => prepareVerified({ sourceUrl: input, signal: controller.signal, onRetry() {
      $('transfer-message').textContent = '连接暂时中断，正在重新确认官方文件…';
    } });
    let info = await prepare();
    // A fresh signed link must independently confirm the exact same live object.
    // Use its filename when continuing, since Echo may change the name per link.
    let resume = pending?.etag === info.etag && pending?.size === info.size ? pending : undefined;
    pending = undefined;
    if (!resume) $('transfer-progress').value = 0;
    $('ready').hidden = false;
    $('filename').textContent = info.filename;
    $('version').textContent = `官方版本标识：${info.etag}`;
    $('checked-at').textContent = `本次回源：${new Date(info.checkedAt).toLocaleString()} · ${(info.size / 1048576).toFixed(1)} MiB`;
    $('digest').textContent = '下载完成后显示本次文件 SHA-256。';
    let digest;
    let lastUpdate = 0;
    let recovering = false;
    let blob;
    for (let renewals = 0; ; renewals++) {
      try {
        blob = await downloadVerified({ url: info.download, sourceUrl: info.sourceUrl || input, size: info.size, etag: info.etag, expiresInMs: info.expiresInMs, resume, signal: controller.signal, onDigest(value) { digest = value; }, onRetry() {
      recovering = true;
      status('连接短暂中断，正在自动补取失败部分。已完成的分段会保留。');
    }, onProgress(received, total, phase) {
      if (recovering) { status(''); recovering = false; }
      if (performance.now() - lastUpdate < 100 && received !== total) return;
      lastUpdate = performance.now();
      const percent = Math.floor(received / total * 100);
      $('transfer-progress').value = percent;
      $('transfer-message').textContent = phase === 'verifying' ? '文件已接收，正在计算本次文件指纹…' : `正在实时下载 ${percent}% · ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB`;
        } });
        break;
      } catch (error) {
        if (!entry || error.message !== 'LINK_EXPIRED' || controller.signal.aborted || renewals >= 3) throw error;
        resume = error.resume;
        status('正在获取新的官方签名，接续已完成的分段…');
        let renewed;
        try { renewed = await prepare(); }
        catch (failure) { failure.resume = resume; throw failure; }
        if (renewed.etag !== info.etag || renewed.size !== info.size) throw new Error('VERSION_CHANGED');
        info = renewed;
        $('filename').textContent = info.filename;
        $('checked-at').textContent = `本次回源：${new Date(info.checkedAt).toLocaleString()} · ${(info.size / 1048576).toFixed(1)} MiB`;
        status('');
      }
    }
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
    if (controller.signal.aborted || ['VERSION_CHANGED', 'UPSTREAM_DENIED', 'CF_CHALLENGE'].includes(error.message)) pending = undefined;
    else if (error.resume) pending = error.resume;
    status(controller.signal.aborted ? '下载已取消。' : pending ? `下载已暂停，已保留 ${Math.floor(pending.received / pending.size * 100)}% 的已校验内容。请粘贴有效的官方地址，点击“继续下载”。保持此页面打开。` : error.message === 'INVALID_SOURCE' ? '请粘贴完整的 https://dl.echo.ac/… 下载入口，或包含全部参数的 https://builds.echo.ac/echo.exe?… 文件地址。' : errors[error.message] || '下载中断，未保存不完整文件。请获取新的官方地址后重试。', 'error');
  } finally {
    if ($('status').classList.contains('error') || !$('status').textContent) $('transfer-message').textContent = pending ? '下载已暂停，已完成的分段保留在此页面。' : '本次下载未完成。';
    $('download-button').disabled = false;
    $('download-button').querySelector('span').textContent = pending ? '继续下载' : '实时加速下载';
    $('transfer-cancel').hidden = !pending;
    $('transfer-cancel').textContent = pending ? '放弃' : '取消';
    task = undefined;
  }
}
$('download-form').addEventListener('submit', event => { event.preventDefault(); download($('signed-url').value.trim()); });
$('transfer-cancel').addEventListener('click', () => {
  if (task) { task.abort(); return; }
  pending = undefined;
  $('transfer-cancel').hidden = true;
  $('download-button').querySelector('span').textContent = '实时加速下载';
  $('transfer-message').textContent = '下载已取消。';
  status('下载已取消。');
});
// Optional return bookmark passes the signed URL in the fragment, never a query.
if (location.hash.startsWith('#import=')) {
  const input = new URLSearchParams(location.hash.slice(1)).get('import');
  history.replaceState(null, '', '/');
  $('signed-url').value = input || '';
  if (input) download(input);
}
