// End-to-end: a website target (fixture site in Chrome/Edge) with setup steps, a note on an open popup, an element
// note, error capture with an ignore rule, a page change, and Finish from the toolbar.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveFixture } from './fixtures/server.mjs';

process.env.QA_RECORDER_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-recorder-smoke-url-'));
const { startSession } = await import('../src/core/recorder.mjs');
const { parseTarget } = await import('../src/core/targets.mjs');

const site = await serveFixture();
const config = await parseTarget(JSON.stringify({
  name: 'Fixture shop',
  launch: { type: 'browser', url: site.url },
  setup: [
    { fill: { placeholder: 'Find a product', value: 'teapot' } },
    { click: { role: 'button', name: 'Search', exact: true } },
    { waitFor: { text: 'Searched for teapot' } },
    { ifVisible: { text: 'Cookie banner' }, click: { text: 'Accept' } },
  ],
  capture: { ignore: [{ type: 'http', url: '*/favicon.ico' }] },
  handoff: { workspace: 'the fixture repo', hints: 'The site is test/fixtures/site.' },
}));
const session = await startSession({ id: 'fixture', config }, { log: m => console.log('[session]', m) });
await session.ready;
const page = session.page;
const root = page.locator('#qa-recorder-root');
const countIs = n => page.waitForFunction(c => document.getElementById('qa-recorder-root')?.shadowRoot.querySelector('.count')?.textContent === c, String(n));

// a note on an open popup, started from the toolbar: the popup must stay open
await page.getByRole('button', { name: 'Open menu' }).click();
const menu = page.getByText('Menu item one');
await menu.waitFor();
await root.locator('button[data-act="region"]').click();
assert.ok(await menu.isVisible(), 'menu still open after clicking the toolbar');
const box = await menu.boundingBox();
await page.mouse.move(box.x - 10, box.y - 10);
await page.mouse.down();
await page.mouse.move(box.x + 200, box.y + 80, { steps: 5 });
await page.mouse.up();
await page.keyboard.type('Menu items need icons');
await page.keyboard.press('Control+Enter');
await countIs(1);
assert.ok(await menu.isVisible(), 'menu still open after saving the note');

// the tester types a search and runs it: these become the steps before the next note
await page.keyboard.press('Escape');
await page.getByPlaceholder('Find a product').click();
await page.keyboard.press('Control+A');
await page.keyboard.type('kettle');
await page.getByRole('button', { name: 'Search', exact: true }).click(); // blurs the field, so it reports the change
await page.getByText('Searched for kettle').waitFor();

// an element note via F8
const search = await page.getByPlaceholder('Find a product').boundingBox();
await page.keyboard.press('F8');
await page.mouse.move(search.x + 10, search.y + 5);
await page.mouse.click(search.x + 10, search.y + 5);
await root.locator('.kinds button[data-kind="idea"]').click();
await page.keyboard.type('Search should suggest as I type');
await page.keyboard.press('Control+Enter');
await countIs(2);

// a page change: the toolbar comes back, and the missing image is logged
await page.getByRole('link', { name: 'Next page' }).click();
await page.waitForURL('**/page2.html');
await root.locator('button[data-act="finish"]').waitFor();

// tabs: a link that opens a new tab, on a page that only accepts Trusted Types markup (the toolbar must still load)
const [help] = await Promise.all([session.context.waitForEvent('page'), page.getByRole('link', { name: 'Open help in a new tab' }).click()]);
await help.waitForURL('**/strict.html');
await help.locator('#qa-recorder-root button[data-act="finish"]').waitFor();
await help.getByRole('button', { name: 'Got it' }).click();
// a new tab the tester opens themselves (Ctrl+T): the browser's own page, no toolbar and none of its errors
const blank = await session.context.newPage();
await blank.goto('chrome://new-tab-page/').catch(() => blank.goto('about:blank'));
await blank.waitForTimeout(500);
assert.equal(await blank.evaluate(() => !!document.getElementById('qa-recorder-root')), false, 'no toolbar on the browser\'s own page');
await blank.close();
// back to the first tab, and on to Finish there
await page.bringToFront();
await page.getByRole('heading', { name: 'Page two' }).click();
await root.locator('button[data-act="finish"]').click();
await root.locator('button[data-act="finish"]').click();
const { notes, events } = await session.done;
site.close();

