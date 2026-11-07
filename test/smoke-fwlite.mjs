// End-to-end on Windows: the bundled fwlite-maui target (latest develop build, downloaded if needed) through its
// setup steps, then act as the tester on a second CDP connection: region and element notes, a note on an open
// popup, the side toggle, and Finish. Usage: node test/smoke-fwlite.mjs [--exe <FwLiteMaui.exe>]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { startSession } from '../src/core/recorder.mjs';
import { getTarget } from '../src/core/targets.mjs';

const { values } = parseArgs({ options: { exe: { type: 'string' } } });
const target = await getTarget('fwlite-maui');
const session = await startSession(target, { exe: values.exe, log: m => console.log('[session]', m) });
await session.ready;

const page = session.page;
assert.match(new URL(page.url()).pathname, /^\/project\//, 'setup steps opened the example project');
await page.waitForTimeout(3000); // let the entry list render
const vw = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
const countIs = n => page.waitForFunction(c => document.getElementById('qa-recorder-root').shadowRoot.querySelector('.count').textContent === c, String(n));

await page.keyboard.press('F9');
await page.mouse.move(40, 120);
await page.mouse.down();
await page.mouse.move(vw.w / 3, vw.h / 2, { steps: 5 });
await page.mouse.up();
await page.keyboard.type('Smoke test: region note\nsecond line');
await page.keyboard.press('Control+Enter');
await countIs(1);

await page.keyboard.press('F8');
await page.mouse.move(vw.w / 2, 30);
await page.mouse.click(vw.w / 2, 30);
await page.locator('#qa-recorder-root').locator('.kinds button[data-kind="idea"]').click();
await page.keyboard.type('Smoke test: element note');
await page.keyboard.press('Control+Enter');
await countIs(2);

// a note about an open popup: using the toolbar must not close it (popups close on clicks/focus outside them)
await page.getByRole('button', { name: 'Toggle filters' }).click();
const popupContent = page.getByText('Specific field');
await popupContent.waitFor();
const toolbar = page.locator('#qa-recorder-root .bar');
await toolbar.locator('button[data-act="region"]').click();
assert.ok(await popupContent.isVisible(), 'popup still open after clicking the toolbar');
const box = await popupContent.boundingBox();
await page.mouse.move(box.x - 20, box.y - 20);
await page.mouse.down();
await page.mouse.move(box.x + 250, box.y + 120, { steps: 5 });
await page.mouse.up();
assert.ok(await popupContent.isVisible(), 'popup still open after dragging a region');
await page.keyboard.type('Smoke test: popup note');
await page.keyboard.press('Control+Enter');
await countIs(3);
assert.ok(await popupContent.isVisible(), 'popup still open after saving the note');

// Escape cancels a capture without closing the popup
await page.keyboard.press('F9');
await page.keyboard.press('Escape');
assert.ok(await popupContent.isVisible(), 'popup still open after cancelling a capture');

await toolbar.locator('button[data-act="side"]').click();
assert.match(await toolbar.getAttribute('class'), /\bright\b/, 'toolbar moved to the right');

// Finish needs two clicks, then ends the session and closes the app
await toolbar.locator('button[data-act="finish"]').click();
await toolbar.locator('button[data-act="finish"]').click();
const { notes, events } = await session.done;

assert.equal(notes.length, 3);
assert.equal(notes[0].kind, 'bug');
assert.ok(notes[0].rect && notes[0].screenshots.crop, 'region note has a crop');
assert.equal(notes[1].kind, 'idea');
assert.equal(notes[1].text, 'Smoke test: element note', 'typing after picking a kind lands in the note');
assert.ok(notes[1].target?.tag, 'element note describes its target');
assert.equal(notes[2].text, 'Smoke test: popup note');
for (const n of notes) {
  for (const shot of Object.values(n.screenshots).filter(Boolean)) {
    const { size } = await fs.stat(path.join(session.dir, shot));
    assert.ok(size > 1000, `${shot} is a real image`);
  }
}
assert.ok(!events.some(e => e.url?.endsWith('/favicon.ico')), 'favicon errors ignored by the target config');
const md = await fs.readFile(path.join(session.dir, 'feedback.md'), 'utf8');
assert.match(md, /Smoke test: region note/);
assert.match(md, /second line/);
const handoff = await fs.readFile(path.join(session.dir, 'HANDOFF.md'), 'utf8');
assert.match(handoff, /frontend\/viewer\/src/);
assert.doesNotMatch(handoff, /\$\{build\.sha\}/, 'variables expanded in the handoff hints');
const appData = await fs.readdir(path.join(session.dir, '.app-data'));
assert.ok(appData.some(f => f.toLowerCase().startsWith('example-project')), `example project created in the session folder (${appData})`);
console.log(`\nPASS. Session folder: ${session.dir}`);
process.exit(0);
