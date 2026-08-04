/**
 * Public API: capture browser-use-style simplified DOM via JS DomService (no Python).
 */
import { createHash } from 'node:crypto'
import type { Page } from 'puppeteer-core'
import { DomService, type DomServiceOptions } from './service'
import { keyTreeRepresentation } from './prunedKeyTree'
import { llmRepresentation } from './serializer'
import { rewriteIndexesToRefs, stampAiRefs } from './stampRefs'

/** browser-use = 完整精简树；key = 超精简关键节点树（默认给模型） */
export type DomTreeFormat = 'browser-use' | 'key'

export type DomServiceObservation = {
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
  timing?: Record<string, number>
  error?: string
  hint?: string
}

function fingerprint(url: string, tree: string, elementCount: number) {
  const textHash = createHash('sha256').update(tree || '', 'utf8').digest('hex').slice(0, 16)
  return {
    textHash,
    pageFingerprint: `${url || ''}|${elementCount}|${textHash}`,
  }
}

export async function captureDomServiceObservation(
  page: Page,
  opts?: {
    maxChars?: number
    stampRefs?: boolean
    serviceOptions?: DomServiceOptions
    /** key=超精简关键树（默认）；browser-use=完整精简树 */
    treeFormat?: DomTreeFormat
  },
): Promise<DomServiceObservation> {
  const maxChars = Math.min(Math.max(Number(opts?.maxChars) || 40000, 2000), 80000)
  const stamp = opts?.stampRefs !== false
  const treeFormat: DomTreeFormat = opts?.treeFormat === 'browser-use' ? 'browser-use' : 'key'
  const useKey = treeFormat === 'key'

  let cdp: Awaited<ReturnType<Page['createCDPSession']>> | null = null
  try {
    cdp = await page.createCDPSession()
    try {
      await cdp.send('DOM.enable')
      await cdp.send('Accessibility.enable')
    } catch {
      // optional
    }

    const service = new DomService(cdp, {
      paintOrderFiltering: true,
      crossOriginIframes: false,
      ...(opts?.serviceOptions || {}),
    })

    const { serialized, timing } = await service.getSerializedDomTree()
    const selectorMap = serialized.selectorMap || {}

    if (stamp && Object.keys(selectorMap).length) {
      await stampAiRefs(cdp, selectorMap)
    }

    let tree: string
    let format: string
    let elementCount: number
    let mode: string
    let hint: string

    if (useKey) {
      const key = keyTreeRepresentation(serialized)
      // key 剪空时自动回退完整精简树，避免模型拿到 mode=key 却没有 tree
      if (!String(key.tree || '').trim() || key.elementCount <= 0) {
        tree = rewriteIndexesToRefs(llmRepresentation(serialized))
        format = 'browser-use-llm-tree'
        elementCount = Object.keys(selectorMap).length
        mode = 'browser_use'
        hint =
          '超精简 key 树为空，已自动回退完整精简 DOM。点击/输入请用 [ref=eN]。'
      } else {
        tree = key.tree
        format = key.format
        elementCount = key.elementCount
        mode = 'key'
        hint =
          '超精简关键 DOM（仅可点/报错/短状态及分区壳；含 @x,y wxh 与 c=/bg=）。' +
          '点击/输入请用 [ref=eN]。需要更完整结构请 browser_snapshot(mode=browser_use)。'
      }
    } else {
      tree = rewriteIndexesToRefs(llmRepresentation(serialized))
      format = 'browser-use-llm-tree'
      elementCount = Object.keys(selectorMap).length
      mode = 'browser_use'
      hint =
        'DOM 由桌面端 JS DomService（CDP）精简；可交互节点已标记 data-ai-ref=eN。点击/输入请用 ref=eN。'
    }

    const truncated = tree.length > maxChars
    if (truncated) tree = tree.slice(0, maxChars) + '\n…(truncated)'

    const meta = await page
      .evaluate(() => ({ url: location.href, title: document.title || '' }))
      .catch(() => ({ url: page.url(), title: '' }))

    const fp = fingerprint(meta.url || '', tree, elementCount)

    return {
      ok: true,
      source: 'dom-service-js',
      mode,
      format,
      url: meta.url,
      title: meta.title,
      tree,
      truncated,
      elementCount,
      pageFingerprint: fp.pageFingerprint,
      textHash: fp.textHash,
      timing,
      hint,
    }
  } catch (e: any) {
    return {
      ok: false,
      source: 'dom-service-js',
      mode: useKey ? 'key' : 'browser_use',
      error: e?.message || String(e),
    }
  } finally {
    if (cdp) {
      try {
        await cdp.detach()
      } catch {
        // ignore
      }
    }
  }
}

export { DomService } from './service'
export type { DomServiceOptions } from './service'
export { llmRepresentation } from './serializer'
export { keyTreeRepresentation, pruneLlmTreeText } from './prunedKeyTree'
