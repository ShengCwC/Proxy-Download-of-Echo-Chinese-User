from http.server import BaseHTTPRequestHandler
import hmac
import base64
import json
import os
import re
from curl_cffi import requests
from _protocol import validate, validate_entry, inspect, DownloadError


def resolve_entry(url):
    url = validate_entry(url)
    body = bytearray()

    def receive(block):
        if len(body) + len(block) > 65536:
            return 0
        body.extend(block)
        return len(block)

    with requests.Session(impersonate='chrome') as session:
        # This is the same JSON signing endpoint used by Echo's download page.
        # No account cookies are accepted or copied, and redirects are forbidden.
        response = session.get(url + '?platform=windows',
                               headers={'X-Requested-With': 'XMLHttpRequest'},
                               timeout=(8, 20), allow_redirects=False,
                               content_callback=receive)
        if response.headers.get('cf-mitigated') == 'challenge':
            raise DownloadError('CF_CHALLENGE', 503)
        if response.status_code in (401, 403, 404):
            raise DownloadError('UPSTREAM_DENIED', 410)
        if response.status_code == 429:
            raise DownloadError('UPSTREAM_RATE_LIMIT', 429)
        if response.status_code != 200 or not response.headers.get('content-type', '').startswith('application/json'):
            raise DownloadError('ORIGIN_UNREACHABLE', 503)
        try:
            signed = json.loads(body)['url']
        except (ValueError, TypeError, KeyError):
            raise DownloadError('ORIGIN_UNREACHABLE', 503)
        validate({'url': signed, 'start': 0, 'end': 31})
        return signed


def fetch_part(data):
    start, end = data['start'], data['end']
    expected = end-start+1
    headers = {'Range': f'bytes={start}-{end}', 'Accept-Encoding': 'identity'}
    if data.get('etag'):
        headers['If-Match'] = data['etag']
    body = bytearray()
    overflow = False

    def receive(block):
        nonlocal overflow
        # Allow a small error response so inspect() can identify 403/412/429.
        if len(body) + len(block) > max(expected, 65536):
            overflow = True
            return 0
        body.extend(block)
        return len(block)

    # A synchronous callback avoids curl_cffi's streaming background thread and
    # queue, which can outlive a request in a frozen/reused serverless instance.
    with requests.Session(impersonate='chrome') as session:
        try:
            response = session.get(data['url'], headers=headers, timeout=(8, 20),
                                   allow_redirects=False, content_callback=receive)
        except Exception:
            if overflow:
                raise DownloadError('INVALID_FILE_RESPONSE', 502)
            raise
        inspect(response.status_code, response.headers, data)
        if len(body) != expected or (start == 0 and body[:2] != b'MZ'):
            raise DownloadError('INVALID_FILE_RESPONSE', 502)
        output = {'Content-Type': 'application/octet-stream', 'Content-Length': str(len(body))}
        for name in ['ETag', 'Content-Range', 'Last-Modified']:
            if response.headers.get(name):
                output[name] = response.headers[name]
        return body, output


class handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, data, headers=None):
        self.send_response(code)
        for key, value in (headers or {'Content-Type': 'application/json'}).items():
            self.send_header(key, value)
        self.send_header('Cache-Control', 'private, no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        key = os.environ.get('ECHO_ORIGIN_KEY', '')
        if not re.fullmatch('[a-f0-9]{64}', key) or not hmac.compare_digest(self.headers.get('Authorization', '').encode(), ('Bearer ' + key).encode()):
            return self.reply(401, b'{"code":"UNAUTHORIZED"}')
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 1 or length > 8192:
                return self.reply(400, b'{"code":"INVALID_BODY"}')
            input_data = json.loads(self.rfile.read(length))
            if isinstance(input_data, dict) and 'entryUrl' in input_data:
                if set(input_data) != {'entryUrl'}:
                    raise DownloadError('INVALID_BODY')
                return self.reply(200, json.dumps({'url': resolve_entry(input_data['entryUrl'])}).encode())
            data = validate(input_data)
            body, output = fetch_part(data)
            # Encode this bounded part because Makers rewrites raw 206 responses.
            payload = json.dumps({'status': 206, 'headers': output, 'bytes': base64.b64encode(body).decode()}, separators=(',', ':')).encode()
            return self.reply(200, payload, {'Content-Type':'application/json', 'X-Echo-Origin-Encoding':'base64'})
        except DownloadError as error:
            return self.reply(error.status, json.dumps({'code': error.code}).encode())
        except (ValueError, TypeError, KeyError):
            return self.reply(400, b'{"code":"INVALID_BODY"}')
        except Exception as error:
            # libcurl numeric codes help distinguish timeout/TLS/network errors
            # without logging signed URLs, credentials or response bodies.
            curl_code = getattr(error, 'code', None)
            print('echo-native', type(error).__name__, 'curl-code', curl_code, flush=True)
            code = 'UPSTREAM_TIMEOUT' if curl_code == 28 else 'ORIGIN_UNREACHABLE'
            return self.reply(503, json.dumps({'code': code}).encode())
