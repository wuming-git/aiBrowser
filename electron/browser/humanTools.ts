/**
 * CDP 人工行为浏览器工具（puppeteer-core + ghost-cursor）
 * - 不另起浏览器：挂接到 launcher 已启动的指纹 Chrome
 * - 鼠标：ghost-cursor 贝塞尔轨迹
 * - 键盘/滚动/等待：随机延迟模拟人工节奏
 * - 观察：CDP Accessibility 精简树 + data-ai-ref（兼容自编译 Chrome）
 */
import type { Page } from 'puppeteer-core'
import { getRandomPagePoint } from 'ghost-cursor'
import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { captureDomSnapshot } from './domSnapshot'
import { captureA11ySnapshot, refSelector } from './a11ySnapshot'
import { findElementsByText } from './domFind'
import { capturePageSignature, signatureChanged } from './pageSignature'
import {
  addRefHighlights,
  highlightCoordinate,
  highlightInteraction,
  removeHighlights,
  withDomObserveEffect
} from './highlights'
import { attachDownloadWatchdog, ensurePopupWatchdog } from './watchdogs'
import {
  dropHumanSession,
  ensureHumanSession,
  humanPause,
  randInt,
  withHumanPage,
  type HumanSession
} from './humanSession'
import { getRunningDebugInfo } from './launcher'
import { captureSimplifiedObservation } from './simplifiedDom'

function requireSelector(args: Record<string, any>): string {
  const s = String(args.selector || '').trim()
  if (!s) throw new Error('缺少 selector（CSS 选择器）')
  return s
}

/** 优先 ref（来自 browser.snapshot），否则 CSS selector */
function resolveTargetSelector(args: Record<string, any>): { selector: string; ref?: string } {
  const ref = String(args.ref || '').trim()
  if (ref) {
    return { selector: refSelector(ref), ref }
  }
  return { selector: requireSelector(args) }
}

function requireProfileId(args: Record<string, any>): string | number {
  if (args.profileId == null) throw new Error('缺少 profileId')
  return args.profileId
}

function ensureUrl(url: unknown, fallback?: string): string {
  const s = String(url || '').trim()
  if (!s) {
    if (fallback) return fallback
    throw new Error('缺少 url')
  }
  if (!/^https?:\/\//i.test(s) && s !== 'about:blank') {
    throw new Error('url 必须以 http(s):// 开头')
  }
  return s
}

const DEFAULT_ENV_URL = 'https://browser168.com'

/** 解析单个或多个 URL（数组 / 逗号分号换行分隔） */
function parseUrlList(args: Record<string, any>, fallback = DEFAULT_ENV_URL): string[] {
  const raw = args.urls != null ? args.urls : args.url
  let items: unknown[] = []
  if (raw == null || (typeof raw === 'string' && !String(raw).trim())) {
    return [fallback]
  }
  if (Array.isArray(raw)) {
    items = raw
  } else {
    const text = String(raw).trim()
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text)
        items = Array.isArray(parsed) ? parsed : [text]
      } catch {
        items = [text]
      }
    } else {
      items = text.split(/[,，;；|\n]+/).map((s) => s.trim()).filter(Boolean)
    }
  }
  const urls = items
    .map((u) => {
      const s = String(u || '').trim()
      if (!s) return ''
      if (/^https?:\/\//i.test(s) || s === 'about:blank') return s
      return `https://${s}`
    })
    .filter(Boolean)
  return urls.length ? urls : [fallback]
}

async function gotoWithHuman(page: import('puppeteer-core').Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await humanPause(400, 1100)
  if (url !== 'about:blank') {
    await humanScroll(page, randInt(80, 280))
  }
}

/** 第一个 URL 在当前页打开，其余新标签打开；会话焦点保持在第一个标签 */
async function openUrlList(
  session: HumanSession,
  urls: string[]
): Promise<{ url: string; urls: string[]; openedTabs: number }> {
  const list = urls.length ? urls : [DEFAULT_ENV_URL]
  const first = list[0]
  const current = session.page.url()
  if (current !== first) {
    await gotoWithHuman(session.page, first)
  }
  for (let i = 1; i < list.length; i++) {
    const page = await session.browser.newPage()
    await gotoWithHuman(page, list[i])
    await humanPause(120, 280)
  }
  return { url: first, urls: list, openedTabs: list.length }
}

