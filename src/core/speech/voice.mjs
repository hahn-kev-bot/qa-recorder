import { SAMPLE_RATE } from './transcriber.mjs';

const FRAME = 480; // 30 ms
const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000;
const PRE_ROLL_MS = 300; // keep the start of a word begun just before the key went down
const TAIL_MS = 300; // audio arrives a little after the key is released

/**
 * Push-to-talk: turns a 16 kHz microphone stream into one utterance per key press. talk(true/false) marks each
 * press; onStart fires on the press (for the screenshot), onUtterance({ id, at, end (ms since epoch), samples }) when
 * its audio is complete. Nothing is kept while muted or between presses. (Open mic uses chunker.mjs instead.)
 */
export function createSegmenter({ onStart = () => {}, onUtterance }) {
  let id = 0;
  let muted = false;
  let carry = new Float32Array(0);
  let carryAt = 0;
  const preRoll = []; // recent frames: { at, samples }
  let current = null; // { id, at, frames }
  let until = null; // stop collecting after this time

  function end(at) {
    const u = current;
    current = null;
    until = null;
    const samples = new Float32Array(u.frames.length * FRAME);
    u.frames.forEach((f, i) => samples.set(f, i * FRAME));
    onUtterance({ id: u.id, at: u.at, end: at, samples });
  }

  function frame(samples, at) {
    preRoll.push({ at, samples });
    while (preRoll.length > PRE_ROLL_MS / FRAME_MS) preRoll.shift();
    if (!current) return;
    current.frames.push(samples);
    if (until !== null && at >= until) end(at);
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
    /** Key (or toolbar button) down: true, up: false; `at` in ms since epoch. */
    talk(down, at) {
      if (muted) return;
      if (down && !current) {
        current = { id: ++id, at: preRoll[0]?.at ?? at, frames: preRoll.map(p => p.samples) };
        until = null;
        onStart({ id: current.id, at: current.at });
      } else if (!down && current) {
        until = at + TAIL_MS;
      }
    },
    setMuted(value) {
      muted = value;
      if (muted && current) end(Date.now());
      preRoll.length = 0;
    },
    get muted() { return muted; },
  };
}
