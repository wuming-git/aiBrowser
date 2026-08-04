/**
 * Desktop-side simplified DOM observation (browser-use style).
 * Prefer JS DomService via CDP on the focused page; fallback to Electron interactive snapshot.
 * When a task-relevant dialog is open, auto-scope the tree to that dialog (ads demoted).
 */
import { createHash } from 'node:crypto'
import type { Page } from 'puppeteer-core'
import { captureDomSnapshot } from './domSnapshot'
import {
  captureDomServiceObservation,
  pruneLlmTreeText,
  type DomTreeFormat
} from './domService'
import {
  applyDialogFocus,
  detectCenteredDialog,
  resolveDomScope,
  type DomScope
} from './dialogFocus'
import { withDomObserveEffect } from './highlights'

export type DomObservation = {
  ok: boolean
  source: string
  mode: string
  format?: string
  url?: string
  title?: string
  tree?: string
  truncated?: boolean
  elementCount?: number
  pageFingerprint?: string
  textHash?: string
  error?: string
  hint?: string
  scope?: DomScope
  dialogScoped?: boolean
  /** Plain note for the model: what DOM slice was returned and how to request full page */
  domNote?: string
}

/** Resolve tree format from tool args / explicit option. Default = key (超精简). */
export function resolveDomTreeFormat(args?: Record<string, any>, explicit?: DomTreeFormat): DomTreeFormat {
  if (explicit === 'browser-use' || explicit === 'key') return explicit
  const raw = String(args?.treeFormat || args?.domFormat || args?.mode || args?.domMode || '')
    .trim()
    .toLowerCase()
  if (!raw) return 'key'
  if (
    raw === 'browser_use' ||
    raw === 'browser-use' ||
    raw === 'bu' ||
    raw === 'full_tree' ||
    raw === 'simplified'
  ) {
    return 'browser-use'
  }
  if (
    raw === 'key' ||
    raw === 'ultra' ||
    raw === 'compact' ||
    raw === 'ultra_compact' ||
    raw === '超精简' ||
    raw === '超精简dom'
  ) {
    return 'key'
  }
  // other snapshot modes (a11y/interactive/…) are not DomService formats
  return 'key'
}

const ATTACH_TOOLS = new Set([
  'browser.launch',
  'browser.open',
  'browser.navigate',
  'browser.click',
  'browser.type',
  'browser.hover',
  'browser.scroll',
  'browser.waitFor',
  'browser.pressKey',
  'browser.act',
  'browser.clickXy',
  'browser.download',
  'browser.find'
])

/** snapshot 本身就是 DOM，不再重复附加 */
const SKIP_ATTACH = new Set([
  'browser.snapshot',
  'browser.debugInfo',
  'browser.highlight',
  'browser.screenshot',
  'browser.close',
  'browser.extractText'
])

/** 解析模型下发的 includeDom / attachDom / observe（仅显式真值才挂 DOM）。 */
export function wantsIncludeDom(args: Record<string, any> | undefined): boolean {
  if (!args || typeof args !== 'object') return false
  const raw = args.includeDom ?? args.attachDom ?? args.observe
  if (raw === true || raw === 1) return true
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase()
    return s === 'true' || s === '1' || s === 'yes' || s === 'on'
  }
  return false
}

/**
 * 是否在动作后附加 observation.tree。
 * 策略：全由模型决定 — 仅当 args.includeDom/attachDom/observe 为真时挂载；
 * 省略或 false 不挂 DOM（snapshot 本身除外，走 SKIP）。
 */
export function shouldAttachDom(tool: string, args: Record<string, any>): boolean {
  if (SKIP_ATTACH.has(tool)) return false
  if (!(ATTACH_TOOLS.has(tool) || tool.startsWith('browser.'))) return false
  return wantsIncludeDom(args)
}

function fingerprint(url: string, tree: string, elementCount: number) {
  const textHash = createHash('sha256').update(tree || '', 'utf8').digest('hex').slice(0, 16)
  return {
    textHash,
    pageFingerprint: `${url || ''}|${elementCount}|${textHash}`
  }
}

