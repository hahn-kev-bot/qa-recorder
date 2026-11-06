import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBundle } from './bundle.mjs';

const overlaySource = await fs.readFile(fileURLToPath(new URL('./overlay.js', import.meta.url)), 'utf8');

/**
 * Attaches to the running app, injects the feedback toolbar and records notes, errors and navigation into
 * sessionDir until the app closes or the user presses Ctrl+C.
 */
export async function runSession({ launcher, sessionDir, session, openExample = true, log = console.log, onReady }) {
  const notesDir = path.join(sessionDir, 'notes');
  await fs.mkdir(notesDir, { recursive: true });
  const { browser, context, page } = await launcher.connect();
  const notes = [];
  const events = [];
  const record = (type, data) => events.push({ at: new Date().toISOString(), type, ...data });
  const flush = () => writeBundle({ sessionDir, session, notes, events });

  await context.exposeBinding('__fwliteQaNote', async ({ page: source }, note) => {
    const id = String(notes.length + 1).padStart(3, '0');
    const full = `notes/${id}-full.png`;
    await source.screenshot({ path: path.join(sessionDir, full) });
    let crop;
    if (note.rect) {
      crop = `notes/${id}.png`;
      await source.screenshot({ path: path.join(sessionDir, crop), clip: padded(note.rect, note.viewport) });
    }
    notes.push({ id, ...note, screenshots: { crop, full } });
    await flush();
    log(`  note ${id} (${note.kind}) saved`);
    return { id, count: notes.length };
  });
  await context.addInitScript({ content: overlaySource });

  const watch = p => {
    p.on('console', m => {
      if (m.type() === 'error' || m.type() === 'warning') record(`console.${m.type()}`, { text: m.text().slice(0, 2000) });
    });
    p.on('pageerror', e => record('pageerror', { text: String(e.stack ?? e).slice(0, 4000) }));
    p.on('requestfailed', r => record('requestfailed', { url: r.url(), error: r.failure()?.errorText }));
    p.on('response', r => { if (r.status() >= 400) record('http', { url: r.url(), status: r.status() }); });
    p.on('framenavigated', f => { if (f === p.mainFrame()) record('navigate', { url: f.url() }); });
  };
  for (const p of context.pages()) {
    watch(p);
    await p.evaluate(overlaySource).catch(() => {}); // already loaded, so the init script missed it
  }
  context.on('page', watch);

  await goHome(page);
  if (openExample) await openExampleProject(page, log);
  record('navigate', { url: page.url() });
  await flush();
  onReady?.();

  log('\nQA session running. Use the toolbar in the bottom-left corner of the app:');
  log('  F8 pick an element · F9 drag a region · F7 general note');
  log('Close the app or press Ctrl+C here to finish.\n');

  await new Promise(resolve => {
    launcher.child.once('exit', resolve);
    browser.once('disconnected', resolve);
    process.once('SIGINT', resolve);
  });
  record('end', {});
  await flush();
  await launcher.close(browser);
  return { notes, events };
}

/** Crop with some context around the selection, kept inside the viewport. */
function padded(rect, viewport, pad = 24) {
  const x = Math.max(0, rect.x - pad);
  const y = Math.max(0, rect.y - pad);
  return {
    x, y,
    width: Math.max(1, Math.min(viewport.width, rect.x + rect.width + pad) - x),
    height: Math.max(1, Math.min(viewport.height, rect.y + rect.height + pad) - y),
  };
}

/** Builds that predate --start-url reopen the last page from the tester's real install; route home instead. */
async function goHome(page) {
  if (new URL(page.url()).pathname === '/') return;
  await page.evaluate(() => {
    history.pushState({}, '', '/');
    dispatchEvent(new PopStateEvent('popstate'));
  });
}

async function openExampleProject(page, log) {
  const create = page.getByText('Create Example Project', { exact: true });
  // the list item reads "Example-Project (example-project)"
  const existing = page.getByRole('link', { name: /Example-Project/ });
  await create.or(existing).first().waitFor({ timeout: 120_000 });
  if (!await existing.isVisible()) {
    log('Creating the example project...');
    await create.click();
    await existing.waitFor({ timeout: 120_000 });
  }
  await existing.click();
  await page.waitForURL(u => u.pathname.startsWith('/project'), { timeout: 60_000 });
}
