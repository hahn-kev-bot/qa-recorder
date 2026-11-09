// Retakes the README screenshots in docs/screenshots: a demo session on a made-up shop (scripts/demo-site), recorded
// through the desktop app in a throwaway data folder, so no real sessions or names end up in them.
// Run: node scripts/readme-screenshots.mjs (needs Chrome or Edge)
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, chromium } from 'playwright-core';
import { freePort } from '../src/core/launch.mjs';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = path.join(repo, 'docs', 'screenshots');
// inside the repo (and git-ignored) so the paths in the pictures don't name anyone's user folder
const home = path.join(repo, '.demo-home');
await fs.rm(home, { recursive: true, force: true });
await fs.mkdir(path.join(home, 'targets'), { recursive: true });
await fs.mkdir(out, { recursive: true });

const page1 = await fs.readFile(path.join(repo, 'scripts', 'demo-site', 'index.html'));
const server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page1));
await new Promise(r => server.listen(0, '127.0.0.1', r));
const siteUrl = `http://localhost:${server.address().port}/`;

// the demo browser: the script plays the tester in it
const port = await freePort();
const launchArgs = { headless: false, args: [`--remote-debugging-port=${port}`, '--window-size=1280,860'] };
const browser = await chromium.launch({ channel: 'msedge', ...launchArgs }).catch(() => chromium.launch({ channel: 'chrome', ...launchArgs }));
const page = await (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage();
await page.goto('about:blank');
await fs.writeFile(path.join(home, 'targets', 'leaf-and-kettle.json'), JSON.stringify({
  name: 'Leaf & Kettle shop',
  description: 'The shop website, in a browser the recorder attaches to',
  launch: { type: 'cdp', cdpUrl: `http://127.0.0.1:${port}` },
  setup: [{ goto: siteUrl }, { waitFor: { text: 'Autumn teas' } }],
}, null, 2));

const env = { ...process.env, QA_RECORDER_HOME: home, QA_RECORDER_NO_BROWSER: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [repo], env });
const win = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 760));
const hideToasts = () => win.addStyleTag({ content: '#toast { display: none !important; }' });
const nav = name => win.locator('#sidebar').getByRole('button', { name });
const main = win.locator('#main');

await nav('Leaf & Kettle shop').click();

// a session: the tester browses and leaves notes with the toolbar
await main.getByRole('button', { name: '▶ Start session' }).click();
await main.locator('.badge.running').waitFor({ timeout: 60_000 });
await page.waitForFunction(() => !!document.getElementById('qa-recorder-root'));
const toolbar = page.locator('#qa-recorder-root');
await page.getByRole('button', { name: 'Green' }).click();
await page.getByRole('button', { name: 'All' }).click();
await page.getByPlaceholder('Find a tea').fill('oolong');
await page.getByRole('button', { name: 'Search', exact: true }).click();
await page.getByRole('button', { name: 'Add' }).nth(1).click();

// a region note (F9) on the filters, photographed with the note form open
const filters = await page.getByRole('toolbar', { name: 'Filters' }).boundingBox();
await page.keyboard.press('F9');
await page.mouse.move(filters.x - 8, filters.y - 8);
await page.mouse.down();
await page.mouse.move(filters.x + filters.width + 8, filters.y + filters.height + 8, { steps: 5 });
await page.mouse.up();
await page.keyboard.type('Picking a filter doesn\'t show which teas match until I scroll. Show a count on each filter?');
await toolbar.locator('.kinds button[data-kind="idea"]').click();
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(out, 'toolbar.png') });
await page.keyboard.press('Control+Enter');
await main.locator('.note').nth(0).waitFor({ timeout: 15_000 });

// an element note (F8) on the search box
const search = await page.getByPlaceholder('Find a tea').boundingBox();
await page.keyboard.press('F8');
await page.mouse.move(search.x + 20, search.y + 8);
await page.mouse.click(search.x + 20, search.y + 8);
await toolbar.locator('.kinds button[data-kind="bug"]').click();
await page.keyboard.type('Searching for "oolong" shows nothing and gives no message. Say no teas matched.');
await page.keyboard.press('Control+Enter');
await main.locator('.note').nth(1).waitFor({ timeout: 15_000 });

// a general note, from the toolbar's button
await toolbar.locator('button[data-act="note"]').click();
await toolbar.locator('.kinds button[data-kind="like"]').click();
await page.keyboard.type('The product cards are easy to scan.');
await page.keyboard.press('Control+Enter');
await main.locator('.note').nth(2).waitFor({ timeout: 15_000 });

await main.getByRole('button', { name: 'Finish session' }).click();
await main.locator('.badge.ended').waitFor({ timeout: 60_000 });
await browser.close().catch(() => {});
await win.waitForFunction(() => [...document.querySelectorAll('#main .note img')].every(i => i.complete && i.naturalWidth > 0));
await hideToasts();
await win.waitForTimeout(500);
await win.screenshot({ path: path.join(out, 'session.png') });
// the timeline, further down the same page
await main.locator('#timeline').scrollIntoViewIfNeeded();
await win.waitForTimeout(300);
await win.screenshot({ path: path.join(out, 'timeline.png') });

await app.close();
server.close();
await fs.rm(home, { recursive: true, force: true });
console.log(`Saved ${(await fs.readdir(out)).join(', ')} in ${out}`);
