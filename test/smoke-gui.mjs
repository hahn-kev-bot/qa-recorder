// End-to-end through the desktop app: create a target from a URL, start and finish a session from the GUI, watch a
// note arrive live (the test drives the page through a CDP target), copy the hand-off, clean up.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, chromium } from 'playwright-core';
import { freePort } from '../src/core/launch.mjs';
import { qaHome } from '../src/core/paths.mjs';
import { fromWav } from '../src/core/speech/transcriber.mjs';
import { serveFixture } from './fixtures/server.mjs';

// editors built on Electron set ELECTRON_RUN_AS_NODE for their terminals; it would start Electron as plain Node
function withoutRunAsNode() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-recorder-smoke-gui-'));
const site = await serveFixture();
const fakeBuild = path.join(home, 'builds', 'sillsdev_languageforge-lexbox', '1-fw-lite-portable');
await fs.mkdir(fakeBuild, { recursive: true });
await fs.writeFile(path.join(fakeBuild, 'qa-recorder-build.json'), JSON.stringify({
  source: 'github-actions', repo: 'sillsdev/languageforge-lexbox', artifact: 'fw-lite-portable', runId: '1',
  sha: 'fake01aaaa', title: 'Fake download', createdAt: new Date().toISOString(),
}));
// QA_RECORDER_EXE: test the packaged app (npm run dist, then dist/win-unpacked/QA Recorder.exe) instead of the checkout
const packaged = process.env.QA_RECORDER_EXE;
const electronApp = await _electron.launch({
  executablePath: packaged ?? createRequire(import.meta.url)('electron'),
  args: packaged ? [] : [path.resolve(fileURLToPath(new URL('..', import.meta.url)))], // no trailing slash: it would escape the closing quote
  // the speech model is shared with your real data folder so it downloads at most once
  env: { ...withoutRunAsNode(), QA_RECORDER_HOME: home, QA_RECORDER_MODELS: path.join(qaHome(), 'models'), QA_RECORDER_NO_BROWSER: '1' },
});
const win = await electronApp.firstWindow();
win.on('console', m => { if (m.type() === 'error') console.log('[window]', m.text()); });
const pageErrors = [];
win.on('pageerror', e => pageErrors.push(e));
const nav = name => win.locator('#sidebar').getByRole('button', { name });
const main = win.locator('#main');

// bundled targets are listed; sessions default to the newest download rather than downloading
await nav(/FW Lite \(Windows\)/).click();
await main.locator('#build-choice').waitFor({ timeout: 30_000 });
assert.match(await main.locator('#build-choice option:checked').textContent(), /^fake01a · Fake download .*\(newest download\)$/);
assert.equal(await main.locator('#build-choice option').count(), 1, 'no "download the latest" choice in the list');

// --- a target from a URL, with live validation
await nav('＋ New target').click();
// a bare host, as people type it, submitted with Enter
await win.locator('#new-url').fill(site.url.replace('http://', ''));
await win.locator('#new-url').press('Enter');
await main.getByText('Matches the schema.').waitFor();
assert.equal(await win.locator('#target-id').inputValue(), '127-0-0-1');
const json = win.locator('#target-json');
assert.match(await json.inputValue(), /"type": "browser"/);
assert.ok((await json.inputValue()).includes(`"url": "${site.url}"`), 'a local host gets http://');
// something that isn't an address explains itself instead of failing silently
await win.locator('#new-url').fill('not a url');
await win.getByRole('button', { name: 'Fill in' }).click();
await win.locator('#toast').getByText("isn't a web address").waitFor();
await json.fill('{ "name": "Broken", "launch": { "type": "browser" } }');
await main.getByText("/launch: must have required property 'url'").waitFor();
await win.locator('#target-id').fill('fixture');
await json.fill(JSON.stringify({ name: 'Fixture shop', launch: { type: 'browser', url: site.url } }, null, 2));
await main.getByText('Matches the schema.').waitFor();
await main.getByRole('button', { name: 'Save', exact: true }).click();
await main.getByRole('heading', { name: 'Fixture shop' }).waitFor();
await fs.access(path.join(home, 'targets', 'fixture.json'));

// --- start a browser session from the GUI, finish it from the GUI
await main.getByRole('button', { name: '▶ Start session' }).click();
await main.getByRole('button', { name: 'Finish session' }).waitFor();
await main.locator('.badge.running').waitFor({ timeout: 60_000 });
await main.getByRole('button', { name: 'Finish session' }).click();
await main.locator('.badge.ended').waitFor({ timeout: 30_000 });
await main.getByText('No notes or spoken remarks in this session.').waitFor();

