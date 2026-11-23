// A page for working on the toolbar's look: the real src/core/overlay.js on the demo shop, in your own browser,
// with the recorder replaced by stand-ins. The page reloads when overlay.js or a page changes, and comes back in
// the state the address names, so a dialog stays open while you edit its styles.
//
//   npm run lab            then open the address it prints
//   ?open=note|element|region|move|resize    the tool to start after each load
//   ?voice=push-to-talk|open-mic             the microphone button to show
//   ?slow=2000                               how long a save takes, in ms (the toolbar is hidden meanwhile)
//   /fixture/design.html                     the fixture pages instead of the demo shop
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const overlay = path.join(repo, 'src', 'core', 'overlay.js');
const pages = { '/': path.join(repo, 'scripts', 'demo-site'), '/fixture/': path.join(repo, 'test', 'fixtures', 'site') };
const port = Number(process.env.PORT) || 4517;

// Runs in the page before overlay.js: the config and the bindings the recorder would have given it.
function standIn() {
  const params = new URLSearchParams(location.search);
  const voice = params.get('voice');
  window.__qaRecorderConfig = { typedText: true, voice: ['push-to-talk', 'open-mic'].includes(voice) ? voice : null, talkKey: 'F6' };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const slow = Number(params.get('slow')) || 300;
  let count = 0;
  let muted = false;
  window.__qaRecorderAction = async action => console.debug('[lab] action', action);
  window.__qaRecorderTabShown = async () => {};
  window.__qaRecorderBefore = () => wait(slow);
  window.__qaRecorderNote = async note => {
    await wait(slow);
    count += 1;
    console.log('[lab] note', note);
    return { id: String(count).padStart(3, '0'), count };
  };
  window.__qaRecorderFinish = async () => {
    console.log('[lab] finish');
    await wait(800);
    location.reload();
  };
  window.__qaRecorderTalk = async down => {
    if (!down) count += 1;
    return { count };
  };
  window.__qaRecorderMute = async next => {
    if (typeof next === 'boolean') muted = next;
    return { muted };
  };

  new EventSource('/__lab/events').addEventListener('reload', () => location.reload());

  const open = params.get('open');
  if (open) {
    addEventListener('load', () => {
      document.getElementById('qa-recorder-root')?.shadowRoot.querySelector(`button[data-act="${CSS.escape(open)}"]`)?.click();
    });
  }
}

const head = () => `<script>(${standIn})();</script>\n<script>${fs.readFileSync(overlay, 'utf8')}</script>\n`;
const clients = new Set();

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/__lab/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write('retry: 500\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const prefix = pathname.startsWith('/fixture/') ? '/fixture/' : '/';
  const name = pathname.slice(prefix.length) || 'index.html';
  const file = path.join(pages[prefix], path.normalize(name));
  if (!file.startsWith(pages[prefix]) || !fs.existsSync(file)) return void res.writeHead(404).end('not found');
  if (!name.endsWith('.html')) return void res.writeHead(200).end(fs.readFileSync(file));
  // the toolbar goes in first, as the recorder's init scripts do
  const body = fs.readFileSync(file, 'utf8').replace(/<head>/i, m => m + head());
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
});

let timer = null;
for (const dir of [path.dirname(overlay), ...Object.values(pages)]) {
  fs.watch(dir, () => {
    clearTimeout(timer); // editors save in several writes
    timer = setTimeout(() => { for (const res of clients) res.write('event: reload\ndata: 1\n\n'); }, 80);
  });
}

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Toolbar lab: ${url}
  ${url}?open=note                   the note dialog, reopened after every reload
  ${url}?open=move                   a design tool, ready to drag
  ${url}?voice=push-to-talk          with the microphone button (or open-mic)
  ${url}fixture/design.html          the fixture cart
Edit src/core/overlay.js and the page reloads. Ctrl+C to stop.`);
});
