import fs from 'node:fs/promises';
import path from 'node:path';
import { createTranscriber, toWav } from './transcriber.mjs';
import { createSegmenter } from './voice.mjs';

export const VOICE_MODES = ['off', 'push-to-talk', 'open-mic'];

/**
 * Voice for one session. The microphone lives in the desktop app's window, which feeds audio through push();
 * the page's toolbar drives talk() (push-to-talk) and setMuted() (open mic).
 * - push-to-talk: each press becomes a 🎙 Spoken note with a full-window screenshot from the moment of the press;
 *   its text fills in when transcribed.
 * - open-mic: each utterance goes into speech[] (timeline.md + transcript.md) with a screenshot from when it began.
 * Audio of each utterance is kept in speech/NNN.wav.
 */
export function createSessionVoice({ mode, dir, notes, speech, flush, screenshot, currentUrl, onNote, onSpeech = () => {}, mark, log }) {
  const transcriber = createTranscriber({ log });
  transcriber.ready.catch(e => log(`${e.message} Audio is still saved in speech/.`));
  const pending = new Set();
  const byUtterance = new Map(); // utterance id → the note or speech entry it fills in
  const file = (id, ext) => `speech/${String(id).padStart(3, '0')}.${ext}`;
  const mkdir = fs.mkdir(path.join(dir, 'speech'), { recursive: true });

  const track = p => {
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  };

  async function startEntry({ id, at }) {
    await mkdir;
    const shot = file(id, 'png');
    await screenshot(path.join(dir, shot)).catch(() => {});
    if (mode === 'push-to-talk') {
      const note = {
        id: String(notes.length + 1).padStart(3, '0'), kind: 'spoken', text: '', transcribing: true,
        url: currentUrl(), at: new Date(at).toISOString(), screenshots: { full: shot },
      };
      notes.push(note);
      byUtterance.set(id, note);
      onNote(note);
      mark(`note ${note.id} (spoken, push-to-talk)`);
    } else {
      const entry = { id, mode, at: new Date(at).toISOString(), text: '', transcribing: true, screenshot: shot };
      speech.push(entry);
      byUtterance.set(id, entry);
      mark('speaking…');
    }
    await flush();
    if (mode === 'open-mic') onSpeech(byUtterance.get(id));
  }

  const starts = new Map(); // utterance id → its startEntry promise
  const segmenter = createSegmenter({
    mode,
    onStart: u => starts.set(u.id, track(startEntry(u))),
    onDiscard: u => track((async () => {
      await starts.get(u.id)?.catch(() => {});
      const entry = byUtterance.get(u.id);
      const at = speech.indexOf(entry);
      if (at >= 0) speech.splice(at, 1);
      if (entry?.screenshot) await fs.rm(path.join(dir, entry.screenshot), { force: true });
      await flush();
      onSpeech(entry);
    })()),
    onUtterance: u => track((async () => {
      // the start entry comes first: its screenshot is taken as speaking starts
      await starts.get(u.id)?.catch(() => {});
      const target = byUtterance.get(u.id);
      if (!target) return;
      const audio = file(u.id, 'wav');
      await fs.writeFile(path.join(dir, audio), toWav(u.samples));
      let text;
      let segments = [];
      try {
        segments = (await transcriber.transcribe(u.samples)).map(s => ({
          at: new Date(u.at + s.start * 1000).toISOString(), end: new Date(u.at + s.end * 1000).toISOString(), text: s.text,
        }));
        text = segments.map(s => s.text).join(' ');
      } catch (e) {
        text = `(not transcribed: ${e.message.split('\n')[0]}; audio in ${audio})`;
      }
      const entry = { id: u.id, mode, at: new Date(u.at).toISOString(), end: new Date(u.end).toISOString(), text, segments, audio };
      if (mode === 'push-to-talk') {
        Object.assign(target, { text: text || '(nothing heard)', audio, transcribing: undefined });
        speech.push({ ...entry, noteId: target.id, screenshot: target.screenshots.full });
        onNote(target);
      } else {
        Object.assign(target, entry, { transcribing: undefined });
      }
      if (text) mark(`🎙 ${text.slice(0, 150)}`);
      await flush();
      if (mode === 'open-mic') onSpeech(target);
    })()),
  });

  return {
    mode,
    push: (samples, at) => segmenter.push(samples, at),
    talk: (down, at = Date.now()) => segmenter.talk(down, at),
    setMuted: muted => segmenter.setMuted(muted),
    get muted() { return segmenter.muted; },
    /** Ends the last utterance and waits (up to a minute) for transcriptions to finish. */
    async stop() {
      // ends the utterance in progress and ignores the audio still arriving until the window stops its microphone
      segmenter.setMuted(true);
      // a just-ended utterance queues its transcription after the start entry, so settle twice
      const deadline = Date.now() + 60_000;
      while (pending.size && Date.now() < deadline) {
        await Promise.race([Promise.allSettled([...pending]), new Promise(r => setTimeout(r, deadline - Date.now()))]);
      }
      transcriber.close();
    },
  };
}
