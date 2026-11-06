// End-to-end smoke test: launch FW Lite, let the harness open the example project, then act as the tester
// through a second CDP connection (drag a region, write a note, pick an element) and check the bundle.
// Usage: node test/smoke.mjs [--exe <FwLiteMaui.exe>]   (default: latest develop build, downloaded if needed)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fetchBuild, findRun } from '../src/builds.mjs';
import { launchMaui } from '../src/launch.mjs';
import { runSession } from '../src/harness.mjs';

const { values } = parseArgs({ options: { exe: { type: 'string' } } });
const run = values.exe
  ? { databaseId: 'local', headSha: 'local-build', headBranch: 'local', displayTitle: 'local', url: '' }
  : await findRun();
const buildDir = values.exe ? undefined : (await fetchBuild(run, 'maui')).dir;
const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fwlite-qa-smoke-'));
const session = { id: 'smoke', repo: 'sillsdev/languageforge-lexbox', target: 'maui', run, startedAt: new Date().toISOString(), openExample: true };

const launcher = await launchMaui({ buildDir, sessionDir, exe: values.exe });
let ready;
const harnessReady = new Promise(r => { ready = r; });
const sessionDone = runSession({ launcher, sessionDir, session, log: m => console.log('[harness]', m), onReady: ready });
await Promise.race([harnessReady, sessionDone]);

// act as the tester on a separate connection once the harness has opened the project
const { browser, page } = await launcher.connect();
assert.match(new URL(page.url()).pathname, /^\/project\//);
await page.waitForFunction(() => !!document.getElementById('fwlite-qa-root'));
await page.waitForTimeout(3000); // let the entry list render
const vw = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));

await page.keyboard.press('F9');
await page.mouse.move(40, 120);
await page.mouse.down();
await page.mouse.move(vw.w / 3, vw.h / 2, { steps: 5 });
await page.mouse.up();
await page.keyboard.type('Smoke test: region note\nsecond line');
await page.keyboard.press('Control+Enter');
await page.waitForFunction(() => document.getElementById('fwlite-qa-root').shadowRoot.querySelector('.count').textContent === '1');

await page.keyboard.press('F8');
await page.mouse.move(vw.w / 2, 30);
await page.mouse.click(vw.w / 2, 30);
await page.locator('#fwlite-qa-root').locator('.kinds button[data-kind="idea"]').click();
await page.keyboard.type('Smoke test: element note');
await page.keyboard.press('Control+Enter');
await page.waitForFunction(() => document.getElementById('fwlite-qa-root').shadowRoot.querySelector('.count').textContent === '2');

await browser.close();
launcher.child.kill();
const { notes } = await sessionDone;

assert.equal(notes.length, 2);
assert.equal(notes[0].kind, 'bug');
assert.ok(notes[0].rect && notes[0].screenshots.crop, 'region note has a crop');
assert.equal(notes[1].kind, 'idea');
assert.equal(notes[1].text, 'Smoke test: element note', 'typing after picking a kind lands in the note');
assert.ok(notes[1].target?.tag, 'element note describes its target');
for (const n of notes) {
  for (const shot of Object.values(n.screenshots).filter(Boolean)) {
    const { size } = await fs.stat(path.join(sessionDir, shot));
    assert.ok(size > 1000, `${shot} is a real image`);
  }
}
const md = await fs.readFile(path.join(sessionDir, 'feedback.md'), 'utf8');
assert.match(md, /Smoke test: region note/);
assert.match(md, /second line/);
await fs.access(path.join(sessionDir, 'HANDOFF.md'));
const appData = await fs.readdir(path.join(sessionDir, '.app-data'));
assert.ok(appData.some(f => f.toLowerCase().startsWith('example-project')), `example project created in the session folder (${appData})`);
console.log(`\nPASS. Session folder: ${sessionDir}`);
process.exit(0);
