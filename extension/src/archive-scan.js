"use strict";

// Read the same rendered library/chapters the signed-in user can browse.
// No private API, cookie export, playback, or MoveTrainer interaction.
(() => {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => !!el.getClientRects().length;
  const clean = text => (text || "").replace(/[\uE000-\uF8FF]/g, "").replace(/\s+/g, " ").trim();
  const courseLink = a => {
    const url = new URL(a.href);
    return url.origin === location.origin && /^\/course\/\d+(?:\/\d+)?\/?$/.test(url.pathname);
  };
  async function ready() {
    for (let n = 0; n < 40; n++) {
      if (document.querySelector('input[type="password"]')) throw Error("Sign in to Chessable, then retry the scan.");
      if (document.querySelector('a.bookTitle, h1.courseUI-bookChapter, [data-testid="filter-by-trigger"]')) {
        await pause(1500);
        return;
      }
      await pause(500);
    }
    throw Error("Chessable did not load a library or course page. Check the scan tab, then retry.");
  }
  async function chooseFilter(label) {
    const trigger = document.querySelector('[data-testid="filter-by-trigger"]');
    if (!trigger) throw Error("Cannot find Chessable's library filter; refusing an incomplete scan.");
    if (clean(trigger.textContent) === label) return;
    trigger.click();
    for (let n = 0; n < 20; n++) {
      const option = [...document.querySelectorAll('[role="option"]')]
        .find(el => visible(el) && clean(el.textContent) === label);
      if (option) { option.click(); await pause(2000); return; }
      await pause(250);
    }
    throw Error(`Cannot select the ${label} library filter.`);
  }
  async function library() {
    const previous = clean(document.querySelector('[data-testid="filter-by-trigger"]')?.textContent);
    const courses = new Map();
    try {
      await chooseFilter("All");
      let stable = 0;
      for (let n = 0; n < 300; n++) {
        const before = courses.size;
        document.querySelectorAll('a.bookTitle').forEach(a => {
          if (!courseLink(a)) return;
          const id = new URL(a.href).pathname.split('/')[2];
          courses.set(id, { id, title: clean(a.textContent), url: `${location.origin}/course/${id}` });
        });
        const next = [...document.querySelectorAll('a,button')].find(el => visible(el)
          && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
          && (el.getAttribute('rel') === 'next' || /^(Next|Next page|Load more|Show more)$/i.test(clean(el.getAttribute('aria-label') || el.textContent))));
        if (next) { next.click(); stable = 0; }
        else { window.scrollTo(0, document.body.scrollHeight); stable = courses.size === before ? stable + 1 : 0; }
        if (stable >= 3) {
          if (!courses.size) throw Error("No library courses found. Check your login and library.");
          return { courses: [...courses.values()] };
        }
        await pause(1500);
      }
      throw Error("Library pagination did not finish; scan stopped instead of reporting a partial archive.");
    } finally {
      if (previous && previous !== "All") await chooseFilter(previous);
    }
  }
  function chapters() {
    const courseId = location.pathname.split('/')[2];
    const seen = new Set();
    const chapters = [...document.querySelectorAll('a[href]')].filter(a => {
      if (!courseLink(a)) return false;
      const match = new URL(a.href).pathname.match(/^\/course\/(\d+)\/(\d+)\/?$/);
      if (!match || match[1] !== courseId || seen.has(match[2])) return false;
      seen.add(match[2]); return true;
    }).map((a, index) => ({
      id: new URL(a.href).pathname.split('/')[3], url: a.href,
      order: index + 1,
      title: clean(a.querySelector('.title')?.textContent),
      hasVideo: /\uf03d/.test(a.textContent) || !!a.querySelector('.fa-video, .fa-video-camera'),
    }));
    if (chapters.some(c => !c.title)) throw Error('A chapter title is missing; scan stopped.');
    if (!chapters.length) throw Error("No chapter links found; check course access in the scan tab.");
    return { chapters };
  }
  async function videos() {
    // Some chapters contain several embeds. Wait for lazy players to mount.
    window.scrollTo(0, document.body.scrollHeight);
    await pause(1500);
    const videos = new Map();
    document.querySelectorAll('iframe[src]').forEach(el => {
      const url = new URL(el.src);
      if (url.origin !== 'https://player.vimeo.com' || !/^\/video\/\d+\/?$/.test(url.pathname)) return;
      url.hash = '';
      if (!clean(el.title)) throw Error('Video title is missing; scan stopped.');
      videos.set(url.pathname, { url: url.href, title: clean(el.title) });
    });
    return { videos: [...videos.values()] };
  }
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.type !== 'ARCHIVE_SCAN' || !location.hash.startsWith('#relay-rook-archive=')) return false;
    (async () => {
      await ready();
      if (msg.mode === 'library' && location.pathname === '/') return library();
      if (msg.mode === 'chapters') return chapters();
      if (msg.mode === 'videos') return videos();
      throw Error('Invalid archive scan request.');
    })().then(data => respond({ ok: true, ...data }), error => respond({ ok: false, error: error.message }));
    return true;
  });
})();
