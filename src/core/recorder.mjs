import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeAction, writeBundle } from './bundle.mjs';
import { createSessionVoice, VOICE_MODES } from './speech/session-voice.mjs';
import { startTrace } from './trace.mjs';
import { resolveBuild } from './builds.mjs';
import { freePort, launch } from './launch.mjs';
import { buildsDir, sessionsDir } from './paths.mjs';
import { runSteps } from './steps.mjs';
import { expand } from './targets.mjs';

const overlaySource = await fs.readFile(fileURLToPath(new URL('./overlay.js', import.meta.url)), 'utf8');

const stamp = d => d.toISOString().slice(0, 19).replace(/[:T]/g, '-');

/**
 * Starts a QA session for a target and returns a controller right away:
 * { id, dir, emitter ('log', 'status', 'note'), status, ready, done, finish(), page }.
 * `ready` resolves once setup has run and the tester can start; `done` resolves with { notes, events } when the
 * session ends (Finish on the toolbar, finish(), or the app/browser closing).
 */
export const TALK_KEY = 'F6';

/**
 * voice: 'off' | 'push-to-talk' | 'open-mic'. With voice on, the caller feeds microphone audio (16 kHz mono)
 * through controller.voice.push(samples, startedAtMs); the desktop app does this from its window.
 */
export async function startSession(target, { runId, latest = true, exe, log, voice = 'off' } = {}) {
  if (!VOICE_MODES.includes(voice)) throw new Error(`voice must be one of ${VOICE_MODES.join(', ')}`);
  const startedAt = new Date();
  const id = `${stamp(startedAt)}_${target.id}`;
  const dir = path.join(sessionsDir(), id);
  await fs.mkdir(path.join(dir, 'notes'), { recursive: true });
  const emitter = new EventEmitter();
  const say = m => { emitter.emit('log', m); log?.(m); };
  let requestFinish;
  const finishSignal = new Promise(resolve => { requestFinish = () => resolve('finish'); });
  const controller = { id, dir, emitter, status: 'starting', finish: () => requestFinish() };

  const session = {
    id,
    target: { id: target.id, name: target.config.name, file: target.file },
    handoff: target.config.handoff ?? {},
    startedAt: startedAt.toISOString(),
    voice,
  };
  const notes = [];
  const events = [];
  const speech = [];
  // one write at a time: overlapping writes of the same files could interleave
  let writing = Promise.resolve();
  const write = () => writeBundle({ sessionDir: dir, session: { ...session, status: controller.status }, notes, events, speech });
  const flush = () => (writing = writing.then(write, write));
  // actions arrive often; save them soon, not on every click
  let flushTimer;
  const flushSoon = () => {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { flush().catch(() => {}); }, 1000);
  };
  controller.speech = speech;
  const setStatus = async s => {
    controller.status = s;
    emitter.emit('status', s);
    await flush();
  };
  await flush();

  let readyResolve;
  let readyReject;
  controller.ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  controller.ready.catch(() => {});
  controller.done = (async () => {
    let app;
    let trace;
    try {
      const { build, dir: buildDir } = exe
        ? { build: { source: 'local', sha: 'local', title: exe } }
        : await resolveBuild(target, { runId, latest, log: say });
      session.build = build;
      const appData = path.join(dir, '.app-data');
      await fs.mkdir(appData, { recursive: true });
      const vars = {
        sessionDir: dir,
        appData,
        buildDir: buildDir ?? '',
        buildCache: buildsDir(),
        port: await freePort(),
        arch: process.arch,
        platform: process.platform,
        targetDir: target.file ? path.dirname(target.file) : process.cwd(),
        'build.sha': build?.sha ?? '',
        'build.branch': build?.branch ?? '',
        'build.runId': build?.runId ?? '',
        'build.url': build?.url ?? '',
      };
      session.handoff = expand(session.handoff, vars);
      const launchCfg = expand(target.config.launch, vars);
      if (exe) launchCfg.exe = exe;
      const sha = build?.sha && build.sha !== 'local' ? ` (${build.sha.slice(0, 7)})` : '';
      say(`Launching ${target.config.name}${sha}...`);
      app = await launch(launchCfg, { buildDir, appData, port: vars.port, targetId: target.id });
      controller.page = app.page;
      controller.context = app.context;
      const capture = target.config.capture ?? {};
      // the tab the tester is looking at, for spoken remarks' screenshots
      let tabsTracker;
      const shownPage = () => tabsTracker?.activePage() ?? app.page;
      if (voice !== 'off') {
        say(`Voice: ${voice === 'push-to-talk' ? `push-to-talk (hold ${TALK_KEY} in the app, or hold 🎙 on its toolbar)` : 'open mic (🎙 on the toolbar mutes)'}.`);
        controller.voice = createSessionVoice({
          mode: voice, dir, notes, speech, flush,
          // These happen while the tester talks or browses, so they must not touch the page: hiding the toolbar (or
          // Playwright's default of hiding the text cursor) makes the page flash every time. The toolbar shows in a
          // corner of these screenshots instead; notes the tester captures still leave it out.
          screenshot: file => shownPage().screenshot({ path: file, caret: 'initial' }),
          currentUrl: () => shownPage().url(),
          onNote: n => emitter.emit('note', n),
          onSpeech: s => emitter.emit('speech', s),
          onAudio: info => { session.audio = info; },
          mark: label => trace?.mark(label),
          log: say,
        });
      }
      tabsTracker = await attachRecorder(app.context, {
        dir, notes, events, flush,
        ignore: capture.ignore ?? [],
        overlayConfig: { typedText: capture.typedText ?? true, voice, talkKey: TALK_KEY },
        getVoice: () => controller.voice,
        onNote: n => { emitter.emit('note', n); trace?.mark(`note ${n.id} (${n.kind}): ${(n.text ?? '').split('\n')[0]}`); },
        isSetup: () => controller.status === 'starting',
        onAction: a => {
          emitter.emit('action', a);
          trace?.mark(describeAction(a));
          flushSoon();
        },
        onFinish: () => requestFinish(),
      });
      if (capture.trace !== false) {
        trace = await startTrace(app.context, dir, { title: `${target.config.name} ${id}`, log: say })
          .catch(e => { say(`No trace for this session: ${e.message.split('\n')[0]}`); return undefined; });
        controller.trace = trace;
      }

      if (target.config.setup?.length) {
        say('Running setup steps...');
        await runSteps(expand(target.config.setup, vars), { page: app.page, context: app.context, vars, configDir: vars.targetDir, log: say });
      }
      events.push({ at: new Date().toISOString(), type: 'navigate', url: app.page.url() });
      controller.voice?.pageChanged(); // the page the tester starts on
      await setStatus('running');
      readyResolve();
      say('Session running. F8 pick an element · F9 drag a region · F7 general note · Finish on the toolbar when done.');

      const why = await Promise.race([finishSignal, app.closed]);
      say(why === 'finish' ? 'Finishing...' : 'The app was closed; saving the session.');
    } catch (e) {
      session.error = e.message;
      readyReject(e);
      say(`Error: ${e.message}`);
    } finally {
      events.push({ at: new Date().toISOString(), type: 'end' });
      session.endedAt = new Date().toISOString();
      if (controller.voice) {
        say('Finishing transcription...');
        await controller.voice.stop();
      }
      if (trace) {
        const timeout = new Promise(resolve => setTimeout(resolve, 20_000));
        await Promise.race([trace.stop(), timeout]);
        session.trace = [...trace.files];
        if (!session.trace.length) say('The trace was lost: the app closed before it could be saved.');
      }
      await setStatus(session.error && !notes.length ? 'failed' : 'ended').catch(() => {});
      await app?.close();
    }
    if (controller.status === 'failed') throw new Error(session.error);
    return { notes, events };
  })();
  controller.done.catch(() => {});
  return controller;
}

