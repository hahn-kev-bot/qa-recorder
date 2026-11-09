// Electron main process: owns the core (builds, sessions, Playwright) and serves it to the window over IPC.
import { app, BrowserWindow, clipboard, ipcMain, protocol, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactSize, buildsFor, deleteBuild, downloadBuild, latestBuild, listBuilds, pruneBuilds } from '../core/builds.mjs';
import { buildsDir, qaHome, sessionsDir } from '../core/paths.mjs';
import { startSession } from '../core/recorder.mjs';
import { serveFile } from '../core/serve-file.mjs';
import { analyzeAudio } from '../core/speech/analyze.mjs';
import { normalize } from '../core/speech/chunker.mjs';
import { retranscribeSession } from '../core/speech/retranscribe.mjs';
import { createTranscriber, isDownloaded, MODELS, modelFor, modelsDir } from '../core/speech/transcriber.mjs';
import { cleanupSessions, deleteSession, getSession, listSessions, storageSummary } from '../core/sessions.mjs';
import { startUpdates } from './updates.mjs';
import {
  authoringPrompt, deleteTarget, getTarget, listTargets, saveTarget, slug, targetFromUrl, validateTarget,
} from '../core/targets.mjs';

// main.cjs registers the qa-file scheme before this module loads

/** Sessions running in this process, by id. */
const live = new Map();
let win;

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const log = (scope, message) => send('log', { scope, message, at: new Date().toISOString() });
const liveIds = () => new Set(live.keys());

