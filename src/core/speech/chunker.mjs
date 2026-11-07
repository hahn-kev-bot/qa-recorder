import { SAMPLE_RATE } from './transcriber.mjs';

const FRAME = 480; // 30 ms
const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000;
const EDGE_FRAMES = 10; // 300 ms of quiet kept around speech

/**
 * Cuts a continuous 16 kHz stream into windows for transcription without ever dropping speech: every sample ends up
 * in a window except stretches with no voice at all. Windows end at a pause (so a remark is transcribed soon after
 * it is said) or, in long monologues, at the quietest moment before maxSeconds.
 * Level detection here only picks cut points and the moments speech starts (onOnset, for screenshots); it never
 * decides what is kept, so quiet speech is still transcribed.
 *
 * onWindow({ start, samples }): start is the index of the window's first sample in the stream.
 * onOnset(index): speech started at that sample, after a pause.
 */
export function createChunker({ onWindow, onOnset = () => {}, pauseMs = 1200, onsetGapMs = 700, minSeconds = 1.5, maxSeconds = 25 }) {
  let carry = new Float32Array(0);
  let total = 0; // samples consumed into frames so far
  let frames = []; // current window: { samples, level }
  let windowStart = 0;
  let voicedRun = 0;
  let silentRun = 0;
  let hadVoice = false;
  let speaking = false;

  // The background level is the quietest 15% of the last 10 s. A steady hum (fan, PC) then raises the bar instead of
  // counting as speech, which would hide every pause.
  const recent = [];
  let floor = 0.003;
  let sinceFloor = 0;
  function updateFloor(level) {
    recent.push(level);
    if (recent.length > 10_000 / FRAME_MS) recent.shift();
    if (++sinceFloor < 10 && recent.length > 30) return;
    sinceFloor = 0;
    const sorted = [...recent].sort((a, b) => a - b);
    floor = Math.min(0.05, sorted[Math.floor(sorted.length * 0.15)]);
  }

  const rms = f => Math.sqrt(f.reduce((s, x) => s + x * x, 0) / f.length);
  const isVoiced = level => level > Math.max(0.006, floor * 2.2);

  let trimNextStart = true;
  /** atPause: the window ends in real silence. A forced cut mid-speech trims neither side of the cut. */
  function emit(count, atPause = true) {
    let take = frames.slice(0, count);
    frames = frames.slice(count);
    let start = windowStart;
    windowStart += count * FRAME;
    hadVoice = frames.some(f => f.voiced);
    const trimStart = trimNextStart;
    trimNextStart = atPause;
    const first = take.findIndex(f => f.voiced);
    if (first < 0) return; // nothing but silence
    // trim silence at both ends (keeping 300 ms): Whisper dates a window's first words from its start, so the
    // window has to start where the speech does
    const last = take.findLastIndex(f => f.voiced);
    const from = trimStart ? Math.max(0, first - EDGE_FRAMES) : 0;
    take = take.slice(from, atPause ? Math.min(take.length, last + 1 + EDGE_FRAMES) : take.length);
    start += from * FRAME;
    const samples = new Float32Array(take.length * FRAME);
    take.forEach((f, i) => samples.set(f.samples, i * FRAME));
    onWindow({ start, samples });
  }

  function frame(samples) {
    const level = rms(samples);
    updateFloor(level);
    const voiced = isVoiced(level);
    frames.push({ samples, level, voiced });
    const index = total;
    total += FRAME;

    if (voiced) {
      voicedRun++;
      silentRun = 0;
      hadVoice = true;
      if (!speaking && voicedRun >= 3) {
        speaking = true;
        onOnset(index - 2 * FRAME);
      }
    } else {
      voicedRun = 0;
      silentRun++;
      if (silentRun * FRAME_MS >= onsetGapMs) speaking = false; // a short breath is enough for a new "started speaking" screenshot
    }

    const seconds = (frames.length * FRAME) / SAMPLE_RATE;
    if (!hadVoice && seconds >= 5) return emit(frames.length); // drop a long silence
    if (hadVoice && silentRun * FRAME_MS >= pauseMs && seconds >= minSeconds) return emit(frames.length);
    if (seconds >= maxSeconds) {
      // cut at the quietest 300 ms in the last 40% of the window
      const from = Math.floor(frames.length * 0.6);
      let best = frames.length;
      let bestLevel = Infinity;
      for (let i = from; i + 10 <= frames.length; i++) {
        const l = frames.slice(i, i + 10).reduce((s, f) => s + f.level, 0);
        if (l < bestLevel) {
          bestLevel = l;
          best = i + 5;
        }
      }
      emit(best, false);
    }
  }

  return {
    push(samples) {
      const all = new Float32Array(carry.length + samples.length);
      all.set(carry);
      all.set(samples, carry.length);
      let i = 0;
      for (; i + FRAME <= all.length; i += FRAME) frame(all.slice(i, i + FRAME));
      carry = all.slice(i);
    },
    /** Emits whatever is buffered (end of the stream). */
    flush() {
      if (carry.length) {
        const last = new Float32Array(FRAME);
        last.set(carry);
        carry = new Float32Array(0);
        frame(last);
      }
      if (frames.length) emit(frames.length);
    },
  };
}

/** Scales quiet speech up (at most 20×) so Whisper hears it at a normal level; the saved audio stays as recorded. */
export function normalize(samples) {
  const sorted = Float32Array.from(samples, Math.abs).sort();
  const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
  if (p99 < 1e-4) return samples;
  const gain = Math.min(20, 0.5 / p99);
  if (gain <= 1) return samples;
  return Float32Array.from(samples, x => Math.max(-1, Math.min(1, x * gain)));
}