/** Injects the toolbar and records notes, actions, errors and navigation. */
async function attachRecorder(context, { dir, notes, events, flush, ignore, overlayConfig, getVoice, isSetup, onNote, onAction, onFinish }) {
  // Browser tabs, numbered in the order they appear. Every event says which tab it came from, and the timeline
  // says when a tab opens, closes, or the tester moves to another one.
  const tabs = new Map();
  let active;
  const record = (type, data, page) => {
    // while the setup steps run, what happens is theirs, not the tester's
    const event = { at: new Date().toISOString(), type, ...data, ...(page && tabs.has(page) ? { tab: tabs.get(page) } : {}), ...(isSetup() ? { setup: true } : {}) };
    if (!ignore.some(rule => matchesRule(rule, event))) events.push(event);
    return event;
  };
  /** The tester is looking at this tab now: note the switch, and give spoken remarks a screenshot of it. */
  const show = p => {
    if (!tabs.has(p) || p === active || p.isClosed()) return;
    const first = !active;
    active = p;
    if (first) return;
    record('tab', { change: 'switched', url: isWeb(p.url()) ? p.url() : undefined }, p);
    if (!isSetup()) getVoice()?.pageChanged();
  };
  await context.exposeBinding('__qaRecorderAction', ({ page: source }, action) => {
    if (!action || typeof action !== 'object') return;
    show(source);
    onAction(record('action', action, source));
  });
  await context.exposeBinding('__qaRecorderTabShown', ({ page: source }) => show(source));
  await context.exposeBinding('__qaRecorderNote', async ({ page: source }, note) => {
    const id = String(notes.length + 1).padStart(3, '0');
    const full = `notes/${id}-full.png`;
    await source.screenshot({ path: path.join(dir, full) });
    let crop;
    if (note.rect) {
      crop = `notes/${id}.png`;
      await source.screenshot({ path: path.join(dir, crop), clip: padded(note.rect, note.viewport) });
    }
    const saved = { id, ...note, screenshots: { crop, full } };
    notes.push(saved);
    await flush();
    onNote(saved);
    return { id, count: notes.length };
  });
  await context.exposeBinding('__qaRecorderFinish', () => onFinish());
  // voice: push-to-talk key/button, and the open-mic mute toggle; both answer with the state to show
  await context.exposeBinding('__qaRecorderTalk', (_source, down) => {
    getVoice()?.talk(!!down);
    return { count: notes.length };
  });
  await context.exposeBinding('__qaRecorderMute', (_source, muted) => {
    const voice = getVoice();
    if (voice && typeof muted === 'boolean') voice.setMuted(muted);
    return { muted: voice?.muted ?? false };
  });
  const configScript = `window.__qaRecorderConfig = ${JSON.stringify(overlayConfig)};`;
  await context.addInitScript({ content: configScript });
  await context.addInitScript({ content: overlaySource });

  const watch = (p, { opened = false } = {}) => {
    tabs.set(p, tabs.size + 1);
    active ??= p;
    if (opened) {
      // a link or window.open has an opener; a new tab the tester opened (Ctrl+T) doesn't
      p.opener().then(o => record('tab', { change: 'opened', from: o ? tabs.get(o) : undefined, url: isWeb(p.url()) ? p.url() : undefined }, p))
        .catch(() => record('tab', { change: 'opened' }, p));
    }
    // the browser's own pages (a new tab, settings) aren't the app: their messages aren't the app's errors
    const fromApp = () => isWeb(p.url());
    p.on('console', m => {
      if ((m.type() !== 'error' && m.type() !== 'warning') || !fromApp()) return;
      // "Failed to load resource" only names the URL in its location
      record(`console.${m.type()}`, { text: m.text().slice(0, 2000), url: m.location()?.url || undefined }, p);
    });
    // an unhandled rejection of a bare or message-less Error has an empty stack; say so rather than log nothing
    p.on('pageerror', e => { if (fromApp()) record('pageerror', { text: (e.stack || e.message || `${e.name ?? 'Error'} with no message`).slice(0, 4000) }, p); });
    p.on('requestfailed', r => {
      // ERR_ABORTED is the page cancelling its own request (leaving the page, a closed stream), not a failure
      const text = r.failure()?.errorText;
      if (fromApp() && text !== 'net::ERR_ABORTED') record('requestfailed', { url: r.url(), text }, p);
    });
    p.on('response', r => { if (r.status() >= 400 && fromApp()) record('http', { url: r.url(), status: r.status() }, p); });
    p.on('framenavigated', f => {
      if (f !== p.mainFrame() || !isWeb(f.url())) return;
      record('navigate', { url: f.url() }, p);
      if (p !== active) {
        // a tab the tester opened and is now using (typed an address in it) rather than one loading behind
        p.evaluate(() => document.visibilityState).then(v => { if (v === 'visible') show(p); }).catch(() => {});
        return;
      }
      if (!isSetup()) getVoice()?.pageChanged();
    });
    p.on('close', () => {
      if (events.some(e => e.type === 'end')) return; // the session is closing the browser, not the tester
      record('tab', { change: 'closed' }, p);
      if (active === p) active = context.pages().find(x => x !== p && !x.isClosed());
    });
  };
  for (const p of context.pages()) {
    watch(p);
    await p.evaluate(`${configScript}\n${overlaySource}`).catch(() => {}); // already loaded, so the init scripts missed it
  }
  context.on('page', p => watch(p, { opened: true }));
  return { activePage: () => (active && !active.isClosed() ? active : undefined) };
}

const isWeb = url => /^(https?|file):/i.test(url ?? '');

const wildcard = pattern => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 's');

/** An ignore rule matches when every field it gives matches the event (* is a wildcard). */
export function matchesRule(rule, event) {
  return Object.entries(rule).every(([k, pattern]) => event[k] !== undefined && wildcard(pattern).test(String(event[k])));
}

/** Crop with some context around the selection, kept inside the viewport. */
function padded(rect, viewport, pad = 24) {
  const x = Math.max(0, rect.x - pad);
  const y = Math.max(0, rect.y - pad);
  return {
    x, y,
    width: Math.max(1, Math.min(viewport.width, rect.x + rect.width + pad) - x),
    height: Math.max(1, Math.min(viewport.height, rect.y + rect.height + pad) - y),
  };
}