const handlers = {
  'app:info': () => ({ home: qaHome(), version: app.getVersion(), platform: process.platform }),
  'app:about': async () => {
    const pkg = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    return {
      version: pkg.version,
      description: pkg.description,
      repo: repoUrl(pkg),
      home: qaHome(),
      sessions: sessionsDir(),
      builds: buildsDir(),
      models: modelsDir(),
      speech: await Promise.all(Object.values(MODELS).map(async m => ({ label: m.label, size: m.size, downloaded: await isDownloaded(m) }))),
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      platform: `${process.platform} ${process.arch}`,
    };
  },
  'updates:state': () => updates.state(),
  'updates:check': () => updates.check(),
  'updates:install': () => {
    if (live.size) throw new Error('Finish the running session first: restarting would end it.');
    updates.install();
  },
  // only ever the project's own page, never a URL from the window
  'app:openRepo': async () => shell.openExternal(repoUrl(JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8')))),

  'targets:list': async () => (await listTargets()).map(t => ({
    id: t.id,
    source: t.source,
    overrides: t.overrides ?? false,
    file: t.file,
    available: t.available ?? false,
    error: t.error,
    name: t.config?.name ?? t.id,
    description: t.config?.description,
    launchType: t.config?.launch.type,
    url: t.config?.launch.url,
    build: t.config?.build,
    platforms: t.config?.platforms,
  })),
  'targets:read': async id => {
    const t = (await listTargets()).find(x => x.id === id);
    if (!t) throw new Error(`No target ${id}`);
    return { id, source: t.source, overrides: t.overrides ?? false, file: t.file, text: await fs.readFile(t.file, 'utf8') };
  },
  'targets:validate': async text => {
    try {
      return await validateTarget(JSON.parse(text));
    } catch (e) {
      return [`Not valid JSON: ${e.message}`];
    }
  },
  'targets:save': async (id, text) => (await saveTarget(id, text)).id,
  'targets:delete': id => deleteTarget(id),
  'targets:fromUrl': url => {
    const { id, config } = targetFromUrl(url);
    return { id, text: `${JSON.stringify(config, null, 2)}\n` };
  },
  'targets:slug': s => slug(s),
  'targets:copyPrompt': async () => {
    const prompt = await authoringPrompt();
    clipboard.writeText(prompt);
    return prompt.length;
  },

  'builds:latest': async targetId => {
    const build = await latestBuild(await getTarget(targetId));
    return build && { ...build, artifactSize: await artifactSize(build).catch(() => undefined) };
  },
  'builds:forTarget': async targetId => buildsFor(await getTarget(targetId)),
  'builds:download': async (targetId, runId) => {
    const target = await getTarget(targetId);
    const build = await latestBuild(target, { runId });
    return downloadBuild(build, { log: m => log(targetId, m) });
  },
  'builds:list': () => listBuilds(),
  'builds:delete': dir => deleteBuild(dir),
  'builds:prune': () => pruneBuilds(),

  'sessions:list': () => listSessions({ live: liveIds() }),
  'sessions:get': id => getSession(id),
  'sessions:start': async (targetId, { runId, offline, voice = 'off' } = {}) => {
    const target = await getTarget(targetId);
    const controller = await startSession(target, { runId, latest: !offline, voice });
    live.set(controller.id, controller);
    const emit = (type, data) => send('session', { id: controller.id, targetId, type, data });
    controller.emitter.on('log', m => { log(controller.id, m); emit('log', m); });
    controller.emitter.on('status', s => emit('status', s));
    controller.emitter.on('note', n => emit('note', { id: n.id, kind: n.kind }));
    controller.emitter.on('action', () => emit('action'));
    controller.emitter.on('speech', () => emit('speech'));
    controller.done.finally(() => {
      live.delete(controller.id);
      emit('status', controller.status);
    });
    return controller.id;
  },
  'sessions:finish': id => live.get(id)?.finish(),
  'sessions:delete': id => {
    if (live.has(id)) throw new Error('Finish the session before deleting it.');
    return deleteSession(id);
  },
  'sessions:cleanup': opts => cleanupSessions({ ...opts, live: liveIds() }),
  'sessions:copyHandoff': async id => {
    const { session } = await getSession(id);
    const text = `Read ${path.join(session.dir, 'HANDOFF.md')} and follow it.`;
    clipboard.writeText(text);
    return text;
  },

  'sessions:retranscribe': async id => {
    if (live.has(id)) throw new Error('Finish the session first.');
    const { session } = await getSession(id);
    // tests pick the fast model so they don't download the big one
    const model = process.env.QA_RECORDER_RETRANSCRIBE_MODEL ? modelFor(process.env.QA_RECORDER_RETRANSCRIBE_MODEL) : undefined;
    const count = await retranscribeSession(session.dir, { model, log: m => send('session', { id, type: 'retranscribe', data: m }) });
    send('session', { id, type: 'updated' }); // the window reloads it
    return count;
  },

  // which models are already downloaded, so the window only warns about a download when there is one
  'speech:models': async () => {
    const better = process.env.QA_RECORDER_RETRANSCRIBE_MODEL ? modelFor(process.env.QA_RECORDER_RETRANSCRIBE_MODEL) : MODELS.better;
    return { better: { ...better, downloaded: await isDownloaded(better) } };
  },
  // the microphone page's check: how usable the recording is, and what the fast model makes of it
  'mic:test': async samples => {
    if (!(samples instanceof Float32Array)) throw new Error('No audio.');
    const analysis = analyzeAudio(samples);
    // Whisper invents words ("you", "Thank you.") from silence; don't show that as a transcript
    if (analysis.speechLevel < 0.003) return { ...analysis, text: '' };
    testTranscriber ??= createTranscriber();
    const segments = await testTranscriber.transcribe(normalize(samples));
    return { ...analysis, text: segments.map(s => s.text).join(' ') };
  },

  'storage:summary': () => storageSummary({ live: liveIds() }),

  'shell:open': p => openInside(p),
  'trace:open': (sessionId, file) => openTrace(sessionId, file),
};

const repoUrl = pkg => (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');

let traceViewer;
let testTranscriber;
app.on('will-quit', () => testTranscriber?.close());
/**
 * Serves a session's trace with Playwright's Trace Viewer and opens it in the default browser (Playwright opens
 * the tab itself once it is listening). One viewer at a time.
 */
async function openTrace(sessionId, file) {
  const { session } = await getSession(sessionId);
  const trace = path.resolve(session.dir, file);
  if (!trace.startsWith(path.resolve(session.dir) + path.sep)) throw new Error(`Not a trace in this session: ${file}`);
  await fs.access(trace);
  traceViewer?.kill();
  const cli = fileURLToPath(new URL('../../node_modules/playwright-core/cli.js', import.meta.url));
  // run Playwright's CLI on Electron's own Node; without the coding-agent variables it opens the browser tab itself
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.CLAUDECODE;
  delete env.COPILOT_CLI;
  if (process.env.QA_RECORDER_NO_BROWSER) env.CLAUDECODE = '1'; // tests: serve only (Playwright skips the tab for coding agents)
  const child = spawn(process.execPath, [cli, 'show-trace', '--host', '127.0.0.1', '--port', '0', trace], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  traceViewer = child;
  return await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`The trace viewer didn't start:\n${output}`)), 20_000);
    const onData = d => {
      output += d;
      const url = /Listening on (\S+)/.exec(output)?.[1];
      if (url) {
        clearTimeout(timer);
        resolve(url);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`The trace viewer exited (${code}):\n${output}`));
    });
  });
}
app.on('will-quit', () => traceViewer?.kill());

