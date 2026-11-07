import { SAMPLE_RATE } from './transcriber.mjs';

const N = 512;

/** In-place radix-2 FFT of a real frame; returns the power spectrum (N/2 bins). */
function powerSpectrum(frame) {
  const re = Float64Array.from(frame, (x, i) => x * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)))); // Hann
  const im = new Float64Array(N);
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]];
  }
  for (let len = 2; len <= N; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const cr = Math.cos(angle * k);
        const ci = Math.sin(angle * k);
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  return Array.from({ length: N / 2 }, (_, k) => re[k] * re[k] + im[k] * im[k]);
}

/**
 * How usable a recording is for transcription: loudness, clipping, how much of the speech energy is above
 * 1.5 kHz (consonants live there; a muffled mic or heavy noise suppression removes it), and how far the voice stands
 * out from the background (snrDb; transcription falls apart below ~15 dB).
 * Returns { seconds, peak, speechLevel, clipped, highShare, noiseLevel, snrDb, problems: [text], ok }.
 */
export function analyzeAudio(samples) {
  const seconds = samples.length / SAMPLE_RATE;
  let peak = 0;
  let clippedCount = 0;
  for (const x of samples) {
    const a = Math.abs(x);
    if (a > peak) peak = a;
    if (a > 0.98) clippedCount++;
  }
  // speech frames: the loudest 40% of 32 ms frames, or none if it's all near silence
  const frames = [];
  for (let i = 0; i + N <= samples.length; i += N) {
    const f = samples.subarray(i, i + N);
    frames.push({ f, level: Math.sqrt(f.reduce((s, x) => s + x * x, 0) / N) });
  }
  const loud = [...frames].sort((a, b) => b.level - a.level).slice(0, Math.max(1, Math.floor(frames.length * 0.4))).filter(f => f.level > 0.003);
  const speechLevel = loud.length ? Math.sqrt(loud.reduce((s, f) => s + f.level * f.level, 0) / loud.length) : 0;
  const cutoff = Math.round((1500 / SAMPLE_RATE) * N);
  let high = 0;
  let all = 0;
  for (const { f } of loud) {
    const p = powerSpectrum(f);
    for (let k = 2; k < p.length; k++) { // skip DC and hum
      all += p[k];
      if (k >= cutoff) high += p[k];
    }
  }
  const highShare = all ? high / all : 0;
  const clipped = samples.length ? clippedCount / samples.length : 0;
  // how far the voice stands out from the background: the loudest frames against the quietest
  const byLevel = frames.map(f => f.level).sort((a, b) => a - b);
  const noiseLevel = byLevel[Math.floor(byLevel.length * 0.15)] ?? 0;
  const voiceLevel = byLevel[Math.floor(byLevel.length * 0.95)] ?? 0;
  const snrDb = 20 * Math.log10(Math.max(voiceLevel, 1e-6) / Math.max(noiseLevel, 1e-5));

  const problems = [];
  if (speechLevel < 0.003) problems.push('Almost nothing was heard. Check that the right microphone is picked and not muted.');
  else if (speechLevel < 0.02) problems.push('Very quiet. Move closer to the microphone or raise its input level in Windows sound settings.');
  if (speechLevel >= 0.003 && highShare < 0.03) {
    problems.push('Muffled: almost no sound above 1.5 kHz, where consonants are. Usually a noise filter ("Voice Focus", AI noise suppression, voice clarity) or a microphone far away. Turn the enhancement off for this microphone in Windows Settings > Sound.');
  }
  if (clipped > 0.005) problems.push('Distorted: the signal is too loud and clips. Lower the input level.');
  if (speechLevel >= 0.003 && snrDb < 15) {
    problems.push(`Noisy: your voice is only ${Math.round(snrDb)} dB louder than the background (fan, room, laptop). Transcripts will be poor below about 15 dB. A headset or a microphone close to your mouth helps most; raising the volume doesn't, it raises the noise too.`);
  }
  return { seconds, peak, speechLevel, clipped, highShare, noiseLevel, snrDb, problems, ok: problems.length === 0 };
}
