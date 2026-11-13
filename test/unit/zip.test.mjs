import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { writeZip } from '../../src/core/zip.mjs';

/** Reads a zip through its central directory, the way unzip tools do. */
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    const content = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    assert.equal(zlib.crc32(content), crc, `crc of ${name}`);
    files[name] = { method, content };
    at += 46 + nameLen;
  }
  return files;
}

test('writeZip stores files and buffers that read back intact', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-zip-'));
  try {
    const big = Buffer.alloc(300_000, 'feedback ');
    await fs.writeFile(path.join(dir, 'notes.json'), big);
    await fs.writeFile(path.join(dir, 'shot.png'), Buffer.from([1, 2, 3, 4]));
    const out = path.join(dir, 'out.zip');
    const seen = [];
    await writeZip(out, [
      { name: 's/notes.json', file: path.join(dir, 'notes.json') },
      { name: 's/notes/001.png', file: path.join(dir, 'shot.png') },
      { name: 's/HANDOFF.md', data: 'Ünïcode hand-off' },
      { name: 's/empty.txt', data: '' },
    ], { onProgress: (done, total) => seen.push([done, total]) });
    const zip = await fs.readFile(out);
    const files = readZip(zip);
    assert.deepEqual(Object.keys(files), ['s/notes.json', 's/notes/001.png', 's/HANDOFF.md', 's/empty.txt']);
    assert.ok(files['s/notes.json'].content.equals(big));
    assert.equal(files['s/notes.json'].method, 8);
    assert.equal(files['s/notes/001.png'].method, 0, 'images are stored, not deflated again');
    assert.equal(files['s/HANDOFF.md'].content.toString('utf8'), 'Ünïcode hand-off');
    assert.equal(files['s/empty.txt'].content.length, 0);
    assert.ok(zip.length < big.length / 10, 'text is compressed');
    assert.deepEqual(seen.at(-1), [big.length + 4 + Buffer.byteLength('Ünïcode hand-off'), big.length + 4 + Buffer.byteLength('Ünïcode hand-off')]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('writeZip removes the partial zip when a file is missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-zip-'));
  try {
    const out = path.join(dir, 'out.zip');
    await assert.rejects(writeZip(out, [{ name: 'x', file: path.join(dir, 'missing') }]));
    await assert.rejects(fs.access(out));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