assert.equal(notes.length, 2);
assert.equal(notes[0].text, 'Menu items need icons');
assert.ok(notes[0].screenshots.crop);
assert.equal(notes[1].kind, 'idea');
assert.equal(notes[1].target.attrs.placeholder, 'Find a product');
assert.ok(events.some(e => e.type === 'console.error' && e.text.includes('search backend unavailable')), 'console error from setup recorded');
assert.ok(events.some(e => e.type === 'http' && e.url.endsWith('/missing.png')), '404 recorded');
assert.ok(!events.some(e => e.url?.endsWith('/favicon.ico')), 'favicon ignored by the capture rule');
const md = await fs.readFile(path.join(session.dir, 'feedback.md'), 'utf8');
assert.match(md, /# QA session: Fixture shop/);
assert.match(md, /Menu items need icons/);
const handoff = await fs.readFile(path.join(session.dir, 'HANDOFF.md'), 'utf8');
assert.match(handoff, /Work in `the fixture repo`/);
assert.match(handoff, /The site is test\/fixtures\/site\./);
const saved = JSON.parse(await fs.readFile(path.join(session.dir, 'session.json'), 'utf8'));
assert.equal(saved.status, 'ended');
assert.equal(saved.notes, 2);

// the timeline: the tester's actions in words, setup steps marked, toolbar clicks left out
const actions = events.filter(e => e.type === 'action');
assert.ok(actions.some(a => a.setup && a.action === 'click' && a.target.name === 'Search'), 'setup click recorded as setup');
assert.ok(!actions.some(a => a.target?.name?.includes('Region')), 'toolbar clicks are not app actions');
const note1Steps = md.split('## 001.')[1].split('## 002.')[0];
assert.match(note1Steps, /Steps before this note:\s+1\. went to http:\/\/127\.0\.0\.1:\d+\/\s+2\. click button “Open menu”/);
const note2Steps = md.split('## 002.')[1];
assert.match(note2Steps, /set textbox “Search” to “kettle”/);
assert.match(note2Steps, /click button “Search”/);
assert.doesNotMatch(note2Steps, /teapot/, 'setup steps are not steps before a note');
const timeline = await fs.readFile(path.join(session.dir, 'timeline.md'), 'utf8');
assert.match(timeline, /`00:\d\d` set textbox “Search” to “teapot” _\(setup step\)_|`00:\d\d` click button “Search” _\(setup step\)_/);
assert.match(timeline, /\*\*note 001\*\*/);
assert.match(timeline, /went to `http:\/\/127\.0\.0\.1:\d+\/page2\.html`/);
assert.match(timeline, /⚠ http 404/);
assert.match(handoff, /timeline\.md/);

// tabs: which tab things happened in, and nothing from the recorder or the browser's own pages as an app error
assert.ok(!events.some(e => e.type === 'pageerror'), `no page errors (${events.filter(e => e.type === 'pageerror').map(e => e.text)})`);
assert.ok(!events.some(e => e.text === 'net::ERR_ABORTED'), 'cancelled requests are not failures');
assert.ok(events.some(e => e.type === 'action' && e.tab === 2 && e.target?.name === 'Got it'), 'the click in the new tab is tab 2\'s');
assert.match(timeline, /🗂 opened tab 2 from tab 1/);
assert.match(timeline, /tab 2 went to `http:\/\/127\.0\.0\.1:\d+\/strict\.html`|🗂 switched to tab 2/);
assert.match(timeline, /click button “Got it”/);
assert.match(timeline, /🗂 opened tab 3\n/, 'a tab opened by the tester has no opener');
assert.match(timeline, /🗂 closed tab 3/);
assert.match(timeline, /🗂 switched to tab 1 \(http:\/\/127\.0\.0\.1:\d+\/page2\.html\)\n.*click h1 “Page two”/);
assert.doesNotMatch(timeline, /chrome:\/\//, 'the browser\'s own pages are not app pages');

// the trace: saved at Finish, with the timeline as markers
assert.deepEqual(saved.trace, ['trace/001.zip']);
const traceZip = await fs.readFile(path.join(session.dir, 'trace', '001.zip'));
assert.ok(traceZip.length > 5000, 'trace has content');
const traceEvents = process.platform === 'win32'
  ? execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xOf', path.join(session.dir, 'trace', '001.zip'), 'trace.trace'], { encoding: 'utf8' })
  : execFileSync('unzip', ['-p', path.join(session.dir, 'trace', '001.zip'), 'trace.trace'], { encoding: 'utf8' });
assert.match(traceEvents, /"title":"set textbox “Search” to “kettle”"/, 'timeline markers are in the trace');
assert.match(traceEvents, /"title":"note 001 \(bug\): Menu items need icons"/);
assert.match(traceEvents, /screencast-frame/, 'the trace has screenshots');
console.log(`\nPASS. Session folder: ${session.dir}`);
process.exit(0);
