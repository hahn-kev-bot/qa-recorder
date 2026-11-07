import { SAMPLE_RATE } from './transcriber.mjs';

const FRAME = 480; // 30 ms
const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000;

/**
 * Cuts a continuous 16 kHz stream into back-to-back windows for transcription. Every sample lands in a window, except
 * stretches with nothing above the steady background (or muted silence), so speech is never dropped, however quiet.
 * Windows end at a pause (so a remark is transcribed soon after it is said) or, in long monologues, at the quietest
 * moment before maxSeconds. A window starts where the previous pause ended, so its first words are dated right.
 *
 * Two levels, both relative to the background (the quietest 15% of the last 10 s, so a steady hum raises the bar):
 * - voiced: clearly speech. Decides pauses (where to cut) and onsets (when to take a screenshot).
 * - active: anything above the background. Decides only whether a window is worth transcribing at all.
 *
 * onWindow({ start, samples, voiced }): start is the index of the window's first sample in the stream; voiced says
 * whether any of it was clearly speech (a window that wasn't is where Whisper tends to invent "Thank you.").
 * onOnset(index): speech started at that sample, after a pause.
 */
export function createChunker({ onWindow, onOnset = () => {}, pauseMs = 1200, onsetGapMs = 700, minSeconds = 1.5, maxSeconds = 25 }) {
  let carry = new Float32Array(0);
  let total = 0; // samples consumed into frames so far
  let frames = []; // current window: { samples, level, voiced, active }
  let windowStart = 0;
  let voicedRun = 0;
  let silentRun = 0;
  let hadVoice = false;
  let speaking = false;

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

  function emit(count) {
    const take = frames.slice(0, count);
    frames = frames.slice(count);
    const start = windowStart;
    windowStart += count * FRAME;
    hadVoice = frames.some(f => f.voiced);
    if (!take.some(f => f.active)) return; // only the background, or muted
    const samples = new Float32Array(take.length * FRAME);
    take.forEach((f, i) => samples.set(f.samples, i * FRAME));
    onWindow({ start, samples, voiced: take.some(f => f.voiced) });
  }

  function frame(samples) {
    const level = rms(samples);
    updateFloor(level);
    const voiced = level > Math.max(0.006, floor * 2.2);
    const active = level > Math.max(0.002, floor * 1.4);
    frames.push({ samples, level, voiced, active });
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
      if (silentRun * FRAME_MS >= onsetGapMs) speaking = false; // a short breath is enough for a new screenshot
    }

    const seconds = (frames.length * FRAME) / SAMPLE_RATE;
    // a pause after speech: transcribe what was said
    if (hadVoice && silentRun * FRAME_MS >= pauseMs && seconds >= minSeconds) return emit(frames.length);
    // no clear speech for a while: hand it over anyway (quiet speech is still speech), or drop it if it's background
    if (!hadVoice && seconds >= 8) return emit(frames.length);
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
      emit(best);
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

/** Raises quiet speech (at most 20×, never clipping) so Whisper hears it at a normal level; the saved audio stays as recorded. */
export function normalize(samples) {
  let peak = 0;
  for (const x of samples) peak = Math.max(peak, Math.abs(x));
  if (peak < 1e-4) return samples;
  const gain = Math.min(20, 0.9 / peak);
  if (gain <= 1.05) return samples;
  return Float32Array.from(samples, x => x * gain);
}

/** What Whisper tends to say over background noise or a breath. */
const HALLUCINATION = /^\W*(thank you|thanks( for watching)?|you|bye|the|and|okay|so|uh|um)\W*$/i;

/**
 * Whether a transcribed segment is Whisper filling in background noise: one of its stock phrases over a span that is
 * no louder than the window's background. samples: the window; start/end: the segment in seconds.
 */
export function isLikelyHallucination(text, samples, start, end) {
  if (!HALLUCINATION.test(text)) return false;
  const frameLevels = [];
  for (let i = 0; i + 480 <= samples.length; i += 480) {
    let s = 0;
    for (let j = i; j < i + 480; j++) s += samples[j] * samples[j];
    frameLevels.push(Math.sqrt(s / 480));
  }
  if (!frameLevels.length) return true;
  const background = [...frameLevels].sort((a, b) => a - b)[Math.floor(frameLevels.length * 0.15)];
  const from = Math.floor((start * SAMPLE_RATE) / 480);
  const to = Math.max(from + 1, Math.ceil((end * SAMPLE_RATE) / 480));
  const loudest = Math.max(...frameLevels.slice(from, to), 0);
  return loudest < Math.max(0.006, background * 2.2);
}
