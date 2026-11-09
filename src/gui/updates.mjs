// Updates for the installed app: new versions are GitHub releases (see "build.publish" in package.json). The app
// checks at start and every few hours, downloads in the background, and installs when the tester restarts it.
import updater from 'electron-updater';

const CHECK_EVERY = 4 * 60 * 60 * 1000;

/**
 * Returns { state(), check(), install() }. state().status is one of:
 * dev (running from a source checkout: no updates), idle, checking, current, downloading, ready, error.
 */
export function startUpdates({ app, onChange, log = () => {} }) {
  const state = { status: app.isPackaged ? 'idle' : 'dev', current: app.getVersion() };
  const set = patch => {
    Object.assign(state, patch);
    onChange({ ...state });
  };
  if (!app.isPackaged) return { state: () => ({ ...state }), check: async () => {}, install: () => {} };

  const { autoUpdater } = updater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // a downloaded update also goes in whenever the app is next closed
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: undefined }));
  autoUpdater.on('update-not-available', () => set({ status: 'current', checkedAt: new Date().toISOString() }));
  autoUpdater.on('update-available', info => set({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', p => set({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', info => set({ status: 'ready', version: info.version }));
  autoUpdater.on('error', e => set({ status: 'error', error: e.message.split('\n')[0] }));

  const check = () => autoUpdater.checkForUpdates().catch(e => set({ status: 'error', error: e.message.split('\n')[0] }));
  void check();
  setInterval(() => { if (state.status !== 'downloading' && state.status !== 'ready') void check(); }, CHECK_EVERY).unref();

  return {
    state: () => ({ ...state }),
    check,
    // silent install, then start the new version
    install: () => { if (state.status === 'ready') autoUpdater.quitAndInstall(true, true); },
  };
}
