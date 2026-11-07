import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildsDir } from './paths.mjs';
import { dirSize } from './fsutil.mjs';

const exec = promisify(execFile);
const MARKER = 'qa-recorder-build.json';
const RUN_FIELDS = 'databaseId,headSha,headBranch,createdAt,displayTitle,url,conclusion';

async function gh(args) {
  try {
    const { stdout } = await exec('gh', args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('The GitHub CLI (gh) is required: https://cli.github.com, then run `gh auth login`.');
    throw new Error(`gh ${args.join(' ')} failed:\n${e.stderr || e.message}`);
  }
}

const toBuild = (cfg, run) => ({
  source: 'github-actions',
  repo: cfg.repo,
  artifact: cfg.artifact,
  runId: String(run.databaseId),
  sha: run.headSha,
  branch: run.headBranch,
  title: run.displayTitle,
  url: run.url,
  createdAt: run.createdAt,
});

/** Latest successful run of the target's workflow, or a specific run. Undefined for targets without a CI build. */
export async function latestBuild(target, { runId } = {}) {
  const cfg = target.config.build;
  if (cfg?.type !== 'github-actions') return undefined;
  if (runId) return toBuild(cfg, JSON.parse(await gh(['run', 'view', String(runId), '-R', cfg.repo, '--json', RUN_FIELDS])));
  const branch = cfg.branch ?? 'develop';
  const [run] = JSON.parse(await gh(['run', 'list', '-R', cfg.repo, '-w', cfg.workflow, '-b', branch, '-s', 'success', '-L', '1', '--json', RUN_FIELDS]));
  if (!run) throw new Error(`No successful ${cfg.workflow} run on ${branch} in ${cfg.repo}.`);
  return toBuild(cfg, run);
}

const cacheDir = build => path.join(buildsDir(), build.repo.replace('/', '_'), `${build.runId}-${build.artifact}`);

/** Every downloaded build, newest first, with its size. */
export async function listBuilds() {
  let entries;
  try {
    entries = await fs.readdir(buildsDir(), { recursive: true });
  } catch {
    return [];
  }
  const builds = await Promise.all(entries.filter(e => path.basename(e) === MARKER).map(async e => {
    const dir = path.join(buildsDir(), path.dirname(e));
    const build = JSON.parse(await fs.readFile(path.join(dir, MARKER), 'utf8'));
    return { ...build, dir, size: await dirSize(dir) };
  }));
  return builds.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/** Builds already downloaded for this target's repo + artifact. */
export async function buildsFor(target) {
  const cfg = target.config.build;
  if (cfg?.type !== 'github-actions') return [];
  return (await listBuilds()).filter(b => b.repo === cfg.repo && b.artifact === cfg.artifact);
}

/** Downloads a build into the cache, or reuses the earlier download. CI artifacts expire, so old runs may be gone. */
export async function downloadBuild(build, { log = console.log } = {}) {
  const dir = cacheDir(build);
  try {
    await fs.access(path.join(dir, MARKER));
    return dir;
  } catch { /* not cached yet */ }
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  log(`Downloading ${build.artifact} from run ${build.runId} (${build.sha.slice(0, 7)}, ${build.title})...`);
  try {
    await gh(['run', 'download', build.runId, '-R', build.repo, '-n', build.artifact, '-D', dir]);
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    throw e;
  }
  await fs.writeFile(path.join(dir, MARKER), JSON.stringify({ ...build, downloadedAt: new Date().toISOString() }, null, 2));
  log('Download finished.');
  return dir;
}

export async function deleteBuild(dir) {
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(buildsDir()) + path.sep)) throw new Error(`${dir} is not in the build cache.`);
  await fs.rm(resolved, { recursive: true, force: true });
}

/**
 * The build a session runs: { build, dir }. For CI targets: a given run, or the latest (downloading it if needed);
 * offline, the newest download. For local targets, its folder. For websites, nothing.
 */
export async function resolveBuild(target, { runId, latest = true, log = console.log } = {}) {
  const cfg = target.config.build;
  if (!cfg) return { build: undefined, dir: undefined };
  if (cfg.type === 'local') {
    const dir = path.resolve(path.dirname(target.file ?? '.'), cfg.path);
    return { build: { source: 'local', dir, sha: 'local', title: dir }, dir };
  }
  // a run that is already downloaded needs no network
  let build = runId ? (await buildsFor(target)).find(b => b.runId === String(runId)) : undefined;
  if (build) return { build: buildInfo(build), dir: build.dir };
  if (runId || latest) {
    try {
      build = await latestBuild(target, { runId });
    } catch (e) {
      if (runId) throw e;
      log(`Couldn't check for the latest build (${e.message.split('\n')[0]}); using the newest download.`);
    }
  }
  if (!build) {
    [build] = await buildsFor(target);
    if (!build) throw new Error(`No downloaded build for ${target.config.name} and the latest couldn't be checked.`);
  }
  return { build: buildInfo(build), dir: await downloadBuild(buildInfo(build), { log }) };
}

/** A cached build also carries its folder and size; sessions only record what was built. */
const buildInfo = ({ dir, size, downloadedAt, ...info }) => info;

/** Deletes every download except the newest per repo + artifact. Returns the folders deleted. */
export async function pruneBuilds({ keep = new Set() } = {}) {
  const seen = new Set();
  const deleted = [];
  for (const b of await listBuilds()) {
    const key = `${b.repo}|${b.artifact}`;
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }
    if (keep.has(b.dir)) continue;
    await deleteBuild(b.dir);
    deleted.push(b.dir);
  }
  return deleted;
}
