const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  runRenamer: (opts) => ipcRenderer.invoke('run-renamer', opts),
  onLog: (cb) => ipcRenderer.on('renamer-log', (e, data) => cb(data)),
  chooseFolder: () => ipcRenderer.invoke('choose-folder')
});
