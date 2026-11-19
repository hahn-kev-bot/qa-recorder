import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { changeSummary, writeBundle } from '../../src/core/bundle.mjs';

const target = { tag: 'button', text: 'Checkout', classes: '', attrs: {}, landmarks: [], cssPath: 'header > button' };
const move = {
  id: '001', kind: 'move', text: 'Checkout belongs next to the cart total', at: '2026-01-01T00:00:10.000Z', url: 'http://127.0.0.1/',
  rect: { x: 10, y: 10, width: 300, height: 200 }, viewport: { width: 1280, height: 800 }, target,
  change: {
    tool: 'move', before: { x: 10, y: 10, width: 80, height: 30 }, after: { x: 230, y: 180, width: 80, height: 30 }, dx: 220, dy: 170,
    droppedOn: { tag: 'div', text: 'Total: $42', attrs: {}, landmarks: [], cssPath: 'aside > div' },
    style: { translate: '220px 170px' },
  },
  screenshots: { crop: 'notes/001.png', full: 'notes/001-full.png', before: 'notes/001-before.png', beforeFull: 'notes/001-before-full.png' },
};
const resize = {
  id: '002', kind: 'resize', text: '', at: '2026-01-01T00:00:20.000Z', url: 'http://127.0.0.1/',
  rect: { x: 0, y: 0, width: 400, height: 300 }, viewport: { width: 1280, height: 800 }, target: { ...target, tag: 'img', text: '' },
  change: { tool: 'resize', before: { x: 0, y: 0, width: 320, height: 200 }, after: { x: 0, y: 0, width: 400, height: 300 }, dw: 80, dh: 100, style: { width: '400px' } },
  screenshots: { crop: 'notes/002.png', full: 'notes/002-full.png', before: 'notes/002-before.png' },
};

test('design changes are summed up in words', () => {
  assert.equal(changeSummary(move), 'button “Checkout”: 220px right, 170px down, onto div “Total: $42”');
  assert.equal(changeSummary({ ...move, change: { ...move.change, dx: -5, dy: -6, droppedOn: undefined } }), 'button “Checkout”: 5px left, 6px up');
  assert.equal(changeSummary(resize), 'img: 320×200 → 400×300');
});

test('feedback.md and HANDOFF.md carry design changes with before and after', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-design-'));
  const session = { id: 's', target: { name: 'Shop' }, startedAt: '2026-01-01T00:00:00.000Z', handoff: {} };
  await writeBundle({ sessionDir: dir, session, notes: [move, resize], events: [] });
  const md = await fs.readFile(path.join(dir, 'feedback.md'), 'utf8');
  assert.match(md, /## 001\. ✥ Move: button “Checkout”: 220px right, 170px down/);
  assert.match(md, /> Checkout belongs next to the cart total/);
  assert.match(md, /\| !\[before\]\(notes\/001-before\.png\) \| !\[after\]\(notes\/001\.png\) \|/);
  assert.match(md, /droppedOn: \{ tag: div, text: "Total: \$42", cssPath: "aside > div" \}/);
  assert.match(md, /## 002\. ⤡ Resize: img: 320×200 → 400×300/);
  const handoff = await fs.readFile(path.join(dir, 'HANDOFF.md'), 'utf8');
  assert.match(handoff, /\*\*design changes\*\*/);
  assert.match(handoff, /Never hard-code the tool's `translate`/);

  // without design changes the hand-off says nothing about them
  await writeBundle({ sessionDir: dir, session, notes: [{ ...move, kind: 'bug', change: undefined }], events: [] });
  assert.doesNotMatch(await fs.readFile(path.join(dir, 'HANDOFF.md'), 'utf8'), /design change/);
});