async function pageMeta(page: Page) {
  const sig = await capturePageSignature(page)
  return {
    title: sig.title,
    url: sig.url,
    pageSignature: sig.signature,
    hasDialog: sig.hasDialog,
    textFingerprint: sig.textFingerprint
  }
}

async function withActionSignature<T extends Record<string, any>>(
  page: Page,
  run: () => Promise<T>
): Promise<T & { before: Awaited<ReturnType<typeof capturePageSignature>>; after: Awaited<ReturnType<typeof capturePageSignature>>; changed: boolean }> {
  const before = await capturePageSignature(page)
  const result = await run()
  await humanPause(120, 280)
  const after = await capturePageSignature(page)
  return {
    ...result,
    before,
    after,
    changed: signatureChanged(before, after)
  }
}

/** 逐字输入，随机键间隔 */
async function humanType(page: Page, text: string, clearFirst = false) {
  if (clearFirst) {
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyA')
    await page.keyboard.up('Control')
    await humanPause(40, 120)
    await page.keyboard.press('Backspace')
    await humanPause(80, 200)
  }
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: randInt(45, 160) })
    if (Math.random() < 0.08) await humanPause(180, 420) // 偶尔停顿
  }
}

async function humanScroll(page: Page, deltaY: number, steps = 0) {
  const total = Math.abs(deltaY)
  const dir = deltaY >= 0 ? 1 : -1
  const n = steps > 0 ? steps : randInt(4, 10)
  let left = total
  for (let i = 0; i < n; i++) {
    const chunk = i === n - 1 ? left : Math.max(20, Math.floor(left / (n - i) + randInt(-15, 25)))
    left = Math.max(0, left - chunk)
    await page.mouse.wheel({ deltaY: chunk * dir })
    await humanPause(60, 180)
  }
}

const moveOpts = {
  moveDelay: 120,
  randomizeMoveDelay: true,
  paddingPercentage: 20,
  scrollSpeed: 40,
  scrollDelay: 180,
  overshootThreshold: 420
} as const

function clickOpts() {
  return {
    ...moveOpts,
    hesitate: randInt(40, 160),
    waitForClick: randInt(80, 220)
  }
}

async function idleMouseJitter(session: HumanSession) {
  try {
    const pt = await getRandomPagePoint(session.page)
    await session.cursor.moveTo(pt, { moveDelay: randInt(40, 160), randomizeMoveDelay: true })
  } catch (_) {}
}

export async function browserLaunch(args: Record<string, any>) {
  const profileId = requireProfileId(args)
  const urls = parseUrlList(args, DEFAULT_ENV_URL)
  const session = await ensureHumanSession({
    profileId,
    fingerprint: args.fingerprint,
    proxy: args.proxy,
    profileName: args.profileName,
    startUrl: urls[0]
  })
  await humanPause(200, 500)
  const opened = await openUrlList(session, urls)
  const meta = await pageMeta(session.page)
  return { launched: true, humanized: true, profileId, ...opened, ...meta }
}

export async function browserOpen(args: Record<string, any>) {
  const profileId = requireProfileId(args)
  const urls = parseUrlList(args, DEFAULT_ENV_URL)
  const session = await ensureHumanSession({
    profileId,
    fingerprint: args.fingerprint,
    proxy: args.proxy,
    profileName: args.profileName,
    startUrl: urls[0]
  })
  await humanPause(200, 500)
  const opened = await openUrlList(session, urls)
  const meta = await pageMeta(session.page)
  return { opened: true, humanized: true, profileId, ...opened, ...meta }
}

export async function browserNavigate(args: Record<string, any>) {
  const profileId = requireProfileId(args)
  const url = ensureUrl(args.url)
  return withHumanPage(
    {
      profileId,
      fingerprint: args.fingerprint,
      proxy: args.proxy,
      profileName: args.profileName,
      startUrl: 'about:blank'
    },
    async (session) => {
      return withActionSignature(session.page, async () => {
        await humanPause(150, 400)
        await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
        await humanPause(400, 1100)
        await humanScroll(session.page, randInt(80, 280))
        const meta = await pageMeta(session.page)
        return { navigated: true, humanized: true, profileId, ...meta }
      })
    }
  )
}

