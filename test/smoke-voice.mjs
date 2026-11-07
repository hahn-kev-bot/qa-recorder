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

const env = { ...process.env, QA_RECORDER_HOME: home, QA_RECORDER_MODELS: realModels, QA_RECORDER_RETRANSCRIBE_MODEL: 'Xenova/whisper-base.en', QA_RECORDER_FAKE_MIC: fileURLToPath(new URL('./fixtures/speech.wav', import.meta.url)) };
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
// automatic screenshots must not touch the page (hiding the toolbar for them made it flash whenever you spoke):
// watch the toolbar on every frame while the first remark is captured
await page.waitForFunction(() => !!document.getElementById('qa-recorder-root'));
await page.evaluate(() => {
  window.__toolbarHiddenFrames = 0;
  const host = document.getElementById('qa-recorder-root');
  const watch = () => {
    if (getComputedStyle(host).display === 'none') window.__toolbarHiddenFrames++;
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
});
await main.locator('#timeline .tl.speech').filter({ hasText: SENTENCES }).first().waitFor({ timeout: 120_000 });
assert.equal(await page.evaluate(() => window.__toolbarHiddenFrames), 0, 'the toolbar never disappeared for an automatic screenshot');
await page.getByRole('button', { name: 'Open menu' }).click(); // an action between utterances
await main.locator('#timeline .tl.speech').filter({ hasText: SENTENCES }).nth(1).waitFor({ timeout: 60_000 });
// a page change: the next remark must show the new page, not the old one
await page.getByRole('link', { name: 'Next page' }).click();
const navigatedAt = Date.now();
await main.locator('#timeline .tl.speech').filter({ hasText: SENTENCES }).nth(2).waitFor({ timeout: 60_000 });
await finish();
const transcript = await fs.readFile(path.join(openDir, 'transcript.md'), 'utf8');
assert.match(transcript, /`\d\d:\d\d–\d\d:\d\d` .*search button does nothing/i);
const timeline = await fs.readFile(path.join(openDir, 'timeline.md'), 'utf8');
assert.match(timeline, /🎙 “.*(search button|filter).*” \(\[screen\]\(speech\/onset-\d{3}\.png\)\)/i);
assert.match(timeline, /click button “Open menu”/);
assert.doesNotMatch(timeline, /transcribing/, 'every utterance was transcribed by the end');
// each sentence gets the screenshot from when it was said, not the previous one's
const speechEntries = JSON.parse(await fs.readFile(path.join(openDir, 'speech.json'), 'utf8'));
const first = speechEntries.find(e => /search button does nothing when/i.test(e.text));
const second = speechEntries.find(e => /filter to remember/i.test(e.text));
assert.ok(first && second, `both sentences transcribed (${speechEntries.map(e => e.text)})`);
assert.notEqual(first.screenshot, second.screenshot, 'separate screenshots for separate remarks');
const shots = JSON.parse(await fs.readFile(path.join(openDir, 'speech', 'screenshots.json'), 'utf8'));
assert.ok(shots.some(s => s.kind === 'page' && Date.parse(s.at) > navigatedAt), 'a screenshot of the new page');
const afterNav = speechEntries.filter(e => Date.parse(e.at) > navigatedAt + 1500);
assert.ok(afterNav.length, 'a remark after the page change');
for (const e of afterNav) {
  const shot = shots.find(s => s.file === e.screenshot);
  assert.ok(shot && Date.parse(shot.at) > navigatedAt, `remark at ${e.at} shows the new page (${e.screenshot})`);
}
assert.ok(Date.parse(second.at) - Date.parse(first.at) > 3500, 'the second sentence is dated about 5 s after the first');
const speechFiles = await fs.readdir(path.join(openDir, 'speech'));
assert.ok(speechFiles.includes('session.wav') && speechFiles.some(f => f.endsWith('.png')), `the whole session's audio and screenshots kept (${speechFiles})`);
const openSession = JSON.parse(await fs.readFile(path.join(openDir, 'session.json'), 'utf8'));
assert.equal(openSession.audio.file, 'speech/session.wav');
assert.equal(openSession.voice, 'open-mic');
const handoff = await fs.readFile(path.join(openDir, 'HANDOFF.md'), 'utf8');
assert.match(handoff, /transcript\.md/);

// the session page: remarks as cards with audio, a summary, and a timeline filter
const remark = main.locator('.note').filter({ hasText: /search button does nothing/i }).first();
await remark.waitFor();
await main.locator('.stats').getByText(/spoken remarks?/).waitFor();
await main.locator('.stats').getByText('🎙 open mic').waitFor();
// a remark plays its own part of the session recording
const playSrc = await remark.getByRole('button', { name: '▶ Play' }).getAttribute('data-src');
const clipStart = Number(/#t=([\d.]+),/.exec(playSrc)[1]);
await remark.getByRole('button', { name: '▶ Play' }).click();
await win.waitForFunction(from => state.audio && !state.audio.clip.paused && state.audio.clip.currentTime > from + 0.2, clipStart, { timeout: 10_000 });
await remark.getByRole('button', { name: '▶ Play' }).click(); // stops it
await main.locator('.chip', { hasText: 'Notes & speech' }).click();
const kinds = await main.locator('#timeline .tl').evaluateAll(rows => rows.map(r => r.className));
assert.ok(kinds.length >= 2 && kinds.every(k => /\bspeech\b|\bnote\b/.test(k)), `only notes and speech shown (${kinds})`);
assert.ok(await main.locator('#timeline .tl.speech img.thumb').count() >= 2, 'speech rows have screenshots');

// re-transcribe the finished session (the fast model here; the app uses the better one)
await main.getByRole('button', { name: 'Re-transcribe with the better model' }).click(); // already downloaded: no prompt
await win.locator('#toast').getByText(/^Re-transcribed: \d+ segments?\./).waitFor({ timeout: 120_000 });
await main.getByText(/Transcribed again with whisper-base\.en/).waitFor();
assert.match(await fs.readFile(path.join(openDir, 'transcript.md'), 'utf8'), /search button does nothing/i);

// the Microphone page: level meter and a recorded test, checked and transcribed
await nav('Microphone').click();
await win.locator('#mic-choice option').first().waitFor({ state: 'attached' });
await win.waitForFunction(() => parseFloat(document.getElementById('meter-bar')?.style.width) > 0, null, { timeout: 10_000 });
await main.getByRole('button', { name: '● Record a 4-second test' }).click();
await main.getByText(/Sounds usable|Problems found/).waitFor({ timeout: 60_000 });
// the fixture is clear speech: it must pass, and be heard as words from it
assert.match(await main.textContent(), /✓ Sounds usable/);
assert.match(await main.textContent(), /Transcribed: “.*(search|button|click|filter|remember|choice).*”/i);
assert.match(await main.textContent(), /% of the speech above 1\.5 kHz/);

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
