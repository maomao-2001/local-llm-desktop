import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  selectModel: () => ipcRenderer.invoke('select-model'),
  startServer: (modelPath: string, contextSize: number) => ipcRenderer.invoke('start-server', modelPath, contextSize),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  checkServerStatus: () => ipcRenderer.invoke('check-server-status'),
  getSystemStats: () => ipcRenderer.invoke('get-system-stats'),
  onServerLog: (callback: (log: string) => void) =>
    ipcRenderer.on('server-log', (_event, log) => callback(log))
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
