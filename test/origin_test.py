import sys
import unittest
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'makers' / 'cloud-functions'))
from _protocol import validate, validate_entry, inspect, DownloadError

NOW = 1792051200  # 2026-10-15 08:00:00 UTC


def source():
    return 'https://builds.echo.ac/echo.exe?' + urlencode({
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': 'test',
        'X-Amz-Date': '20261015T080000Z', 'X-Amz-Expires': '120',
        'X-Amz-SignedHeaders': 'host', 'X-Amz-Signature': 'a' * 64,
        'response-content-disposition': 'attachment; filename="echo-user.exe"'})


class OriginContract(unittest.TestCase):
    def test_entry_targets_are_only_exact_official_download_links(self):
        self.assertEqual(validate_entry('https://dl.echo.ac/example-token'), 'https://dl.echo.ac/example-token')
        for url in ['http://dl.echo.ac/example-token', 'https://dl.echo.ac.evil.test/example-token', 'https://dl.echo.ac@127.0.0.1/example-token', 'https://dl.echo.ac/a', 'https://dl.echo.ac/example-token?next=evil', 'https://dl.echo.ac/example-token/extra', 'https://builds.echo.ac/echo.exe']:
            with self.subTest(url=url), self.assertRaises(DownloadError):
                validate_entry(url)

    def test_only_fresh_official_signed_targets_and_bounded_ranges(self):
        data = {'url': source(), 'start': 0, 'end': 31}
        self.assertEqual(validate(data, NOW)['url'], source())
        for change in [
            {'url': source().replace('builds.echo.ac', '127.0.0.1')},
            {'url': source().replace('builds.echo.ac', 'builds.echo.ac@evil.test')},
            {'url': source() + '&X-Amz-Expires=3600'},
            {'url': source().replace('20261015', '20260230')},
            {'start': True}, {'start': 1}, {'end': 4*1024*1024},
            {'etag': 'W/"weak"', 'size': 99},
        ]:
            with self.subTest(change=change), self.assertRaises(DownloadError):
                validate({**data, **change}, NOW)
        with self.assertRaises(DownloadError) as expired:
            validate(data, NOW+120)
        self.assertEqual(expired.exception.code, 'LINK_EXPIRED')

    def test_every_part_must_match_the_prepared_version(self):
        data = {'url': source(), 'start': 0, 'end': 31, 'etag': '"current"', 'size': 99}
        headers = {'content-type': 'application/octet-stream', 'content-range': 'bytes 0-31/99', 'content-length': '32', 'etag': '"current"'}
        validate(data, NOW)
        inspect(206, headers, data)
        for change in [{'etag': '"new"'}, {'content-range': 'bytes 0-31/100'}, {'content-type': 'text/html'}, {'content-encoding': 'gzip'}, {'content-length': '31'}]:
            with self.subTest(change=change), self.assertRaises(DownloadError):
                inspect(206, {**headers, **change}, data)
        for status, expected in [(412, 'VERSION_CHANGED'), (403, 'UPSTREAM_DENIED'), (429, 'UPSTREAM_RATE_LIMIT'), (200, 'INVALID_FILE_RESPONSE')]:
            with self.subTest(status=status), self.assertRaises(DownloadError) as error:
                inspect(status, headers, data)
            self.assertEqual(error.exception.code, expected)


if __name__ == '__main__':
    unittest.main()
