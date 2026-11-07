import fs from 'node:fs/promises';
import path from 'node:path';
import { writeBundle } from '../bundle.mjs';
import { createChunker, isLikelyHallucination, normalize } from './chunker.mjs';
import { pickScreenshot, SESSION_AUDIO } from './session-voice.mjs';
import { createTranscriber, fromWav, MODELS, SAMPLE_RATE } from './transcriber.mjs';

const readJson = async (file, fallback) => JSON.parse(await fs.readFile(file, 'utf8').catch(() => JSON.stringify(fallback)));
const round = s => Math.round(s * 100) / 100;
const PIECE_SECONDS = 300;
const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Transcribes a finished session's speech again, by default with the better model, and rewrites its files.
 * - Open mic with the whole session recorded (speech/session.wav): the whole recording, in pieces of up to five
 *   minutes cut at quiet moments, each decoded as one long recording so Whisper has the context.
 * - Older open-mic sessions (one WAV per remark) and push-to-talk notes: each clip again.
 * Screenshots stay with the remark they were taken for. Returns the number of segments.
 */
export async function retranscribeSession(dir, { model = MODELS.better, log = () => {} } = {}) {
  const session = await readJson(path.join(dir, 'session.json'), null);
  if (!session) throw new Error(`No session in ${dir}`);
  const notes = await readJson(path.join(dir, 'notes.json'), []);
  const events = await readJson(path.join(dir, 'events.json'), []);
  let speech = await readJson(path.join(dir, 'speech.json'), []);
  log(`Loading ${model.label ?? model.id}${model.size ? ` (downloads ${model.size} the first time)` : ''}…`);
  const transcriber = createTranscriber({ model, log });
  const wav = async file => fromWav(await fs.readFile(path.join(dir, file)));

  try {
    await transcriber.ready;
    if (session.audio?.file === SESSION_AUDIO) {
      const samples = await wav(SESSION_AUDIO);
      const start = Date.parse(session.audio.startedAt);
      // screenshots.json has every screenshot; the first sessions with this format kept onsets.json instead
      const shots = await readJson(path.join(dir, 'speech', 'screenshots.json'), null)
        ?? (await readJson(path.join(dir, 'speech', 'onsets.json'), [])).map(o => ({ ...o, kind: 'speech' }));
      const navigations = events.filter(e => e.type === 'navigate' && !e.setup).map(e => Date.parse(e.at));
      const pieces = [];
      const onsets = []; // seconds into the recording where speech started, heard in the audio itself
      const chunker = createChunker({ onWindow: w => pieces.push(w), onOnset: i => onsets.push(i / SAMPLE_RATE), pauseMs: Infinity, maxSeconds: PIECE_SECONDS });
      chunker.push(samples);
      chunker.flush();
      const next = [];
      for (const [i, piece] of pieces.entries()) {
        const offset = piece.start / SAMPLE_RATE;
        log(`Transcribing part ${i + 1} of ${pieces.length} (${clock(offset)}–${clock(offset + piece.samples.length / SAMPLE_RATE)})…`);
        for (const s of await transcriber.transcribe(normalize(piece.samples), { long: true })) {
          if (isLikelyHallucination(s.text, piece.samples, s.start, s.end)) continue;
          // Whisper's start can sit in the pause before the words; use where speech was heard starting, if later
          const heard = onsets.find(o => o > offset + s.start - 0.2 && o < offset + s.end);
          if (heard !== undefined && heard > offset + s.start) s.start = heard - offset;
          const at = start + (offset + s.start) * 1000;
          next.push({
            id: next.length + 1, mode: 'open-mic', text: s.text,
            at: new Date(at).toISOString(), end: new Date(start + (offset + s.end) * 1000).toISOString(),
            audio: SESSION_AUDIO, clip: [round(offset + s.start), round(offset + s.end)], screenshot: pickScreenshot(shots, at, navigations),
          });
        }
      }
      speech = [...next, ...speech.filter(s => s.mode === 'push-to-talk')];
    } else {
      const clips = speech.filter(s => s.audio && !s.clip);
      for (const [i, s] of clips.entries()) {
        log(`Transcribing clip ${i + 1} of ${clips.length}…`);
        const segments = await transcriber.transcribe(normalize(await wav(s.audio)));
        s.text = segments.map(x => x.text).join(' ');
        s.segments = segments.map(x => ({
          at: new Date(Date.parse(s.at) + x.start * 1000).toISOString(), end: new Date(Date.parse(s.at) + x.end * 1000).toISOString(), text: x.text,
        }));
      }
    }
    // push-to-talk notes take their text from their clip
    for (const n of notes.filter(n => n.kind === 'spoken' && n.audio)) {
      const s = speech.find(x => x.noteId === n.id);
      if (s?.text) n.text = s.text;
    }
    session.transcribedWith = model.id;
    await writeBundle({ sessionDir: dir, session, notes, events, speech });
    log(`Done: ${speech.length} transcribed segment${speech.length === 1 ? '' : 's'}.`);
    return speech.length;
  } finally {
    transcriber.close();
  }
}
