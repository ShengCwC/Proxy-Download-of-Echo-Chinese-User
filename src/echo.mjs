export class DownloadError extends Error {
  constructor(code, message, status = 502, stage = 'entry') {
    super(message);
    Object.assign(this, { code, status, stage });
  }
}

const ENTRY_HOST = 'dl.echo.ac';
const FILE_HOST = 'builds.echo.ac';
const TOKEN = /^[A-Za-z0-9_-]{6,128}={0,2}$/;
const SIGNATURE_KEYS = new Set([
  'X-Amz-Algorithm', 'X-Amz-Checksum-Mode', 'X-Amz-Credential',
  'X-Amz-Date', 'X-Amz-Expires', 'X-Amz-SignedHeaders', 'X-Amz-Signature',
  'X-Amz-Security-Token', 'response-content-disposition', 'response-content-type', 'x-id',
]);

function fail(code, message, status = 400, stage) {
  throw new DownloadError(code, message, status, stage);
}

export function parseEntry(value) {
  if (typeof value !== 'string' || value.length > 512) fail('INVALID_LINK', '请输入完整的 Echo 下载链接。');
  const input = value.trim();
  let url;
  try { url = new URL(TOKEN.test(input) ? `https://${ENTRY_HOST}/${input}` : input); }
  catch { fail('INVALID_LINK', '链接格式不正确，请复制 Echo 的原始下载链接。'); }
  if (url.protocol !== 'https:' || url.hostname !== ENTRY_HOST || url.port || url.username || url.password || url.search || url.hash || !TOKEN.test(url.pathname.slice(1))) {
    fail('INVALID_LINK', '目前支持 https://dl.echo.ac/ 开头的 Echo 下载链接。');
  }
  return url.href;
}

export function parseSigned(value, now = Date.now(), minimumLifetime = 0, { metadataOnly = false } = {}) {
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n\x00]/.test(value)) fail('INVALID_FILE_LINK', '文件地址格式不正确。', 400, 'file');
  let url;
  try { url = new URL(value); } catch { fail('INVALID_FILE_LINK', '文件地址格式不正确。', 400, 'file'); }
  if (url.protocol !== 'https:' || url.hostname !== FILE_HOST || url.port || url.username || url.password || url.hash || url.pathname !== '/echo.exe') {
    fail('INVALID_FILE_LINK', '只接受 Echo 官方 builds.echo.ac/echo.exe 文件地址。', 400, 'file');
  }
  const p = url.searchParams;
  const keys = [...p.keys()];
  if (new Set(keys).size !== keys.length || keys.some(k => !SIGNATURE_KEYS.has(k))) fail('INVALID_FILE_LINK', '文件地址包含重复或不支持的参数。', 400, 'file');
  if (p.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' || p.get('X-Amz-SignedHeaders') !== 'host' || !/^[a-f0-9]{64}$/i.test(p.get('X-Amz-Signature') || '') || !p.get('X-Amz-Credential')) {
    fail('INVALID_FILE_LINK', '缺少完整的 Echo 文件签名，请重新复制下载地址。', 400, 'file');
  }
  const date = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(p.get('X-Amz-Date') || '');
  const seconds = p.get('X-Amz-Expires') || '';
  if (!date || !/^\d{1,6}$/.test(seconds) || +seconds < 1 || +seconds > 604800) fail('INVALID_FILE_LINK', '签名时间无效。', 400, 'file');
  const iso = `${date[1]}-${date[2]}-${date[3]}T${date[4]}:${date[5]}:${date[6]}Z`;
  const issued = Date.parse(iso);
  if (!Number.isFinite(issued) || new Date(issued).toISOString().slice(0, 19) !== iso.slice(0, 19) || issued > now + 60000) fail('INVALID_FILE_LINK', '签名时间无效。', 400, 'file');
  const expiresAt = issued + Number(seconds) * 1000;
  if (!metadataOnly && expiresAt <= now + minimumLifetime) fail('LINK_EXPIRED', '临时下载地址已过期或即将过期，请重新获取。', 410, 'file');
  const disposition = p.get('response-content-disposition') || '';
  const name = /^attachment;\s*filename="([A-Za-z0-9._-]{1,200}\.exe)"$/i.exec(disposition)?.[1];
  if (!name || name.includes('..')) fail('INVALID_FILENAME', '无法确认官方文件名，请重新获取下载链接。', 400, 'file');
  // Preserve the original query encoding. Parsing time/shape is not authorization:
  // every file request is forwarded to Echo, which verifies the actual signature.
  return { url: value, filename: name, expiresAt };
}

