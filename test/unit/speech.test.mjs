import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fromWav, SAMPLE_RATE, toWav } from '../../src/core/speech/transcriber.mjs';
import { createSegmenter } from '../../src/core/speech/voice.mjs';

// test/fixtures/speech.wav: 0.8 s silence, a sentence, 2 s silence, a sentence, 1.2 s silence (Windows TTS)
const fixture = fromWav(fs.readFileSync(new URL('../fixtures/speech.wav', import.meta.url)));
const T0 = Date.parse('2026-01-01T00:00:00Z');

/** Feeds the fixture in 100 ms chunks, as the microphone would, with trailing silence. */
function stream(segmenter, samples = fixture) {
  const chunk = SAMPLE_RATE / 10;
  const padded = new Float32Array(samples.length + SAMPLE_RATE * 2);
  padded.set(samples);
  for (let i = 0; i < padded.length; i += chunk) segmenter.push(padded.slice(i, i + chunk), T0 + (i / SAMPLE_RATE) * 1000);
}

test('open mic splits speech on silence', () => {
  const starts = [];
  const utterances = [];
  const seg = createSegmenter({ mode: 'open-mic', onStart: s => starts.push(s), onUtterance: u => utterances.push(u) });
  stream(seg);
  assert.equal(utterances.length, 2, `utterances at ${utterances.map(u => u.at - T0)}`);
  assert.deepEqual(starts.map(s => s.id), [1, 2]);
  const [a, b] = utterances;
  assert.ok(a.at - T0 > 300 && a.at - T0 < 900, `first starts near 0.8 s (${a.at - T0})`);
  assert.ok(b.at - a.end > 1200, 'the pause separates them');
  assert.ok(a.samples.length / SAMPLE_RATE > 1.5 && a.samples.length / SAMPLE_RATE < 4, 'roughly a sentence long');
});

test('a click or cough that starts an utterance is discarded, and says so', () => {
  const starts = [];
  const discarded = [];
  const utterances = [];
  const seg = createSegmenter({ mode: 'open-mic', onStart: s => starts.push(s), onUtterance: u => utterances.push(u), onDiscard: d => discarded.push(d) });
  const burst = new Float32Array(SAMPLE_RATE * 2);
  for (let i = 0; i < SAMPLE_RATE * 0.15; i++) burst[SAMPLE_RATE / 2 + i] = Math.sin(i / 3) * 0.5; // 150 ms of noise
  stream(seg, burst);
  assert.equal(starts.length, 1);
  assert.deepEqual(discarded.map(d => d.id), [starts[0].id]);
  assert.equal(utterances.length, 0);
});

test('nothing is kept while muted', () => {
  const utterances = [];
  const seg = createSegmenter({ mode: 'open-mic', onUtterance: u => utterances.push(u) });
  seg.setMuted(true);
  stream(seg);
  assert.equal(utterances.length, 0);
});

test('push-to-talk keeps exactly the pressed span plus a short tail', () => {
  const utterances = [];
  const seg = createSegmenter({ mode: 'push-to-talk', onUtterance: u => utterances.push(u) });
  const chunk = SAMPLE_RATE / 10;
  for (let i = 0; i < fixture.length; i += chunk) {
    const at = T0 + (i / SAMPLE_RATE) * 1000;
    if (i === SAMPLE_RATE) seg.talk(true, at); // press at 1 s
    if (i === SAMPLE_RATE * 3) seg.talk(false, at); // release at 3 s
    seg.push(fixture.slice(i, i + chunk), at);
  }
  assert.equal(utterances.length, 1);
  const seconds = utterances[0].samples.length / SAMPLE_RATE;
  assert.ok(seconds > 2.2 && seconds < 2.8, `about 2 s plus pre-roll and tail (${seconds})`);
});

test('WAV round trip', () => {
  const back = fromWav(toWav(fixture));
  assert.equal(back.length, fixture.length);
  assert.ok(Math.abs(back[5000] - fixture[5000]) < 1e-3);
});
