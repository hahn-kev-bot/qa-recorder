// Child process that runs Whisper (transformers.js, onnxruntime on the CPU). Kept out of the main process so a
// transcription never stalls the app. Messages in: { id, audio: number[] (16 kHz mono) }; out: { id, segments } or
// { id, error }. The first message out is { ready: true } once the model is loaded (downloaded the first time).
import { env, pipeline } from '@huggingface/transformers';

const model = process.env.QA_RECORDER_SPEECH_MODEL || 'Xenova/whisper-base.en';
env.cacheDir = process.env.QA_RECORDER_MODELS;
env.allowLocalModels = false;

let lastProgress = 0;
const transcriber = await pipeline('automatic-speech-recognition', model, {
  dtype: 'q8',
  progress_callback: p => {
    // report downloads, at most every 2 s
    if (p.status === 'progress' && Date.now() - lastProgress > 2000) {
      lastProgress = Date.now();
      process.send({ progress: `${p.file} ${Math.round(p.progress)}%` });
    }
  },
}).catch(e => {
  process.send({ fatal: e.message });
  process.exit(1);
});
process.send({ ready: true, model });

process.on('message', async ({ id, audio }) => {
  try {
    const out = await transcriber(Float32Array.from(audio), { return_timestamps: true, chunk_length_s: 30 });
    const segments = (out.chunks ?? [{ timestamp: [0, audio.length / 16000], text: out.text }])
      .map(c => ({ start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? audio.length / 16000, text: c.text.trim() }))
      .filter(s => s.text && !/^\[.*\]$|^\(.*\)$/.test(s.text)); // Whisper's "[BLANK_AUDIO]" / "(silence)"
    process.send({ id, segments });
  } catch (e) {
    process.send({ id, error: e.message });
  }
});
