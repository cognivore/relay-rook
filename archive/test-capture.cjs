const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const listeners = {};
const extensionPage = 'chrome-extension://' + 'a'.repeat(32) + '/archive/archive.html';
const on = name => ({ addListener: fn => { listeners[name] = fn; } });
const context = { URL, Map, Object, Number, Uint8Array,
  chrome: { webRequest: { onBeforeRequest: on('before'), onSendHeaders: on('headers'), onErrorOccurred: on('error') },
    tabs: { onRemoved: on('removed') },
    runtime: { onMessage: on('message'), getURL: () => extensionPage } } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/src/archive-capture.js'), 'utf8'), context);
const message = (msg, sender = { url: extensionPage }) => {
  let result; listeners.message(msg, sender, value => { result = value; }); return result;
};
assert.equal(message({ type: 'ARCHIVE_CAPTURE_ARM', tabId: 4 }, { url: 'https://www.chessable.com/' }), undefined);
assert.equal(message({ type: 'ARCHIVE_CAPTURE_ARM', tabId: 4 }).ok, true);
listeners.before({ tabId: 4, frameId: 7, type: 'sub_frame', url: 'https://player.vimeo.com/video/1133981693' });
const request = { tabId: 4, frameId: 7, url: 'https://vod-adaptive-ak.vimeocdn.com/a/master.mpd?signature=test',
 requestHeaders: [{ name: 'Referer', value: 'https://player.vimeo.com/' }, { name: 'Cookie', value: 'session=abc' }, { name: 'Unrelated', value: 'ignored' }] };
listeners.headers({ ...request, tabId: 99 });
listeners.headers({ ...request, frameId: 99 });
assert.equal(Object.keys(message({ type: 'ARCHIVE_CAPTURE_GET', tabId: 4 }).streams).length, 0);
listeners.headers(request);
const captured = message({ type: 'ARCHIVE_CAPTURE_GET', tabId: 4 }).streams['1133981693'];
assert.equal(captured.url, request.url);
assert.deepEqual(Object.keys(captured.headers), ['referer', 'cookie']);
listeners.headers({ ...request, url: 'https://vod-adaptive-ak.vimeocdn.com/a/alternate.m3u8' });
assert.equal(message({ type: 'ARCHIVE_CAPTURE_GET', tabId: 4 }).streams['1133981693'].url, request.url, 'No automatic source fallback');
assert.equal(message({ type: 'ARCHIVE_CAPTURE_GET', tabId: 4 }).ready.length, 0, 'A manifest alone does not establish successful playback');
const player = { tab: { id: 4 }, frameId: 7, url: 'https://player.vimeo.com/video/1133981693' };
assert.equal(message({ type: 'ARCHIVE_PLAYER_READY' }, player).capture, true);
const license = { tabId: 4, frameId: 7, requestId: 'license-1', method: 'POST',
  url: 'https://player.vimeo.com/test/widevine?token=sample',
  requestBody: { raw: [{ bytes: new Uint8Array([8, 1, 18, 0]).buffer }] } };
listeners.before(license);
listeners.headers({ ...license, requestHeaders: [{ name: 'Authorization', value: 'private' }, { name: 'Content-Type', value: 'application/octet-stream' }, { name: 'Content-Length', value: '4' }] });
message({ type: 'ARCHIVE_PLAYER_STARTED' }, player);
const finished = message({ type: 'ARCHIVE_CAPTURE_GET', tabId: 4 });
assert.deepEqual(Array.from(finished.ready), ['1133981693']);
assert.equal(finished.streams['1133981693'].license.encoding, 'binary');
assert.equal(finished.streams['1133981693'].license.headers.authorization, 'private');
assert.equal(finished.streams['1133981693'].license.headers['content-length'], undefined);
assert.equal(finished.streams['1133981693'].license.requestBody, undefined, 'Do not persist browser license challenges');
assert.equal(finished.streams['1133981693'].headers.authorization, undefined, 'Do not forward license authorization to the media CDN');
listeners.removed(4);
assert.equal(message({ type: 'ARCHIVE_CAPTURE_GET', tabId: 4 }).ok, false);
console.log('Capture checks passed: owned frames, exact stream, separate license credentials, playback readiness and cleanup.');
