const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rnperf', {
  getPort: () => ipcRenderer.invoke('rnperf:port'),
  getProjectRoot: () => ipcRenderer.invoke('rnperf:project-root'),
  pickProjectRoot: () => ipcRenderer.invoke('rnperf:pick-project-root'),
});
