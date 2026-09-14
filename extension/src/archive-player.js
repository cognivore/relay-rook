"use strict";
(async () => {
  const response = await chrome.runtime.sendMessage({ type: 'ARCHIVE_PLAYER_READY' });
  if (!response?.capture) return;
  for (let attempt = 0; attempt < 40; attempt++) {
    const button = document.querySelector('button[data-play-button="true"]');
    const video = document.querySelector('video');
    if (button && video) {
      const started = () => {
        video.pause();
        chrome.runtime.sendMessage({ type: 'ARCHIVE_PLAYER_STARTED' }).catch(() => {});
      };
      video.addEventListener('playing', started, { once: true });
      video.addEventListener('error', () => chrome.runtime.sendMessage({ type: 'ARCHIVE_PLAYER_ERROR' }).catch(() => {}), { once: true });
      video.muted = true;
      if (!video.paused && video.readyState >= 3) started();
      else button.click();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await chrome.runtime.sendMessage({ type: 'ARCHIVE_PLAYER_ERROR' });
})();
