import { contextBridge, ipcRenderer } from 'electron'

export type UpdateEventPayload =
  | { type: 'checking' }
  | { type: 'available'; version: string; releaseNotes?: string | null }
  | { type: 'not-available'; version: string }
  | { type: 'progress'; percent: number; transferred: number; total: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }
  | { type: 'dev-skip'; message: string }

const api = {
  launchBrowser: (payload: unknown) => ipcRenderer.invoke('browser:launch', payload),
  closeBrowser: (profileId: string | number) => ipcRenderer.invoke('browser:close', profileId),
  listBrowsers: () => ipcRenderer.invoke('browser:list'),
  onBrowserStatus: (
    cb: (p: {
      profileId: string
      running: boolean
      pid?: number
      browsers: Array<{ profileId: string; pid: number }>
    }) => void
  ) => {
    const listener = (
      _: unknown,
      p: {
        profileId: string
        running: boolean
        pid?: number
        browsers: Array<{ profileId: string; pid: number }>
      }
    ) => cb(p)
    ipcRenderer.on('browser:status', listener)
    return () => ipcRenderer.removeListener('browser:status', listener)
  },

  getDeviceId: () => ipcRenderer.invoke('desktop:deviceId') as Promise<string>,
  desktopStatus: () =>
    ipcRenderer.invoke('desktop:status') as Promise<{
      connected: boolean
      connecting: boolean
      deviceId: string
      lastError?: string
      userId?: number
    }>,
  desktopConnect: (opts: { token: string; apiBase: string }) =>
    ipcRenderer.invoke('desktop:connect', opts),
  desktopDisconnect: () => ipcRenderer.invoke('desktop:disconnect'),

  schedulerList: () => ipcRenderer.invoke('scheduler:list'),
  schedulerLogs: (jobId: string, limit?: number) => ipcRenderer.invoke('scheduler:logs', jobId, limit),
  schedulerSetStatus: (jobId: string, status: 'running' | 'paused') =>
    ipcRenderer.invoke('scheduler:setStatus', jobId, status),
  schedulerCancel: (jobId: string) => ipcRenderer.invoke('scheduler:cancel', jobId),
  schedulerRunNow: (jobId: string) => ipcRenderer.invoke('scheduler:runNow', jobId),
  schedulerUpdate: (
    jobId: string,
    patch: {
      name?: string
      cron?: string
      url?: string
      profileId?: number | string
      description?: string
      remark?: string
      status?: 'running' | 'paused'
    }
  ) => ipcRenderer.invoke('scheduler:update', jobId, patch),

  filterSensitive: (text: string) => ipcRenderer.invoke('contentSafety:filterSensitive', text),
  contentScore: (text: string) => ipcRenderer.invoke('contentSafety:contentScore', text),

  getAppVersion: () =>
    ipcRenderer.invoke('app:getVersion') as Promise<{ version: string; packaged: boolean }>,
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install') as Promise<{ ok: boolean; message?: string }>,
  onUpdateEvent: (cb: (payload: UpdateEventPayload) => void) => {
    const listener = (_: unknown, payload: UpdateEventPayload) => cb(payload)
    ipcRenderer.on('updater:event', listener)
    return () => ipcRenderer.removeListener('updater:event', listener)
  }
}

contextBridge.exposeInMainWorld('aiBrowser', api)
contextBridge.exposeInMainWorld('browser168', api)
// 兼容旧页面注入名
contextBridge.exposeInMainWorld('yuntuo', api)