export async function browserClick(args: Record<string, any>) {
  const profileId = requireProfileId(args)
  const { selector, ref } = resolveTargetSelector(args)
  return withHumanPage(
    {
      profileId,
      fingerprint: args.fingerprint,
      proxy: args.proxy,
      profileName: args.profileName
    },
    async (session) => {
      await ensurePopupWatchdog(session.page)
      return withActionSignature(session.page, async () => {
        await humanPause()
        await session.page.waitForSelector(selector, { timeout: Number(args.timeoutMs) || 20000 })
        if (args.highlight !== false) {
          await highlightInteraction(session.page, selector).catch(() => undefined)
        }
        await session.cursor.click(selector, {
          ...clickOpts(),
          waitForSelector: Number(args.timeoutMs) || 20000
        })
        await humanPause(200, 600)
        const meta = await pageMeta(session.page)
        return {
          clicked: true,
          selector,
          ref: ref || undefined,
          humanized: true,
          profileId,
          ...meta,
          metadata: { action: 'click', ref: ref || undefined }
        }
      })
    }
  )
}

export async function browserType(args: Record<string, any>) {
  const profileId = requireProfileId(args)
  const { selector, ref } = resolveTargetSelector(args)
  const text = String(args.text ?? '')
  if (!text) throw new Error('缺少 text')
  const clear = args.clear !== false
  return withHumanPage(
    {
      profileId,
      fingerprint: args.fingerprint,
      proxy: args.proxy,
      profileName: args.profileName
    },
    async (session) => {
      await ensurePopupWatchdog(session.page)
      return withActionSignature(session.page, async () => {
        await humanPause()
        await session.page.waitForSelector(selector, { timeout: Number(args.timeoutMs) || 20000 })
        if (args.highlight !== false) {
          await highlightInteraction(session.page, selector).catch(() => undefined)
        }
        await session.cursor.click(selector, {
          ...clickOpts(),
          waitForSelector: Number(args.timeoutMs) || 20000
        })
        await humanPause(100, 280)
        await humanType(session.page, text, clear)
        await humanPause(150, 400)
        const meta = await pageMeta(session.page)
        return {
          typed: true,
          selector,
          ref: ref || undefined,
          length: text.length,
          humanized: true,
          profileId,
          ...meta,
          metadata: { action: 'type', ref: ref || undefined }
        }
      })
    }
  )
}

export async function browserHover(args: Record<string, any>) {
  const profileId = requireProfileId(args)
  const { selector, ref } = resolveTargetSelector(args)
  return withHumanPage(
    {
      profileId,
      fingerprint: args.fingerprint,
      proxy: args.proxy,
      profileName: args.profileName
    },
    async (session) => {
      await humanPause()
      await session.page.waitForSelector(selector, { timeout: Number(args.timeoutMs) || 20000 })
      await session.cursor.move(selector, {
        ...moveOpts,
        waitForSelector: Number(args.timeoutMs) || 20000
      })
      await humanPause(200, 700)
      const meta = await pageMeta(session.page)
      return { hovered: true, selector, ref: ref || undefined, humanized: true, profileId, ...meta }
    }
  )
}

export async function browserScroll(args: Record<string, any>) {
  const profileId = requireProfileId(args)
  const deltaY = Number(args.deltaY ?? 600)
  if (!Number.isFinite(deltaY)) throw new Error('deltaY 无效')
  return withHumanPage(
    {
      profileId,
      fingerprint: args.fingerprint,
      proxy: args.proxy,
      profileName: args.profileName
    },
    async (session) => {
      await humanPause()
      await idleMouseJitter(session)
      await humanScroll(session.page, deltaY)
      await humanPause(200, 500)
      const meta = await pageMeta(session.page)
      return { scrolled: true, deltaY, humanized: true, profileId, ...meta }
    }
  )
}

