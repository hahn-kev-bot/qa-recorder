#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_REPO, fetchBuild, findRun } from './builds.mjs';
import { launchMaui, launchWeb } from './launch.mjs';
import { runSession } from './harness.mjs';
import { sessionsDir } from './paths.mjs';

const USAGE = `fwlite-qa: QA a CI build of FieldWorks Lite and collect feedback for a coding agent.

Usage:
  fwlite-qa [start] [options]   download (if needed), launch, and record a QA session
  fwlite-qa fetch [options]     only download the build

Options:
  --target maui|web   maui = Windows MAUI app (default on Windows), web = FwLiteWeb in a browser (default elsewhere)
  --branch <name>     branch to take the latest successful build from (default develop)
  --run <id>          a specific CI run instead of the latest
  --repo <owner/name> default ${DEFAULT_REPO}
  --exe <path>        run a local build instead of downloading (FwLiteMaui.exe or FwLiteWeb)
  --no-example        start with an empty data folder instead of opening the example project
  -h, --help
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    target: { type: 'string', default: process.platform === 'win32' ? 'maui' : 'web' },
    branch: { type: 'string', default: 'develop' },
    run: { type: 'string' },
    repo: { type: 'string', default: DEFAULT_REPO },
    exe: { type: 'string' },
    'no-example': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const command = positionals[0] ?? 'start';
if (values.help || !['start', 'fetch'].includes(command)) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}
if (!['maui', 'web'].includes(values.target)) throw new Error(`Unknown --target ${values.target}`);
if (values.target === 'maui' && process.platform !== 'win32') throw new Error('The MAUI target is Windows only; use --target web.');

const repo = values.repo;
let run;
let buildDir;
if (values.exe) {
  run = { databaseId: 'local', headSha: 'local-build', headBranch: 'local', displayTitle: values.exe, url: '' };
} else {
  run = await findRun({ repo, branch: values.branch, runId: values.run });
  ({ dir: buildDir } = await fetchBuild(run, values.target, { repo }));
}
if (command === 'fetch') {
  console.log(buildDir);
  process.exit(0);
}

const startedAt = new Date();
const id = `${startedAt.toISOString().slice(0, 19).replace(/[:T]/g, '-')}_${run.headSha.slice(0, 7)}`;
const sessionDir = path.join(sessionsDir(), id);
await fs.mkdir(sessionDir, { recursive: true });
const session = { id, repo, target: values.target, run, startedAt: startedAt.toISOString(), openExample: !values['no-example'] };

console.log(`Launching FW Lite (${values.target}, ${run.headSha.slice(0, 7)})...`);
const launch = values.target === 'maui' ? launchMaui : launchWeb;
const launcher = await launch({ buildDir, sessionDir, exe: values.exe });
const { notes } = await runSession({ launcher, sessionDir, session, openExample: session.openExample });

console.log(`\nSession saved: ${sessionDir}`);
console.log(`${notes.length} note(s) in ${path.join(sessionDir, 'feedback.md')}`);
if (notes.length) {
  console.log('\nTo hand it off, start a coding agent in your LexBox checkout and say:');
  console.log(`  Read ${path.join(sessionDir, 'HANDOFF.md')} and follow it.`);
}
process.exit(0);
