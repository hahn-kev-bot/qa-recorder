import fs from 'node:fs/promises';
import path from 'node:path';

const MIME = { '.png': 'image/png', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.wav': 'audio/wav' };
const MAX_CHUNK = 2 * 1024 * 1024;

/**
 * A session file, with byte ranges: the audio player asks for ranges to stream and seek, and a session recording
 * can run to hundreds of MB, so open-ended ranges get at most MAX_CHUNK at a time.
 */
export async function serveFile(file, rangeHeader) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return new Response('not found', { status: 404 });
  const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader ?? '');
  if (!range || (!range[1] && !range[2])) {
    if (stat.size <= MAX_CHUNK) return new Response(await fs.readFile(file), { headers: { ...headers, 'Content-Length': String(stat.size) } });
    // too big to send whole: answer as if the first chunk was asked for
    return serveFile(file, 'bytes=0-');
  }
  let start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
  let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
  end = Math.min(end, stat.size - 1, start + MAX_CHUNK - 1);
  if (start >= stat.size || start > end) {
    return new Response('range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
  }
  const handle = await fs.open(file);
  try {
    const buffer = Buffer.alloc(end - start + 1);
    await handle.read(buffer, 0, buffer.length, start);
    return new Response(buffer, {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': String(buffer.length) },
    });
  } finally {
    await handle.close();
  }
}

