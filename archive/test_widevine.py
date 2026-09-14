import base64
from pathlib import Path
import tempfile
import struct
from uuid import UUID
import unittest
from unittest.mock import patch
from widevine import manifest_keys, acquire_keys, provider_url, validate_license, parse_pssh

KID = '00112233445566778899aabbccddeeff'
INIT = b'\x12\x10' + bytes.fromhex(KID)
PSSH = base64.b64encode(struct.pack('>I4sI16sI',32+len(INIT),b'pssh',0,UUID('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed').bytes,len(INIT))+INIT).decode()
MPD = f'''<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013"><Period><AdaptationSet>
<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="{KID}"/>
<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"><cenc:pssh>{PSSH}</cenc:pssh></ContentProtection>
</AdaptationSet></Period></MPD>'''.encode()
LICENSE = {'url': 'https://player.vimeo.com/test/widevine', 'headers': {'authorization': 'private'}, 'encoding': 'binary'}


class WidevineChecks(unittest.TestCase):
    def test_pinned_mp4_parser_compatibility(self):
        parsed = parse_pssh(PSSH)
        self.assertEqual([key.hex for key in parsed.key_ids], [KID])
        self.assertEqual(parsed.init_data, INIT)

    def test_manifest_and_missing_provision_fail_before_license_request(self):
        with patch('widevine.fetch', return_value=MPD):
            info = manifest_keys({'source':'https://vod.vimeocdn.com/a.mpd','headers':{}})
        self.assertEqual(info, ([PSSH], {KID}))
        with tempfile.TemporaryDirectory() as temp, patch('widevine.fetch') as network:
            with self.assertRaisesRegex(ValueError, 'provision missing'):
                acquire_keys(info, LICENSE, Path(temp)/'absent.wvd', Path(temp)/'certificate')
            network.assert_not_called()
        with patch('widevine.fetch', return_value=b'<MPD/>'):
            self.assertIsNone(manifest_keys({'source':'https://vod.vimeocdn.com/a.mpd','headers':{}}))

    def test_provider_and_license_boundaries(self):
        for url in ['http://player.vimeo.com/a', 'https://vimeocdn.com.evil/a', 'https://thirdparty.example/widevine', 'https://user:password@player.vimeo.com/a']:
            with self.assertRaises(ValueError): provider_url(url)
        self.assertEqual(validate_license(LICENSE), LICENSE)
        with self.assertRaises(ValueError): validate_license({**LICENSE,'encoding':'json'})
        with self.assertRaises(ValueError): validate_license({**LICENSE,'headers':{'authorization':'a\r\nb'}})
        with self.assertRaises(ValueError): validate_license({**LICENSE,'headers':{'host':'evil'}})

    def test_license_keys_stay_local_and_session_is_closed_on_failure(self):
        from pywidevine.cdm import Cdm
        with tempfile.TemporaryDirectory() as temp:
            device = Path(temp)/'device.wvd'; device.write_bytes(b'fixture'); device.chmod(0o600)
            certificate = Path(temp)/'certificate'; certificate.write_bytes(b'certificate')
            with patch('pywidevine.device.Device.load'), patch('pywidevine.cdm.Cdm.from_device') as factory, patch('widevine.fetch',return_value=b'license') as send:
                cdm = factory.return_value
                cdm.open.return_value = b'session'
                cdm.get_license_challenge.return_value = b'challenge'
                cdm.get_keys.return_value = []
                with self.assertRaisesRegex(ValueError, 'every key'):
                    acquire_keys(([PSSH],{KID}),LICENSE,device,certificate)
                send.assert_called_once_with(LICENSE['url'],LICENSE['headers'],b'challenge')
                cdm.set_service_certificate.assert_called_once_with(b'session',b'certificate')
                cdm.get_license_challenge.assert_called_once_with(b'session', unittest.mock.ANY, license_type='STREAMING', privacy_mode=True)
                cdm.close.assert_called_once_with(b'session')

if __name__ == '__main__': unittest.main()
