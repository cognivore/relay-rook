#!/usr/bin/env python3
"""Local queue for stream requests captured from authenticated browser playback."""
import argparse
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import signal
import shutil
import subprocess
import threading
import tempfile
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs, urlencode
from datetime import datetime, timezone
from widevine import manifest_keys, acquire_keys, validate_license


def require_capture(job):
    if not job.get('source') or not isinstance(job.get('headers'), dict):
        raise ValueError('This saved job has no captured browser request. Rescan its course to capture the video before retrying.')


def redact_log(text):
    # Signed URLs and request credentials must not appear in the visible log.
    text = re.sub(r'https?://[^\s<>\"\']+', '[URL redacted]', text)
    text = re.sub(r'(?i)\b[0-9a-f]{32}:[0-9a-f]{32}\b', '[content key redacted]', text)
    return re.sub(r'(?im)^.*(?:cookie|authorization|--add-header|--key\s).*$','[request credentials redacted]', text)


def safe_name(value):
    value = re.sub(r'[\x00-\x1f\x7f/\\:*?"<>|%]', '_', str(value))
    value = re.sub(r'\s+', ' ', value).strip(' .')
    # Bound bytes, not code points, for macOS/Linux filename limits.
    value = value.encode('utf-8')[:120].decode('utf-8', 'ignore').strip(' .')
    if not value: raise ValueError('Empty archive name')
    if re.fullmatch(r'(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])', value):
        value = '_' + value
    return value


def validate(raw):
    course_id, chapter_id = str(raw['courseId']), str(raw['chapterId'])
    if not re.fullmatch(r'\d{1,12}', course_id) or not re.fullmatch(r'\d{1,12}', chapter_id):
        raise ValueError('Invalid course or chapter ID')
    ref = urlsplit(raw['referer'])
    if ref.scheme != 'https' or ref.netloc != 'www.chessable.com' or ref.path.rstrip('/') != f'/course/{course_id}/{chapter_id}':
        raise ValueError('Expected the matching Chessable chapter URL')
    url = urlsplit(raw['url'])
    match = re.fullmatch(r'/video/(\d{1,15})/?', url.path)
    if url.scheme != 'https' or url.netloc != 'player.vimeo.com' or not match:
        raise ValueError('Only Vimeo players found in course chapters are supported')
    video_id = match[1]
    # Keep Vimeo's unlisted-video hash, discard tracking/playback parameters.
    query = parse_qs(url.query)
    video_url = f'https://player.vimeo.com/video/{video_id}'
    if 'h' in query:
        if not re.fullmatch('[a-zA-Z0-9]+', query['h'][0]):
            raise ValueError('Invalid Vimeo video hash')
        video_url += '?' + urlencode({'h': query['h'][0]})
    order, video_order = int(raw['order']), int(raw['videoOrder'])
    if not 1 <= order <= 10000 or not 1 <= video_order <= 1000:
        raise ValueError('Invalid chapter/video order')
    names = {key: str(raw[key])[:500] for key in ('course', 'chapter', 'title')}
    source = urlsplit(raw['stream']['url'])
    if (source.scheme != 'https' or not source.hostname or not source.hostname.endswith('.vimeocdn.com')
            or source.username or source.password or source.port not in (None, 443)):
        raise ValueError('Expected the Vimeo CDN stream captured by the browser')
    if not source.path.endswith(('.mpd', '.m3u8')):
        raise ValueError('The browser stream is not a supported MPD or HLS manifest; no alternate source was tried')
    headers = raw['stream']['headers']
    if not isinstance(headers, dict) or set(headers) - {'origin', 'referer', 'user-agent', 'cookie'}:
        raise ValueError('Unexpected stream request headers')
    if any(not isinstance(v, str) or len(v) > 16384 or re.search(r'[\r\n\t]', v) for v in headers.values()):
        raise ValueError('Invalid stream request header')
    folder = f"{safe_name(names['course'])} [{course_id}]"
    chapter = f"{order:03d} - {safe_name(names['chapter'])} [{chapter_id}]"
    stem = f"{video_order:02d} - {safe_name(names['title'])} [{video_id}]"
    return {**names, 'id': f'{course_id}-{chapter_id}-{video_id}', 'url': video_url,
            'referer': f'https://www.chessable.com/course/{course_id}/{chapter_id}',
            'relative': str(Path(folder) / chapter / stem), 'source': raw['stream']['url'],
            'headers': headers, 'license': validate_license(raw['stream'].get('license')), 'status': 'queued', 'error': ''}