/**
 * Opens a file or folder the tool owns (sessions, builds, targets) in its default app. On Windows, shell.openPath
 * can stall the whole app while Explorer or the file's app starts, so hand the path to explorer.exe and return.
 */
async function openInside(p) {
  const resolved = path.resolve(p);
  const roots = [qaHome(), buildsDir(), modelsDir(), fileURLToPath(new URL('../../configs/', import.meta.url))].map(r => path.resolve(r) + path.sep);
  if (!roots.some(r => resolved.startsWith(r))) throw new Error(`Not a qa-recorder file: ${p}`);
  await fs.access(resolved);
  if (process.platform === 'win32') {
    spawn('explorer.exe', [resolved], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const error = await shell.openPath(resolved);
  if (error) throw new Error(error);
}

for (const [channel, fn] of Object.entries(handlers)) {
  ipcMain.handle(channel, async (_event, ...args) => fn(...args));
}

// microphone audio from the window, for sessions with voice on
ipcMain.on('voice:audio', (_event, sessionId, samples, at) => {
  const voice = live.get(sessionId)?.voice;
  if (voice && samples instanceof Float32Array) voice.push(samples, at);
});

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 820,
    minHeight: 520,
    title: 'QA Recorder',
    // the window and taskbar icon (made from assets/icon.svg by scripts/make-icon.mjs)
    icon: fileURLToPath(new URL(`../../assets/icon.${process.platform === 'win32' ? 'ico' : 'png'}`, import.meta.url)),
    autoHideMenuBar: true,
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.loadFile(fileURLToPath(new URL('./renderer/index.html', import.meta.url)));
}

app.whenReady().then(() => {
  // screenshots in the session viewer: qa-file://session/<id>/notes/001.png
  protocol.handle('qa-file', request => {
    const u = new URL(request.url);
    const file = path.resolve(sessionsDir(), decodeURIComponent(u.pathname).replace(/^\/+/, ''));
    if (u.hostname !== 'session' || !file.startsWith(path.resolve(sessionsDir()) + path.sep)) return new Response('forbidden', { status: 403 });
    return serveFile(file, request.headers.get('range'));
  });
  createWindow();
  updates = startUpdates({ app, onChange: s => send('update', s), log: m => log('updates', String(m)) });
});

let updates = { state: () => ({ status: 'idle' }), check: async () => {}, install: () => {} };

// finish running sessions so their notes are written and their apps closed
let quitting = false;
app.on('before-quit', async e => {
  if (quitting || !live.size) return;
  e.preventDefault();
  quitting = true;
  for (const c of live.values()) c.finish();
  await Promise.allSettled([...live.values()].map(c => c.done));
  app.quit();
});
app.on('window-all-closed', () => app.quit());
