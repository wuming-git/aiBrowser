import { app, BrowserWindow, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import { writeUtf8Line } from './consoleUtf8'

const { autoUpdater } = electronUpdater

const DEFAULT_FEED_URL = 'https://browser168.com/releases'

export type UpdateEventPayload =
  | { type: 'checking' }
  | { type: 'available'; version: string; releaseNotes?: string | null }
  | { type: 'not-available'; version: string }
  | { type: 'progress'; percent: number; transferred: number; total: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }
  | { type: 'dev-skip'; message: string }

let initialized = false
let checking = false
let downloading = false

function feedUrl() {
  const raw = String(process.env.UPDATE_FEED_URL || DEFAULT_FEED_URL).trim()
  return raw.replace(/\/+$/, '')
}

function send(payload: UpdateEventPayload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('updater:event', payload)
    }
  }
}

export function getAppVersion() {
  return app.getVersion()
}

export function setupAutoUpdater() {
  if (initialized) return
  initialized = true

  ipcMain.handle('app:getVersion', async () => ({
    version: getAppVersion(),
    packaged: app.isPackaged
  }))

  ipcMain.handle('updater:check', async () => checkForUpdates(true))
  ipcMain.handle('updater:download', async () => downloadUpdate())
  ipcMain.handle('updater:install', async () => {
    if (!app.isPackaged) {
      return { ok: false, message: '开发模式不支持安装更新' }
    }
    // 立即退出并安装全量包
    setImmediate(() => {
      autoUpdater.quitAndInstall(false, true)
    })
    return { ok: true }
  })

  if (!app.isPackaged) {
    writeUtf8Line(process.stdout, '[updater] skipped (not packaged)')
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: feedUrl()
  })

  autoUpdater.on('checking-for-update', () => {
    send({ type: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    checking = false
    send({
      type: 'available',
      version: String(info.version || ''),
      releaseNotes:
        typeof info.releaseNotes === 'string'
          ? info.releaseNotes
          : Array.isArray(info.releaseNotes)
            ? info.releaseNotes.map((n) => (typeof n === 'string' ? n : n.note)).join('\n')
            : null
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    checking = false
    send({ type: 'not-available', version: String(info.version || getAppVersion()) })
  })

  autoUpdater.on('download-progress', (p) => {
    send({
      type: 'progress',
      percent: Number(p.percent || 0),
      transferred: Number(p.transferred || 0),
      total: Number(p.total || 0)
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    downloading = false
    send({ type: 'downloaded', version: String(info.version || '') })
  })

  autoUpdater.on('error', (err) => {
    checking = false
    downloading = false
    const message = err?.message || String(err)
    writeUtf8Line(process.stderr, `[updater] error ${message}`)
    send({ type: 'error', message })
  })
}

/** 启动后延迟检查，避免抢首屏 */
export function scheduleStartupUpdateCheck(delayMs = 4000) {
  if (!app.isPackaged) return
  setTimeout(() => {
    void checkForUpdates(false)
  }, delayMs)
}

export async function checkForUpdates(manual: boolean) {
  if (!app.isPackaged) {
    const payload: UpdateEventPayload = {
      type: 'dev-skip',
      message: '开发模式不检查更新'
    }
    if (manual) send(payload)
    return { ok: true, skipped: true, message: payload.message }
  }
  if (checking || downloading) {
    return { ok: true, skipped: true, message: '正在检查或下载更新' }
  }
  checking = true
  try {
    const result = await autoUpdater.checkForUpdates()
    return {
      ok: true,
      version: result?.updateInfo?.version || null
    }
  } catch (err: any) {
    checking = false
    const message = err?.message || String(err)
    send({ type: 'error', message })
    return { ok: false, message }
  }
}

export async function downloadUpdate() {
  if (!app.isPackaged) {
    return { ok: false, message: '开发模式不支持下载更新' }
  }
  if (downloading) {
    return { ok: true, skipped: true, message: '正在下载更新' }
  }
  downloading = true
  try {
    await autoUpdater.downloadUpdate()
    return { ok: true }
  } catch (err: any) {
    downloading = false
    const message = err?.message || String(err)
    send({ type: 'error', message })
    return { ok: false, message }
  }
}
