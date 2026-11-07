import { SAMPLE_RATE } from './transcriber.mjs';

const FRAME = 480; // 30 ms
const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000;
const PRE_ROLL_MS = 300; // keep the start of a word that began just before detection or the key press
const START_FRAMES = 3; // 90 ms of voice starts an utterance
const END_SILENCE_MS = 800;
const MIN_VOICED_MS = 300;
const MAX_UTTERANCE_MS = 30_000;
const PTT_TAIL_MS = 300; // audio arrives a little after the key is released

/**
 * Turns a 16 kHz microphone stream into utterances.
 * - open-mic: silence detection with an adaptive noise floor; onStart fires when speech begins (for a screenshot).
 * - push-to-talk: talk(true/false) marks each utterance.
 * onUtterance gets { id, at, end (ms since epoch), samples }; onDiscard({ id }) says a started one was too short to
 * keep. Nothing is kept while muted.
 */
export function createSegmenter({ mode, onStart = () => {}, onUtterance, onDiscard = () => {} }) {
  let id = 0;
  let muted = false;
  let carry = new Float32Array(0); // samples not yet a whole frame
  let carryAt = 0;
  const preRoll = []; // recent frames: { at, samples }
  let current = null; // { id, at, frames: [], voicedMs, silentMs }
  let voicedRun = 0;
  let floor = 0.005;
  let talkUntil = null; // push-to-talk: stop collecting after this time

  const rms = f => Math.sqrt(f.reduce((s, x) => s + x * x, 0) / f.length);

  function begin(at) {
    current = { id: ++id, at, frames: preRoll.map(p => p.samples), voicedMs: 0, silentMs: 0 };
    current.at = preRoll[0]?.at ?? at;
    onStart({ id: current.id, at: current.at });
  }

  function end(at) {
    const u = current;
    current = null;
    voicedRun = 0;
    if (mode === 'open-mic' && u.voicedMs < MIN_VOICED_MS) return void onDiscard({ id: u.id }); // a cough, a click
    // open mic: drop the trailing silence that ended it, keeping a little
    const keep = mode === 'open-mic' ? Math.max(0, u.frames.length - Math.floor((u.silentMs - 200) / FRAME_MS)) : u.frames.length;
    const frames = u.frames.slice(0, keep);
    const samples = new Float32Array(frames.length * FRAME);
    frames.forEach((f, i) => samples.set(f, i * FRAME));
    onUtterance({ id: u.id, at: u.at, end: mode === 'open-mic' ? u.at + frames.length * FRAME_MS : at, samples });
  }

  function frame(samples, at) {
    preRoll.push({ at, samples });
    while (preRoll.length > PRE_ROLL_MS / FRAME_MS) preRoll.shift();
    if (mode === 'push-to-talk') {
      if (current) {
        current.frames.push(samples);
        if (talkUntil !== null && at >= talkUntil) {
          talkUntil = null;
          end(at);
        }
      }
      return;
    }
    const level = rms(samples);
    const threshold = Math.max(0.015, floor * 3);
    const voiced = level > threshold;
    if (!current) {
      if (!voiced) floor = floor * 0.95 + level * 0.05;
      voicedRun = voiced ? voicedRun + 1 : 0;
      if (voicedRun >= START_FRAMES) begin(at);
      return;
    }
    current.frames.push(samples);
    if (voiced) {
      current.voicedMs += FRAME_MS;
      current.silentMs = 0;
    } else {
      current.silentMs += FRAME_MS;
    }
    if (current.silentMs >= END_SILENCE_MS || current.frames.length * FRAME_MS >= MAX_UTTERANCE_MS) end(at);
  }

  return {
    /** Mic audio: samples starting at `at` (ms since epoch). */
    push(samples, at) {
      if (muted) return;
      const all = new Float32Array(carry.length + samples.length);
      all.set(carry);
      all.set(samples, carry.length);
      const startAt = carry.length ? carryAt : at;
      let i = 0;
      for (; i + FRAME <= all.length; i += FRAME) frame(all.slice(i, i + FRAME), startAt + (i / SAMPLE_RATE) * 1000);
      carry = all.slice(i);
      carryAt = startAt + (i / SAMPLE_RATE) * 1000;
    },
    /** Push-to-talk key down (true) or up (false), at `at` ms since epoch. */
    talk(down, at) {
      if (mode !== 'push-to-talk' || muted) return;
      if (down && !current) {
        begin(at);
        talkUntil = null;
      } else if (!down && current) {
        talkUntil = at + PTT_TAIL_MS;
      }
    },
    setMuted(value) {
      muted = value;
      if (muted && current) end(Date.now());
      preRoll.length = 0;
    },
    get muted() { return muted; },
    /** Ends an utterance in progress (session over). */
    flush() {
      if (current) end(Date.now());
    },
  };
}
