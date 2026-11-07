import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBundle } from './bundle.mjs';
import { resolveBuild } from './builds.mjs';
import { freePort, launch } from './launch.mjs';
import { sessionsDir } from './paths.mjs';
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
export async function startSession(target, { runId, latest = true, exe, log } = {}) {
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
  };
  const notes = [];
  const events = [];
  const flush = () => writeBundle({ sessionDir: dir, session: { ...session, status: controller.status }, notes, events });
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
      await attachRecorder(app.context, {
        dir, notes, events, flush,
        ignore: target.config.capture?.ignore ?? [],
        onNote: n => emitter.emit('note', n),
        onFinish: () => requestFinish(),
      });

      if (target.config.setup?.length) {
        say('Running setup steps...');
        await runSteps(expand(target.config.setup, vars), { page: app.page, context: app.context, vars, configDir: vars.targetDir, log: say });
      }
      events.push({ at: new Date().toISOString(), type: 'navigate', url: app.page.url() });
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
      await setStatus(session.error && !notes.length ? 'failed' : 'ended').catch(() => {});
      await app?.close();
    }
    if (controller.status === 'failed') throw new Error(session.error);
    return { notes, events };
  })();
  controller.done.catch(() => {});
  return controller;
}

/** Injects the toolbar and records notes, errors and navigation. */
async function attachRecorder(context, { dir, notes, events, flush, ignore, onNote, onFinish }) {
  const record = (type, data) => {
    const event = { at: new Date().toISOString(), type, ...data };
    if (!ignore.some(rule => matchesRule(rule, event))) events.push(event);
  };
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
  await context.addInitScript({ content: overlaySource });

  const watch = p => {
    p.on('console', m => {
      if (m.type() !== 'error' && m.type() !== 'warning') return;
      // "Failed to load resource" only names the URL in its location
      record(`console.${m.type()}`, { text: m.text().slice(0, 2000), url: m.location()?.url || undefined });
    });
    p.on('pageerror', e => record('pageerror', { text: String(e.stack ?? e).slice(0, 4000) }));
    p.on('requestfailed', r => record('requestfailed', { url: r.url(), text: r.failure()?.errorText }));
    p.on('response', r => { if (r.status() >= 400) record('http', { url: r.url(), status: r.status() }); });
    p.on('framenavigated', f => { if (f === p.mainFrame()) record('navigate', { url: f.url() }); });
  };
  for (const p of context.pages()) {
    watch(p);
    await p.evaluate(overlaySource).catch(() => {}); // already loaded, so the init script missed it
  }
  context.on('page', watch);
}

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
