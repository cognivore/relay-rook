import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from server import Archive, safe_name, validate, handler, redact_log

VIDEO = dict(courseId='123333', course='Calculation / Skills', chapterId='10',
             chapter='2. Skills to be Trained', order=2, videoOrder=1,
             title='CHAPTER 2', url='https://player.vimeo.com/video/1133911579?app_id=122963&h=abcd#t=997',
             referer='https://www.chessable.com/course/123333/10',
             stream={'url': 'https://vod-adaptive-ak.vimeocdn.com/example/master.mpd?token=sample',
                     'headers': {'referer': 'https://player.vimeo.com/'}})


class ArchiveChecks(unittest.TestCase):
    def setUp(self):
        # These queue/downloader checks use a clear-stream fixture. Manifest and
        # license parsing have their own real-structure checks in test_widevine.
        mocked = patch('server.manifest_keys', return_value=None)
        mocked.start()
        self.addCleanup(mocked.stop)

    def test_old_jobs_require_rescan_instead_of_crashing_or_anonymous_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Archive(Path(directory), 'yt-dlp', 'ffmpeg')
            archive.enqueue([VIDEO])
            job = next(iter(archive.data['jobs'].values()))
            del job['headers']
            del job['source']
            job.update(status='failed', error="'headers'")
            archive.save()
            archive = Archive(Path(directory), 'yt-dlp', 'ffmpeg')
            job = next(iter(archive.data['jobs'].values()))
            self.assertEqual(job['status'], 'needs_rescan')
            self.assertIn('Rescan', archive.log_tail(job['id']))
            archive.retry()
            self.assertEqual(job['status'], 'needs_rescan')
            with self.assertRaisesRegex(ValueError, 'Rescan'):
                archive.command(job, archive.meta / 'receipt')
            archive.enqueue([VIDEO])
            self.assertEqual(job['status'], 'queued')
            self.assertEqual(job['headers'], VIDEO['stream']['headers'])
            self.assertEqual(job['source'], VIDEO['stream']['url'])

    def test_visible_logs_are_bounded_and_redact_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Archive(Path(directory), 'yt-dlp', 'ffmpeg')
            archive.enqueue([VIDEO])
            job = next(iter(archive.data['jobs'].values()))
            log = archive.meta / (job['id'] + '.log')
            log.write_text('old-line\n' * 5000 + 'ERROR https://cdn.example/master.mpd?token=secret\nCookie: private\n[download] 45% at 20MiB/s\n')
            tail = archive.log_tail(job['id'])
            self.assertNotIn('token=secret', tail)
            self.assertNotIn('private', tail)
            self.assertIn('45% at 20MiB/s', tail)
            self.assertLessEqual(len(tail), 16400)
            with self.assertRaises(ValueError): archive.log_tail('../queue.json')
            self.assertNotIn('secret', redact_log('Authorization: Bearer secret'))

    def test_names_and_validation(self):
        job = validate(VIDEO)
        self.assertEqual(job['url'], 'https://player.vimeo.com/video/1133911579?h=abcd')
        self.assertIn('002 - 2. Skills to be Trained [10]', job['relative'])
        self.assertLessEqual(len(safe_name('棋' * 200).encode()), 120)
        self.assertEqual(safe_name('../../evil%(.ext)s'), '_.._evil_(.ext)s')
        self.assertEqual(safe_name('CON'), '_CON')
        for url in ['http://127.0.0.1/video/1', 'https://player.vimeo.com.evil/video/1', 'https://player.vimeo.com@evil/video/1', 'file:///video/1']:
            with self.assertRaises(ValueError): validate({**VIDEO, 'url': url})
        with self.assertRaises(ValueError): validate({**VIDEO, 'referer': 'https://www.chessable.com/course/2/10'})
        with self.assertRaises(ValueError): validate({**VIDEO, 'chapterId': '../escape'})

    def test_durable_queue_resume_and_deduplication(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Archive(Path(directory), 'yt-dlp', 'ffmpeg')
            archive.enqueue([VIDEO, VIDEO])
            self.assertEqual(len(archive.data['jobs']), 1)
            job = next(iter(archive.data['jobs'].values()))
            original = job['relative']
            job['status'] = 'downloading'
            archive.save()
            archive = Archive(Path(directory), 'yt-dlp', 'ffmpeg')
            job = next(iter(archive.data['jobs'].values()))
            self.assertEqual(job['status'], 'queued')
            output = archive.root / 'test.mp4'
            output.write_bytes(b'video')
            job.update(status='complete', file=str(output))
            archive.enqueue([{**VIDEO, 'course': 'Renamed', 'order': 1}])
            self.assertEqual(job['status'], 'complete')
            self.assertEqual(job['relative'], original)
            output.unlink()
            archive.enqueue([VIDEO])
            self.assertEqual(job['status'], 'queued')
            self.assertNotIn('url', archive.state()['jobs'][0])
            with self.assertRaises(ValueError): archive.enqueue([VIDEO, {**VIDEO, 'url': 'https://evil.com/'}])
            self.assertEqual(len(archive.data['jobs']), 1)

    def test_downloader_requires_a_real_output_and_never_skips_fragments(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Archive(Path(directory), 'yt-dlp', 'ffmpeg')
            job = validate(VIDEO)
            receipt = archive.meta / (job['id'] + '.path')
            cmd = archive.command(job, receipt)
            self.assertIn('--abort-on-unavailable-fragments', cmd)
            self.assertIn('--ignore-config', cmd)
            self.assertIn('--no-check-formats', cmd)
            self.assertEqual(cmd[cmd.index('-f') + 1], 'bv+ba')
            self.assertIn('--force-generic-extractor', cmd)
            self.assertIn('--no-overwrites', cmd)
            self.assertEqual(cmd[-2:], ['--', job['source']])
            self.assertFalse(any('cookies' in option for option in cmd))
            with patch('server.subprocess.Popen') as run:
                run.return_value.wait.return_value = 0
                with self.assertRaises(RuntimeError): archive.download(job)
                def finish(*args, **kwargs):
                    target = archive.root / 'test.mp4'
                    target.write_bytes(b'video')
                    receipt.write_text(str(target) + '\n')
                    return type('Result', (), {'wait': lambda self: 0})()
                run.side_effect = finish
                self.assertTrue(Path(archive.download(job)).is_file())
                def protected(*args, **kwargs):
                    kwargs['stdout'].write('ERROR: This format is DRM protected')
                    return type('Result', (), {'wait': lambda self: 1})()
                run.side_effect = protected
                with self.assertRaisesRegex(RuntimeError, 'rejected the captured browser stream'):
                    archive.download(job)

    def test_captured_request_validation_and_cookie_scope(self):
        for stream in [
            {'url': 'https://localhost/master.mpd', 'headers': {}},
            {'url': 'https://vod-adaptive-ak.vimeocdn.com/master.json', 'headers': {}},
            {'url': VIDEO['stream']['url'], 'headers': {'cookie': 'a=b\\r\\nInjected: yes'.encode().decode('unicode_escape')}},
        ]:
            with self.assertRaises(ValueError): validate({**VIDEO, 'stream': stream})
        with tempfile.TemporaryDirectory() as directory:
            archive = Archive(Path(directory), 'yt-dlp', 'ffmpeg')
            job = validate({**VIDEO, 'stream': {**VIDEO['stream'], 'headers': {'cookie': 'session=abc'}}})
            captured = {}
            def run(command, **kwargs):
                cookie_path = Path(command[command.index('--cookies') + 1])
                captured.update(path=cookie_path, text=cookie_path.read_text())
                self.assertNotIn('session=abc', ' '.join(command))
                return type('Result', (), {'wait': lambda self: 1})()
            with patch('server.subprocess.Popen', side_effect=run):
                with self.assertRaises(RuntimeError): archive.download(job)
            self.assertIn('vod-adaptive-ak.vimeocdn.com\tFALSE\t/\tTRUE\t0\tsession\tabc', captured['text'])
            self.assertFalse(captured['path'].exists())

    def test_auth_and_origin(self):
        cls = handler(None, 'local-secret')
        request = object.__new__(cls)
        request.headers = {'Host': '127.0.0.1:8675', 'Authorization': 'Bearer local-secret', 'Origin': 'chrome-extension://' + 'a' * 32}
        self.assertTrue(request.authorized())
        for field, bad in [('Origin', 'https://evil.example'), ('Host', 'evil.example:8675'), ('Authorization', 'Bearer wrong')]:
            good = request.headers[field]
            request.headers[field] = bad
            self.assertFalse(request.authorized())
            request.headers[field] = good


if __name__ == '__main__': unittest.main()
