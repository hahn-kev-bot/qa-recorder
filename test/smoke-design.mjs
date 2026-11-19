// End-to-end: the design tools on the fixture cart. Move a button into the summary, resize the photo, undo a move
// with Esc, then check the notes, their before and after screenshots, feedback.md and HANDOFF.md.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveFixture } from './fixtures/server.mjs';

process.env.QA_RECORDER_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-recorder-smoke-design-'));
const { startSession } = await import('../src/core/recorder.mjs');
const { parseTarget } = await import('../src/core/targets.mjs');

const site = await serveFixture();
const config = await parseTarget(JSON.stringify({ name: 'Fixture cart', launch: { type: 'browser', url: `${site.url}design.html` }, capture: { trace: false } }));
const session = await startSession({ id: 'fixture-design', config }, { log: m => console.log('[session]', m) });
await session.ready;
const page = session.page;
const root = page.locator('#qa-recorder-root');
const countIs = n => page.waitForFunction(c => document.getElementById('qa-recorder-root')?.shadowRoot.querySelector('.count')?.textContent === c, String(n));
const drag = async (from, dx, dy) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
  await page.mouse.up();
};
const centre = b => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

// Move: drag Checkout from the header into the summary panel, adjust it once, write a note, confirm
const checkout = page.locator('#checkout');
const before = await checkout.boundingBox();
const total = await page.getByText('Total: $42').boundingBox();
await root.locator('button[data-act="move"]').click();
await drag(centre(before), total.x - before.x, total.y + 40 - before.y);
await root.locator('.form .what').waitFor();
await drag(centre(await checkout.boundingBox()), 10, 0); // a second drag adjusts the same element
assert.match(await root.locator('.form .what').textContent(), /button “Checkout”: \d+px right, \d+px down/);
await page.keyboard.type('Checkout belongs under the total');
await root.locator('button[data-form="confirm"]').click();
await countIs(1);
const moved = await checkout.boundingBox();
assert.ok(Math.abs(moved.x - (total.x + 10)) < 3 && Math.abs(moved.y - (total.y + 40)) < 3, `Checkout stays where it was dropped (${JSON.stringify(moved)})`);

// Resize: pick the photo and drag its corner
const photo = page.getByRole('img', { name: 'Product photo' });
const photoBefore = await photo.boundingBox();
await root.locator('button[data-act="resize"]').click();
await page.mouse.click(photoBefore.x + 20, photoBefore.y + 20);
await drag(centre(await root.locator('.handle[data-h="se"]').boundingBox()), 80, 60);
await root.locator('button[data-form="confirm"]').click();
await countIs(2);
const photoAfter = await photo.boundingBox();
assert.ok(Math.abs(photoAfter.width - (photoBefore.width + 80)) < 3 && Math.abs(photoAfter.height - (photoBefore.height + 60)) < 3, 'the photo keeps its new size');

// Esc undoes a move that isn't confirmed
const help = page.getByRole('link', { name: 'Help' });
const helpBefore = await help.boundingBox();
await root.locator('button[data-act="move"]').click();
await drag(centre(helpBefore), 0, 120);
await root.locator('.form').waitFor();
await page.keyboard.press('Escape');
await root.locator('.form').waitFor({ state: 'detached' });
const helpAfter = await help.boundingBox();
assert.ok(Math.abs(helpAfter.y - helpBefore.y) < 1, 'Esc put the link back');

await root.locator('button[data-act="finish"]').click();
await root.locator('button[data-act="finish"]').click();
const { notes } = await session.done;
site.close();

assert.equal(notes.length, 2);
const [move, resize] = notes;
assert.equal(move.kind, 'move');
assert.equal(move.text, 'Checkout belongs under the total');
assert.equal(move.target.attrs.id, 'checkout');
assert.ok(move.change.dx > 100 && move.change.dy > 50, `move recorded (${move.change.dx}, ${move.change.dy})`);
assert.match(move.change.droppedOn?.cssPath ?? '', /aside/, `dropped on the summary (${JSON.stringify(move.change.droppedOn)})`);
assert.equal(resize.kind, 'resize');
assert.ok(Math.abs(resize.change.dw - 80) < 3 && Math.abs(resize.change.dh - 60) < 3, `resize recorded (${resize.change.dw}, ${resize.change.dh})`);
for (const n of notes) {
  for (const key of ['before', 'beforeFull', 'crop', 'full']) {
    assert.ok(n.screenshots[key], `note ${n.id} has a ${key} screenshot`);
    assert.ok((await fs.stat(path.join(session.dir, n.screenshots[key]))).size > 1000, `${n.screenshots[key]} has content`);
  }
}
const md = await fs.readFile(path.join(session.dir, 'feedback.md'), 'utf8');
assert.match(md, /## 001\. ✥ Move: button “Checkout”/);
assert.match(md, /\| !\[before\]\(notes\/001-before\.png\) \| !\[after\]\(notes\/001\.png\) \|/);
assert.match(md, /## 002\. ⤡ Resize: div \[Product photo\]: 320×200 → \d+×\d+/);
const handoff = await fs.readFile(path.join(session.dir, 'HANDOFF.md'), 'utf8');
assert.match(handoff, /\*\*design changes\*\*/);
console.log(`\nPASS. Session folder: ${session.dir}`);
process.exit(0);
