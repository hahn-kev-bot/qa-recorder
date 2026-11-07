// End-to-end voice through the desktop app. Chromium's fake microphone plays test/fixtures/speech.wav (two
// sentences, looping), so nobody has to talk. One open-mic session, then one push-to-talk session, on a CDP target
// the test drives. The speech model is shared with your real data folder so it downloads at most once.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, chromium } from 'playwright-core';
import { freePort } from '../src/core/launch.mjs';
import { qaHome } from '../src/core/paths.mjs';
import { serveFixture } from './fixtures/server.mjs';

const realModels = path.join(qaHome(), 'models');
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-recorder-smoke-voice-'));
const site = await serveFixture();
const port = await freePort();
const browser = await chromium.launch({ channel: 'msedge', headless: false, args: [`--remote-debugging-port=${port}`] })
  .catch(() => chromium.launch({ channel: 'chrome', headless: false, args: [`--remote-debugging-port=${port}`] }));
const page = await browser.newPage();
await fs.mkdir(path.join(home, 'targets'), { recursive: true });
await fs.writeFile(path.join(home, 'targets', 'voice-fixture.json'), JSON.stringify({
  name: 'Voice fixture',
  launch: { type: 'cdp', cdpUrl: `http://127.0.0.1:${port}` },
  setup: [{ goto: site.url }, { waitFor: { text: 'Fixture shop' } }],
}));

const env = { ...process.env, QA_RECORDER_HOME: home, QA_RECORDER_MODELS: realModels, QA_RECORDER_FAKE_MIC: fileURLToPath(new URL('./fixtures/speech.wav', import.meta.url)) };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [path.resolve(fileURLToPath(new URL('..', import.meta.url)))],
  env,
});
const win = await app.firstWindow();
win.on('console', m => { if (m.type() === 'error') console.log('[window]', m.text()); });
const main = win.locator('#main');
const nav = name => win.locator('#sidebar').getByRole('button', { name });

async function start(voice) {
  await nav('Voice fixture').click();
  await win.locator('#voice-choice').selectOption(voice);
  await main.getByRole('button', { name: '▶ Start session' }).click();
  await main.locator('.badge.running').waitFor({ timeout: 60_000 });
  await main.getByText('Microphone on').waitFor();
  return (await main.locator('.path').textContent()).trim();
}
async function finish() {
  await main.getByRole('button', { name: 'Finish session' }).click();
  await main.locator('.badge.ended').waitFor({ timeout: 120_000 });
}
const SENTENCES = /search button does nothing|filter to remember/i;

// --- open mic: utterances land in the timeline (with a screenshot) and in transcript.md
const openDir = await start('open-mic');
await main.locator('#timeline .tl.speech').filter({ hasText: SENTENCES }).first().waitFor({ timeout: 120_000 });
await page.getByRole('button', { name: 'Open menu' }).click(); // an action between utterances
await main.locator('#timeline .tl.speech').filter({ hasText: SENTENCES }).nth(1).waitFor({ timeout: 60_000 });
await finish();
const transcript = await fs.readFile(path.join(openDir, 'transcript.md'), 'utf8');
assert.match(transcript, /`\d\d:\d\d–\d\d:\d\d` .*search button does nothing/i);
const timeline = await fs.readFile(path.join(openDir, 'timeline.md'), 'utf8');
assert.match(timeline, /🎙 “.*(search button|filter).*” \(\[screen\]\(speech\/\d{3}\.png\)\)/i);
assert.match(timeline, /click button “Open menu”/);
assert.doesNotMatch(timeline, /transcribing/, 'every utterance was transcribed or dropped by the end');
const speechFiles = await fs.readdir(path.join(openDir, 'speech'));
assert.ok(speechFiles.some(f => f.endsWith('.wav')) && speechFiles.some(f => f.endsWith('.png')), `audio and screenshots kept (${speechFiles})`);
const handoff = await fs.readFile(path.join(openDir, 'HANDOFF.md'), 'utf8');
assert.match(handoff, /transcript\.md/);

// --- push-to-talk: a press becomes a 🎙 Spoken note, transcribed after release
const pttDir = await start('push-to-talk');
await page.waitForFunction(() => !!document.getElementById('qa-recorder-root')?.shadowRoot.querySelector('.mic'));
await page.keyboard.down('F6');
await page.waitForTimeout(6000); // longer than the loop's pause, so the press holds at least part of a sentence
await page.keyboard.up('F6');
const note = main.locator('.note').first();
await note.getByText('🎙 Spoken').waitFor({ timeout: 15_000 });
await note.locator('.text').filter({ hasText: /\w{3,}/ }).filter({ hasNotText: 'transcribing' }).waitFor({ timeout: 60_000 });
await finish();
const notes = JSON.parse(await fs.readFile(path.join(pttDir, 'notes.json'), 'utf8'));
assert.equal(notes.length, 1);
assert.equal(notes[0].kind, 'spoken');
assert.match(notes[0].text, /search|button|click|filter|remember|choice/i, `transcribed: ${notes[0].text}`);
const feedback = await fs.readFile(path.join(pttDir, 'feedback.md'), 'utf8');
assert.match(feedback, /## 001\. 🎙 Spoken: /);
assert.match(feedback, /!\[note 001\]\(speech\/001\.png\)/);

await app.close();
await browser.close();
site.close();
console.log(`\nPASS. Home: ${home}`);
process.exit(0);
