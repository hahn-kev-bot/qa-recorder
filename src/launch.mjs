import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findFile } from './builds.mjs';

/** Settings that keep a QA session away from the tester's real data and out of production telemetry. */
function isolationSettings(appData) {
  return {
    'FwLiteMaui:BaseDataDir': appData, // MAUI: projects, logs, auth cache, settings file
    'LcmCrdt:ProjectPath': appData, // FwLiteWeb: projects
    'FwDataBridge:ProjectsFolder': path.join(appData, 'fieldworks-projects'), // instead of the registry's real FieldWorks folder
    'Analytics:Enabled': 'false',
    'FwLite:UpdateCheckCondition': 'Never',
  };
}

const asEnv = settings => Object.fromEntries(Object.entries(settings).map(([k, v]) => [k.replaceAll(':', '__'), v]));
const asArgs = settings => Object.entries(settings).map(([k, v]) => `--${k}=${v}`);

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
    if (child.exitCode !== null) throw new Error(`${what} exited (code ${child.exitCode}) before it was ready.`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 750));
  }
  throw new Error(`Timed out waiting for ${what} at ${url}.`);
}

async function prepareAppData(sessionDir) {
  const appData = path.join(sessionDir, '.app-data');
  await fs.mkdir(path.join(appData, 'fieldworks-projects'), { recursive: true });
  return appData;
}

/**
 * Windows MAUI app. WebView2 reads WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, so an unmodified CI build exposes the
 * DevTools protocol and the harness can attach to it like a browser.
 */
export async function launchMaui({ buildDir, sessionDir, exe }) {
  exe ??= await findFile(buildDir, 'FwLiteMaui.exe');
  if (!exe) throw new Error(`FwLiteMaui.exe not found under ${buildDir}`);
  const appData = await prepareAppData(sessionDir);
  const port = await freePort();
  const child = spawn(exe, ['--start-url', '/'], {
    cwd: appData, // portable builds keep data in the working directory
    stdio: 'ignore',
    env: {
      ...process.env,
      ...asEnv(isolationSettings(appData)),
      WEBVIEW2_USER_DATA_FOLDER: path.join(appData, 'webview2'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  });
  const cdpUrl = `http://127.0.0.1:${port}`;
  await waitFor(`${cdpUrl}/json/version`, child, 'FW Lite');
  return {
    kind: 'maui',
    child,
    appData,
    async connect() {
      const browser = await chromium.connectOverCDP(cdpUrl);
      const context = browser.contexts()[0];
      const page = context.pages()[0] ?? await context.waitForEvent('page');
      return { browser, context, page };
    },
    async close(browser) {
      await browser?.close().catch(() => {});
      if (child.exitCode === null) child.kill();
    },
  };
}

/** FwLiteWeb in a Playwright-launched browser: the fallback where there is no Windows MAUI build. */
export async function launchWeb({ buildDir, sessionDir, exe }) {
  if (!exe) {
    const rid = process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
    exe = await findFile(path.join(buildDir, `release_${rid}`), 'FwLiteWeb');
    if (!exe) throw new Error(`FwLiteWeb not found for ${rid} under ${buildDir}. On macOS/Windows pass --web-exe <path to a local FwLiteWeb build>.`);
    await fs.chmod(exe, 0o755); // artifacts lose the executable bit
  }
  const appData = await prepareAppData(sessionDir);
  const port = await freePort();
  const appUrl = `http://127.0.0.1:${port}/`;
  const child = spawn(exe, [`--urls=${appUrl}`, '--FwLiteWeb:OpenBrowser=false', '--FwLiteWeb:EnableFileLogging=false',
    ...asArgs(isolationSettings(appData))], { cwd: appData, stdio: 'ignore' });
  await waitFor(appUrl, child, 'FwLiteWeb');
  return {
    kind: 'web',
    child,
    appData,
    async connect() {
      const browser = await launchBrowser();
      const context = await browser.newContext({ viewport: null });
      const page = await context.newPage();
      await page.goto(appUrl);
      return { browser, context, page };
    },
    async close(browser) {
      await browser?.close().catch(() => {});
      if (child.exitCode === null) child.kill();
    },
  };
}

async function launchBrowser() {
  const errors = [];
  for (const channel of ['chrome', 'msedge', undefined]) {
    try {
      return await chromium.launch({ channel, headless: false, args: ['--start-maximized'] });
    } catch (e) {
      errors.push(`${channel ?? 'playwright chromium'}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error(`No Chromium-based browser found. Install Chrome or Edge, or run \`npx playwright install chromium\`.\n${errors.join('\n')}`);
}
