"use strict";

// Capture only requests made by player frames in explicitly armed scan tabs.
const archiveCaptures = new Map();
const archiveRequestFilter = { urls: ['https://player.vimeo.com/*', 'https://*.vimeocdn.com/*'] };
function archivePlayer(sender) {
  const capture = archiveCaptures.get(sender.tab?.id);
  if (!capture || !sender.url) return {};
  const url = new URL(sender.url);
  const match = url.origin === 'https://player.vimeo.com' && url.pathname.match(/^\/video\/(\d+)\/?$/);
  return match ? { capture, videoId: match[1] } : {};
}
chrome.webRequest.onBeforeRequest.addListener(details => {
  const capture = archiveCaptures.get(details.tabId);
  if (!capture) return;
  const url = new URL(details.url);
  const video = url.origin === 'https://player.vimeo.com' && url.pathname.match(/^\/video\/(\d+)\/?$/);
  if (video && details.type === 'sub_frame') capture.frames.set(details.frameId, video[1]);
  const videoId = capture.frames.get(details.frameId);
  if (!videoId || details.method !== 'POST') return;
  const raw = details.requestBody?.raw;
  const first = raw?.[0]?.bytes && new Uint8Array(raw[0].bytes);
  // Widevine SignedMessage LICENSE_REQUEST starts with protobuf type 1.
  // We retain only endpoint/headers, never the browser's challenge or response.
  const binary = first?.length > 2 && first[0] === 8 && first[1] === 1;
  if (binary || /widevine/i.test(url.pathname)) {
    capture.requests.set(details.requestId, { videoId, url: details.url, encoding: binary ? 'binary' : 'unsupported' });
  }
}, archiveRequestFilter, ['requestBody']);
chrome.webRequest.onSendHeaders.addListener(details => {
  const capture = archiveCaptures.get(details.tabId);
  const videoId = capture?.frames.get(details.frameId);
  if (!videoId) return;
  const license = capture.requests.get(details.requestId);
  const allowed = license ? ['referer', 'origin', 'user-agent', 'cookie', 'authorization', 'content-type', 'accept']
    : ['referer', 'origin', 'user-agent', 'cookie'];
  const headers = {};
  for (const header of details.requestHeaders || []) {
    const name = header.name.toLowerCase();
    if (allowed.includes(name)) headers[name] = header.value;
  }
  if (license) {
    capture.requests.delete(details.requestId);
    // Certificate exchanges may share the endpoint. Retain the actual license request.
    if (!capture.licenses.has(videoId) || license.encoding === 'binary')
      capture.licenses.set(videoId, { url: license.url, encoding: license.encoding, headers });
    return;
  }
  const url = new URL(details.url);
  if (capture.streams.has(videoId) || !url.hostname.endsWith('.vimeocdn.com') || !/\.(mpd|m3u8|json)$/.test(url.pathname)) return;
  capture.streams.set(videoId, { url: details.url, headers });
}, archiveRequestFilter, ['requestHeaders', 'extraHeaders']);
chrome.webRequest.onErrorOccurred.addListener(details => archiveCaptures.get(details.tabId)?.requests.delete(details.requestId), archiveRequestFilter);
chrome.tabs.onRemoved.addListener(id => archiveCaptures.delete(id));
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (['ARCHIVE_PLAYER_READY', 'ARCHIVE_PLAYER_STARTED', 'ARCHIVE_PLAYER_ERROR'].includes(msg.type)) {
    const { capture, videoId } = archivePlayer(sender);
    if (capture) {
      capture.frames.set(sender.frameId, videoId);
      if (msg.type === 'ARCHIVE_PLAYER_STARTED') capture.ready.add(videoId);
      if (msg.type === 'ARCHIVE_PLAYER_ERROR') capture.errors.set(videoId, 'The player could not start playback. Check access in Chessable.');
    }
    respond({ capture: !!capture });
    return false;
  }
  if (sender.url?.split('?')[0] !== chrome.runtime.getURL('archive/archive.html')) return false;
  if (msg.type === 'ARCHIVE_CAPTURE_ARM' && Number.isInteger(msg.tabId)) {
    archiveCaptures.set(msg.tabId, { frames: new Map(), streams: new Map(), licenses: new Map(), requests: new Map(), ready: new Set(), errors: new Map() });
    respond({ ok: true });
  } else if (msg.type === 'ARCHIVE_CAPTURE_GET') {
    const capture = archiveCaptures.get(msg.tabId);
    respond({ ok: !!capture, ready: capture ? [...capture.ready] : [], errors: capture ? Object.fromEntries(capture.errors) : {},
      streams: capture ? Object.fromEntries([...capture.streams].map(([id, stream]) => [id, { ...stream, license: capture.licenses.get(id) || null }])) : {} });
  } else if (msg.type === 'ARCHIVE_CAPTURE_END') {
    archiveCaptures.delete(msg.tabId);
    respond({ ok: true });
  }
  return false;
});