export async function browserWaitFor(args: Record<string, any>) {
  const profileId = requireProfileId(args)
  const { selector, ref } = resolveTargetSelector(args)
  const timeout = Number(args.timeoutMs) || 20000
  return withHumanPage(
    {
      profileId,
      fingerprint: args.fingerprint,
      proxy: args.proxy,
      profileName: args.profileName
    },
    async (session) => {
      await session.page.waitForSelector(selector, { timeout })
      await humanPause(150, 400)
      const meta = await pageMeta(session.page)
      return { ready: true, selector, ref: ref || undefined, humanized: true, profileId, ...meta }
    }
  )
}

export async function browserPressKey(args: Record<string, any>) {
  const profileId = requireProfileId(args)
  const key = String(args.key || '').trim()
  if (!key) throw new Error('缺少 key，例如 Enter / Escape / Tab')
  return withHumanPage(
    {
      profileId,
      fingerprint: args.fingerprint,
      proxy: args.proxy,
      profileName: args.profileName
    },
    async (session) => {
      await humanPause(80, 220)
      await session.page.keyboard.press(key as any)
      await humanPause(120, 360)
      const meta = await pageMeta(session.page)
      return { pressed: true, key, humanized: true, profileId, ...meta }
    }
  )
}

export async function browserExtractText(args: Record<string, any>) {
  const profileId = requireProfileId(args)
  const maxChars = Number(args.maxChars) || 8000
  // 禁止通过 extract_text 导航，避免猜错登录 URL 把会话带偏
  if (args.url != null && String(args.url).trim()) {
    throw new Error('browser.extractText 不再接受 url；请先 browser_navigate/open，再提取当前页文本')
  }
  return withHumanPage(
    {
      profileId,
      fingerprint: args.fingerprint,
      proxy: args.proxy,
      profileName: args.profileName
    },
    async (session) => {
      await humanPause()
      await idleMouseJitter(session)
      const data = await session.page.evaluate((limit: number) => {
        const text = (document.body?.innerText || document.body?.textContent || '')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
        return {
          title: document.title || '',
          url: location.href,
          text: text.length > limit ? text.slice(0, limit) + '\n…(truncated)' : text
        }
      }, maxChars)
      const meta = await pageMeta(session.page)
      return { ...data, ...meta, humanized: true, profileId }
    }
  )
}

export async function browserSnapshot(args: Record<string, any>) {
  const profileId = requireProfileId(args)
  const maxNodes = Number(args.maxNodes) || 100
  const scope = String(args.scope || 'auto')
  // 默认超精简关键 DOM（key）；完整精简树用 mode=browser_use
  const modeRaw = String(args.mode || args.domMode || 'key')
  const mode = modeRaw.trim().toLowerCase()
  const selector = args.selector ? String(args.selector).trim() : ''
  const maxChars = Number(args.maxChars) || 12000
  const maxTreeChars = Number(args.maxTreeChars) || 40000
  // 默认不画全页编号框；仅当显式 highlight=true 时才铺编号（调试用）
  const highlightAll = args.highlight === true || args.highlightAll === true
  const isKeyMode =
    !mode ||
    mode === 'key' ||
    mode === 'ultra' ||
    mode === 'compact' ||
    mode === 'ultra_compact' ||
    mode === '超精简' ||
    mode === '超精简dom' ||
    mode === 'default' ||
    mode === 'auto'
  const useBu =
    isKeyMode ||
    mode === 'browser_use' ||
    mode === 'bu' ||
    mode === 'browser-use'

  return withHumanPage(
    {
      profileId,
      fingerprint: args.fingerprint,
      proxy: args.proxy,
      profileName: args.profileName
    },
    async (session) => {
      await ensurePopupWatchdog(session.page)
      await humanPause()
      try {
        await removeHighlights(session.page).catch(() => undefined)

        // DomService 路径：key=超精简关键树；browser_use=完整精简树
        if (useBu) {
          const treeFormat =
            mode === 'browser_use' || mode === 'bu' || mode === 'browser-use'
              ? 'browser-use'
              : 'key'
          const obs = await captureSimplifiedObservation({
            page: session.page,
            profileId,
            maxChars: maxTreeChars,
            preferBrowserUse: true,
            treeFormat,
            args: { ...args, scope, domScope: scope, mode: treeFormat === 'key' ? 'key' : 'browser_use' }
          })
          return {
            ok: obs.ok,
            source: obs.source,
            mode: obs.mode,
            format: obs.format,
            url: obs.url,
            title: obs.title,
            truncated: obs.truncated,
            elementCount: obs.elementCount,
            pageFingerprint: obs.pageFingerprint,
            error: obs.error,
            humanized: true,
            profileId,
            highlightAdded: 0,
            // 主动 snapshot：tree 只在 observation；dialogScoped/domNote 仅真值
            observation: obs.ok
              ? {
                  source: obs.source,
                  mode: obs.mode,
                  format: obs.format,
                  url: obs.url,
                  title: obs.title,
                  tree: obs.tree,
                  truncated: obs.truncated,
                  elementCount: obs.elementCount,
                  scope: obs.scope,
                  ...(obs.dialogScoped
                    ? { dialogScoped: true, domNote: obs.domNote }
                    : {}),
                  ...(obs.hint ? { hint: obs.hint } : {})
                }
              : undefined
          }
        }

        const snap = await withDomObserveEffect(session.page, () =>
          captureDomSnapshot(session.page, {
            mode: modeRaw,
            maxNodes,
            scope,
            selector: selector || undefined,
            maxChars,
            maxTreeChars
          })
        )
        let highlightAdded = 0
        if (highlightAll) {
          const h = await addRefHighlights(session.page).catch(() => ({ added: 0 }))
          highlightAdded = h.added
        }
        return { ...snap, humanized: true, profileId, highlightAdded }
      } catch (e: any) {
        try {
          const snap = await captureA11ySnapshot(session.page, { maxNodes, scope })
          return {
            ...snap,
            mode: 'a11y',
            errorHints: [],
            humanized: true,
            profileId,
            source: 'cdp-accessibility-fallback',
            fallbackError: e?.message || String(e)
          }
        } catch (e2: any) {
          const meta = await pageMeta(session.page)
          return {
            ok: false,
            ...meta,
            mode: modeRaw,
            tree: `(snapshot failed) ${e2?.message || e2}`,
            humanized: true,
            profileId,
            source: 'error',
            error: e2?.message || String(e2)
          }
        }
      }
    }
  )
}

