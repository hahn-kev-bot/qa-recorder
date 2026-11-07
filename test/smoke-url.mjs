// End-to-end: a website target (fixture site in Chrome/Edge) with setup steps, a note on an open popup, an element
// note, error capture with an ignore rule, a page change, and Finish from the toolbar.
import assert from 'node:assert/strict';
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
console.log(`\nPASS. Session folder: ${session.dir}`);
process.exit(0);