export function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (match, entity) => {
    const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const number = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : match;
  });
}

export function extractDownload(html) {
  for (const anchor of html.matchAll(/<a\b[^>]*>/gi)) {
    const attributes = new Map([...anchor[0].matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/gs)].map(m => [m[1].toLowerCase(), m[3]]));
    if (attributes.get('id') === 'dlURL' && attributes.has('href')) return decodeEntities(attributes.get('href'));
  }
  const assignment = /window\.location(?:\.href)?\s*=\s*("(?:\\.|[^"\\])*")/s.exec(html);
  if (assignment) {
    try { return JSON.parse(assignment[1]); } catch { /* Do not evaluate upstream JavaScript. */ }
  }
  fail('DOWNLOAD_NOT_FOUND', 'Echo 暂未提供有效文件地址。链接可能已失效，请在官方页面确认。', 422);
}

export async function readLimited(response, limit = 524288) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await readChunk(reader);
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); fail('UPSTREAM_TOO_LARGE', 'Echo 返回的页面异常，请稍后重试。', 502); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export function isChallenge(response, html = '') {
  return response.headers.get('cf-mitigated') === 'challenge' ||
    /<title>\s*(?:Just a moment|Attention Required|请稍候)/i.test(html) ||
    /(?:id=["']challenge-form|window\._cf_chl_opt|cf-chl-widget)/i.test(html);
}

function upstreamError(response, stage, html = '') {
  if (isChallenge(response, html)) fail('CF_CHALLENGE', stage === 'entry' ? 'Echo 要求浏览器验证。请打开官方页面完成验证，再带回临时文件地址。' : 'Echo 文件服务要求浏览器验证，当前加速线路无法读取文件。请使用官方直连下载。', 503, stage);
  if (response.status === 429) fail('UPSTREAM_RATE_LIMIT', 'Echo 请求较多，请稍后再试。', 429, stage);
  if ([401, 403].includes(response.status)) fail('UPSTREAM_DENIED', 'Echo 拒绝了此下载请求，签名可能已失效。请重新获取链接。', 403, stage);
  if (response.status === 404) fail('UPSTREAM_NOT_FOUND', 'Echo 未找到此下载链接或文件。', 404, stage);
  if (!response.ok) fail('UPSTREAM_ERROR', 'Echo 暂时无法提供下载，请稍后再试。', 502, stage);
}

export async function fetchUpstream(url, options, fetcher = fetch, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Origin response timeout')), 25000);
  try {
    const response = await fetcher(url, {
      ...options, redirect: 'manual', signal: controller.signal,
      eo: { timeoutSetting: { connectTimeout: 15000, readTimeout: 120000, writeTimeout: 15000 } },
    });
    if (!response.body) { signal?.removeEventListener('abort', abort); return response; }
    const reader = response.body.getReader();
    const clean = () => signal?.removeEventListener('abort', abort);
    return new Response(streamReader(reader, [], clean), { status: response.status, headers: response.headers });
  } catch (error) {
    signal?.removeEventListener('abort', abort);
    if (signal?.aborted) throw error;
    fail('UPSTREAM_UNREACHABLE', '暂时无法连接 Echo，请稍后重试。', 502, options.stage || 'entry');
  } finally { clearTimeout(timer); }
}

async function readChunk(reader) {
  let timer;
  try {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((_, reject) => { timer = setTimeout(() => { reader.cancel().catch(() => {}); reject(new DownloadError('UPSTREAM_TIMEOUT', 'Echo 传输超时，请重新下载。', 504, 'file')); }, 120000); }),
    ]);
    if (chunk.done) return chunk;
    // EdgeOne returns ArrayBuffer/string chunks as well as typed arrays.
    const value = chunk.value;
    if (typeof value === 'string') return { done: false, value: new TextEncoder().encode(value) };
    if (value instanceof ArrayBuffer) return { done: false, value: new Uint8Array(value) };
    if (ArrayBuffer.isView(value)) return { done: false, value: new Uint8Array(value.buffer, value.byteOffset, value.byteLength) };
    throw new DownloadError('INVALID_CHUNK', '上游返回了不支持的数据格式。', 502, 'file');
  } finally { clearTimeout(timer); }
}

