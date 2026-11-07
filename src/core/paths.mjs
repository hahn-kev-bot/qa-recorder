import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root for downloaded builds, sessions and your own targets. Override with QA_RECORDER_HOME. */
export function qaHome() {
  if (process.env.QA_RECORDER_HOME) return path.resolve(process.env.QA_RECORDER_HOME);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'qa-recorder');
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'qa-recorder');
}

export const buildsDir = () => path.join(qaHome(), 'builds');
export const sessionsDir = () => path.join(qaHome(), 'sessions');
export const userTargetsDir = () => path.join(qaHome(), 'targets');
export const profilesDir = () => path.join(qaHome(), 'profiles');

/** The repo root: configs/, schema/ and AUTHORING.md ship with the tool. */
export const toolRoot = () => fileURLToPath(new URL('../../', import.meta.url));
export const bundledTargetsDir = () => path.join(toolRoot(), 'configs');
export const schemaPath = () => path.join(toolRoot(), 'schema', 'target.schema.json');
