import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./site/', import.meta.url));

/** Serves test/fixtures/site on a free port. Returns { url, close }. */
export async function serveFixture() {
  const server = http.createServer(async (req, res) => {
    const name = new URL(req.url, 'http://x').pathname.replace(/^\/$/, '/index.html');
    try {
      const body = await fs.readFile(path.join(root, path.normalize(name)));
      res.writeHead(200, { 'content-type': name.endsWith('.html') ? 'text/html' : 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}
