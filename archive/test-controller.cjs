// Exercise the shipped controller with Chrome/helper boundaries replaced.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('extension/archive/archive.js', 'utf8');
function fixture({ redirect = url => url.replace('/258968#', '/258968/#'), apiError = null } = {}) {
  const elements = new Map();
  function element() { return { textContent: '', children: [], listeners: {}, append(child) { this.children.push(child); this.lastElementChild = child; },
    replaceChildren(...children) { this.children = children; }, addEventListener(name, fn) { this.listeners[name] = fn; } }; }
  const tab = { id: 9, url: 'about:blank', status: 'complete' };
  const saved = [];
  const context = vm.createContext({ URL, Error, Map, Date, Blob, AbortSignal, crypto: { randomUUID: () => 'test-scan' },
    location: { href: 'chrome-extension://test/archive/archive.html?course=258968' },
    setTimeout: fn => { queueMicrotask(fn); }, setInterval() {},
    document: { getElementById: id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element },
    navigator: { locks: { request: async (_name, _opts, callback) => callback({}) } },
    fetch: async url => ({ ok: !apiError, status: apiError ? 400 : 200,
      json: async () => apiError ? { error: apiError } : url === 'local-config.json' ? { token: 'local' } : { root: '/tmp/archive', paused: false, jobs: [] } }),
    chrome: { storage: { local: { get: async () => ({}), set: async data => saved.push(JSON.parse(JSON.stringify(data))) } },
      runtime: { sendMessage: async () => ({ ok: true, streams: {} }) },
      tabs: { create: async () => tab, update: async (_id, { url }) => { tab.url = redirect(url); }, get: async () => tab,
        remove: async () => {}, sendMessage: async (_id, { mode }) => {
          if (mode === 'library') return { ok: true, courses: [{ id: '258968', title: 'Preventing Blunders', url: 'https://www.chessable.com/course/258968' }] };
          return { ok: false, error: 'Visible chapter failure' };
        } } }
  });
  vm.runInContext(source, context);
  return { context, elements, saved, run: code => vm.runInContext(code, context) };
}
(async () => {
  const canonical = fixture();
  // If the trailing-slash URL were rejected, this would time out before the
  // scanner response could surface its specific error.
  await assert.rejects(canonical.run("scanPage('https://www.chessable.com/course/258968', 'chapters')"), /Visible chapter failure/);
  const otherCourse = fixture({ redirect: url => url.replace('258968', '999') });
  await assert.rejects(otherCourse.run("scanPage('https://www.chessable.com/course/258968', 'chapters')"), /redirected/);
  const otherHost = fixture({ redirect: url => url.replace('www.chessable.com', 'evil.example') });
  await assert.rejects(otherHost.run("scanPage('https://www.chessable.com/course/258968', 'chapters')"), /redirected/);
  const missingMarker = fixture({ redirect: url => url.split('#')[0] });
  await assert.rejects(missingMarker.run("scanPage('https://www.chessable.com/course/258968', 'chapters')"), /45 seconds/);
  const badHelper = fixture({ apiError: 'Missing captured request headers; rescan this chapter.' });
  badHelper.run("config = { token: 'local' }");
  await assert.rejects(badHelper.run("api('/queue', { jobs: [] })"), /Missing captured request headers/);
  const visible = fixture();
  await new Promise(resolve => setImmediate(resolve));
  await visible.run('archiveAll()');
  assert.match(visible.elements.get('activity').textContent, /Visible chapter failure/);
  assert.ok(visible.saved.some(s => s.archiveScanReport.issues.some(i => i.error === 'Visible chapter failure')));
  assert.equal(visible.run('scanning'), false);
  assert.equal(visible.run('scannerId'), null);
  console.log('Controller checks passed: canonical redirects, strict scan identity, helper errors, visible/persisted scan failures, cleanup.');
})();