/** 返回指纹环境调试端口（桌面本地 DomService / 调试用；后端不应直连） */
export async function browserDebugInfo(args: Record<string, any>) {
  const profileId = requireProfileId(args)
  // 确保环境已启动并已连接，从而 debugPort 可用
  const session = await ensureHumanSession({
    profileId,
    fingerprint: args.fingerprint,
    proxy: args.proxy,
    profileName: args.profileName
  })
  const info = getRunningDebugInfo(profileId)
  const port = info?.debugPort ?? session.debugPort
  if (!port) {
    throw new Error('调试端口不可用')
  }
  return {
    profileId,
    debugPort: port,
    debugHost: '127.0.0.1',
    cdpHttpUrl: `http://127.0.0.1:${port}`,
    pid: info?.pid,
    userDataDir: info?.userDataDir
  }
}

/** 按文案查找 DOM（登录/Sign in 等），返回可点击 ref */
export async function browserFind(args: Record<string, any>) {
  const profileId = requireProfileId(args)
  const query = args.query != null ? String(args.query) : ''
  const match = args.match != null ? String(args.match) : 'contains'
  const maxResults = Number(args.maxResults || args.max_results) || 12
  return withHumanPage(
    {
      profileId,
      fingerprint: args.fingerprint,
      proxy: args.proxy,
      profileName: args.profileName
    },
    async (session) => {
      await humanPause()
      const found = await findElementsByText(session.page, { query, match, maxResults })
      return { ...found, humanized: true, profileId }
    }
  )
}

/**
 * 在指纹浏览器环境中下载文件（走环境 Cookie/代理）。
 * - 提供 url：导航触发下载，或直接拉取资源
 * - 提供 selector：点击下载链接/按钮
 * - 文件保存到 userData/downloads/{profileId}/
 */
