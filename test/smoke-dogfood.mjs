// End-to-end: the bundled qa-recorder target records this app with itself. Checks the app starts with its own
// empty data folder, the toolbar works inside the Electron window, and Finish closes it.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.QA_RECORDER_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-recorder-smoke-dogfood-'));
const { startSession } = await import('../src/core/recorder.mjs');
const { getTarget } = await import('../src/core/targets.mjs');

const session = await startSession(await getTarget('qa-recorder'), { log: m => console.log('[session]', m) });
await session.ready;
const page = session.page;
const root = page.locator('#qa-recorder-root');

// the recorded app has its own data: no sessions, and it lists the bundled targets
await page.locator('#sidebar').getByRole('button', { name: 'All sessions' }).click();
await page.getByText('No sessions yet.').waitFor();
await page.locator('#sidebar').getByRole('button', { name: /QA Recorder \(this app\)/ }).waitFor();

// an element note on the recorded app's New target button
const button = await page.locator('#sidebar').getByRole('button', { name: '＋ New target' }).boundingBox();
await page.keyboard.press('F8');
await page.mouse.move(button.x + 20, button.y + 8);
await page.mouse.click(button.x + 20, button.y + 8);
await root.locator('.kinds button[data-kind="dislike"]').click();
await page.keyboard.type('The plus sign looks heavier than the text');
await page.keyboard.press('Control+Enter');
await page.waitForFunction(() => document.getElementById('qa-recorder-root').shadowRoot.querySelector('.count').textContent === '1');

await root.locator('button[data-act="finish"]').click();
await root.locator('button[data-act="finish"]').click();
const { notes } = await session.done;
assert.equal(notes.length, 1);
assert.equal(notes[0].kind, 'dislike');
assert.match(notes[0].target.text, /New target/);
const appHome = await fs.readdir(path.join(session.dir, '.app-data', 'qa-recorder-home')).catch(() => []);
assert.ok(!appHome.includes('sessions'), 'the recorded app wrote no sessions of its own');
const handoff = await fs.readFile(path.join(session.dir, 'HANDOFF.md'), 'utf8');
assert.match(handoff, /src\/gui\/renderer/);
console.log(`\nPASS. Session folder: ${session.dir}`);
process.exit(0);
