#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { listBuilds, resolveBuild } from './core/builds.mjs';
import { qaHome, toolRoot } from './core/paths.mjs';
import { startSession } from './core/recorder.mjs';
import { cleanupSessions, listSessions } from './core/sessions.mjs';
import { authoringPrompt, getTarget, listTargets, parseTarget, targetFromUrl } from './core/targets.mjs';

const USAGE = `qa-recorder: record a QA session of an app or website and hand the feedback to a coding agent.

Usage:
  qa-recorder gui                         open the desktop app
  qa-recorder start <target> [options]    record a session (target: an id from \`targets\`, or a .json file)
  qa-recorder start --url <url>           record a session of any website
  qa-recorder targets                     list targets
  qa-recorder fetch <target> [--run <id>] download a target's build without starting
  qa-recorder builds                      list downloaded builds
  qa-recorder sessions                    list sessions
  qa-recorder cleanup --older-than <days> [--empty]   delete old sessions (--empty: only those without notes)
  qa-recorder validate <file.json>        check a target config against the schema
  qa-recorder prompt                      print the prompt for an AI to write a target config

Options for start:
  --run <id>      a specific CI run instead of the latest
  --offline       don't check for a newer build; use the newest download
  --exe <path>    run this program instead of the target's build (e.g. a local build)

Data lives in ${qaHome()} (set QA_RECORDER_HOME to move it).
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string' },
    run: { type: 'string' },
    offline: { type: 'boolean', default: false },
    exe: { type: 'string' },
    'older-than': { type: 'string' },
    empty: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const [command, arg] = positionals;
const mb = n => `${(n / 1024 / 1024).toFixed(1)} MB`;

switch (values.help ? 'help' : command) {
  case 'gui': {
    const electron = createRequire(import.meta.url)('electron');
    // editors built on Electron set this for their terminals; it would start Electron as plain Node
    const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
    void ELECTRON_RUN_AS_NODE;
    // no trailing slash: on Windows "C:\dir\" escapes the closing quote
    const child = spawn(electron, [path.resolve(toolRoot())], { stdio: 'inherit', env });
    child.on('exit', code => process.exit(code ?? 0));
    break;
  }
  case 'start': {
    const target = values.url ? { ...targetFromUrl(values.url), file: undefined } : await getTarget(need(arg, 'a target'));
    const session = await startSession(target, { runId: values.run, latest: !values.offline, exe: values.exe, log: m => console.log(m) });
    console.log(`Session folder: ${session.dir}`);
    process.once('SIGINT', () => session.finish());
    try {
      const { notes } = await session.done;
      console.log(`\n${notes.length} note(s) in ${path.join(session.dir, 'feedback.md')}`);
      if (notes.length) console.log(`To hand it off, tell a coding agent:\n  Read ${path.join(session.dir, 'HANDOFF.md')} and follow it.`);
      process.exit(0);
    } catch {
      process.exit(1);
    }
    break;
  }
  case 'targets':
    for (const t of await listTargets()) {
      const state = t.error ? 'BROKEN' : t.available ? '' : `(not on ${process.platform})`;
      console.log(`${t.id.padEnd(24)} ${(t.config?.name ?? '').padEnd(28)} ${t.source.padEnd(8)} ${state}`);
    }
    break;
  case 'fetch': {
    const { dir } = await resolveBuild(await getTarget(need(arg, 'a target')), { runId: values.run });
    console.log(dir ?? 'This target has no build to download.');
    break;
  }
  case 'builds':
    for (const b of await listBuilds()) console.log(`${b.repo} ${b.artifact} run ${b.runId} ${b.sha.slice(0, 7)} ${b.createdAt} ${mb(b.size)}\n  ${b.dir}`);
    break;
  case 'sessions':
    for (const s of await listSessions()) console.log(`${s.id.padEnd(48)} ${String(s.notes).padStart(3)} notes  ${s.status.padEnd(11)} ${mb(s.size)}`);
    break;
  case 'cleanup': {
    const days = Number(need(values['older-than'], '--older-than <days>'));
    const deleted = await cleanupSessions({ olderThanDays: days, onlyEmpty: values.empty });
    console.log(`Deleted ${deleted.length} session(s).`);
    break;
  }
  case 'validate':
    await parseTarget(await fs.readFile(need(arg, 'a file'), 'utf8'));
    console.log('OK');
    break;
  case 'prompt':
    console.log(await authoringPrompt());
    break;
  default:
    console.log(USAGE);
    process.exit(values.help || !command ? 0 : 1);
}

function need(value, what) {
  if (!value) {
    console.error(`Missing ${what}.\n\n${USAGE}`);
    process.exit(1);
  }
  return value;
}