function streamReader(reader, prefix = [], cleanup = () => {}) {
  // EdgeOne does not implement the ReadableStream constructor or custom
  // TransformStream transformers. An identity stream preserves backpressure.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  let finished = false;
  writer.closed.catch(async reason => {
    if (!finished) await reader.cancel(reason).catch(() => {});
  });
  void (async () => {
    try {
      for (const bytes of prefix) await writer.write(bytes);
      while (true) {
        const chunk = await readChunk(reader);
        if (chunk.done) break;
        await writer.write(chunk.value);
      }
      await writer.close();
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      await writer.abort(error).catch(() => {});
    } finally {
      finished = true;
      cleanup();
      reader.releaseLock();
      writer.releaseLock();
    }
  })();
  return readable;
}

export async function resolveEntry(input, { fetcher = fetch, now = Date.now(), signal } = {}) {
  const entry = parseEntry(input);
  let current = entry;
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetchUpstream(current, { headers: { Accept: 'text/html', 'Accept-Encoding': 'identity' } }, fetcher, signal);
    if (isChallenge(response)) { await response.body?.cancel(); upstreamError(response, 'entry'); }
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      const next = new URL(response.headers.get('location'), current).href;
      await response.body?.cancel();
      if (new URL(next).hostname === FILE_HOST) return { ...parseSigned(next, now, 5000), entry };
      current = parseEntry(next);
      continue;
    }
    const html = await readLimited(response);
    upstreamError(response, 'entry', html);
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html')) fail('UNEXPECTED_PAGE', 'Echo 下载页面格式已变化，请使用官方页面获取文件地址。', 502);
    return { ...parseSigned(extractDownload(html), now, 5000), entry };
  }
  fail('TOO_MANY_REDIRECTS', 'Echo 页面跳转过多，请稍后重试。', 502);
}

export function encodeTicket(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeTicket(value) {
  if (!value || value.length > 7000 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('INVALID_TICKET', '下载地址无效，请返回首页重新获取。');
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
    if (!data || typeof data.url !== 'string' || (data.entry !== undefined && typeof data.entry !== 'string')) throw new Error();
    if (data.entry) parseEntry(data.entry);
    return data;
  } catch { fail('INVALID_TICKET', '下载地址无效，请返回首页重新获取。'); }
}

export function validateRange(value) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || (match[1] && !Number.isSafeInteger(Number(match[1]))) || (match[2] && !Number.isSafeInteger(Number(match[2]))) || (match[1] && match[2] && Number(match[1]) > Number(match[2])) || (!match[1] && Number(match[2]) === 0)) {
    fail('INVALID_RANGE', '不支持此分段下载请求，请重新下载。', 400, 'file');
  }
  return value;
}

