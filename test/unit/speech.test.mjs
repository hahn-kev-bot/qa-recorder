import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createWavWriter, fromWav, SAMPLE_RATE, toWav } from '../../src/core/speech/transcriber.mjs';
import { pickScreenshot } from '../../src/core/speech/session-voice.mjs';
import { createSegmenter } from '../../src/core/speech/voice.mjs';

// test/fixtures/speech.wav: 0.8 s silence, a sentence, 2 s silence, a sentence, 1.2 s silence (Windows TTS)
const fixture = fromWav(fs.readFileSync(new URL('../fixtures/speech.wav', import.meta.url)));
const T0 = Date.parse('2026-01-01T00:00:00Z');

function pressAndRelease(seg, pressAt, releaseAt) {
  const chunk = SAMPLE_RATE / 10;
  for (let i = 0; i < fixture.length; i += chunk) {
    const at = T0 + (i / SAMPLE_RATE) * 1000;
    if (i === pressAt * SAMPLE_RATE) seg.talk(true, at);
    if (i === releaseAt * SAMPLE_RATE) seg.talk(false, at);
    seg.push(fixture.slice(i, i + chunk), at);
  }
}

test('push-to-talk keeps exactly the pressed span plus a short pre-roll and tail', () => {
  const starts = [];
  const utterances = [];
  const seg = createSegmenter({ onStart: s => starts.push(s), onUtterance: u => utterances.push(u) });
  pressAndRelease(seg, 1, 3);
  assert.equal(starts.length, 1);
  assert.equal(utterances.length, 1);
  const seconds = utterances[0].samples.length / SAMPLE_RATE;
  assert.ok(seconds > 2.2 && seconds < 2.8, `about 2 s plus pre-roll and tail (${seconds})`);
  assert.ok(utterances[0].at < T0 + 1000, 'starts with the pre-roll');
});

test('nothing is kept while muted', () => {
  const utterances = [];
  const seg = createSegmenter({ onUtterance: u => utterances.push(u) });
  seg.setMuted(true);
  pressAndRelease(seg, 1, 3);
  assert.equal(utterances.length, 0);
});

test('a remark gets its own "started speaking" screenshot, else one of the page it was said on, never a stale page', () => {
  const shots = [
    { at: 1000, kind: 'speech', file: 'a.png' },
    { at: 9600, kind: 'page', file: 'p.png' }, // after the page changed at 8600
    { at: 20000, kind: 'speech', file: 'b.png' },
  ];
  assert.equal(pickScreenshot(shots, 20500, [8600]), 'b.png', 'its own');
  assert.equal(pickScreenshot(shots, 16000, [8600]), 'p.png', 'the page shot, not the older speech shot');
  assert.equal(pickScreenshot(shots.filter(s => s.kind === 'speech'), 16000, [8600]), undefined, 'no page shot: nothing rather than the login page');
  assert.equal(pickScreenshot(shots.filter(s => s.kind === 'speech'), 5000, [8600]), 'a.png', 'same page: the earlier shot is fine');
});

test('WAV round trip', () => {
  const back = fromWav(toWav(fixture));
  assert.equal(back.length, fixture.length);
  assert.ok(Math.abs(back[5000] - fixture[5000]) < 1e-3);
});

test('the streaming WAV writer makes a valid file', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-wav-')), 'session.wav');
  const writer = createWavWriter(file);
  for (let i = 0; i < fixture.length; i += 1600) writer.append(fixture.slice(i, i + 1600));
  await writer.close();
  const back = fromWav(fs.readFileSync(file));
  assert.equal(back.length, fixture.length);
  assert.equal(fs.readFileSync(file).readUInt32LE(40), fixture.length * 2, 'header has the real size');
});
