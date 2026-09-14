"use strict";
const $ = id => document.getElementById(id);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let config, scanning = false, stop = false, scannerId = null, paused = false, logJobId = null;
const priorityCourse = new URL(location.href).searchParams.get('course');
let report = { courses: [], issues: [], events: [] };
const jobStates = new Map();
function renderActivity() {
  $('activity').textContent = report.events?.map(e => `[${e.at}] ${e.level.toUpperCase()} ${e.message}`).join('\n') || 'No scan activity yet.';
  $('activity').scrollTop = $('activity').scrollHeight;
}
function log(message, level = 'info') {
  report.events ||= [];
  report.events.push({ at: new Date().toISOString(), level, message });
  if (report.events.length > 500) report.events.shift();
  renderActivity();
  chrome.storage.local.set({ archiveScanReport: report }).catch(error => {
    $('scan').textContent = `Could not save scan report: ${error.message}`;
  });
}
function stage(message) { $('scan').textContent = message; log(message); }
function issue(details) {
  report.issues.push(details);
  log([details.course, details.chapter, details.error].filter(Boolean).join(' · '), 'error');
}
async function refreshDownloadLog() {
  if (!logJobId) return;
  try { $('download-log').textContent = (await api(`/logs/${logJobId}`)).text; }
  catch (error) { $('download-log').textContent = error.message; }
}
const api = async (path, data) => {
  if (!config) throw Error('Start the local archive helper first.');
  const response = await fetch(`http://127.0.0.1:8675${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json();
  if (!response.ok) throw Error(body.error || `Archive helper returned ${response.status}.`);
  return body;
};
async function refresh() {
  try {
    if (!config) {
      const response = await fetch('local-config.json', { cache: 'no-store' });
      if (!response.ok) throw Error('Archive helper has not been set up.');
      config = await response.json();
    }
    const state = await api('/state');
    paused = state.paused;
    $('setup').hidden = true;
    $('start').disabled = scanning;
    $('pause').disabled = false;
    $('retry').disabled = false;
    $('pause').textContent = paused ? 'Resume downloads' : 'Pause after current video';
    $('folder').textContent = `Archive folder: ${state.root}`;
    if (state.widevine) $('widevine').textContent = state.widevine.devicePresent
      ? 'A local Widevine device file is present. License-server acceptance is checked for each encrypted video.'
      : `Encrypted videos require a local Widevine device provision: ${state.widevine.devicePath}. The helper cannot generate that provision.`;
    const done = state.jobs.filter(j => j.status === 'complete').length;
    const failed = state.jobs.filter(j => j.status === 'failed').length;
    const rescan = state.jobs.filter(j => j.status === 'needs_rescan').length;
    $('status').textContent = `${done} / ${state.jobs.length} videos saved · ${failed} failed${rescan ? ` · ${rescan} need a fresh scan` : ''}${paused ? ' · Downloads paused' : ''}`;
    $('jobs').replaceChildren(...state.jobs.map(job => {
      if (jobStates.get(job.id) !== `${job.status}:${job.error}`) {
        jobStates.set(job.id, `${job.status}:${job.error}`);
        log(`${job.course} · ${job.chapter} · ${job.error || job.status}`, ['failed', 'needs_rescan'].includes(job.status) ? 'error' : 'info');
      }
      const tr = document.createElement('tr');
      for (const text of [`${job.course} / ${job.chapter}`, job.title, job.error || job.status]) {
        const td = document.createElement('td'); td.textContent = text; tr.append(td);
      }
      const button = document.createElement('button'); button.textContent = 'View log';
      button.addEventListener('click', () => {
        logJobId = job.id;
        $('download-title').textContent = `Download log · ${job.title}`;
        refreshDownloadLog();
      });
      tr.lastElementChild.append(button);
      if (['failed', 'needs_rescan'].includes(job.status)) tr.className = 'error';
      return tr;
    }));
    if (!logJobId && state.jobs.length) {
      const job = state.jobs.find(j => j.status === 'downloading') || state.jobs.at(-1);
      logJobId = job.id; $('download-title').textContent = `Download log · ${job.title}`;
    }
    await refreshDownloadLog();
  } catch (error) {
    config = null;
    $('start').disabled = true; $('pause').disabled = true; $('retry').disabled = true;
    $('setup').hidden = false;
    $('status').textContent = `Archive helper unavailable. ${error.message}`;
  }
}
async function scanPage(url, mode) {
  if (stop) throw Error('Scan stopped. Queued downloads are retained.');
  const target = new URL(url);
  if (target.origin !== 'https://www.chessable.com') throw Error('Unexpected course host.');
  target.hash = `relay-rook-archive=${crypto.randomUUID()}`;
  if (scannerId === null) {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    scannerId = tab.id;
  }
  const armed = await chrome.runtime.sendMessage({ type: 'ARCHIVE_CAPTURE_ARM', tabId: scannerId });
  if (!armed?.ok) throw Error('The capture listener did not start. Reload Relay Rook and retry.');
  log(`Opening ${mode}: ${url}`);
  await chrome.tabs.update(scannerId, { url: target.href });
  let loaded = false;
  let lastUrl = '';
  for (let n = 0; n < 90; n++) {
    if (stop) throw Error('Scan stopped. Queued downloads are retained.');
    const tab = await chrome.tabs.get(scannerId);
    lastUrl = tab.url || '';
    if (tab.status === 'complete' && lastUrl !== 'about:blank') {
      const actual = new URL(lastUrl);
      // Chessable canonicalizes /course/123 to /course/123/. Preserve the
      // origin, course/chapter, query and scan marker checks across that redirect.
      if (actual.origin === target.origin && actual.pathname.replace(/\/$/, '') === target.pathname.replace(/\/$/, '')
          && actual.search === target.search && actual.hash === target.hash) { loaded = true; break; }
      if (actual.hash === target.hash || actual.origin !== target.origin)
        throw Error(`The scan page redirected to ${actual.origin}${actual.pathname}; expected ${target.pathname}.`);
    }
    // Keep the capture service worker alive during a slow page load.
    if (n % 10 === 0) {
      const capture = await chrome.runtime.sendMessage({ type: 'ARCHIVE_CAPTURE_GET', tabId: scannerId });
      if (!capture?.ok) throw Error('The capture listener lost this scan tab. Reload Relay Rook and retry.');
    }
    await delay(500);
  }
  if (!loaded) throw Error(`Page did not finish loading within 45 seconds: ${url}`);
  const response = await chrome.tabs.sendMessage(scannerId, { type: 'ARCHIVE_SCAN', mode });
  if (!response?.ok) throw Error(response?.error || 'No response from the archive scanner. Reload the extension and retry.');
  log(`Read ${response.courses?.length ?? response.chapters?.length ?? response.videos?.length ?? 0} ${mode} entries.`);
  return response;
}
async function archiveAll() {
  // One scan even if several archive tabs were opened from the popup.
  await navigator.locks.request('relay-rook-archive', { ifAvailable: true }, async lock => {
    if (!lock) { $('scan').textContent = 'A scan is already running in another archive tab.'; return; }
    scanning = true; stop = false;
    $('start').disabled = true; $('stop').disabled = false;
    report = { started: new Date().toISOString(), courses: [], issues: [], events: [] };
    try {
      await api('/state');
      stage('Finding every course in your library…');
      const library = await scanPage('https://www.chessable.com/', 'library');
      library.courses.sort((a, b) => Number(b.id === priorityCourse) - Number(a.id === priorityCourse));
      report.courses = library.courses;
      if (priorityCourse) log(`Priority course: ${priorityCourse}.`);
      for (const course of library.courses) {
        if (stop) break;
        stage(`Reading ${course.title}…`);
        try {
          const { chapters } = await scanPage(course.url, 'chapters');
          for (const chapter of chapters) {
            if (stop) break;
            stage(`${course.title} · ${chapter.title}`);
            try {
              const { videos } = await scanPage(chapter.url, 'videos');
              if (!videos.length) issue({ course: course.title, chapter: chapter.title,
                url: chapter.url, error: chapter.hasVideo ? 'Video indicated, but no accessible Vimeo player found.' : 'No accessible video player in this chapter.' });
              for (const [index, video] of videos.entries()) {
                const videoId = new URL(video.url).pathname.split('/')[2];
                let stream, playbackStarted = false;
                for (let attempt = 0; attempt < 40; attempt++) {
                  const captured = await chrome.runtime.sendMessage({ type: 'ARCHIVE_CAPTURE_GET', tabId: scannerId });
                  if (!captured?.ok) throw Error('The capture listener lost this scan tab. Reload Relay Rook and retry.');
                  if (captured.errors?.[videoId]) throw Error(captured.errors[videoId]);
                  stream = captured?.streams?.[videoId];
                  playbackStarted = captured.ready?.includes(videoId);
                  if ((stream && playbackStarted) || stop) break;
                  await delay(500);
                }
                if (!stream) throw Error('The browser did not expose a stream for this video. Scan this chapter again after checking playback.');
                if (!playbackStarted) throw Error('Playback did not start within 20 seconds. Reload Relay Rook and check that this video plays in Chessable.');
                const jobId = `${course.id}-${chapter.id}-${videoId}`;
                log(`Captured browser stream for ${video.title}${stream.license ? ' and its license request' : ''}; sending it to the downloader.`);
                await api('/queue', { jobs: [{
                  courseId: course.id, course: course.title, chapterId: chapter.id, chapter: chapter.title,
                  order: chapter.order, videoOrder: index + 1, title: video.title,
                  url: video.url, referer: chapter.url, stream,
                }] });
                logJobId = jobId; $('download-title').textContent = `Download log · ${video.title}`;
                // Download while this exact authorized page/session is still open.
                for (;;) {
                  if (stop) break;
                  const state = await api('/state');
                  const job = state.jobs.find(j => j.id === jobId);
                  if (!job) throw Error('Queued video disappeared from the helper.');
                  if (job.status === 'complete') break;
                  if (['failed', 'needs_rescan'].includes(job.status)) throw Error(job.error);
                  $('scan').textContent = `Saving ${course.title} · ${chapter.title}`;
                  await delay(2000);
                }
              }
            } catch (error) { issue({ course: course.title, chapter: chapter.title, url: chapter.url, error: error.message }); }
            await chrome.storage.local.set({ archiveScanReport: report });
          }
        } catch (error) { issue({ course: course.title, url: course.url, error: error.message }); }
      }
      report.finished = new Date().toISOString();
      report.stopped = stop;
      stage(`${stop ? 'Scan stopped' : 'Scan finished'} · ${library.courses.length} courses · ${report.issues.length} chapters or courses need review. See the activity log below.`);
    } catch (error) {
      issue({ error: error.message });
      $('scan').textContent = error.message;
    } finally {
      await chrome.storage.local.set({ archiveScanReport: report });
      if (scannerId !== null) {
        await chrome.runtime.sendMessage({ type: 'ARCHIVE_CAPTURE_END', tabId: scannerId }).catch(error => log(error.message, 'error'));
        await chrome.tabs.remove(scannerId).catch(() => {});
      }
      scannerId = null; scanning = false;
      $('stop').disabled = true;
      await refresh();
    }
  });
}
$('start').addEventListener('click', () => archiveAll().catch(error => { $('scan').textContent = error.message; log(error.message, 'error'); }));
$('stop').addEventListener('click', () => { stop = true; $('stop').disabled = true; stage('Stopping the scan; queued downloads are retained.'); });
$('pause').addEventListener('click', async () => { try { await api('/pause', { paused: !paused }); await refresh(); } catch (e) { $('scan').textContent = e.message; } });
$('retry').addEventListener('click', async () => { try { await api('/retry', {}); await refresh(); } catch (e) { $('scan').textContent = e.message; } });
$('report').addEventListener('click', async () => {
  const saved = (await chrome.storage.local.get('archiveScanReport')).archiveScanReport || report;
  const url = URL.createObjectURL(new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'relay-rook-scan-report.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
(async () => {
  const saved = (await chrome.storage.local.get('archiveScanReport')).archiveScanReport;
  if (saved) {
    report = saved;
    if (!report.events) report.events = report.issues.map(i => ({ at: report.started || 'Previous scan', level: 'error',
      message: [i.course, i.chapter, i.error].filter(Boolean).join(' · ') }));
    renderActivity();
  }
  await refresh();
  setInterval(refresh, 3000);
})();