export async function downloadFile(data, request, { fetcher = fetch, now = Date.now(), signal } = {}) {
  const signed = parseSigned(data.url, now);
  const range = validateRange(request.headers.get('range'));
  const headers = { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' };
  if (range) headers.Range = range;
  const ifRange = request.headers.get('if-range');
  if (ifRange && range && ifRange.length <= 256) headers['If-Range'] = ifRange;
  // A GET presign cannot safely be used as HEAD. GET a small range for metadata.
  if (request.method === 'HEAD') headers.Range = 'bytes=0-0';
  const response = await fetchUpstream(signed.url, { method: 'GET', headers, stage: 'file' }, fetcher, signal);
  const type = response.headers.get('content-type') || '';
  if (isChallenge(response)) { await response.body?.cancel(); upstreamError(response, 'file'); }
  if (response.status === 416) {
    await response.body?.cancel();
    const contentRange = response.headers.get('content-range');
    return new Response(null, { status: 416, headers: contentRange && /^bytes \*\/\d+$/.test(contentRange) ? { 'Content-Range': contentRange } : {} });
  }
  if (![200, 206].includes(response.status) || /(?:text\/|json|xml|html)/i.test(type)) {
    const body = await readLimited(response);
    upstreamError(response, 'file', body);
    fail('NOT_A_FILE', 'Echo 返回了网页而非安装程序，已停止下载。', 502, 'file');
  }
  if (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity') {
    await response.body?.cancel(); fail('UNEXPECTED_ENCODING', '上游返回了不支持的文件编码，请使用官方直连。', 502, 'file');
  }
  const contentRange = response.headers.get('content-range');
  if (response.status === 206 && (!contentRange || !/^bytes \d+-\d+\/\d+$/.test(contentRange) || (!range && request.method !== 'HEAD'))) {
    await response.body?.cancel();
    fail('INVALID_PARTIAL_RESPONSE', 'Echo 返回的文件分段信息异常，请重新下载。', 502, 'file');
  }
  if (response.status === 206) {
    const [, start, end, total] = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange).map(Number);
    const requested = /^bytes=(\d*)-(\d*)$/.exec(headers.Range);
    const expectedStart = requested[1] ? Number(requested[1]) : Math.max(0, total - Number(requested[2]));
    const expectedEnd = requested[1] ? (requested[2] ? Math.min(Number(requested[2]), total - 1) : total - 1) : total - 1;
    if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total || start !== expectedStart || end !== expectedEnd || (response.headers.has('content-length') && Number(response.headers.get('content-length')) !== end - start + 1)) {
      await response.body?.cancel(); fail('INVALID_PARTIAL_RESPONSE', 'Echo 返回的文件分段与请求不一致，请重新下载。', 502, 'file');
    }
  }
  const out = new Headers({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${signed.filename}"` });
  for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    if (response.headers.has(name)) out.set(name, response.headers.get(name));
  }
  if (request.method === 'HEAD') {
    await response.body?.cancel();
    out.delete('content-range');
    if (response.status === 206) out.set('content-length', contentRange.split('/')[1]);
    return new Response(null, { status: 200, headers: out });
  }
  if (!response.body) fail('EMPTY_FILE', 'Echo 返回了空文件，请重新尝试。', 502, 'file');
  // Reject HTML/error bodies mislabeled as binary. Partial ranges starting in
  // the middle cannot carry the PE prefix and rely on status/range validation.
  const startsAtZero = response.status === 200 || contentRange?.startsWith('bytes 0-');
  let body = response.body;
  if (startsAtZero) {
    const reader = body.getReader();
    const prefix = [];
    let size = 0;
    while (size < 2) {
      const chunk = await readChunk(reader);
      if (chunk.done) break;
      prefix.push(chunk.value); size += chunk.value.length;
    }
    const first = prefix[0]?.[0];
    const second = prefix[0]?.length > 1 ? prefix[0][1] : prefix[1]?.[0];
    const requestedOneByte = response.status === 206 && /^bytes 0-0\//.test(contentRange);
    if (first !== 77 || (!requestedOneByte && second !== 90)) {
      await reader.cancel(); fail('NOT_A_FILE', '返回内容不是有效的 Windows 程序，已停止下载。', 502, 'file');
    }
    body = streamReader(reader, prefix);
  }
  return new Response(body, { status: response.status, headers: out });
}
