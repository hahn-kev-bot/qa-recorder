import fs from 'node:fs/promises';
import path from 'node:path';
import { listBuilds } from './builds.mjs';
import { dirSize } from './fsutil.mjs';
import { sessionsDir } from './paths.mjs';

const inSessions = id => {
  const dir = path.resolve(sessionsDir(), id);
  if (path.dirname(dir) !== path.resolve(sessionsDir())) throw new Error(`Not a session id: ${id}`);
  return dir;
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Every session, newest first. `live` is the set of session ids running in this process. */
export async function listSessions({ live = new Set(), sizes = true } = {}) {
  let ids;
  try {
    ids = await fs.readdir(sessionsDir());
  } catch {
    return [];
  }
  const sessions = await Promise.all(ids.map(async id => {
    const dir = path.join(sessionsDir(), id);
    const s = await readJson(path.join(dir, 'session.json'));
    if (!s) return undefined;
    // a session that says it is running but isn't ours was cut off (crash, killed)
    const status = live.has(id) ? s.status : s.status === 'running' || s.status === 'starting' ? 'interrupted' : s.status;
    return { ...s, status, dir, size: sizes ? await dirSize(dir) : undefined };
  }));
  return sessions.filter(Boolean).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** One session with its notes and events, for the viewer. */
export async function getSession(id) {
  const dir = inSessions(id);
  const session = await readJson(path.join(dir, 'session.json'));
  if (!session) throw new Error(`No session ${id}`);
  return {
    session: { ...session, dir },
    notes: await readJson(path.join(dir, 'notes.json'), []),
    events: await readJson(path.join(dir, 'events.json'), []),
  };
}

export async function deleteSession(id) {
  await fs.rm(inSessions(id), { recursive: true, force: true });
}

/** Deletes ended sessions older than the cutoff (optionally only those without notes). Returns the ids deleted. */
export async function cleanupSessions({ olderThanDays = 0, onlyEmpty = false, live = new Set() } = {}) {
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const doomed = (await listSessions({ live, sizes: false }))
    .filter(s => !live.has(s.id) && Date.parse(s.startedAt) <= cutoff && (!onlyEmpty || !s.notes));
  for (const s of doomed) await deleteSession(s.id);
  return doomed.map(s => s.id);
}

/** Sizes for the storage page. */
export async function storageSummary({ live } = {}) {
  const [sessions, builds] = await Promise.all([listSessions({ live }), listBuilds()]);
  const sum = xs => xs.reduce((t, x) => t + (x.size ?? 0), 0);
  return { sessions, builds, sessionsSize: sum(sessions), buildsSize: sum(builds) };
}