// --- a CDP target: the test owns the browser, so it can act as the tester while the GUI watches
const port = await freePort();
const browser = await chromium.launch({ channel: 'msedge', headless: false, args: [`--remote-debugging-port=${port}`] })
  .catch(() => chromium.launch({ channel: 'chrome', headless: false, args: [`--remote-debugging-port=${port}`] }));
const page = await browser.newPage();
await page.goto('about:blank');
await nav('＋ New target').click();
await win.locator('#target-id').fill('fixture-cdp');
await json.fill(JSON.stringify({
  name: 'Fixture over CDP',
  launch: { type: 'cdp', cdpUrl: `http://127.0.0.1:${port}` },
  setup: [{ goto: site.url }, { waitFor: { text: 'Fixture shop' } }],
  handoff: { workspace: 'the fixture repo' },
}));
await main.getByText('Matches the schema.').waitFor();
await main.getByRole('button', { name: 'Save and start' }).click();
await main.locator('.badge.running').waitFor({ timeout: 60_000 });

await page.waitForFunction(() => !!document.getElementById('qa-recorder-root'));
await page.keyboard.press('F9');
await page.mouse.move(30, 30);
await page.mouse.down();
await page.mouse.move(400, 200, { steps: 4 });
await page.mouse.up();
await page.keyboard.type('Heading is too plain');
await page.keyboard.press('Control+Enter');

const card = main.locator('.note').first();
await card.getByText('Heading is too plain').waitFor({ timeout: 15_000 });
const img = card.locator('img');
await win.waitForFunction(el => el.complete && el.naturalWidth > 0, await img.elementHandle());
await main.getByRole('button', { name: 'Copy hand-off' }).click();
const copied = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
assert.match(copied, /^Read .+HANDOFF\.md and follow it\.$/);
const handoff = await fs.readFile(copied.slice(5, -' and follow it.'.length), 'utf8');
assert.match(handoff, /Fixture over CDP/);

// the live timeline picks up what the tester does
await page.getByRole('button', { name: 'Open menu' }).click();
await main.locator('#timeline').getByText('click button “Open menu”').waitFor({ timeout: 10_000 });

await main.getByRole('button', { name: 'Finish session' }).click();
await main.locator('.badge.ended').waitFor({ timeout: 30_000 });
await browser.close().catch(() => {});

// the trace opens in Playwright's Trace Viewer (served only, no browser tab, in tests)
await main.getByRole('button', { name: 'trace', exact: true }).click();
const viewer = await win.locator('#toast').getByText(/^Trace Viewer: http/).textContent({ timeout: 30_000 });
const viewerUrl = viewer.replace('Trace Viewer: ', '');
assert.equal((await fetch(viewerUrl)).status, 200, 'the trace viewer serves');

// --- the sessions list and cleanup
await nav('All sessions').click();
await main.locator('tr.clickable').nth(1).waitFor();
assert.equal(await main.locator('tr.clickable').count(), 2);
await nav('Storage and cleanup').click();
await win.locator('#older-than').fill('0');
await win.locator('#only-empty').check();
win.once('dialog', d => d.accept());
await main.getByRole('button', { name: 'Delete', exact: true }).first().click();
await win.locator('#toast').getByText('Deleted 1 session(s).').waitFor();
const left = await fs.readdir(path.join(home, 'sessions'));
assert.equal(left.length, 1, 'only the session with a note is left');
assert.match(left[0], /fixture-cdp$/);

// --- the About page: version, the app's folders, and the icon actually loads
await nav('About').click();
const version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
await main.getByText(`Version ${version}`).waitFor();
await main.getByRole('button', { name: 'Source, issues and docs on GitHub' }).waitFor();
assert.ok((await main.textContent()).includes(home), 'shows the data folder');
await win.waitForFunction(() => document.querySelector('.about-head img')?.naturalWidth > 0, null, { timeout: 5000 });
// updates: the checkout says to use git; the installed app checks GitHub releases
if (packaged) await main.locator('.card', { hasText: 'Updates' }).getByText(/Checking|newest|Downloading|downloaded|Couldn't check/).waitFor({ timeout: 30_000 });
else await main.getByText('Running from a source checkout').waitFor();
await win.screenshot({ path: path.join(home, 'about.png') });

// speech: the transcriber runs in its own process (in the installed app too) and hears the fixture's words
const speech = Array.from(fromWav(await fs.readFile(new URL('./fixtures/speech.wav', import.meta.url))));
const heard = await win.evaluate(s => window.qa.invoke('mic:test', Float32Array.from(s)), speech);
assert.match(heard.text, /search|button|filter|remember/i, `transcribed: ${heard.text}`);

assert.deepEqual(pageErrors.map(String), [], 'the window had no uncaught errors');
await electronApp.close();
site.close();
console.log(`\nPASS. Home: ${home}`);
process.exit(0);