class Archive:
    def __init__(self, root, ytdlp, ffmpeg, device=None, mp4decrypt=None, certificate=None):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.meta = self.root / '.relay-rook'
        self.meta.mkdir(exist_ok=True, mode=0o700)
        self.meta.chmod(0o700)
        self.file = self.meta / 'queue.json'
        self.lock = threading.RLock()
        self.wake = threading.Event()
        self.stopping = threading.Event()
        self.process = None
        self.ytdlp, self.ffmpeg = ytdlp, ffmpeg
        self.device = device or self.meta / 'device.wvd'
        self.mp4decrypt = mp4decrypt
        self.certificate = certificate or self.meta / 'service-certificate.bin'
        self.data = json.loads(self.file.read_text()) if self.file.exists() else {'paused': False, 'jobs': {}}
        for job in self.data['jobs'].values():
            if job['status'] != 'complete':
                try: require_capture(job)
                except ValueError as exc:
                    job.update(status='needs_rescan', error=str(exc))
            if job['status'] == 'downloading': job['status'] = 'queued'
        self.save()

    def save(self):
        temporary = self.file.with_suffix('.tmp')
        with temporary.open('w') as output:
            json.dump(self.data, output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, self.file)

    def enqueue(self, raws):
        if not isinstance(raws, list) or len(raws) > 1000:
            raise ValueError('Expected at most 1000 videos per request')
        jobs = [validate(raw) for raw in raws]  # validate whole batch before writing
        with self.lock:
            for job in jobs:
                old = self.data['jobs'].get(job['id'])
                if old:
                    # Preserve existing paths if a course was renamed/reordered.
                    old.update(url=job['url'], referer=job['referer'], source=job['source'], headers=job['headers'], license=job['license'])
                    if old['status'] in ('failed', 'needs_rescan'): old.update(status='queued', error='')
                    if old['status'] == 'complete' and not self.finished_file(old):
                        old.update(status='queued', error='')
                else:
                    self.data['jobs'][job['id']] = job
            self.save()
        self.wake.set()

    def retry(self):
        with self.lock:
            for job in self.data['jobs'].values():
                if job['status'] != 'failed': continue
                try: require_capture(job)
                except ValueError as exc:
                    job.update(status='needs_rescan', error=str(exc))
                else: job.update(status='queued', error='')
            self.save()
        self.wake.set()

    def log_tail(self, job_id):
        with self.lock:
            if job_id not in self.data['jobs'] or not re.fullmatch(r'\d+-\d+-\d+', job_id):
                raise ValueError('Unknown archive job')
            job = self.data['jobs'][job_id]
            if job['status'] == 'needs_rescan': return job['error']
            path = self.meta / (job_id + '.log')
            if not path.exists(): return job['error'] or 'Waiting for the downloader to start.'
            with path.open('rb') as source:
                source.seek(max(0, path.stat().st_size - 16384))
                tail = source.read().decode('utf-8', 'replace')
            return redact_log(tail)

    def finished_file(self, job):
        path = Path(job.get('file', ''))
        return path.is_file() and path.stat().st_size > 0 and self.root in path.resolve().parents

    def state(self):
        with self.lock:
            return {'root': str(self.root), 'paused': self.data['paused'],
                    'widevine': {'devicePresent': Path(self.device).is_file(), 'devicePath': str(self.device),
                                 'certificatePresent': Path(self.certificate).is_file()}, 'jobs': [
                {k: job.get(k, '') for k in ('id', 'course', 'chapter', 'title', 'status', 'error', 'file')}
                for job in self.data['jobs'].values()]}

    def command(self, job, receipt, encrypted=False):
        require_capture(job)
        target = self.root / job['relative']
        if self.root not in target.resolve().parents:
            raise ValueError('Archive path escapes its root')
        target.parent.mkdir(parents=True, exist_ok=True)
        if encrypted:
            target = self.meta / job['id'] / 'encrypted'
            target.parent.mkdir(exist_ok=True, mode=0o700)
        return [self.ytdlp, '--ignore-config', '--no-plugin-dirs', '--no-playlist', '--no-check-formats',
                '--force-generic-extractor',
                '--continue', '--no-overwrites', '--abort-on-unavailable-fragments',
                '--retries', '10', '--fragment-retries', '10', '--socket-timeout', '30',
                '--ffmpeg-location', self.ffmpeg, '-f', 'bv,ba' if encrypted else 'bv+ba',
                *(['--allow-unplayable-formats', '--fixup', 'never'] if encrypted else []),
                '--merge-output-format', 'mp4', '--newline', '--no-colors',
                '--progress', '--progress-delta', '1',
                '--print-to-file', 'after_move:filepath', str(receipt),
                '-o', str(target).replace('%', '%%') + ('.%(format_id)s' if encrypted else '') + '.%(ext)s',
                *[arg for k, v in job['headers'].items() if k != 'cookie' for arg in ('--add-header', f'{k}:{v}')],
                '--', job['source']]

    def download(self, job):
        receipt = self.meta / (job['id'] + '.path')
        log = self.meta / (job['id'] + '.log')
        receipt.unlink(missing_ok=True)
        # Resolve every required key before downloading any encrypted media.
        log.write_text('Inspecting the captured stream manifest.\n')
        info = manifest_keys(job)
        keys = {}
        if info:
            if not self.mp4decrypt: raise ValueError('Bento4 is missing. Restart the helper with nix run .#archive.')
            with log.open('a') as output: output.write('Widevine detected. Acquiring a license locally.\n')
            keys = acquire_keys(info, job.get('license'), self.device, self.certificate)
        try: return self.download_media(job, receipt, log, keys)
        finally: keys.clear()

    def run_process(self, command, output):
        with self.lock:
            if self.stopping.is_set(): raise RuntimeError('Helper stopped; resume on restart.')
            self.process = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try: result = self.process.wait()
        finally:
            with self.lock: self.process = None
        if self.stopping.is_set(): raise RuntimeError('Helper stopped; resume on restart.')
        return result

    def download_media(self, job, receipt, log, keys):
        command = self.command(job, receipt, encrypted=bool(keys))
        # Cookies observed on a CDN request are scoped to that exact CDN host.
        # Never turn them into a global Cookie header for child/redirect requests.
        with tempfile.NamedTemporaryFile(mode='w', prefix='cookies-', dir=self.meta) as cookie_file, log.open('a') as output:
            cookie_header = job['headers'].get('cookie')
            if cookie_header:
                cookies = SimpleCookie()
                cookies.load(cookie_header)
                if not cookies: raise ValueError('The captured stream cookies could not be parsed')
                cookie_file.write('# Netscape HTTP Cookie File\n')
                host = urlsplit(job['source']).hostname
                for name, cookie in cookies.items():
                    cookie_file.write(f'{host}\tFALSE\t/\tTRUE\t0\t{name}\t{cookie.value}\n')
                cookie_file.flush()
                command[1:1] = ['--cookies', cookie_file.name]
            returncode = self.run_process(command, output)
        if self.stopping.is_set(): raise RuntimeError('Helper stopped; resume on restart.')
        lines = receipt.read_text().splitlines() if receipt.exists() else []
        if returncode or not lines:
            # Keep signed media URLs out of the UI. Detailed error stays local.
            if 'DRM protected' in log.read_text(errors='replace'):
                raise RuntimeError('The downloader rejected the captured browser stream as protected; no output saved. ' +
                                   f'See {log.name}.')
            raise RuntimeError(f'Download failed (exit {returncode}). See {log.name}; retry when online.')
        if keys: return self.decrypt_media(job, lines, keys, log)
        path = Path(lines[-1]).resolve()
        candidate = {**job, 'file': str(path)}
        if not self.finished_file(candidate):
            raise RuntimeError('Downloader did not produce a non-empty local video.')
        return str(path)

    def decrypt_media(self, job, lines, keys, log):
        work = self.meta / job['id']
        if len(lines) != 2: raise RuntimeError('Expected exactly one encrypted video and one audio track.')
        inputs = [Path(line).resolve() for line in lines]
        if any(work.resolve() not in path.parents or not path.is_file() for path in inputs):
            raise RuntimeError('Downloader returned an unexpected encrypted track path.')
        parts = [work / f'clear-{n}.mp4' for n in range(2)]
        merged = work / 'verified.mp4'
        target = self.root / (job['relative'] + '.mp4')
        if target.exists(): raise RuntimeError('Archive output already exists; refusing to overwrite it.')
        try:
            with log.open('a') as output:
                for source, clear in zip(inputs, parts):
                    clear.unlink(missing_ok=True)
                    output.write('Decrypting a downloaded track locally.\n'); output.flush()
                    command = [self.mp4decrypt, '--show-progress',
                               *[arg for kid, key in keys.items() for arg in ('--key', f'{kid}:{key}')], str(source), str(clear)]
                    if self.run_process(command, output): raise RuntimeError('Track decryption failed; see the download log.')
                merged.unlink(missing_ok=True)
                output.write('Merging decrypted audio and video.\n'); output.flush()
                if self.run_process([self.ffmpeg, '-hide_banner', '-loglevel', 'error', '-n', '-i', str(parts[0]),
                                     '-i', str(parts[1]), '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', str(merged)], output):
                    raise RuntimeError('Merging decrypted tracks failed; see the download log.')
                output.write('Checking the complete video and audio before saving.\n'); output.flush()
                if self.run_process([self.ffmpeg, '-hide_banner', '-loglevel', 'error', '-xerror', '-i', str(merged),
                                     '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], output):
                    raise RuntimeError('Decrypted media failed the full playback check; archive was not marked complete.')
                if not merged.is_file() or not merged.stat().st_size: raise RuntimeError('The merged video is empty.')
                target.parent.mkdir(parents=True, exist_ok=True)
                os.link(merged, target)  # atomic, same filesystem, refuses overwrites
                output.write('Verified video saved.\n')
            return str(target)
        finally:
            for path in [*parts, merged]: path.unlink(missing_ok=True)

    def worker(self):
        while not self.stopping.is_set():
            self.wake.clear()
            with self.lock:
                job = None if self.data['paused'] else next((j for j in self.data['jobs'].values() if j['status'] == 'queued'), None)
                if job:
                    job.update(status='downloading', error='')
                    self.save()
            if not job:
                self.wake.wait(5)
                continue
            try:
                path = self.download(dict(job))
                with self.lock: job.update(status='complete', error='', file=path)
            except Exception as exc:
                message = f'Missing required job field: {exc.args[0]}. Rescan this course.' if isinstance(exc, KeyError) else str(exc)
                message = redact_log(message)
                with (self.meta / (job['id'] + '.log')).open('a') as output:
                    output.write(f'\n[{datetime.now(timezone.utc).isoformat()}] ERROR: {message}\n')
                with self.lock: job.update(status='queued' if self.stopping.is_set() else 'failed', error=message)
            with self.lock: self.save()

    def shutdown(self):
        with self.lock:
            self.stopping.set()
            if self.process and self.process.poll() is None:
                try: os.killpg(self.process.pid, signal.SIGTERM)
                except ProcessLookupError: pass
        self.wake.set()


def handler(archive, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args): pass

        def allowed(self):
            origin = self.headers.get('Origin', '')
            return (self.headers.get('Host') == '127.0.0.1:8675'
                    and (not origin or re.fullmatch(r'chrome-extension://[a-p]{32}', origin)))

        def respond(self, status, body):
            encoded = json.dumps(body).encode()
            self.send_response(status)
            origin = self.headers.get('Origin')
            if self.allowed() and origin:
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_OPTIONS(self):
            if not self.allowed(): return self.respond(403, {'error': 'Forbidden'})
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin', ''))
            self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.end_headers()

        def authorized(self):
            return self.allowed() and hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token)

        def do_GET(self):
            if not self.authorized(): return self.respond(403, {'error': 'Forbidden'})
            if self.path.startswith('/logs/'):
                try: return self.respond(200, {'text': archive.log_tail(self.path[6:])})
                except ValueError as exc: return self.respond(404, {'error': str(exc)})
            if self.path != '/state': return self.respond(404, {})
            self.respond(200, archive.state())

        def do_POST(self):
            if not self.authorized(): return self.respond(403, {'error': 'Forbidden'})
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 2_000_000: raise ValueError('Invalid request size')
                data = json.loads(self.rfile.read(size))
                with archive.lock:
                    if self.path == '/queue': archive.enqueue(data['jobs'])
                    elif self.path == '/pause':
                        if not isinstance(data['paused'], bool): raise ValueError('Expected a boolean')
                        archive.data['paused'] = data['paused']
                    elif self.path == '/retry':
                        archive.retry()
                    else: return self.respond(404, {})
                    archive.save()
                archive.wake.set()
                self.respond(200, {'ok': True})
            except (ValueError, KeyError, TypeError) as exc:
                message = f'Missing required request field: {exc.args[0]}. Rescan this chapter.' if isinstance(exc, KeyError) else str(exc)
                self.respond(400, {'error': message})
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path.home() / 'Movies' / 'Relay Rook')
    parser.add_argument('--extension', type=Path, default=Path(__file__).resolve().parents[1] / 'extension')
    parser.add_argument('--device', type=Path, help='Private local Widevine .wvd provision (default: ROOT/.relay-rook/device.wvd)')
    parser.add_argument('--certificate', type=Path, help='Provider certificate observed in EME (default: ROOT/.relay-rook/service-certificate.bin)')
    args = parser.parse_args()
    ytdlp, ffmpeg = shutil.which('yt-dlp'), shutil.which('ffmpeg')
    if not ytdlp or not ffmpeg: parser.error('yt-dlp and ffmpeg must be on PATH (see README).')
    if not (args.extension / 'manifest.json').is_file(): parser.error('--extension must point to Relay Rook extension/')
    config_file = args.extension / 'archive' / 'local-config.json'
    config = json.loads(config_file.read_text()) if config_file.exists() else {'token': secrets.token_urlsafe(32)}
    archive = Archive(args.root, ytdlp, ffmpeg, args.device, shutil.which('mp4decrypt'), args.certificate)
    server = ThreadingHTTPServer(('127.0.0.1', 8675), handler(archive, config['token']))
    config_file.write_text(json.dumps(config))
    config_file.chmod(0o600)
    worker = threading.Thread(target=archive.worker, daemon=True)
    worker.start()
    def stop(_signum, _frame): raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    print(f'Archiving to {archive.root}. Open Relay Rook → Archive all courses.', flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        archive.shutdown()
        worker.join(timeout=10)
        server.server_close()


if __name__ == '__main__': main()
