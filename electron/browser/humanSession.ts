import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { createCursor, type GhostCursor } from 'ghost-cursor'
import { getRunningDebugInfo, launchBrowser } from './launcher'
import { ensurePopupWatchdog } from './watchdogs'

export type HumanSession = {
  profileId: string
  debugPort: number
  browser: Browser
  page: Page
  cursor: GhostCursor
}

const sessions = new Map<string, HumanSession>()

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** 人工思考/操作间隙 */
export async function humanPause(minMs = 180, maxMs = 620) {
  await sleep(randInt(minMs, maxMs))
}

async function waitDebugReady(port: number, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
    } catch (_) {}
    await sleep(200)
  }
  throw new Error(`调试端口 ${port} 未就绪`)
}

async function pickPage(browser: Browser): Promise<Page> {
  const pages = await browser.pages()
  const usable = pages.filter((p) => {
    const u = p.url()
    return !u.startsWith('chrome://') && !u.startsWith('chrome-extension://') && !u.startsWith('devtools://')
  })
  return usable[0] || pages[0] || (await browser.newPage())
}

async function connectSession(profileId: string, debugPort: number): Promise<HumanSession> {
  await waitDebugReady(debugPort)
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${debugPort}`,
    defaultViewport: null
  })
  const page = await pickPage(browser)
  const cursor = createCursor(page, undefined, true)
  await ensurePopupWatchdog(page, 'accept')
  const session: HumanSession = { profileId, debugPort, browser, page, cursor }
  sessions.set(profileId, session)

  browser.on('disconnected', () => {
    if (sessions.get(profileId)?.browser === browser) {
      sessions.delete(profileId)
    }
  })
  return session
}

/** 只读取现有会话，不发起连接（供收尾清理） */
export function peekHumanSession(profileId: string | number): HumanSession | null {
  return sessions.get(String(profileId)) || null
}

export function dropHumanSession(profileId: string | number) {
  const id = String(profileId)
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  try {
    s.browser.disconnect()
  } catch (_) {}
}

/** 确保指纹环境已启动，并返回已连接的人工操作会话 */
export async function ensureHumanSession(args: {
  profileId: string | number
  fingerprint?: Record<string, any>
  proxy?: Record<string, any> | null
  profileName?: string
  startUrl?: string
}): Promise<HumanSession> {
  const profileId = String(args.profileId)
  const existing = sessions.get(profileId)
  if (existing) {
    try {
      // 探测连接是否仍可用
      await existing.page.evaluate(() => true)
      return existing
    } catch (_) {
      dropHumanSession(profileId)
    }
  }

  let info = getRunningDebugInfo(profileId)
  if (!info?.debugPort) {
    await launchBrowser({
      profileId,
      name: args.profileName,
      fingerprint: args.fingerprint,
      proxy: args.proxy || null,
      startUrl: args.startUrl || 'about:blank',
      enableDebug: true
    })
    info = getRunningDebugInfo(profileId)
    await sleep(800)
  }
  if (!info?.debugPort) {
    throw new Error('浏览器未开启调试端口，无法建立 CDP 会话')
  }
  return connectSession(profileId, info.debugPort)
}

export async function withHumanPage<T>(
  args: {
    profileId: string | number
    fingerprint?: Record<string, any>
    proxy?: Record<string, any> | null
    profileName?: string
    startUrl?: string
  },
  fn: (session: HumanSession) => Promise<T>
): Promise<T> {
  const session = await ensureHumanSession(args)
  return fn(session)
}
