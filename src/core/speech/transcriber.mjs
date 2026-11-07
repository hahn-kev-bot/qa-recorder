import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qaHome } from '../paths.mjs';

export const SAMPLE_RATE = 16_000;

/** Live transcription uses the fast model; re-transcribing a finished session can use the better one. */
export const MODELS = {
  fast: { id: 'Xenova/whisper-base.en', label: 'Whisper base.en', size: '77 MB' },
  better: { id: 'Xenova/whisper-small.en', label: 'Whisper small.en', size: '249 MB' },
};

/**
 * Local speech-to-text with Whisper in a child process. The model downloads once into <data>/models.
 * Returns { ready, transcribe(Float32Array) → [{ start, end, text }] (seconds), close() }. Requests run one at a
 * time, in order.
 */
export function createTranscriber({ log = () => {}, model = MODELS.fast.id } = {}) {
  // QA_RECORDER_MODELS shares one model download between data folders (tests, the dogfood target)
  const env = { ...process.env, QA_RECORDER_MODELS: process.env.QA_RECORDER_MODELS ?? path.join(qaHome(), 'models'), QA_RECORDER_SPEECH_MODEL: model };
  // under Electron, fork() runs Electron's own Node only with this set
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const child = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  const pending = new Map();
  let nextId = 0;
  let readyResolve;
  let readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  ready.catch(() => {});

  child.on('message', m => {
    if (m.ready) {
      log(`Speech model ready (${m.model}).`);
      readyResolve();
    } else if (m.progress) {
      log(`Downloading the speech model: ${m.progress}`);
    } else if (m.fatal) {
      readyReject(new Error(`The speech model didn't load: ${m.fatal}`));
    } else if (pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error));
      else resolve(m.segments);
    }
  });
  child.on('exit', code => {
    const error = new Error(`The speech process stopped (${code}). ${stderr.split('\n').filter(Boolean).slice(-3).join(' ')}`);
    readyReject(error);
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  });

  let chain = Promise.resolve();
  return {
    ready,
    transcribe(samples) {
      const run = async () => {
        await ready;
        const id = ++nextId;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          child.send({ id, audio: Array.from(samples) });
        });
      };
      const result = chain.then(run, run);
      chain = result.catch(() => {});
      return result;
    },
    close() {
      child.kill();
    },
  };
}

/**
 * A WAV file written as audio arrives. The header's sizes are rewritten every few seconds and at close(), so the
 * file plays even if the session ends abruptly.
 */
export function createWavWriter(file) {
  let size = 0;
  let lastPatch = 0;
  let chain = fs.mkdir(path.dirname(file), { recursive: true })
    .then(() => fs.open(file, 'w'))
    .then(async handle => {
      await handle.write(wavHeader(0), 0, 44, 0);
      return handle;
    });
  const patch = handle => handle.write(wavHeader(size), 0, 44, 0);
  return {
    append(samples) {
      const data = Buffer.alloc(samples.length * 2);
      for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
      const at = 44 + size;
      size += data.length;
      chain = chain.then(async handle => {
        await handle.write(data, 0, data.length, at);
        if (Date.now() - lastPatch > 5000) {
          lastPatch = Date.now();
          await patch(handle);
        }
        return handle;
      });
    },
    async close() {
      const handle = await chain;
      await patch(handle);
      await handle.close();
    },
  };
}

function wavHeader(dataLength) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

/** 16-bit PCM mono WAV of 16 kHz float samples. */
export function toWav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Float samples from a 16 kHz 16-bit mono WAV (the test fixture). */
export function fromWav(buffer) {
  const dataAt = buffer.indexOf('data') + 8;
  const samples = new Float32Array((buffer.length - dataAt) / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(dataAt + i * 2) / 32768;
  return samples;
}
