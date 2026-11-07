// Electron main process: owns the core (builds, sessions, Playwright) and serves it to the window over IPC.
import { app, BrowserWindow, clipboard, ipcMain, net, protocol, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { artifactSize, buildsFor, deleteBuild, downloadBuild, latestBuild, listBuilds, pruneBuilds } from '../core/builds.mjs';
import { qaHome, sessionsDir } from '../core/paths.mjs';
import { startSession } from '../core/recorder.mjs';
import { cleanupSessions, deleteSession, getSession, listSessions, storageSummary } from '../core/sessions.mjs';
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
  'sessions:start': async (targetId, { runId, offline } = {}) => {
    const target = await getTarget(targetId);
    const controller = await startSession(target, { runId, latest: !offline });
    live.set(controller.id, controller);
    const emit = (type, data) => send('session', { id: controller.id, targetId, type, data });
    controller.emitter.on('log', m => { log(controller.id, m); emit('log', m); });
    controller.emitter.on('status', s => emit('status', s));
    controller.emitter.on('note', n => emit('note', { id: n.id, kind: n.kind }));
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

  'storage:summary': () => storageSummary({ live: liveIds() }),

  'shell:open': p => openInside(p),
};

/**
 * Opens a file or folder the tool owns (sessions, builds, targets) in its default app. On Windows, shell.openPath
 * can stall the whole app while Explorer or the file's app starts, so hand the path to explorer.exe and return.
 */
async function openInside(p) {
  const resolved = path.resolve(p);
  const roots = [qaHome(), fileURLToPath(new URL('../../configs/', import.meta.url))].map(r => path.resolve(r) + path.sep);
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

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 820,
    minHeight: 520,
    title: 'QA Recorder',
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
    return net.fetch(pathToFileURL(file).href);
  });
  createWindow();
});

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
