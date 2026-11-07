import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { matchesRule } from '../../src/core/recorder.mjs';
import { textOrRegex, urlMatcher } from '../../src/core/steps.mjs';
import { expand, listTargets, targetFromUrl, validateTarget } from '../../src/core/targets.mjs';
import { toolRoot } from '../../src/core/paths.mjs';

test('bundled targets are valid', async () => {
  const targets = await listTargets();
  assert.ok(targets.length >= 2);
  for (const t of targets.filter(t => t.source === 'bundled')) assert.equal(t.error, undefined, `${t.id}: ${t.error}`);
});

test('a target from a URL is valid', async () => {
  const { id, config } = targetFromUrl('https://docs.example.org/guide/');
  assert.equal(id, 'docs-example-org');
  assert.deepEqual(await validateTarget(config), []);
  assert.throws(() => targetFromUrl('ftp://x'), /http/);
});

test('schema errors name the problem', async () => {
  assert.deepEqual(await validateTarget({ name: 'x', launch: { type: 'browser' } }), ["/launch: must have required property 'url'"]);
  const errors = await validateTarget({ name: 'x', launch: { type: 'webview2', exe: 'a.exe', url: 'nope' }, setup: [{ click: { text: 'a' }, goto: '/' }] });
  assert.ok(errors.some(e => e.includes('unevaluated properties (url)')), errors.join('\n'));
  assert.ok(errors.some(e => e.startsWith('/setup/0: a step needs exactly one action')), errors.join('\n'));
  assert.deepEqual(await validateTarget({ name: 'x', launch: { type: 'browser', url: 'u' }, setup: [{ fill: { label: 'Name', value: 'v' } }] }), []);
});

test('expand fills variables in nested values and leaves unknown ones', () => {
  const out = expand({ a: ['${appData}/x', '${nope}'], b: { c: 'port ${port}' }, n: 3 }, { appData: 'C:/d', port: 9 });
  assert.deepEqual(out, { a: ['C:/d/x', '${nope}'], b: { c: 'port 9' }, n: 3 });
});

test('urlMatcher handles globs and regexes', () => {
  const u = s => new URL(s);
  assert.ok(urlMatcher('/project/**')(u('https://0.0.0.1/project/abc/browse?x=1')));
  assert.ok(!urlMatcher('/project/*')(u('https://0.0.0.1/project/abc/browse')));
  assert.ok(urlMatcher('**/page2.html')(u('http://127.0.0.1:5/a/page2.html')));
  assert.ok(urlMatcher('/\\/entries\\/\\d+/')(u('https://x/entries/42')));
  assert.equal(textOrRegex('/Example/i').flags, 'i');
  assert.equal(textOrRegex('plain'), 'plain');
});

test('ignore rules need every field to match', () => {
  assert.ok(matchesRule({ url: '*/favicon.ico' }, { type: 'console.error', url: 'https://0.0.0.1/favicon.ico' }));
  assert.ok(!matchesRule({ url: '*/favicon.ico', type: 'http' }, { type: 'console.error', url: 'https://0.0.0.1/favicon.ico' }));
  assert.ok(!matchesRule({ text: 'x*' }, { type: 'http', url: 'x' }), 'a field the event lacks does not match');
});

test('the AI authoring prompt mentions every launch type', async () => {
  const guide = await fs.readFile(path.join(toolRoot(), 'AUTHORING.md'), 'utf8');
  for (const type of ['browser', 'server', 'webview2', 'cdp']) assert.match(guide, new RegExp(`\`${type}\``));
});
