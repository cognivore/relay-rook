// Small DOM doubles exercise the shipped message handler, not a copied parser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../extension/src/archive-scan.js'), 'utf8');
const origin = 'https://www.chessable.com';
function anchor(href, text, video = false) {
  return { href: origin + href, textContent: text, firstElementChild: { textContent: text },
    querySelector: selector => selector.startsWith('.title') ? { textContent: text } : video ? {} : null };
}
function fixture(pathname, selectors = {}) {
  let handler;
  const context = { URL, Map, Set, Error, location: { origin, pathname, hash: '#relay-rook-archive=test' },
    setTimeout: fn => { queueMicrotask(fn); },
    window: { scrollTo() {} },
    document: { body: { scrollHeight: 100 }, querySelector: selector => selector.includes('input[type') ? null : (selectors[selector] || {}),
      querySelectorAll: selector => selectors[selector] || [] },
    chrome: { runtime: { onMessage: { addListener: fn => { handler = fn; } } } } };
  vm.runInNewContext(source, context);
  return { context, scan: mode => new Promise(resolve => handler({ type: 'ARCHIVE_SCAN', mode }, {}, resolve)),
    handler: (...args) => handler(...args) };
}
(async () => {
  const chapters = fixture('/course/123333', { 'a[href]': [
    anchor('/course/123333/0', '1. Introduction', true),
    anchor('/course/123333/10', '2. Skills to be Trained', true),
    anchor('/course/123333/0', 'Duplicate'), anchor('/course/999/1', 'Unrelated'),
  ] });
  const result = await chapters.scan('chapters');
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.chapters, c => [c.id, c.title, c.order, c.hasVideo]), [
    ['0', '1. Introduction', 1, true], ['10', '2. Skills to be Trained', 2, true],
  ]);
  const videos = fixture('/course/123333/0', { 'iframe[src]': [
    { src: 'https://player.vimeo.com/video/1133911510?app_id=122963#t=7', title: 'New Introduction' },
    { src: 'https://player.vimeo.com/video/1133911510?app_id=122963#t=8', title: 'Duplicate embed' },
    { src: 'https://player.vimeo.com/video/42?h=secret', title: 'Second video' },
    { src: 'https://justone.ai/embed/csd.html', title: 'Tracking' },
    { src: 'https://player.vimeo.com.evil/video/1', title: 'Wrong host' },
  ] });
  const found = await videos.scan('videos');
  assert.equal(found.videos.length, 2);
  assert.equal(new URL(found.videos[0].url).hash, '');
  assert.equal(found.videos[1].url, 'https://player.vimeo.com/video/42?h=secret');
  const trigger = { textContent: 'Active', click() {} };
  const option = label => ({ textContent: label, getClientRects: () => [{}], click: () => { trigger.textContent = label; } });
  const library = fixture('/', {
    '[data-testid="filter-by-trigger"]': trigger,
    '[role="option"]': [option('All'), option('Active')],
    'a.bookTitle': [anchor('/course/123333', 'Calculation'), anchor('/course/123333', 'Calculation'), anchor('/course/351885', '1.g3')],
  });
  const courses = await library.scan('library');
  assert.equal(courses.courses.length, 2);
  assert.equal(trigger.textContent, 'Active', 'Restore the original library filter');
  library.context.location.hash = '';
  assert.equal(library.handler({ type: 'ARCHIVE_SCAN', mode: 'library' }, {}, () => {}), false);
  const missing = await fixture('/course/123333').scan('chapters');
  assert.equal(missing.ok, false, 'Never report an empty/inaccessible course as scanned');
  console.log('Scanner checks passed: library, chapter order, multiple players, deduplication, origin checks, scan isolation.');
})();
