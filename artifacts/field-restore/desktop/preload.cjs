const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('fieldRestoreDesktop', {
  selectSave: filename => ipcRenderer.invoke('field-restore:save-select', filename),
  write: (id, data) => ipcRenderer.invoke('field-restore:save-write', id, data),
  close: id => ipcRenderer.invoke('field-restore:save-close', id),
  abort: id => ipcRenderer.invoke('field-restore:save-abort', id),
  protectSource: file => {
    const filename = webUtils.getPathForFile(file);
    return filename ? ipcRenderer.invoke('field-restore:protect-source', filename) : Promise.resolve();
  },
});