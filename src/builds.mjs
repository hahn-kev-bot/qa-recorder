import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildsDir } from './paths.mjs';

const run = promisify(execFile);

export const DEFAULT_REPO = 'sillsdev/languageforge-lexbox';
export const WORKFLOW = 'fw-lite.yaml';

/** CI artifact that holds a runnable app for each target. */
export const ARTIFACTS = {
  maui: 'fw-lite-portable', // Windows MAUI, unpackaged
  web: 'fw-lite-web-linux', // FwLiteWeb, linux-x64 + linux-arm64
};

async function gh(args) {
  try {
    const { stdout } = await run('gh', args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('The GitHub CLI (gh) is required: https://cli.github.com, then run `gh auth login`.');
    throw new Error(`gh ${args.join(' ')} failed:\n${e.stderr || e.message}`);
  }
}

/** Latest successful FW Lite run on a branch, or a specific run id. */
export async function findRun({ repo = DEFAULT_REPO, branch = 'develop', runId } = {}) {
  if (runId) {
    const json = await gh(['run', 'view', String(runId), '-R', repo, '--json', 'databaseId,headSha,headBranch,createdAt,displayTitle,url,conclusion']);
    return JSON.parse(json);
  }
  const json = await gh(['run', 'list', '-R', repo, '-w', WORKFLOW, '-b', branch, '-s', 'success', '-L', '1',
    '--json', 'databaseId,headSha,headBranch,createdAt,displayTitle,url,conclusion']);
  const [latest] = JSON.parse(json);
  if (!latest) throw new Error(`No successful ${WORKFLOW} run found on ${branch} in ${repo}.`);
  return latest;
}

/**
 * Downloads the artifact for a run into the build cache, reusing an earlier download.
 * Returns { dir, run }. CI artifacts expire (90 days by default), so old runs may be gone.
 */
export async function fetchBuild(run, target, { repo = DEFAULT_REPO, log = console.log } = {}) {
  const artifact = ARTIFACTS[target];
  const dir = path.join(buildsDir(), `${run.databaseId}-${artifact}`);
  const marker = path.join(dir, 'fwlite-qa-build.json');
  try {
    await fs.access(marker);
    log(`Using cached build ${dir}`);
    return { dir, run };
  } catch { /* not cached yet */ }

  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  log(`Downloading ${artifact} from run ${run.databaseId} (${run.headSha.slice(0, 7)}, ${run.displayTitle})...`);
  await gh(['run', 'download', String(run.databaseId), '-R', repo, '-n', artifact, '-D', dir]);
  await fs.writeFile(marker, JSON.stringify({ ...run, artifact, repo }, null, 2));
  return { dir, run };
}

/** First file with this name under dir (artifacts nest the app in a release_* folder). */
export async function findFile(dir, name) {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  const hit = entries.find(e => e.isFile() && e.name === name);
  return hit ? path.join(hit.parentPath, hit.name) : undefined;
}
