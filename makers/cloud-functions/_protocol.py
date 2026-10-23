"""Strict shared contract for the private live-origin endpoint."""
from datetime import datetime, timezone
from urllib.parse import urlsplit, parse_qsl
import re
import time

MAX_SIZE = 200 * 1024 * 1024
CHUNK_SIZE = 4 * 1024 * 1024
ETAG = r'"[\x21\x23-\x7e]{1,200}"'
KEYS = {'X-Amz-Algorithm', 'X-Amz-Checksum-Mode', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Expires', 'X-Amz-SignedHeaders', 'X-Amz-Signature', 'X-Amz-Security-Token', 'response-content-disposition', 'response-content-type', 'x-id'}


class DownloadError(Exception):
    def __init__(self, code, status=400):
        self.code, self.status = code, status


def validate_entry(url):
    if not isinstance(url, str) or len(url) > 512:
        raise DownloadError('INVALID_LINK')
    target = urlsplit(url)
    if target.scheme != 'https' or target.netloc != 'dl.echo.ac' or target.query or target.fragment or not re.fullmatch(r'/[A-Za-z0-9_-]{6,128}={0,2}', target.path):
        raise DownloadError('INVALID_LINK')
    return url


def validate(data, now=None):
    now = time.time() if now is None else now
    if not isinstance(data, dict):
        raise DownloadError('INVALID_BODY')
    url = data.get('url')
    if not isinstance(url, str) or len(url) > 4096 or re.search(r'[\r\n\x00]', url):
        raise DownloadError('INVALID_FILE_LINK')
    target = urlsplit(url)
    if target.scheme != 'https' or target.netloc != 'builds.echo.ac' or target.path != '/echo.exe' or target.fragment:
        raise DownloadError('INVALID_FILE_LINK')
    pairs = parse_qsl(target.query, keep_blank_values=True)
    params = dict(pairs)
    if len(pairs) != len(params) or set(params) - KEYS:
        raise DownloadError('INVALID_FILE_LINK')
    if params.get('X-Amz-Algorithm') != 'AWS4-HMAC-SHA256' or params.get('X-Amz-SignedHeaders') != 'host' or not re.fullmatch('[a-fA-F0-9]{64}', params.get('X-Amz-Signature', '')) or not params.get('X-Amz-Credential'):
        raise DownloadError('INVALID_FILE_LINK')
    try:
        date = params['X-Amz-Date']
        seconds = params['X-Amz-Expires']
        if not re.fullmatch(r'\d{8}T\d{6}Z', date) or not re.fullmatch(r'\d{1,6}', seconds) or not 1 <= int(seconds) <= 604800:
            raise ValueError()
        issued = datetime.strptime(date, '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc).timestamp()
        if issued > now + 60:
            raise ValueError()
    except (KeyError, ValueError, OverflowError):
        raise DownloadError('INVALID_FILE_LINK')
    if issued + int(seconds) <= now:
        raise DownloadError('LINK_EXPIRED', 410)
    filename = re.fullmatch(r'attachment;\s*filename="([A-Za-z0-9._-]{1,200}\.exe)"', params.get('response-content-disposition', ''), re.I)
    if not filename or '..' in filename[1]:
        raise DownloadError('INVALID_FILENAME')
    start, end, etag, size = (data.get(name) for name in ['start', 'end', 'etag', 'size'])
    if type(start) is not int or type(end) is not int or not 0 <= start <= end < MAX_SIZE or end - start + 1 > CHUNK_SIZE:
        raise DownloadError('INVALID_RANGE')
    if etag is None:
        if start != 0 or end != 31:
            raise DownloadError('VERSION_REQUIRED')
    elif not isinstance(etag, str) or not re.fullmatch(ETAG, etag) or type(size) is not int or not 32 <= size <= MAX_SIZE or end >= size:
        raise DownloadError('INVALID_VERSION')
    return data


def inspect(status, headers, data):
    if headers.get('cf-mitigated') == 'challenge':
        raise DownloadError('CF_CHALLENGE', 503)
    if status == 412:
        raise DownloadError('VERSION_CHANGED', 409)
    if status in (401, 403):
        raise DownloadError('UPSTREAM_DENIED', 410)
    if status == 429:
        raise DownloadError('UPSTREAM_RATE_LIMIT', 429)
    match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', headers.get('content-range', ''))
    etag = headers.get('etag', '')
    if status != 206 or not match or int(match[1]) != data['start'] or int(match[2]) != data['end'] or not max(32, data['end']+1) <= int(match[3]) <= MAX_SIZE or not re.fullmatch(ETAG, etag) or not re.match(r'application/(octet-stream|x-msdownload|vnd\.microsoft\.portable-executable)(;|$)', headers.get('content-type', ''), re.I) or headers.get('content-encoding', 'identity') != 'identity':
        raise DownloadError('INVALID_FILE_RESPONSE', 502)
    if headers.get('content-length') is not None and headers['content-length'] != str(data['end']-data['start']+1):
        raise DownloadError('INVALID_FILE_RESPONSE', 502)
    if data.get('etag') and (data['etag'] != etag or data['size'] != int(match[3])):
        raise DownloadError('VERSION_CHANGED', 409)