export async function browserDownload(args: Record<string, any>) {
  const profileId = requireProfileId(args)
  const selector = args.selector ? String(args.selector).trim() : ''
  const url = args.url ? String(args.url).trim() : ''
  if (!selector && !url) {
    throw new Error('请提供 url（直接下载）或 selector（点击下载）至少一项')
  }
  if (url && url !== 'about:blank' && !/^https?:\/\//i.test(url)) {
    throw new Error('url 必须以 http(s):// 开头')
  }
  const timeoutMs = Number(args.timeoutMs) || 90000
  const saveAs = args.fileName ? String(args.fileName).trim() : ''

  const downloadRoot = path.join(app.getPath('userData'), 'downloads', String(profileId))
  await fs.mkdir(downloadRoot, { recursive: true })

  return withHumanPage(
    {
      profileId,
      fingerprint: args.fingerprint,
      proxy: args.proxy,
      profileName: args.profileName
    },
    async (session) => {
      await humanPause(150, 400)
      const before = new Set(await fs.readdir(downloadRoot).catch(() => [] as string[]))

      const watch = await attachDownloadWatchdog(session.page, downloadRoot)

      if (url && selector) {
        await session.page.goto(ensureUrl(url), { waitUntil: 'domcontentloaded', timeout: 60000 })
        await humanPause(400, 900)
        await session.page.waitForSelector(selector, { timeout: Math.min(timeoutMs, 30000) })
        await session.cursor.click(selector, {
          ...clickOpts(),
          waitForSelector: Math.min(timeoutMs, 30000)
        })
      } else if (selector) {
        await session.page.waitForSelector(selector, { timeout: Math.min(timeoutMs, 30000) })
        await session.cursor.click(selector, {
          ...clickOpts(),
          waitForSelector: Math.min(timeoutMs, 30000)
        })
      } else {
        // 直接访问下载 URL（可能导航也可能触发附件下载）
        await session.page.goto(ensureUrl(url), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {
          // 某些下载链接 goto 会因下载中断导航，忽略
        })
      }

      const savedPath = await waitForNewDownload(downloadRoot, before, timeoutMs)
      let finalPath = savedPath
      let fileName = path.basename(savedPath)

      if (saveAs) {
        const safe = saveAs.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180)
        const target = path.join(downloadRoot, safe)
        if (path.resolve(target) !== path.resolve(savedPath)) {
          await fs.rename(savedPath, target).catch(async () => {
            await fs.copyFile(savedPath, target)
            await fs.unlink(savedPath).catch(() => undefined)
          })
          finalPath = target
          fileName = safe
        }
      }

      const st = await fs.stat(finalPath)
      const meta = await pageMeta(session.page).catch(() => ({ title: '', url: '' }))
      return {
        downloaded: true,
        humanized: true,
        profileId,
        fileName,
        savedPath: finalPath,
        sizeBytes: st.size,
        downloadDir: downloadRoot,
        suggestedFilename: watch.lastSuggestedFilename,
        downloadUrl: watch.lastUrl,
        ...meta
      }
    }
  )
}

