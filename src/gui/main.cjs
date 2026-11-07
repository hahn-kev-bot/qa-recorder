// CommonJS entry: some tools (Playwright's Electron driver) can't start an ESM main directly, and privileged
// schemes must be registered synchronously, before the app is ready.
const { protocol } = require('electron');

protocol.registerSchemesAsPrivileged([{ scheme: 'qa-file', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
import('./main.mjs').catch(e => {
  console.error(e);
  process.exit(1);
});
