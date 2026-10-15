from http.server import BaseHTTPRequestHandler
import hmac
import base64
import json
import os
import re
from curl_cffi import requests
from _protocol import validate, inspect, DownloadError


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
            data = validate(json.loads(self.rfile.read(length)))
            start, end = data['start'], data['end']
            headers = {'Range': f'bytes={start}-{end}', 'Accept-Encoding': 'identity'}
            if data.get('etag'):
                headers['If-Match'] = data['etag']
            with requests.Session(impersonate='chrome') as session:
                response = session.get(data['url'], headers=headers, timeout=25, allow_redirects=False, stream=True)
                inspect(response.status_code, response.headers, data)
                body = bytearray()
                for block in response.iter_content():
                    body.extend(block)
                    if len(body) > end-start+1:
                        return self.reply(502, b'{"code":"INVALID_FILE_RESPONSE"}')
                if len(body) != end-start+1 or (start == 0 and body[:2] != b'MZ'):
                    return self.reply(502, b'{"code":"INVALID_FILE_RESPONSE"}')
                output = {'Content-Type': 'application/octet-stream', 'Content-Length': str(len(body))}
                for name in ['ETag', 'Content-Range', 'Last-Modified']:
                    if response.headers.get(name):
                        output[name] = response.headers[name]
                # Makers normalizes a Cloud Function's raw 206 response when the
                # caller sent POST JSON rather than a Range header. Encode only
                # this bounded part; the edge validates and restores binary 206.
                payload = json.dumps({'status': 206, 'headers': output, 'bytes': base64.b64encode(body).decode()}, separators=(',', ':')).encode()
                return self.reply(200, payload, {'Content-Type':'application/json', 'X-Echo-Origin-Encoding':'base64'})
        except DownloadError as error:
            return self.reply(error.status, json.dumps({'code': error.code}).encode())
        except (ValueError, TypeError, KeyError):
            return self.reply(400, b'{"code":"INVALID_BODY"}')
        except Exception as error:
            print('echo-native', type(error).__name__)
            return self.reply(503, b'{"code":"ORIGIN_UNREACHABLE"}')
