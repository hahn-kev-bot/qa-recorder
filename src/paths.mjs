import os from 'node:os';
import path from 'node:path';

/** Root for downloaded builds and QA sessions. Override with FWLITE_QA_HOME. */
export function qaHome() {
  if (process.env.FWLITE_QA_HOME) return path.resolve(process.env.FWLITE_QA_HOME);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'fwlite-qa');
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'fwlite-qa');
}

export const buildsDir = () => path.join(qaHome(), 'builds');
export const sessionsDir = () => path.join(qaHome(), 'sessions');