/** 坐标点击兜底（DOM/ref 失效时） */
export async function browserClickXy(args: Record<string, any>) {
  const profileId = requireProfileId(args)
  const x = Number(args.x)
  const y = Number(args.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('需要有效的 x/y 坐标')
  return withHumanPage(
    {
      profileId,
      fingerprint: args.fingerprint,
      proxy: args.proxy,
      profileName: args.profileName
    },
    async (session) => {
      await ensurePopupWatchdog(session.page)
      return withActionSignature(session.page, async () => {
        await humanPause()
        if (args.highlight !== false) {
          await highlightCoordinate(session.page, x, y).catch(() => undefined)
        }
        await session.page.mouse.click(x, y, { delay: randInt(40, 120) })
        await humanPause(200, 500)
        const meta = await pageMeta(session.page)
        return {
          clicked: true,
          x,
          y,
          humanized: true,
          profileId,
          ...meta,
          metadata: { action: 'click_xy', x, y }
        }
      })
    }
  )
}

/**
 * 截图；默认先 removeHighlights，避免编号框污染画面（browser-use ScreenshotWatchdog 模式）。
 * clearHighlights=false 可保留高亮用于人工调试。
 */
export async function browserScreenshot(args: Record<string, any>) {
  const profileId = requireProfileId(args)
  const fullPage = !!args.fullPage
  const clearHighlights = args.clearHighlights !== false
  return withHumanPage(
    {
      profileId,
      fingerprint: args.fingerprint,
      proxy: args.proxy,
      profileName: args.profileName
    },
    async (session) => {
      if (clearHighlights) {
        await removeHighlights(session.page).catch(() => undefined)
      }
      const buf = await session.page.screenshot({
        encoding: 'base64',
        type: 'jpeg',
        quality: Number(args.quality) || 72,
        fullPage
      })
      const meta = await pageMeta(session.page)
      const b64 = String(buf)
      return {
        screenshot: true,
        encoding: 'base64',
        mime: 'image/jpeg',
        fullPage,
        clearedHighlights: clearHighlights,
        image_b64: b64,
        bytesApprox: Math.floor((b64.length * 3) / 4),
        humanized: true,
        profileId,
        ...meta
      }
    }
  )
}

/** 手动开关编号高亮（调试用） */
export async function browserHighlight(args: Record<string, any>) {
  const profileId = requireProfileId(args)
  const enabled = args.enabled !== false
  return withHumanPage(
    {
      profileId,
      fingerprint: args.fingerprint,
      proxy: args.proxy,
      profileName: args.profileName
    },
    async (session) => {
      if (!enabled) {
        await removeHighlights(session.page)
        return { highlighted: false, profileId }
      }
      const { added } = await addRefHighlights(session.page)
      return { highlighted: true, added, profileId }
    }
  )
}

/**
 * 同页批处理多个动作（browser-use multi-act 思路）。
 * actions: [{op:'click'|'type'|'hover'|'scroll'|'press'|'wait'|'navigate'|'click_xy', ...}]
 */
export async function browserAct(args: Record<string, any>) {
  const profileId = requireProfileId(args)
  let actions: any[] = []
  const raw = args.actions != null ? args.actions : args.steps
  if (Array.isArray(raw)) actions = raw
  else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      actions = Array.isArray(parsed) ? parsed : []
    } catch {
      throw new Error('actions/steps 必须是 JSON 数组')
    }
  }
  if (!actions.length) throw new Error('actions/steps 不能为空')
  const maxActions = Math.min(Math.max(Number(args.maxActions) || 5, 1), 8)
  if (actions.length > maxActions) {
    throw new Error(`单次最多 ${maxActions} 个动作，收到 ${actions.length}`)
  }

  return withHumanPage(
    {
      profileId,
      fingerprint: args.fingerprint,
      proxy: args.proxy,
      profileName: args.profileName
    },
    async (session) => {
      await ensurePopupWatchdog(session.page)
      const before = await capturePageSignature(session.page)
      const steps: Array<Record<string, any>> = []
      let stopped = false
      let stopReason = ''

      for (let i = 0; i < actions.length; i++) {
        const a = actions[i] || {}
        const op = String(a.op || a.action || a.type || '')
          .trim()
          .toLowerCase()
        try {
          let stepResult: Record<string, any> = {}
          if (op === 'click') {
            const target = a.ref
              ? { selector: refSelector(String(a.ref)), ref: String(a.ref) }
              : { selector: String(a.selector || ''), ref: undefined }
            if (!target.selector) throw new Error('click 需要 ref 或 selector')
            await session.page.waitForSelector(target.selector, { timeout: Number(a.timeoutMs) || 15000 })
            await highlightInteraction(session.page, target.selector).catch(() => undefined)
            await session.cursor.click(target.selector, {
              ...clickOpts(),
              waitForSelector: Number(a.timeoutMs) || 15000
            })
            stepResult = { op, ok: true, ref: target.ref, selector: target.selector }
          } else if (op === 'type') {
            const target = a.ref
              ? { selector: refSelector(String(a.ref)), ref: String(a.ref) }
              : { selector: String(a.selector || ''), ref: undefined }
            const text = String(a.text ?? '')
            if (!target.selector || !text) throw new Error('type 需要 ref/selector 与 text')
            await session.page.waitForSelector(target.selector, { timeout: Number(a.timeoutMs) || 15000 })
            await highlightInteraction(session.page, target.selector).catch(() => undefined)
            await session.cursor.click(target.selector, { ...clickOpts(), waitForSelector: 15000 })
            await humanType(session.page, text, a.clear !== false)
            stepResult = { op, ok: true, ref: target.ref, length: text.length }
          } else if (op === 'hover') {
            const target = a.ref
              ? { selector: refSelector(String(a.ref)), ref: String(a.ref) }
              : { selector: String(a.selector || ''), ref: undefined }
            if (!target.selector) throw new Error('hover 需要 ref 或 selector')
            await session.cursor.move(target.selector, { ...moveOpts, waitForSelector: 15000 })
            stepResult = { op, ok: true, ref: target.ref }
          } else if (op === 'scroll') {
            const deltaY = Number(a.deltaY ?? a.delta_y ?? 600)
            await humanScroll(session.page, deltaY)
            stepResult = { op, ok: true, deltaY }
          } else if (op === 'press' || op === 'press_key' || op === 'presskey') {
            const key = String(a.key || '').trim()
            if (!key) throw new Error('press 需要 key')
            await session.page.keyboard.press(key as any)
            stepResult = { op, ok: true, key }
          } else if (op === 'wait' || op === 'wait_for' || op === 'waitfor') {
            if (a.ref || a.selector) {
              const sel = a.ref ? refSelector(String(a.ref)) : String(a.selector)
              await session.page.waitForSelector(sel, { timeout: Number(a.timeoutMs) || 15000 })
              stepResult = { op, ok: true, selector: sel }
            } else {
              await humanPause(Number(a.ms) || 500, Number(a.ms) || 800)
              stepResult = { op, ok: true, waitedMs: Number(a.ms) || 500 }
            }
          } else if (op === 'navigate') {
            const url = ensureUrl(a.url)
            await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
            stepResult = { op, ok: true, url }
          } else if (op === 'click_xy' || op === 'clickxy') {
            const x = Number(a.x)
            const y = Number(a.y)
            if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('click_xy 需要 x/y')
            await highlightCoordinate(session.page, x, y).catch(() => undefined)
            await session.page.mouse.click(x, y, { delay: randInt(40, 120) })
            stepResult = { op, ok: true, x, y }
          } else {
            throw new Error(`不支持的 op: ${op || '(empty)'}`)
          }
          await humanPause(120, 320)
          steps.push({ index: i, ...stepResult })
        } catch (e: any) {
          steps.push({ index: i, op, ok: false, error: e?.message || String(e) })
          stopped = true
          stopReason = e?.message || String(e)
          break
        }
      }

      const after = await capturePageSignature(session.page)
      const meta = await pageMeta(session.page)
      return {
        batch: true,
        humanized: true,
        profileId,
        steps,
        stopped,
        stopReason: stopReason || undefined,
        before,
        after,
        changed: signatureChanged(before, after),
        ...meta,
        metadata: { action: 'act', stepCount: steps.length }
      }
    }
  )
}

