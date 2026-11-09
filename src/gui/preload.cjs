// Gives the window a narrow API: invoke a main-process handler, or listen for 'log', 'session' and 'update' events.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qa', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  /** Microphone audio for a running session: fire and forget, ten times a second. */
  sendAudio: (sessionId, samples, at) => ipcRenderer.send('voice:audio', sessionId, samples, at),
  on: (channel, fn) => {
    if (!['log', 'session', 'update'].includes(channel)) throw new Error(`Unknown event ${channel}`);
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.off(channel, listener);
  },
});
