import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { serveFile } from '../../src/core/serve-file.mjs';

// a session recording big enough that the audio player streams it in ranges (the bug: >1 MB wouldn't play)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-serve-'));
const big = path.join(dir, 'session.wav');
const bytes = Buffer.alloc(5 * 1024 * 1024);
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
fs.writeFileSync(big, bytes);

test('a byte range comes back as 206 with the right bytes', async () => {
  const res = await serveFile(big, 'bytes=1000-1999');
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 1000-1999/${bytes.length}`);
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes.subarray(1000, 2000)));
});

test('an open-ended range is served a chunk at a time', async () => {
  const res = await serveFile(big, 'bytes=0-');
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 0-${2 * 1024 * 1024 - 1}/${bytes.length}`);
  const tail = await serveFile(big, 'bytes=-100');
  assert.ok(Buffer.from(await tail.arrayBuffer()).equals(bytes.subarray(bytes.length - 100)));
});

test('no range: small files whole, big files as their first chunk', async () => {
  const small = path.join(dir, 'shot.png');
  fs.writeFileSync(small, 'png');
  const s = await serveFile(small, null);
  assert.equal(s.status, 200);
  assert.equal(s.headers.get('accept-ranges'), 'bytes');
  assert.equal((await serveFile(big, null)).status, 206);
});

test('missing files and impossible ranges', async () => {
  assert.equal((await serveFile(path.join(dir, 'nope.wav'), null)).status, 404);
  assert.equal((await serveFile(big, `bytes=${bytes.length + 10}-`)).status, 416);
});