async function waitForNewDownload(dir: string, before: Set<string>, timeoutMs: number): Promise<string> {
  const start = Date.now()
  let candidate: string | null = null
  let lastSize = -1
  let stableRounds = 0

  while (Date.now() - start < timeoutMs) {
    const files = await fs.readdir(dir)
    const pending = files.filter((f) => f.endsWith('.crdownload') || f.endsWith('.tmp') || f.endsWith('.part'))
    const done = files.filter(
      (f) => !f.endsWith('.crdownload') && !f.endsWith('.tmp') && !f.endsWith('.part') && !before.has(f)
    )

    if (done.length > 0) {
      // 取最新修改的文件
      let newest = done[0]
      let newestMtime = 0
      for (const f of done) {
        const p = path.join(dir, f)
        const st = await fs.stat(p)
        if (st.mtimeMs >= newestMtime) {
          newestMtime = st.mtimeMs
          newest = f
        }
      }
      const p = path.join(dir, newest)
      const st = await fs.stat(p)
      if (st.size === lastSize && st.size > 0) {
        stableRounds++
      } else {
        stableRounds = 0
        lastSize = st.size
      }
      candidate = p
      // 无进行中的临时文件且大小稳定两轮
      if (pending.length === 0 && stableRounds >= 2) {
        return p
      }
    }
    await humanPause(180, 280)
  }
  if (candidate) return candidate
  throw new Error(`下载超时（${timeoutMs}ms），目录: ${dir}`)
}

export { dropHumanSession }
export type { HumanSession }
