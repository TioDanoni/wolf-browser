const { contextBridge, ipcRenderer } = require('electron');

// Ponte da barra de endereço no topo (gota) com o processo principal.
contextBridge.exposeInMainWorld('browser', {
  go: (text) => ipcRenderer.send('nav:go', text),
  suggest: (text) => ipcRenderer.invoke('suggest', text),
  toggleBookmark: () => ipcRenderer.send('bookmark:toggle'),
  toggleAdblockSite: () => ipcRenderer.send('adblock:toggle-site'),
  hover: (over) => ipcRenderer.send('urlbar:hover', over),
  size: (extra) => ipcRenderer.send('urlbar:size', extra),
  done: () => ipcRenderer.send('urlbar:done'),
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
  onFocusAddress: (cb) => ipcRenderer.on('focus-address', () => cb()),
});
