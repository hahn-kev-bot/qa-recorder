import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { analyzeAudio } from '../../src/core/speech/analyze.mjs';
import { createChunker, normalize } from '../../src/core/speech/chunker.mjs';
import { fromWav, SAMPLE_RATE } from '../../src/core/speech/transcriber.mjs';

// 0.8 s silence, a sentence (~2.5 s), 2 s silence, a sentence, 1.2 s silence
const fixture = fromWav(fs.readFileSync(new URL('../fixtures/speech.wav', import.meta.url)));
const scaled = (x, g) => Float32Array.from(x, v => v * g);
/** Heavy low-pass (repeated moving average): what a muffled mic or stacked noise filters do. */
function muffled(x) {
  let y = x;
  for (let pass = 0; pass < 4; pass++) y = Float32Array.from(y, (_, i) => (y[i - 3] ?? 0) / 8 + (y[i - 2] ?? 0) / 8 + (y[i - 1] ?? 0) / 8 + y[i] / 8 + (y[i + 1] ?? 0) / 8 + (y[i + 2] ?? 0) / 8 + (y[i + 3] ?? 0) / 8 + (y[i + 4] ?? 0) / 8);
  return y;
}

function chunk(samples, opts = {}) {
  const windows = [];
  const onsets = [];
  const c = createChunker({ onWindow: w => windows.push(w), onOnset: i => onsets.push(i), ...opts });
  for (let i = 0; i < samples.length; i += 1600) c.push(samples.slice(i, i + 1600));
  c.flush();
  return { windows, onsets };
}

// background noise at the level of a real session (about 0.013 RMS)
function withNoise(x, speechGain) {
  let seed = 1;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  return Float32Array.from(x, v => v * speechGain + rand() * 0.0225);
}
/** Every sample of the fixture's speech lies inside some window. */
function coversSpeech(windows) {
  return fixture.every((v, i) => v === 0 || windows.some(w => i >= w.start && i < w.start + w.samples.length));
}
const contiguousOrGapsAreQuiet = windows => windows.every((w, i) => i === 0 || w.start >= windows[i - 1].start + windows[i - 1].samples.length);

test('each remark becomes its own window, cut at the pause', () => {
  const { windows, onsets } = chunk(fixture);
  assert.equal(windows.length, 2, `windows at ${windows.map(w => w.start / SAMPLE_RATE)}`);
  assert.equal(onsets.length, 2);
  assert.ok(coversSpeech(windows));
  const second = windows[1].start / SAMPLE_RATE;
  assert.ok(second > 3.5 && second < 5.6, `second window starts in the pause before the sentence (${second})`);
  assert.ok(onsets[1] / SAMPLE_RATE > 5 && onsets[1] / SAMPLE_RATE < 6.2, 'and its onset is where speech starts');
  assert.ok(windows.every(w => w.voiced));
});

test('a steady background hum still leaves the pauses visible (the bug that gave one screenshot per session)', () => {
  const { windows, onsets } = chunk(withNoise(fixture, 0.3));
  assert.equal(onsets.length, 2, `onsets at ${onsets.map(i => i / SAMPLE_RATE)}`);
  assert.ok(onsets[1] / SAMPLE_RATE > 5 && onsets[1] / SAMPLE_RATE < 6.2, `second remark starts near 5.6 s (${onsets[1] / SAMPLE_RATE})`);
  assert.equal(windows.length, 2, `windows at ${windows.map(w => w.start / SAMPLE_RATE)}`);
  assert.ok(coversSpeech(windows));
});

test('speech barely above the background is still transcribed, never dropped (the bug that lost remarks)', () => {
  // the voice about 6 dB over the hum, as measured in two real sessions with a laptop mic
  const noisy = withNoise(fixture, 0.15);
  const { windows } = chunk(noisy);
  assert.ok(windows.length >= 1);
  assert.ok(coversSpeech(windows), `windows ${windows.map(w => `${(w.start / SAMPLE_RATE).toFixed(1)}+${(w.samples.length / SAMPLE_RATE).toFixed(1)}`)}`);
  assert.ok(contiguousOrGapsAreQuiet(windows));
});

test('a long monologue is cut before maxSeconds at a quiet moment', () => {
  const long = new Float32Array(fixture.length * 4);
  for (let i = 0; i < 4; i++) long.set(fixture.map(v => (v === 0 ? 0.02 : v)), i * fixture.length); // no real pauses
  const { windows } = chunk(long, { maxSeconds: 8, pauseMs: 5000 });
  assert.ok(windows.length >= 3);
  assert.ok(windows.every(w => w.samples.length / SAMPLE_RATE <= 8.01));
  for (let i = 1; i < windows.length; i++) {
    assert.equal(windows[i].start, windows[i - 1].start + windows[i - 1].samples.length, `gap before window ${i}`);
  }
});

test('silence and a steady hum alone produce no windows', () => {
  assert.equal(chunk(new Float32Array(SAMPLE_RATE * 12)).windows.length, 0);
  assert.equal(chunk(withNoise(new Float32Array(SAMPLE_RATE * 20), 0)).windows.length, 0);
});

test('normalize lifts quiet speech and leaves loud speech alone', () => {
  const quiet = scaled(fixture, 0.05);
  const peak = x => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak(normalize(quiet)) > peak(quiet) * 5);
  const loud = Float32Array.from({ length: SAMPLE_RATE }, (_, i) => (i % 40 < 20 ? 0.9 : -0.9));
  assert.ok(normalize(loud) === loud, 'already loud: unchanged');
  assert.ok(peak(normalize(scaled(fixture, 0.01))) <= 1, 'never clips');
});

test('the mic check: good, quiet, muffled, clipped', () => {
  const good = analyzeAudio(fixture);
  assert.ok(good.ok, good.problems.join(' '));
  assert.ok(good.highShare > 0.05, `high share ${good.highShare}`);
  assert.match(analyzeAudio(scaled(fixture, 0.05)).problems.join(' '), /quiet/i);
  const dull = analyzeAudio(muffled(fixture));
  assert.ok(dull.highShare < 0.03, `muffled high share ${dull.highShare}`);
  assert.match(dull.problems.join(' '), /Muffled/);
  assert.match(analyzeAudio(scaled(fixture, 40)).problems.join(' '), /Distorted/);
  assert.match(analyzeAudio(new Float32Array(SAMPLE_RATE * 2)).problems.join(' '), /Almost nothing/);
  // the two real sessions measured about 6 dB; clear speech over the same hum passes
  const noisy = analyzeAudio(withNoise(fixture, 0.15));
  assert.ok(noisy.snrDb > 3 && noisy.snrDb < 10, `snr ${noisy.snrDb}`);
  assert.match(noisy.problems.join(' '), /Noisy: your voice is only \d+ dB/);
  assert.ok(analyzeAudio(withNoise(fixture, 1)).snrDb > 15, 'a close mic over the same hum is fine');
});
