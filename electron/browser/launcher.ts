import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import { resolveChromePath } from './chromePath'
import { startLocalProxy, stopLocalProxy, stopAllProxies, type ProxyConfig } from './proxy'
import { getFreePort } from './cdp'

export type LaunchPayload = {
  profileId: string | number
  name?: string
  fingerprint?: Record<string, any>
  proxy?: ProxyConfig | null
  startUrl?: string
  /** 开启远程调试，供 Agent 提取页面文本等 CDP 工具使用 */
  enableDebug?: boolean
}

export type BrowserStatusEvent = {
  profileId: string
  running: boolean
  pid?: number
  browsers: Array<{ profileId: string; pid: number }>
}

type Running = {
  profileId: string
  pid: number
  process: ChildProcessWithoutNullStreams
  userDataDir: string
  debugPort?: number
}

const runningBrowserMap = new Map<string, Running>()

function broadcastBrowserStatus(profileId: string, running: boolean, pid?: number) {
  const payload: BrowserStatusEvent = {
    profileId: String(profileId),
    running,
    pid,
    browsers: listBrowsers()
  }
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('browser:status', payload)
    } catch (_) {}
  }
}

export function getRunningDebugInfo(profileId: string | number) {
  const entry = runningBrowserMap.get(String(profileId))
  if (!entry) return null
  return {
    profileId: entry.profileId,
    pid: entry.pid,
    userDataDir: entry.userDataDir,
    debugPort: entry.debugPort
  }
}

function workersRoot() {
  return path.join(app.getPath('userData'), 'Workers')
}

function extensionSourceDir() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(process.cwd(), 'chrome-extension'),
    path.resolve(here, '../chrome-extension'),
    path.resolve(here, '../../chrome-extension')
  ]
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'manifest.json'))) return c
  }
  throw new Error('找不到 chrome-extension 目录')
}

function prepareExtension(profileId: string, fingerprint?: Record<string, any>) {
  const src = extensionSourceDir()
  const dest = path.join(workersRoot(), String(profileId), 'extension')
  fs.mkdirSync(dest, { recursive: true })
  for (const file of fs.readdirSync(src)) {
    const from = path.join(src, file)
    const to = path.join(dest, file)
    if (fs.statSync(from).isFile()) {
      fs.copyFileSync(from, to)
    }
  }
  fs.writeFileSync(
    path.join(dest, 'fingerprint.json'),
    JSON.stringify(fingerprint || {}, null, 2),
    'utf-8'
  )
  return dest
}

export async function launchBrowser(payload: LaunchPayload) {
  const profileId = String(payload.profileId)
  if (runningBrowserMap.has(profileId)) {
    const cur = runningBrowserMap.get(profileId)!
    broadcastBrowserStatus(profileId, true, cur.pid)
    return {
      ok: true,
      message: '环境已在运行',
      pid: cur.pid,
      debugPort: cur.debugPort,
      running: true
    }
  }

  const chrome = resolveChromePath()
  const userDataDir = path.join(workersRoot(), profileId, 'user-data')
  fs.mkdirSync(userDataDir, { recursive: true })
  const extensionDir = prepareExtension(profileId, payload.fingerprint)
  const localProxy = await startLocalProxy(profileId, payload.proxy)

  const enableDebug = payload.enableDebug !== false
  const debugPort = enableDebug ? await getFreePort() : undefined

  const args = [
    `--user-data-dir=${userDataDir}`,
    `--disable-features=Translate,MediaRouter`,
    `--no-first-run`,
    `--no-default-browser-check`,
    `--disable-sync`,
    `--load-extension=${extensionDir}`
  ]

  if (debugPort) {
    args.push(`--remote-debugging-port=${debugPort}`)
    args.push(`--remote-allow-origins=*`)
  }

  if (payload.fingerprint?.userAgent) {
    args.push(`--user-agent=${payload.fingerprint.userAgent}`)
  }
  if (payload.fingerprint?.language) {
    args.push(`--lang=${payload.fingerprint.language}`)
  }
  if (localProxy) {
    args.push(`--proxy-server=${localProxy}`)
  }

  const startUrl = payload.startUrl || 'https://browserleaks.com/javascript'
  args.push(startUrl)

  const child = spawn(chrome, args, {
    detached: false,
    stdio: 'ignore'
  })

  if (!child.pid) {
    await stopLocalProxy(profileId)
    throw new Error('启动 Chrome 失败')
  }

  const entry: Running = {
    profileId,
    pid: child.pid,
    process: child as ChildProcessWithoutNullStreams,
    userDataDir,
    debugPort
  }
  runningBrowserMap.set(profileId, entry)
  broadcastBrowserStatus(profileId, true, child.pid)

  child.on('exit', () => {
    const still = runningBrowserMap.get(profileId)
    if (still?.process === child) {
      runningBrowserMap.delete(profileId)
    }
    void stopLocalProxy(profileId)
    void import('./humanSession')
      .then((m) => m.dropHumanSession(profileId))
      .catch(() => undefined)
    broadcastBrowserStatus(profileId, false)
  })

  return { ok: true, pid: child.pid, debugPort, running: true }
}

export async function closeBrowser(profileId: string | number) {
  const id = String(profileId)
  const entry = runningBrowserMap.get(id)
  if (!entry) {
    broadcastBrowserStatus(id, false)
    return { ok: true, running: false }
  }
  try {
    entry.process.kill()
  } catch (_) {}
  runningBrowserMap.delete(id)
  await stopLocalProxy(id)
  void import('./humanSession')
    .then((m) => m.dropHumanSession(id))
    .catch(() => undefined)
  broadcastBrowserStatus(id, false)
  return { ok: true, running: false }
}

export function listBrowsers() {
  return [...runningBrowserMap.values()].map((x) => ({
    profileId: x.profileId,
    pid: x.pid
  }))
}

export function shutdownAll() {
  for (const entry of runningBrowserMap.values()) {
    try {
      entry.process.kill()
    } catch (_) {}
  }
  runningBrowserMap.clear()
  void stopAllProxies()
}
