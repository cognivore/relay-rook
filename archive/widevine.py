"""Local Widevine license acquisition from an observed provider request."""
import base64
from pathlib import Path
import re
from urllib import request, error
from urllib.parse import urlsplit
from uuid import UUID
import xml.etree.ElementTree as ET

WIDEVINE = 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed'


def parse_pssh(value):
    from pymp4.parser import Box
    from pywidevine.pssh import PSSH
    raw = base64.b64decode(value, validate=True)
    box = Box.parse(raw)
    if box.type != 'pssh' or box.end != len(raw):
        raise ValueError('Expected one complete PSSH box.')
    # The pinned nixpkgs pymp4 exposes box fields under .data; pywidevine's
    # byte constructor still expects the older flattened pymp4 structure.
    pssh = PSSH(box.data)
    if pssh.system_id != PSSH.SystemId.Widevine:
        raise ValueError('Expected a Widevine PSSH box.')
    return pssh


def provider_url(url):
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or not parsed.hostname
            or not (parsed.hostname == 'player.vimeo.com' or parsed.hostname.endswith('.vimeocdn.com'))
            or parsed.username or parsed.password or parsed.port not in (None, 443)):
        raise ValueError('Expected an HTTPS request captured from the Vimeo provider.')
    return url


def validate_license(value):
    if value is None: return None
    if not isinstance(value, dict): raise ValueError('Invalid captured license request.')
    url = provider_url(value['url'])
    headers = value['headers']
    allowed = {'origin', 'referer', 'user-agent', 'cookie', 'authorization', 'content-type', 'accept'}
    if not isinstance(headers, dict) or set(headers) - allowed:
        raise ValueError('Unexpected license request headers.')
    if any(not isinstance(v, str) or len(v) > 16384 or re.search(r'[\r\n\t]', v) for v in headers.values()):
        raise ValueError('Invalid license request header.')
    if value.get('encoding') != 'binary':
        raise ValueError('The provider license request is not raw Widevine binary. Its request format needs an explicit adapter.')
    return {'url': url, 'headers': headers, 'encoding': 'binary'}


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, *_args):
        raise ValueError('Provider request redirected; stopped to keep credentials on their captured endpoint.')


def fetch(url, headers, body=None):
    provider_url(url)
    try:
        with request.build_opener(NoRedirect).open(request.Request(url, data=body, headers=headers), timeout=30) as response:
            result = response.read(8_000_001)
            if len(result) > 8_000_000: raise ValueError('Provider response exceeds the supported size.')
            return result
    except error.HTTPError as exc:
        raise RuntimeError(f'Provider returned HTTP {exc.code}; refresh the captured request by rescanning.') from None
    except error.URLError:
        raise RuntimeError('Provider connection failed; check the network and retry.') from None


def manifest_keys(job):
    if not urlsplit(job['source']).path.endswith('.mpd'): return None
    root = ET.fromstring(fetch(job['source'], job['headers']))
    protected = root.findall('.//{*}ContentProtection')
    if not protected: return None
    pssh = []
    kids = set()
    for item in protected:
        for name, value in item.attrib.items():
            if name.endswith('}default_KID'):
                kids.update(UUID(kid).hex for kid in value.split())
        if item.get('schemeIdUri', '').lower() == WIDEVINE:
            for child in item.findall('{*}pssh'):
                value = ''.join((child.text or '').split())
                if not value or len(value) > 65536: raise ValueError('Missing or oversized Widevine PSSH.')
                base64.b64decode(value, validate=True)
                if value not in pssh: pssh.append(value)
    if not pssh or not kids:
        raise ValueError('Encrypted manifest has no usable Widevine PSSH and key IDs; no alternate format was tried.')
    return pssh, kids


def acquire_keys(info, captured, device_path, certificate_path):
    device_path = Path(device_path)
    if not device_path.is_file():
        raise ValueError(f'Widevine device provision missing. Supply your .wvd file with --device, or place it at {device_path}. No encrypted video was downloaded.')
    if device_path.resolve().is_relative_to('/nix/store') or device_path.stat().st_mode & 0o077:
        raise ValueError('Keep the device provision outside the Nix store with file permissions 600.')
    if captured is None:
        raise ValueError('No license request was captured. Reload Relay Rook and rescan this chapter.')
    captured = validate_license(captured)
    certificate_path = Path(certificate_path)
    if not certificate_path.is_file():
        raise ValueError('The provider service certificate is missing. Supply the certificate observed in the EME log with --certificate.')
    certificate = certificate_path.read_bytes()
    if not 0 < len(certificate) <= 65536: raise ValueError('Invalid provider certificate size.')
    from pywidevine.cdm import Cdm
    from pywidevine.device import Device
    try: cdm = Cdm.from_device(Device.load(device_path))
    except Exception as exc:
        raise ValueError(f'Could not load the Widevine device provision ({type(exc).__name__}).') from None
    pssh_values, expected = info
    keys = {}
    # The public provider certificate comes from the observed setServerCertificate
    # call. No guessed certificate endpoint or third-party key service is used.
    for value in pssh_values:
        session = cdm.open()
        try:
            cdm.set_service_certificate(session, certificate)
            challenge = cdm.get_license_challenge(session, parse_pssh(value), license_type='STREAMING', privacy_mode=True)
            response = fetch(captured['url'], captured['headers'], challenge)
            cdm.parse_license(session, response)
            keys.update({key.kid.hex: key.key.hex() for key in cdm.get_keys(session, type_='CONTENT')})
        except RuntimeError: raise
        except Exception as exc:
            raise RuntimeError(f'Widevine license processing failed ({type(exc).__name__}); no encrypted video was downloaded.') from None
        finally: cdm.close(session)
    if not expected.issubset(keys):
        keys.clear()
        raise ValueError('The license did not supply every key required by the manifest; download stopped.')
    if any(not re.fullmatch(r'[0-9a-f]{32}', value) for pair in keys.items() for value in pair):
        keys.clear()
        raise ValueError('The license returned an invalid content key.')
    return keys
