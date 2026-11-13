// A small zip writer: streams each file through deflate, so big recordings never sit in memory. No zip64, so the
// archive and each file must stay under 4 GB.
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

/** Already compressed: deflating them again only costs time. */
const STORED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip', '.gz', '.webm', '.ogg', '.opus', '.mp3', '.mp4', '.m4a']);
const LIMIT = 0xffff_ffff;
const FLAGS = 0x0808; // sizes in a data descriptor after the data; UTF-8 names

/**
 * Writes `entries` to a zip at `outFile`. Each entry is { name, file } (a file on disk) or { name, data } (a Buffer or
 * string); `name` uses forward slashes. `onProgress(done, total)` reports bytes read. On failure the partial zip is
 * deleted.
 */
export async function writeZip(outFile, entries, { onProgress } = {}) {
  const sizes = await Promise.all(entries.map(async e => (e.file ? (await fs.promises.stat(e.file)).size : Buffer.byteLength(e.data))));
  const total = sizes.reduce((a, b) => a + b, 0);
  const out = await fs.promises.open(outFile, 'w');
  let offset = 0;
  let done = 0;
  const write = async buf => {
    await out.write(buf);
    offset += buf.length;
    if (offset > LIMIT) throw new Error('The session is too big to zip (over 4 GB).');
  };
  try {
    const central = [];
    for (const [i, entry] of entries.entries()) {
      const name = Buffer.from(entry.name, 'utf8');
      const method = STORED.has(path.extname(entry.name).toLowerCase()) ? 0 : 8;
      const mtime = entry.file ? (await fs.promises.stat(entry.file)).mtime : new Date();
      const { time, date } = dosTime(mtime);
      const start = offset;

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(FLAGS, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      // crc and sizes (14..25) stay 0: they follow the data
      local.writeUInt16LE(name.length, 26);
      await write(Buffer.concat([local, name]));

      let crc = 0;
      let size = 0;
      const dataStart = offset;
      const tap = new Transform({
        transform(chunk, _enc, cb) {
          crc = zlib.crc32(chunk, crc);
          size += chunk.length;
          done += chunk.length;
          onProgress?.(done, total);
          cb(null, chunk);
        },
      });
      const sink = new Writable({ write: (chunk, _enc, cb) => write(chunk).then(() => cb(), cb) });
      const source = entry.file ? fs.createReadStream(entry.file) : Readable.from([Buffer.from(entry.data)]);
      await pipeline(source, tap, ...(method === 8 ? [zlib.createDeflateRaw()] : []), sink);
      const compressed = offset - dataStart;
      if (size !== sizes[i]) throw new Error(`${entry.name} changed while zipping.`);

      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressed, 8);
      descriptor.writeUInt32LE(size, 12);
      await write(descriptor);

      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(FLAGS, 8);
      header.writeUInt16LE(method, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(date, 14);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(compressed, 20);
      header.writeUInt32LE(size, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt32LE(start, 42);
      central.push(header, name);
    }
    if (entries.length > 0xffff) throw new Error('Too many files to zip.');
    const centralStart = offset;
    await write(Buffer.concat(central));
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - centralStart, 12);
    end.writeUInt32LE(centralStart, 16);
    await write(end);
    await out.close();
  } catch (e) {
    await out.close().catch(() => {});
    await fs.promises.rm(outFile, { force: true });
    throw e;
  }
}

function dosTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
