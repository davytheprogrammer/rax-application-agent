const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rax', {
  command: (action, values = {}) => ipcRenderer.invoke('rax:command', action, values),
  openDocuments: () => ipcRenderer.invoke('rax:open-documents'),
  readImage: file => ipcRenderer.invoke('rax:read-image', file),
  showMain: () => ipcRenderer.invoke('rax:show-main'),
  showCompanion: () => ipcRenderer.invoke('rax:show-companion'),
  quit: () => ipcRenderer.invoke('rax:quit'),
  onMessage: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('rax:message', listener);
    return () => ipcRenderer.removeListener('rax:message', listener);
  },
});