async function withDialogFocus(
  page: Page,
  obs: DomObservation,
  scope: DomScope
): Promise<DomObservation> {
  if (!obs.ok || !obs.tree) return { ...obs, scope }
  if (scope === 'page' || scope === 'full') {
    return { ...obs, scope, dialogScoped: false }
  }

  // Primary: geometric center of viewport → that panel's DOM
  const centered =
    scope === 'auto' || scope === 'dialog'
      ? await detectCenteredDialog(page)
      : null

  const focused = applyDialogFocus(obs.tree, scope, centered)
  const omitted = focused.omittedBlocks ?? 0
  const focusedCount = focused.scoped
    ? (focused.tree.match(/\[ref=e\d+\]/g) || []).length
    : 0
  const origCount = obs.elementCount || (obs.tree.match(/\[ref=e\d+\]/g) || []).length
  const shrunk = origCount > 0 && focusedCount > 0 && focusedCount < origCount * 0.85
  // 只有真正裁掉背景块 / 节点显著变少时才标 dialogScoped（避免首页 omitted=0 误报）
  if (!focused.scoped || (omitted <= 0 && !shrunk)) {
    return { ...obs, scope, dialogScoped: false, domNote: undefined }
  }
  const elementCount = focusedCount || obs.elementCount || 0
  const fp = fingerprint(obs.url || '', focused.tree, elementCount)
  const richer =
    obs.mode === 'key' || obs.format === 'pruned-key-dom-tree-compact'
      ? 'browser_snapshot(mode=browser_use, scope=page)'
      : 'browser_snapshot(scope=page)'
  const domNote =
    `工具已按中央弹窗裁剪 DOM（dialogScoped=true` +
    (focused.reason === 'centered_dialog' && centered
      ? `, center=${centered.centerScore}`
      : '') +
    `，省略 ${omitted} 个背景块）。` +
    `若不够完成任务，请再调用 ${richer} 申请更完整 DOM。`
  return {
    ...obs,
    tree: focused.tree,
    elementCount,
    pageFingerprint: fp.pageFingerprint,
    textHash: fp.textHash,
    scope: focused.scope,
    dialogScoped: true,
    domNote,
    hint: obs.hint
  }
}

async function captureViaElectron(
  page: Page,
  maxChars: number,
  scope: DomScope,
  treeFormat: DomTreeFormat
): Promise<DomObservation> {
  const snap = await captureDomSnapshot(page, {
    mode: 'interactive',
    maxNodes: 180,
    scope: scope === 'dialog' ? 'dialog' : scope === 'page' || scope === 'full' ? 'page' : 'auto',
    maxTreeChars: maxChars
  })
  let tree = String(snap.tree || '')
  let mode = 'interactive'
  let format: string | undefined
  if (treeFormat === 'key') {
    tree = pruneLlmTreeText(tree)
    mode = 'key'
    format = 'pruned-key-dom-tree-compact'
  }
  const elementCount = Array.isArray(snap.nodes)
    ? snap.nodes.length
    : (tree.match(/\[ref=e\d+\]/g) || []).length
  const fp = fingerprint(snap.url || '', tree, elementCount)
  return withDialogFocus(page, {
    ok: true,
    source: 'electron-interactive',
    mode,
    format,
    url: snap.url,
    title: snap.title,
    tree,
    truncated: !!snap.truncated,
    elementCount,
    pageFingerprint: fp.pageFingerprint,
    textHash: fp.textHash,
    hint:
      treeFormat === 'key'
        ? '超精简关键 DOM（Electron interactive 回退近似剪枝）。需要完整精简树请 browser_snapshot(mode=browser_use)。'
        : '桌面端精简 DOM（Electron interactive；JS DomService 失败时的回退）'
  }, scope)
}

export async function captureSimplifiedObservation(opts: {
  page: Page
  profileId: string | number
  maxChars?: number
  preferBrowserUse?: boolean
  /** auto=有任务弹窗则只返回弹窗；page/full=整页；dialog=强制弹窗 */
  scope?: DomScope
  /** key=超精简（默认）；browser-use=完整精简树 */
  treeFormat?: DomTreeFormat
  args?: Record<string, any>
}): Promise<DomObservation> {
  const maxChars = Math.min(Math.max(Number(opts.maxChars) || 40000, 2000), 80000)
  const prefer = opts.preferBrowserUse !== false
  const scope = opts.scope || resolveDomScope(opts.args)
  const treeFormat = resolveDomTreeFormat(opts.args, opts.treeFormat)

  return withDomObserveEffect(opts.page, async () => {
    if (prefer) {
      const bu = await captureDomServiceObservation(opts.page, {
        maxChars,
        stampRefs: true,
        treeFormat
      })
      if (bu.ok) {
        return withDialogFocus(
          opts.page,
          {
            ok: true,
            source: bu.source,
            mode: bu.mode,
            format: bu.format,
            url: bu.url,
            title: bu.title,
            tree: bu.tree,
            truncated: bu.truncated,
            elementCount: bu.elementCount,
            pageFingerprint: bu.pageFingerprint,
            textHash: bu.textHash,
            hint: bu.hint
          },
          scope
        )
      }
      console.warn('[simplifiedDom] JS DomService failed:', bu.error)
    }

    try {
      return await captureViaElectron(opts.page, maxChars, scope, treeFormat)
    } catch (e: any) {
      return {
        ok: false,
        source: 'error',
        mode: 'none',
        error: e?.message || String(e)
      }
    }
  })
}
