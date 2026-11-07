import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qaHome } from '../paths.mjs';

export const SAMPLE_RATE = 16_000;

/**
 * Local speech-to-text with Whisper in a child process. The model downloads once (~80 MB for base.en) into
 * <data>/models. Returns { ready, transcribe(Float32Array) → [{ start, end, text }] (seconds), close() }.
 */
export function createTranscriber({ log = () => {} } = {}) {
  // QA_RECORDER_MODELS shares one model download between data folders (tests, the dogfood target)
  const env = { ...process.env, QA_RECORDER_MODELS: process.env.QA_RECORDER_MODELS ?? path.join(qaHome(), 'models') };
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

  return {
    ready,
    async transcribe(samples) {
      await ready;
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.send({ id, audio: Array.from(samples) });
      });
    },
    close() {
      child.kill();
    },
  };
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
