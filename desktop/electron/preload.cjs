const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kito', {
  command: (action, values = {}) => ipcRenderer.invoke('kito:command', action, values),
  openDocuments: () => ipcRenderer.invoke('kito:open-documents'),
  readImage: file => ipcRenderer.invoke('kito:read-image', file),
  showMain: () => ipcRenderer.invoke('kito:show-main'),
  showCompanion: () => ipcRenderer.invoke('kito:show-companion'),
  quit: () => ipcRenderer.invoke('kito:quit'),
  onMessage: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('kito:message', listener);
    return () => ipcRenderer.removeListener('kito:message', listener);
  },
});
