import { ElectronAPI } from '@electron-toolkit/preload'

export interface IElectronAPI {
  selectModel: () => Promise<string | null>
  startServer: (modelPath: string, contextSize: number) => Promise<{ success: boolean; message: string }>
  stopServer: () => Promise<void>
  checkServerStatus: () => Promise<boolean>
  getSystemStats: () => Promise<{
    memory: { total: number; used: number }
    gpu: { total: number; used: number }
  }>
  onServerLog: (callback: (log: string) => void) => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: IElectronAPI
  }
}
