// Child process that runs Whisper (transformers.js, onnxruntime on the CPU). Kept out of the main process so a
// transcription never stalls the app. Messages in: { id, audio: Float32Array (16 kHz mono), long?: boolean };
// out: { id, segments } or { id, error }. The first message out is { ready: true } once the model is loaded
// (downloaded the first time). The model and its settings come from QA_RECORDER_SPEECH (JSON).
import { env, pipeline } from '@huggingface/transformers';

const { id: model, dtype = 'q8', language } = JSON.parse(process.env.QA_RECORDER_SPEECH || '{}');
env.cacheDir = process.env.QA_RECORDER_MODELS;
env.allowLocalModels = false;

let lastProgress = 0;
const transcriber = await pipeline('automatic-speech-recognition', model, {
  dtype,
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

process.on('message', async ({ id, audio, long }) => {
  try {
    const seconds = audio.length / 16000;
    const out = await transcriber(audio, {
      return_timestamps: true,
      chunk_length_s: 30,
      ...(long ? { stride_length_s: 5 } : {}), // overlapping 30 s pieces for long recordings
      ...(language ? { language, task: 'transcribe' } : {}),
    });
    // Whisper's timestamps can be off, especially in long recordings: an open end, a start past the audio, or out of
    // order. Keep them in order and inside the audio; a bogus start becomes the previous segment's end.
    let previousEnd = 0;
    const segments = (out.chunks ?? [{ timestamp: [0, seconds], text: out.text }])
      .map((c, i, all) => {
        let start = c.timestamp[0] ?? previousEnd;
        if (start < previousEnd || start >= seconds - 0.1) start = previousEnd;
        let end = Math.min(c.timestamp[1] ?? all[i + 1]?.timestamp[0] ?? seconds, seconds);
        if (end <= start) end = Math.min(seconds, all[i + 1]?.timestamp[0] > start ? all[i + 1].timestamp[0] : seconds);
        previousEnd = end;
        return { start, end, text: c.text.trim() };
      })
      .filter(s => s.text && !/^\[.*\]$|^\(.*\)$/.test(s.text)); // Whisper's "[BLANK_AUDIO]" / "(silence)"
    process.send({ id, segments });
  } catch (e) {
    process.send({ id, error: e.message });
  }
});
