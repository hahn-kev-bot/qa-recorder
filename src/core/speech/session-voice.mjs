import fs from 'node:fs/promises';
import path from 'node:path';
import { createChunker, isLikelyHallucination, normalize } from './chunker.mjs';
import { createTranscriber, createWavWriter, SAMPLE_RATE, toWav } from './transcriber.mjs';
import { createSegmenter } from './voice.mjs';

export const VOICE_MODES = ['off', 'push-to-talk', 'open-mic'];
export const SESSION_AUDIO = 'speech/session.wav';
const MAX_GAP_MS = 60_000;

/**
 * Voice for one session. The microphone lives in the desktop app's window, which feeds audio through push();
 * the page's toolbar drives talk() (push-to-talk) and setMuted() (open mic).
 * - push-to-talk: each press becomes a 🎙 Spoken note with a full-window screenshot from the moment of the press;
 *   its text fills in when transcribed. Audio per press in speech/NNN.wav.
 * - open-mic: the whole session's audio is kept (speech/session.wav) and all of it is transcribed, in windows cut at
 *   pauses; nothing is dropped. Each transcribed segment goes into speech[] (timeline.md + transcript.md) with a
 *   screenshot from when that speech started.
 */
export function createSessionVoice({ mode, dir, notes, speech, flush, screenshot, currentUrl, onNote, onSpeech = () => {}, onAudio = () => {}, mark, log }) {
  const transcriber = createTranscriber({ log });
  transcriber.ready.catch(e => log(`${e.message} Audio is still saved in speech/.`));
  const pending = new Set();
  const mkdir = fs.mkdir(path.join(dir, 'speech'), { recursive: true });
  const track = p => {
    pending.add(p);
    p.catch(() => {}).finally(() => pending.delete(p));
    return p;
  };
  const voice = mode === 'push-to-talk' ? pushToTalk() : openMic();

  async function transcribe(samples) {
    return (await transcriber.transcribe(normalize(samples)));
  }

  function pushToTalk() {
    const byUtterance = new Map(); // utterance id → its note
    const starts = new Map();
    const file = (id, ext) => `speech/${String(id).padStart(3, '0')}.${ext}`;

    async function startNote({ id, at }) {
      await mkdir;
      const shot = file(id, 'png');
      await screenshot(path.join(dir, shot)).catch(() => {});
      const note = {
        id: String(notes.length + 1).padStart(3, '0'), kind: 'spoken', text: '', transcribing: true,
        url: currentUrl(), at: new Date(at).toISOString(), screenshots: { full: shot },
      };
      notes.push(note);
      byUtterance.set(id, note);
      onNote(note);
      mark(`note ${note.id} (spoken, push-to-talk)`);
      await flush();
    }

    const segmenter = createSegmenter({
      onStart: u => starts.set(u.id, track(startNote(u))),
      onUtterance: u => track((async () => {
        await starts.get(u.id)?.catch(() => {});
        const note = byUtterance.get(u.id);
        if (!note) return;
        const audio = file(u.id, 'wav');
        await fs.writeFile(path.join(dir, audio), toWav(u.samples));
        let text;
        let segments = [];
        try {
          segments = (await transcribe(u.samples)).map(s => ({
            at: new Date(u.at + s.start * 1000).toISOString(), end: new Date(u.at + s.end * 1000).toISOString(), text: s.text,
          }));
          text = segments.map(s => s.text).join(' ');
        } catch (e) {
          text = `(not transcribed: ${e.message.split('\n')[0]}; audio in ${audio})`;
        }
        Object.assign(note, { text: text || '(nothing heard)', audio, transcribing: undefined });
        speech.push({ id: u.id, mode, at: note.at, end: new Date(u.end).toISOString(), text, segments, audio, noteId: note.id, screenshot: note.screenshots.full });
        onNote(note);
        if (text) mark(`🎙 ${text.slice(0, 150)}`);
        await flush();
      })()),
    });
    return {
      push: (samples, at) => segmenter.push(samples, at),
      talk: (down, at) => segmenter.talk(down, at),
      setMuted: m => segmenter.setMuted(m),
      get muted() { return segmenter.muted; },
      pageChanged() {}, // each press takes its own screenshot
      async end() { segmenter.setMuted(true); },
    };
  }

  function openMic() {
    let writer;
    let audioStart; // ms since epoch of the first sample
    let written = 0;
    let muted = false;
    let ended = false;
    let entryId = 0;
    let queue = Promise.resolve(); // one window at a time, in order
    // screenshots: when speech starts ('speech'), and when the page changes ('page') as a fallback, so a remark
    // whose start wasn't caught still shows the page it was said on
    const shots = []; // { at, file, kind }
    const navigations = []; // ms: a screenshot from before one of these shows another page
    const timeOf = sample => audioStart + (sample / SAMPLE_RATE) * 1000;
    function takeShot(kind, at) {
      const shot = { at, kind, file: `speech/${kind === 'speech' ? 'onset' : 'page'}-${String(shots.length + 1).padStart(3, '0')}.png` };
      shots.push(shot);
      track(mkdir.then(() => screenshot(path.join(dir, shot.file))).catch(() => { shot.file = undefined; }));
    }

    const chunker = createChunker({
      onOnset: index => {
        takeShot('speech', timeOf(index));
        mark('speaking…');
      },
      onWindow: ({ start, samples }) => {
        queue = queue.then(() => transcribeWindow(start, samples));
        track(queue);
      },
    });

    async function transcribeWindow(start, samples) {
      let segments;
      try {
        segments = (await transcribe(samples)).filter(s => !isLikelyHallucination(s.text, samples, s.start, s.end));
      } catch (e) {
        segments = [{ start: 0, end: samples.length / SAMPLE_RATE, text: `(not transcribed: ${e.message.split('\n')[0]})` }];
      }
      const offset = start / SAMPLE_RATE;
      // a window starts in the pause before the words; Whisper tends to date them from the window's start, so the
      // first segment starts where speech was heard starting, if that was later
      const windowEnd = timeOf(start + samples.length);
      const firstOnset = shots.find(x => x.kind === 'speech' && x.at >= timeOf(start) && x.at < windowEnd)?.at;
      for (const [i, s] of segments.entries()) {
        let at = timeOf(start) + s.start * 1000;
        if (i === 0 && firstOnset && firstOnset > at && firstOnset < timeOf(start) + s.end * 1000) {
          at = firstOnset;
          s.start = (firstOnset - timeOf(start)) / 1000;
        }
        speech.push({
          id: ++entryId, mode, text: s.text,
          at: new Date(at).toISOString(), end: new Date(timeOf(start) + s.end * 1000).toISOString(),
          audio: SESSION_AUDIO, clip: [round(offset + s.start), round(offset + s.end)], screenshot: pickScreenshot(shots, at, navigations),
        });
        mark(`🎙 ${s.text.slice(0, 150)}`);
      }
      await flush();
      onSpeech(segments);
    }

    function feed(samples) {
      writer.append(samples);
      chunker.push(samples);
      written += samples.length;
    }

    return {
      push(samples, at) {
        if (ended) return;
        if (audioStart === undefined) {
          audioStart = at;
          writer = createWavWriter(path.join(dir, SESSION_AUDIO));
          onAudio({ file: SESSION_AUDIO, startedAt: new Date(at).toISOString() });
        }
        // keep the file in step with the clock: a stall in the window becomes silence, not a shift
        const gap = at - timeOf(written);
        if (gap > 300) feed(new Float32Array(Math.round((Math.min(gap, MAX_GAP_MS) / 1000) * SAMPLE_RATE)));
        feed(muted ? new Float32Array(samples.length) : samples); // muted: silence, so times stay right
      },
      talk() {},
      setMuted(m) { muted = m; },
      get muted() { return muted; },
      /** The page changed: a fallback screenshot once it has had a moment to render. */
      pageChanged() {
        if (ended) return;
        navigations.push(Date.now());
        track(new Promise(r => setTimeout(r, 1000)).then(() => { if (!ended) takeShot('page', Date.now()); }));
      },
      async end() {
        ended = true;
        chunker.flush();
        await Promise.allSettled([...pending]);
        await queue.catch(() => {});
        await writer?.close();
        // all of them, so re-transcribing (with different cuts) can pick again
        const kept = shots.filter(s => s.file).map(s => ({ at: new Date(s.at).toISOString(), kind: s.kind, file: s.file }));
        await fs.writeFile(path.join(dir, 'speech', 'screenshots.json'), JSON.stringify(kept, null, 2)).catch(() => {});
      },
    };
  }

  return {
    mode,
    push: (samples, at) => voice.push(samples, at),
    talk: (down, at = Date.now()) => voice.talk(down, at),
    setMuted: muted => voice.setMuted(muted),
    pageChanged: () => voice.pageChanged(),
    get muted() { return voice.muted; },
    /** Stops listening and waits (up to two minutes) for the transcription to catch up. */
    async stop() {
      const done = (async () => {
        await voice.end();
        while (pending.size) await Promise.allSettled([...pending]);
      })();
      await Promise.race([done, new Promise(r => setTimeout(r, 120_000))]);
      transcriber.close();
    },
  };
}

const round = s => Math.round(s * 100) / 100;

/**
 * The screenshot for speech that starts at `at` (ms): the "started speaking" one taken for it (within 3 s before to
 * 1.5 s after), else the latest screenshot before it, as long as the page hasn't changed since (navigations: ms
 * times); a stale picture of another page is worse than none. shots: [{ at (ms or ISO), kind, file }].
 */
export function pickScreenshot(shots, at, navigations = []) {
  const time = s => (typeof s.at === 'number' ? s.at : Date.parse(s.at));
  const usable = shots.filter(s => s.file);
  const speechShot = usable.filter(s => s.kind === 'speech' && time(s) >= at - 3000 && time(s) <= at + 1500).at(-1);
  if (speechShot) return speechShot.file;
  const latest = usable.filter(s => time(s) <= at + 500).sort((a, b) => time(a) - time(b)).at(-1);
  if (!latest || navigations.some(n => n > time(latest) && n <= at)) return undefined;
  return latest.file;
}
