// The operating system's share sheet for a file. Electron has no Web Share API: on macOS it has ShareMenu, and on
// Windows a Windows PowerShell helper (share-windows.ps1) opens the sheet through DataTransferManager.
import { screen, ShareMenu } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const canShare = () => process.platform === 'win32' || process.platform === 'darwin';

/** Opens the share sheet over `win` and resolves when it closes: 'completed', 'canceled' or (macOS) 'closed'. */
export function shareFile(win, file, { title } = {}) {
  if (process.platform === 'darwin') {
    return new Promise(resolve => new ShareMenu({ filePaths: [file] }).popup({ window: win, callback: () => resolve('closed') }));
  }
  if (process.platform !== 'win32') throw new Error('Sharing needs Windows or macOS. Use Save as instead.');
  return shareOnWindows(win, file, title);
}

function shareOnWindows(win, file, title = path.basename(file)) {
  const b = win.getBounds();
  const centre = screen.dipToScreenPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
  const script = fileURLToPath(new URL('./share-windows.ps1', import.meta.url));
  const system = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // path.resolve: StorageFile wants backslashes
  const child = spawn(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script,
    '-Path', path.resolve(file), '-Title', title, '-X', String(centre.x), '-Y', String(centre.y),
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    // clicking back into the app closes the sheet without telling the helper on older Windows 11: end it then
    const onFocus = () => child.kill();
    let shown = false;
    child.stdout.on('data', d => {
      out += d;
      if (!shown && /^shown$/m.test(out)) {
        shown = true;
        win.once('focus', onFocus);
      }
    });
    child.stderr.on('data', d => { err += d; });
    child.once('error', reject);
    child.once('close', code => { // 'close', not 'exit': stderr is read to the end
      win.off('focus', onFocus);
      const result = /^(completed|canceled)$/m.exec(out)?.[1];
      if (result) resolve(result);
      else if (code === null || shown) resolve('canceled'); // ended by us, or the sheet was up
      else reject(new Error(`Couldn't open the share sheet.${err.trim() ? `\n${err.trim().split('\n')[0]}` : ''}`));
    });
  });
}
