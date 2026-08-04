import { app, BrowserWindow, ipcMain, Menu } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureUtf8Console, writeUtf8Line } from './consoleUtf8'
import { launchBrowser, closeBrowser, listBrowsers, shutdownAll } from './browser/launcher'
import { filterSensitive } from './content-safety/filter'
import { scoreContent } from './content-safety/contentScore'
import { getDeviceId } from './desktop/deviceId'
import { connectDesktop, disconnectDesktop, getDesktopStatus } from './desktop/wsBridge'
import {
  restoreScheduler,
  shutdownScheduler,
  listJobs,
  listJobLogs,
  setJobStatus,
  cancelJob,
  runJobNow,
  updateJob
} from './desktop/scheduler'
import { scheduleStartupUpdateCheck, setupAutoUpdater } from './updater'

ensureUtf8Console()

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged
  ? process.env.DIST
  : path.join(process.env.DIST, '../public')

let mainWindow: BrowserWindow | null = null

function getPreloadPath() {
  return path.join(__dirname, 'preload.cjs')
}

function getAppIconPath() {
  const packaged = path.join(process.env.DIST || '', 'icon.png')
  const dev = path.join(__dirname, '../build/icon.png')
  return app.isPackaged ? packaged : dev
}

function createWindow() {
  const preloadPath = getPreloadPath()
  writeUtf8Line(process.stdout, '[aiBrowser] preload =', preloadPath)

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'browser168',
    backgroundColor: '#f7f6f3',
    autoHideMenuBar: true,
    icon: getAppIconPath(),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.webContents.on('preload-error', (_event, preloadPathUsed, error) => {
    console.error('[aiBrowser] preload-error', preloadPathUsed, error)
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'bottom' })
  } else {
    mainWindow.loadFile(path.join(process.env.DIST!, 'index.html'))
  }
}

function buildAppMenu() {
  // Keep accelerators without a persistent menu strip (avoids white bar vs app canvas).
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '窗口',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }
  ]
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

function registerIpc() {
  ipcMain.handle('browser:launch', async (_e, payload) => {
    try {
      return await launchBrowser(payload)
    } catch (err: any) {
      return { ok: false, message: err?.message || String(err) }
    }
  })
  ipcMain.handle('browser:close', async (_e, profileId) => closeBrowser(profileId))
  ipcMain.handle('browser:list', async () => listBrowsers())

  ipcMain.handle('desktop:deviceId', async () => getDeviceId())
  ipcMain.handle('desktop:status', async () => getDesktopStatus())
  ipcMain.handle('desktop:connect', async (_e, opts: { token: string; apiBase: string }) => {
    return connectDesktop(opts)
  })
  ipcMain.handle('desktop:disconnect', async () => disconnectDesktop())

  ipcMain.handle('scheduler:list', async () => listJobs())
  ipcMain.handle('scheduler:logs', async (_e, jobId: string, limit?: number) => listJobLogs(jobId, limit))
  ipcMain.handle('scheduler:setStatus', async (_e, jobId: string, status: 'running' | 'paused') => {
    return setJobStatus(jobId, status)
  })
  ipcMain.handle('scheduler:cancel', async (_e, jobId: string) => ({ ok: cancelJob(jobId) }))
  ipcMain.handle('scheduler:runNow', async (_e, jobId: string) => ({ ok: runJobNow(jobId) }))
  ipcMain.handle(
    'scheduler:update',
    async (
      _e,
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
    ) => updateJob(jobId, patch || {})
  )

  ipcMain.handle('contentSafety:filterSensitive', async (_e, text: string) => {
    return filterSensitive(String(text || ''))
  })
  ipcMain.handle('contentSafety:contentScore', async (_e, text: string) => {
    return scoreContent(String(text || ''))
  })

  setupAutoUpdater()
}

app.whenReady().then(() => {
  registerIpc()
  buildAppMenu()
  restoreScheduler()
  createWindow()
  scheduleStartupUpdateCheck()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void disconnectDesktop()
  shutdownScheduler()
  shutdownAll()
})
