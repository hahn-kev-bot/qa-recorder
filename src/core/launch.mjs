import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { resolveFile } from './fsutil.mjs';
import { profilesDir } from './paths.mjs';

export async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, child, what, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`${what} exited (code ${child.exitCode}) before it was ready.`);
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 750));
  }
  throw new Error(`Timed out waiting for ${what} at ${url}.`);
}

/** The program a launch config names: a file in the build, a path, or (otherwise) a command on PATH. */
async function resolveExe(launch, buildDir) {
  const spec = typeof launch.exe === 'string' ? launch.exe : launch.exe[process.platform];
  if (!spec) throw new Error(`The launch config has no exe for ${process.platform}.`);
  try {
    const file = await resolveFile(spec, buildDir);
    if (process.platform !== 'win32' && buildDir && file.startsWith(buildDir)) await fs.chmod(file, 0o755); // artifacts lose the executable bit
    return file;
  } catch (e) {
    if (!/[\\/]/.test(spec)) return spec; // a bare command name, found on PATH
    throw new Error(`Can't find ${spec}${buildDir ? ` in ${buildDir}` : ''}: ${e.message}`);
  }
}

async function startProcess(launch, buildDir, appData, extraEnv = {}) {
  const exe = await resolveExe(launch, buildDir);
  const cwd = launch.cwd ?? appData;
  await fs.mkdir(cwd, { recursive: true });
  const child = spawn(exe, launch.args ?? [], {
    cwd,
    stdio: 'ignore',
    shell: launch.shell ?? false,
    env: { ...inheritedEnv(), ...launch.env, ...extraEnv },
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', e => reject(new Error(`Couldn't start ${exe}: ${e.message}`)));
  });
  return child;
}

/**
 * Our environment minus ELECTRON_RUN_AS_NODE: Electron-based editors set it for their terminals (and Electron sets
 * it for us), and an Electron app under test would start as plain Node. A target can still set it in launch.env.
 */
function inheritedEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** Kill a process and wait for it to be gone, so callers can rely on it having exited. */
async function stop(child, timeoutMs = 10_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  if (process.platform === 'win32' && child.spawnargs?.length && child.spawnfile?.match(/cmd\.exe$/i)) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); // shell: kill the whole tree
  } else {
    child.kill();
  }
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, timeoutMs))]);
}

async function launchBrowser(launch, { appData, targetId }) {
  const userDataDir = launch.profile === 'persistent' ? path.join(profilesDir(), targetId) : path.join(appData, 'browser-profile');
  const channels = launch.browser ? [launch.browser === 'chromium' ? undefined : launch.browser] : ['chrome', 'msedge', undefined];
  const errors = [];
  for (const channel of channels) {
    try {
      return await chromium.launchPersistentContext(userDataDir, {
        channel, headless: false, viewport: null, args: ['--start-maximized', '--no-first-run', '--no-default-browser-check'],
      });
    } catch (e) {
      errors.push(`${channel ?? 'playwright chromium'}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error(`No Chromium-based browser found. Install Chrome or Edge, or run \`npx playwright install chromium\`.\n${errors.join('\n')}`);
}

/**
 * Starts what a target's launch config describes and attaches to it. Returns
 * { context, page, closed: Promise (the app or browser went away), close() }.
 * `launch` must already have its ${...} variables expanded.
 */
export async function launch(launch, { buildDir, appData, port, targetId }) {
  switch (launch.type) {
    case 'browser': {
      const context = await launchBrowser(launch, { appData, targetId });
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(launch.url);
      return attached({ context, page, closed: once(context, 'close') });
    }
    case 'server': {
      const child = await startProcess(launch, buildDir, appData);
      try {
        await waitFor(launch.readyUrl ?? launch.url, child, 'The server');
        const context = await launchBrowser(launch, { appData, targetId });
        const page = context.pages()[0] ?? await context.newPage();
        await page.goto(launch.url);
        return attached({ context, page, child, closed: Promise.race([once(context, 'close'), once(child, 'exit')]) });
      } catch (e) {
        await stop(child);
        throw e;
      }
    }
    case 'webview2':
    case 'cdp': {
      if (launch.type === 'webview2' && process.platform !== 'win32') throw new Error('WebView2 apps run on Windows only.');
      const extraEnv = launch.type === 'webview2' ? {
        WEBVIEW2_USER_DATA_FOLDER: path.join(appData, 'webview2'),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      } : {};
      const cdpUrl = launch.cdpUrl ?? `http://127.0.0.1:${port}`;
      const child = launch.exe ? await startProcess(launch, buildDir, appData, extraEnv) : undefined;
      try {
        await waitFor(`${cdpUrl}/json/version`, child, launch.exe ? path.basename(String(child.spawnfile)) : 'The DevTools endpoint');
        const browser = await chromium.connectOverCDP(cdpUrl);
        const context = browser.contexts()[0];
        const page = context.pages()[0] ?? await context.waitForEvent('page');
        const closed = Promise.race([once(browser, 'disconnected'), ...(child ? [once(child, 'exit')] : [])]);
        // attaching to something already running: disconnect, don't close it
        return attached({ context, page, child, closed, browser });
      } catch (e) {
        await stop(child);
        throw e;
      }
    }
    default:
      throw new Error(`Unknown launch type ${launch.type}`);
  }
}

const once = (emitter, event) => new Promise(resolve => emitter.once(event, () => resolve(event)));

function attached({ context, page, child, closed, browser }) {
  return {
    context,
    page,
    child,
    closed,
    async close() {
      await (browser ?? context).close().catch(() => {});
      await stop(child);
    },
  };
}
