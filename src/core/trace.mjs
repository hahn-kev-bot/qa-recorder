import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * A Playwright trace of the session: screenshots whenever the screen changes, network and console, viewable with
 * `playwright show-trace`. Saved in chunks (trace/001.zip, …) so an app that closes before Finish loses at most the
 * current chunk. Timeline entries go in as named markers so the Trace Viewer lists them.
 */
export async function startTrace(context, dir, { title, chunkMs = 5 * 60_000, log = () => {} } = {}) {
  await fs.mkdir(path.join(dir, 'trace'), { recursive: true });
  let queue = Promise.resolve();
  const run = fn => (queue = queue.then(fn).catch(e => log(`Trace: ${e.message.split('\n')[0]}`)));
  let part = 0;
  const files = [];
  let stopped = false;

  await context.tracing.start({ screenshots: true, snapshots: false, title });
  await context.tracing.startChunk({ title });
  const rotate = async () => {
    const file = `trace/${String(++part).padStart(3, '0')}.zip`;
    await context.tracing.stopChunk({ path: path.join(dir, file) });
    files.push(file);
  };
  const timer = setInterval(() => run(async () => {
    if (stopped) return;
    await rotate();
    await context.tracing.startChunk({ title });
  }), chunkMs);
  timer.unref();

  return {
    files,
    /** Adds a named marker at this moment. */
    mark(label) {
      if (stopped) return;
      run(async () => {
        await context.tracing.group(label.slice(0, 200));
        await context.tracing.groupEnd();
      });
    },
    /** Saves the last chunk. Fails quietly (and says so) if the app is already gone. */
    async stop() {
      if (stopped) return files;
      stopped = true;
      clearInterval(timer);
      await run(async () => {
        await rotate();
        await context.tracing.stop();
      });
      return files;
    },
  };
}
