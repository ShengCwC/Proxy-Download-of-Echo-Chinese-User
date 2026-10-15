import { DownloadError, parseSigned } from './echo.mjs';

export const CHUNK_SIZE = 4 * 1024 * 1024;
export const MAX_SIZE = 200 * 1024 * 1024;
export const strongEtag = value => typeof value === 'string' && /^"[\x21\x23-\x7e]{1,200}"$/.test(value);
export function liveError(code, message, status = 502) { return new DownloadError(code, message, status, 'file'); }

export function validateRead(input, now = Date.now()) {
  const source = parseSigned(input?.url, now);
  const { start, end, etag, size } = input;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= MAX_SIZE || end - start + 1 > CHUNK_SIZE) throw liveError('INVALID_RANGE', '下载分段范围无效。', 400);
  if (etag !== undefined && (!strongEtag(etag) || !Number.isSafeInteger(size) || size < 32 || size > MAX_SIZE || end >= size)) throw liveError('INVALID_VERSION', '文件版本信息无效，请重新提交地址。', 400);
  if (etag === undefined && (start !== 0 || end !== 31)) throw liveError('VERSION_REQUIRED', '请先确认官方当前版本。', 400);
  return { ...source, start, end, etag, size };
}

export function inspectRange(status, headers, input) {
  const h = headers instanceof Headers ? headers : new Headers(headers);
  if (h.get('cf-mitigated') === 'challenge') throw liveError('CF_CHALLENGE', '官方文件服务要求额外验证，未使用旧文件替代。请稍后重新获取官方链接。', 503);
  if (status === 412) throw liveError('VERSION_CHANGED', '下载期间官方文件已更新，请获取新链接后重新下载。', 409);
  if ([401, 403].includes(status)) throw liveError('UPSTREAM_DENIED', '官方已拒绝此链接，请获取新的完整下载地址。', 410);
  if (status === 429) throw liveError('UPSTREAM_RATE_LIMIT', '官方请求较多，请稍后重试。', 429);
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(h.get('content-range') || '');
  const size = range ? Number(range[3]) : 0;
  const etag = h.get('etag');
  if (status !== 206 || !range || Number(range[1]) !== input.start || Number(range[2]) !== input.end || size <= input.end || size > MAX_SIZE || size < 32 || !strongEtag(etag) || !/^application\/(octet-stream|x-msdownload|vnd\.microsoft\.portable-executable)(;|$)/i.test(h.get('content-type') || '') || (h.has('content-encoding') && h.get('content-encoding') !== 'identity')) throw liveError('INVALID_FILE_RESPONSE', '官方返回的文件数据不符合预期，下载已停止。');
  if ((h.has('content-length') && Number(h.get('content-length')) !== input.end - input.start + 1)) throw liveError('INVALID_FILE_RESPONSE', '下载分段长度不正确。');
  if (input.etag !== undefined && (etag !== input.etag || size !== input.size)) throw liveError('VERSION_CHANGED', '下载期间官方文件已更新，请重新获取链接。', 409);
  return { size, etag, lastModified: h.get('last-modified') };
}
