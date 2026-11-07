// CommonJS entry: some tools (Playwright's Electron driver) can't start an ESM main directly, and privileged
// schemes must be registered synchronously, before the app is ready.
const { app, protocol } = require('electron');

protocol.registerSchemesAsPrivileged([{ scheme: 'qa-file', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
// tests: a WAV file stands in for the microphone (Chromium's fake capture device; it loops)
if (process.env.QA_RECORDER_FAKE_MIC) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.QA_RECORDER_FAKE_MIC);
}
import('./main.mjs').catch(e => {
  console.error(e);
  process.exit(1);
});
