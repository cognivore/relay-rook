"use strict";

// Read the same rendered library/chapters the signed-in user can browse.
// Never starts video playback or a MoveTrainer session.
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
      if ([...document.querySelectorAll('input[type="password"]')].some(visible)) throw Error("Sign in to Chessable, then retry the scan.");
      if (document.querySelector('a.bookTitle, h1.courseUI-bookChapter, [data-testid="filter-by-trigger"], [data-san]')) {
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
    }));
    if (chapters.some(c => !c.title)) throw Error('A chapter title is missing; scan stopped.');
    if (!chapters.length) throw Error("No chapter links found; check course access in the scan tab.");
    return { chapters };
  }
  async function lessons() {
    const filter = document.querySelector('label[title="Filter by video"] input');
    const previous = filter?.checked;
    try {
      if (previous) { filter.click(); await pause(500); }
      const seen = new Set(), lessons = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const url = new URL(a.href);
        const match = url.pathname.match(/^\/variation\/(\d+)\/?$/);
        if (url.origin !== location.origin || !match || seen.has(match[1])) continue;
        const title = clean(a.textContent);
        if (!title || title === 'Click Here For Problem Solution') continue;
        seen.add(match[1]);
        lessons.push({ id: match[1], title, order: lessons.length + 1, url: url.origin + url.pathname });
      }
      if (!lessons.length) throw Error('No book lessons found after clearing the video filter. This chapter needs review.');
      return { lessons };
    } finally { if (previous && !filter.checked) filter.click(); }
  }
  function readable(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';
    if (node.matches('script,style')) return '';
    if (node.tagName === 'BR') return '\n';
    if (node.matches('[role="img"][data-piece]')) {
      const symbols = {king:'♔',queen:'♕',rook:'♖',bishop:'♗',knight:'♘',pawn:'♙'};
      return symbols[node.dataset.piece] || node.getAttribute('aria-label') || '';
    }
    if (node.tagName === 'IMG') return node.alt;
    const body = [...node.childNodes].map(readable).join('');
    return /^(P|DIV|LI|UL|OL)$/.test(node.tagName) ? '\n' + body + '\n' : body;
  }
  async function lesson(meta) {
    if (!meta || location.pathname.replace(/\/$/,'') !== `/variation/${meta.id}`) throw Error('Lesson identity mismatch.');
    const breadcrumb = [...document.querySelectorAll('a[href]')].some(a => new URL(a.href).pathname.replace(/\/$/,'') === `/course/${meta.courseId}/${meta.chapterId}`);
    if (!breadcrumb) throw Error('The lesson does not belong to the expected course chapter.');
    const rewind = document.querySelector('.board-btns__btn .fa-fast-backward')?.closest('button');
    if (!rewind) throw Error('Cannot locate the starting-position control.');
    if (!rewind.disabled) {
      rewind.click();
      for(let n=0;n<40 && !rewind.disabled;n++)await pause(50);
      if(!rewind.disabled)throw Error('The board did not reach the starting position.');
    }
    const initialFen = Book.fen(document.querySelector('#inputFEN')?.value);
    const root = document.querySelector('#theOpeningMoves');
    if (!root) throw Error('The lesson move tree is missing.');
    const tokens = [], comments = [];
    let moves = 0;
    function walk(node) {
      if (node.nodeType === 3) {
        const value = node.textContent.trim();
        if (!value) return;
        if (/^[()]+$/.test(value)) { for (const c of value) tokens.push({kind:c==='('?'open':'close'}); return; }
        throw Error(`Unrecognized text outside the move commentary: ${value.slice(0,60)}`);
      }
      if (node.nodeType !== 1) return;
      if (node.matches('.commentInVariation')) {
        const value = Book.text(readable(node)).replace(/\n[ \t]+/g,'\n');
        if (value) { tokens.push({kind:'comment', text:value}); comments.push(node.innerHTML); }
        return;
      }
      if (node.matches('.commentSubvar')) {
        tokens.push({kind:'open'});
        for (const child of node.childNodes) walk(child);
        tokens.push({kind:'close'}); return;
      }
      if (node.matches('[data-san]')) {
        let san=node.dataset.san, number=node.dataset.move, annotation=clean(node.querySelector('.annotation')?.textContent);
        if (node.matches('.subvariation-context-menu__trigger')) {
          const value=readable(node).replace(/[♔♕♖♗♘♙]/g,c=>({'♔':'K','♕':'Q','♖':'R','♗':'B','♘':'N','♙':''}[c])).trim();
          const match=value.match(/^(\d+\.(?:\.\.)?)\s*(\S+?)([!?]{0,2})$/);
          if(!match || match[2].replace(/[+#]$/,'')!==san.replace(/[+#]$/,'')) throw Error('The displayed subvariation disagrees with its move data.');
          [,number,san,annotation]=match;
        }
        tokens.push({kind:'move',san,number,fen:node.dataset.fen,annotation});
        moves++; return;
      }
      if (node.matches('.openingNum')) return;
      for (const child of node.childNodes) walk(child);
    }
    for (const child of root.childNodes) walk(child);
    if (moves !== root.querySelectorAll('[data-san]').length) throw Error('Some moves were nested inside unsupported commentary markup. Refusing an incomplete export.');
    const result = {...meta, initialFen, tokens, commentHtml:comments, captured:new Date().toISOString()};
    result.pgn = Book.pgn(result);
    return { lesson:result };
  }
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.type !== 'ARCHIVE_SCAN' || !location.hash.startsWith('#relay-rook-archive=')) return false;
    (async () => {
      await ready();
      if (msg.mode === 'library' && location.pathname === '/') return library();
      if (msg.mode === 'chapters') return chapters();
      if (msg.mode === 'lessons') return lessons();
      if (msg.mode === 'lesson') return lesson(msg.lesson);
      throw Error('Invalid archive scan request.');
    })().then(data => respond({ ok: true, ...data }), error => respond({ ok: false, error: error.message }));
    return true;
  });
})();
