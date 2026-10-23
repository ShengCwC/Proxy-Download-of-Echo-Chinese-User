"""Exercise the native bounded reader without requiring a local native wheel."""
import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from datetime import datetime, timezone
from urllib.parse import urlencode
import json

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'makers' / 'cloud-functions'))
from _protocol import DownloadError

spec = importlib.util.spec_from_file_location('echo_read', Path(__file__).resolve().parents[1] / 'makers' / 'cloud-functions' / 'read.py')
native = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'curl_cffi': SimpleNamespace(requests=SimpleNamespace())}):
    spec.loader.exec_module(native)


class NativeReader(unittest.TestCase):
    def test_entry_resolution_uses_the_official_json_interface_and_validates_the_result(self):
        signed = 'https://builds.echo.ac/echo.exe?' + urlencode({
            'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': 'test',
            'X-Amz-Date': datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'),
            'X-Amz-Expires': '120', 'X-Amz-SignedHeaders': 'host',
            'X-Amz-Signature': 'a'*64,
            'response-content-disposition': 'attachment; filename="echo-test.exe"'})
        owner = self

        class Session:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def get(self, url, **kwargs):
                owner.assertEqual(url, 'https://dl.echo.ac/example-token?platform=windows')
                owner.assertEqual(kwargs['headers'], {'X-Requested-With': 'XMLHttpRequest'})
                owner.assertFalse(kwargs['allow_redirects'])
                kwargs['content_callback'](json.dumps({'url': signed}).encode())
                return SimpleNamespace(status_code=200, headers={'content-type': 'application/json'})

        with patch.object(native, 'requests', SimpleNamespace(Session=lambda **kwargs: Session())):
            self.assertEqual(native.resolve_entry('https://dl.echo.ac/example-token'), signed)
            signed = signed.replace('builds.echo.ac', 'evil.test')
            with self.assertRaises(DownloadError):
                native.resolve_entry('https://dl.echo.ac/example-token')

    def run_reader(self, blocks, status=206, etag='"current"', expected_size=32):
        data = {'url': 'https://builds.echo.ac/echo.exe?private', 'start': 0, 'end': expected_size-1, 'etag': '"current"', 'size': 99}
        owner = self

        class Session:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                owner.closed = True

            def get(self, url, **kwargs):
                owner.assertEqual(kwargs['headers']['If-Match'], '"current"')
                owner.assertEqual(kwargs['timeout'], (8, 20))
                owner.assertNotIn('stream', kwargs)
                for block in blocks:
                    if kwargs['content_callback'](block) != len(block):
                        raise RuntimeError('write callback stopped transfer')
                return SimpleNamespace(status_code=status, headers={'content-type': 'application/octet-stream', 'content-range': f'bytes 0-{expected_size-1}/99', 'etag': etag})

        with patch.object(native, 'requests', SimpleNamespace(Session=lambda **kwargs: Session())):
            return native.fetch_part(data)

    def test_exact_bytes_and_cleanup(self):
        self.closed = False
        body, headers = self.run_reader([b'MZ', bytes(range(30))])
        self.assertEqual(body, b'MZ' + bytes(range(30)))
        self.assertEqual(headers['Content-Length'], '32')
        self.assertTrue(self.closed)

    def test_bounded_body_truncation_and_changed_version(self):
        for blocks, status, etag, code in [
            ([b'MZ'], 206, '"current"', 'INVALID_FILE_RESPONSE'),
            ([b'x' * 65537], 206, '"current"', 'INVALID_FILE_RESPONSE'),
            ([b'changed'], 412, '"new"', 'VERSION_CHANGED'),
            ([b'denied'], 403, '"current"', 'UPSTREAM_DENIED'),
            ([b'limited'], 429, '"current"', 'UPSTREAM_RATE_LIMIT'),
        ]:
            self.closed = False
            with self.subTest(code=code), self.assertRaises(DownloadError) as failure:
                self.run_reader(blocks, status, etag)
            self.assertEqual(failure.exception.code, code)
            self.assertTrue(self.closed)


if __name__ == '__main__':
    unittest.main()
