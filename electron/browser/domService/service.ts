/**
 * DomService — TypeScript port of browser-use `dom/service.py`.
 * Operates on a single focused-page CDPSession (no BrowserSession).
 */

import type { CDPSession } from 'puppeteer-core'
import { buildSnapshotLookup, REQUIRED_COMPUTED_STYLES } from './enhancedSnapshot'
import { DOMTreeSerializer } from './serializer'
import type {
  DOMRect,
  EnhancedAXNode,
  EnhancedAXProperty,
  EnhancedDOMTreeNode,
  SerializedDOMState,
  TargetAllTrees,
} from './types'
import { NodeType } from './types'
import { isInteractive } from './clickable'

const MAX_JS_CLICK_LISTENER_ELEMENTS = 100
const DESCRIBE_NODE_BATCH_SIZE = 20
const JS_CLICK_LISTENER_OVERFLOW = '__browser_use_too_many_click_listeners__'
const MIN_CROSS_ORIGIN_IFRAME_EDGE = 10

const CDP_PARALLEL_TIMEOUT_MS = 10_000
const CDP_RETRY_TIMEOUT_MS = 2_000

export type DomServiceOptions = {
  paintOrderFiltering?: boolean
  crossOriginIframes?: boolean
  maxIframes?: number
  maxIframeDepth?: number
  viewportThreshold?: number | null
}

/** Raw CDP Accessibility.AXNode (subset we use). */
type CdpAxNode = {
  nodeId: string
  ignored: boolean
  backendDOMNodeId?: number
  role?: { value?: string }
  name?: { value?: string }
  description?: { value?: string }
  properties?: Array<{ name: string; value?: { value?: string | boolean | null } }>
  childIds?: string[]
}

/** Raw CDP DOM.Node (subset we use). */
type CdpDomNode = {
  nodeId: number
  backendNodeId: number
  nodeType: number
  nodeName: string
  nodeValue: string
  attributes?: string[]
  parentId?: number
  children?: CdpDomNode[]
  shadowRoots?: CdpDomNode[]
  contentDocument?: CdpDomNode
  frameId?: string
  shadowRootType?: string
  isScrollable?: boolean
}

type FrameTreeNode = {
  frame: { id: string; url?: string }
  childFrames?: FrameTreeNode[]
}

type HiddenElementInfo = {
  tag: string
  text: string
  pages: number
}

function isCrossOriginIframeSizeEligible(width: number, height: number): boolean {
  return width >= MIN_CROSS_ORIGIN_IFRAME_EDGE && height >= MIN_CROSS_ORIGIN_IFRAME_EDGE
}

function createDOMRect(x = 0, y = 0, width = 0, height = 0): DOMRect {
  return { x, y, width, height }
}

function copyDOMRect(rect: DOMRect): DOMRect {
  return createDOMRect(rect.x, rect.y, rect.width, rect.height)
}

function nowMs(): number {
  return Date.now()
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`CDP request ${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Create an EnhancedDOMTreeNode with camelCase fields and tagName getter semantics.
 */
function findHtmlInContentDocument(node: EnhancedDOMTreeNode): EnhancedDOMTreeNode | null {
  if (!node.contentDocument) return null
  if (node.contentDocument.tagName === 'html') return node.contentDocument
  for (const child of node.contentDocument.childrenNodes || []) {
    if (child.tagName === 'html') return child
  }
  return null
}

function computeScrollInfo(self: EnhancedDOMTreeNode): Record<string, number> | null {
  if (!self.isActuallyScrollable || !self.snapshotNode) return null
  const scrollRects = self.snapshotNode.scrollRects
  const clientRects = self.snapshotNode.clientRects
  if (!scrollRects || !clientRects) return null

  const scrollTop = scrollRects.y
  const scrollLeft = scrollRects.x
  const scrollableHeight = scrollRects.height
  const scrollableWidth = scrollRects.width
  const visibleHeight = clientRects.height
  const visibleWidth = clientRects.width
  const contentAbove = Math.max(0, scrollTop)
  const contentBelow = Math.max(0, scrollableHeight - visibleHeight - scrollTop)
  const contentLeft = Math.max(0, scrollLeft)
  const contentRight = Math.max(0, scrollableWidth - visibleWidth - scrollLeft)

  let verticalScrollPercentage = 0
  let horizontalScrollPercentage = 0
  if (scrollableHeight > visibleHeight) {
    const maxScrollTop = scrollableHeight - visibleHeight
    verticalScrollPercentage = maxScrollTop > 0 ? (scrollTop / maxScrollTop) * 100 : 0
  }
  if (scrollableWidth > visibleWidth) {
    const maxScrollLeft = scrollableWidth - visibleWidth
    horizontalScrollPercentage = maxScrollLeft > 0 ? (scrollLeft / maxScrollLeft) * 100 : 0
  }

  return {
    scroll_top: scrollTop,
    scroll_left: scrollLeft,
    scrollable_height: scrollableHeight,
    scrollable_width: scrollableWidth,
    visible_height: visibleHeight,
    visible_width: visibleWidth,
    content_above: contentAbove,
    content_below: contentBelow,
    content_left: contentLeft,
    content_right: contentRight,
    vertical_scroll_percentage: Math.round(verticalScrollPercentage * 10) / 10,
    horizontal_scroll_percentage: Math.round(horizontalScrollPercentage * 10) / 10,
    pages_above: visibleHeight > 0 ? Math.round((contentAbove / visibleHeight) * 10) / 10 : 0,
    pages_below: visibleHeight > 0 ? Math.round((contentBelow / visibleHeight) * 10) / 10 : 0,
    total_pages: visibleHeight > 0 ? Math.round((scrollableHeight / visibleHeight) * 10) / 10 : 1,
  }
}

export function createEnhancedNode(init: {
  nodeId: number
  backendNodeId: number
  nodeType: NodeType
  nodeName: string
  nodeValue: string
  attributes?: Record<string, string>
  isScrollable?: boolean | null
  frameId?: string | null
  sessionId?: string | null
  targetId?: string
  contentDocument?: EnhancedDOMTreeNode | null
  shadowRootType?: string | null
  shadowRoots?: EnhancedDOMTreeNode[] | null
  parentNode?: EnhancedDOMTreeNode | null
  childrenNodes?: EnhancedDOMTreeNode[] | null
  axNode?: EnhancedAXNode | null
  snapshotNode?: EnhancedDOMTreeNode['snapshotNode']
  isVisible?: boolean | null
  hasJsClickListener?: boolean
  absolutePosition?: DOMRect | null
  hiddenElementsInfo?: HiddenElementInfo[]
  hasHiddenContent?: boolean
}): EnhancedDOMTreeNode {
  const node = {
    nodeId: init.nodeId,
    backendNodeId: init.backendNodeId,
    nodeType: init.nodeType,
    nodeName: init.nodeName,
    nodeValue: init.nodeValue,
    attributes: init.attributes ?? {},
    isScrollable: init.isScrollable ?? null,
    frameId: init.frameId ?? null,
    sessionId: init.sessionId ?? null,
    targetId: init.targetId ?? '',
    contentDocument: init.contentDocument ?? null,
    shadowRootType: init.shadowRootType ?? null,
    shadowRoots: init.shadowRoots ?? null,
    parentNode: init.parentNode ?? null,
    childrenNodes: init.childrenNodes ?? null,
    axNode: init.axNode ?? null,
    snapshotNode: init.snapshotNode ?? null,
    isVisible: init.isVisible ?? null,
    hasJsClickListener: init.hasJsClickListener ?? false,
    absolutePosition: init.absolutePosition ?? null,
    hiddenElementsInfo: init.hiddenElementsInfo ?? [],
    hasHiddenContent: init.hasHiddenContent ?? false,
    get tagName(): string {
      return this.nodeName.toLowerCase()
    },
    get childrenAndShadowRoots(): EnhancedDOMTreeNode[] {
      const children = this.childrenNodes ? [...this.childrenNodes] : []
      if (this.shadowRoots) children.push(...this.shadowRoots)
      return children
    },
    get isActuallyScrollable(): boolean {
      if (this.isScrollable) return true
      if (!this.snapshotNode) return false
      const scrollRects = this.snapshotNode.scrollRects
      const clientRects = this.snapshotNode.clientRects
      if (!scrollRects || !clientRects) return false
      const hasVertical = scrollRects.height > clientRects.height + 1
      const hasHorizontal = scrollRects.width > clientRects.width + 1
      if (!hasVertical && !hasHorizontal) return false
      if (this.snapshotNode.computedStyles) {
        const styles = this.snapshotNode.computedStyles
        const overflow = (styles.overflow || 'visible').toLowerCase()
        const overflowX = (styles['overflow-x'] || overflow).toLowerCase()
        const overflowY = (styles['overflow-y'] || overflow).toLowerCase()
        return (
          ['auto', 'scroll', 'overlay'].includes(overflow) ||
          ['auto', 'scroll', 'overlay'].includes(overflowX) ||
          ['auto', 'scroll', 'overlay'].includes(overflowY)
        )
      }
      return ['div', 'main', 'section', 'article', 'aside', 'body', 'html'].includes(this.tagName)
    },
    get shouldShowScrollInfo(): boolean {
      if (this.tagName === 'iframe') return true
      if (!(this.isScrollable || this.isActuallyScrollable)) return false
      if (this.tagName === 'body' || this.tagName === 'html') return true
      if (
        this.parentNode &&
        (this.parentNode.isScrollable || this.parentNode.isActuallyScrollable)
      ) {
        return false
      }
      return true
    },
    getScrollInfoText(): string {
      if (this.tagName === 'iframe') {
        if (this.contentDocument) {
          const htmlElement = findHtmlInContentDocument(this as EnhancedDOMTreeNode)
          const info = htmlElement ? computeScrollInfo(htmlElement) : null
          if (info) {
            const pagesBelow = info.pages_below || 0
            const pagesAbove = info.pages_above || 0
            const vPct = Math.trunc(info.vertical_scroll_percentage || 0)
            if (pagesBelow > 0 || pagesAbove > 0) {
              return `scroll: ${pagesAbove.toFixed(1)}↑ ${pagesBelow.toFixed(1)}↓ ${vPct}%`
            }
          }
        }
        return 'scroll'
      }
      const scrollInfo = computeScrollInfo(this as EnhancedDOMTreeNode)
      if (!scrollInfo) return ''
      const parts: string[] = []
      if (scrollInfo.scrollable_height > scrollInfo.visible_height) {
        parts.push(
          `${scrollInfo.pages_above.toFixed(1)} pages above, ${scrollInfo.pages_below.toFixed(1)} pages below`,
        )
      }
      if (scrollInfo.scrollable_width > scrollInfo.visible_width) {
        parts.push(`horizontal ${scrollInfo.horizontal_scroll_percentage.toFixed(0)}%`)
      }
      return parts.join(' ')
    },
  }
  return node as unknown as EnhancedDOMTreeNode
}

export class DomService {
  private readonly cdp: CDPSession
  readonly paintOrderFiltering: boolean
  readonly crossOriginIframes: boolean
  readonly maxIframes: number
  readonly maxIframeDepth: number
  readonly viewportThreshold: number | null

  constructor(cdp: CDPSession, options?: DomServiceOptions) {
    this.cdp = cdp
    this.paintOrderFiltering = options?.paintOrderFiltering ?? true
    this.crossOriginIframes = options?.crossOriginIframes ?? false
    this.maxIframes = options?.maxIframes ?? 100
    this.maxIframeDepth = options?.maxIframeDepth ?? 5
    this.viewportThreshold = options?.viewportThreshold === undefined ? 1000 : options.viewportThreshold
  }

  /**
   * Collect hidden interactive elements in iframes for LLM hints.
   */
  private countHiddenElementsInIframes(node: EnhancedDOMTreeNode): void {
    const isHiddenByThreshold = (element: EnhancedDOMTreeNode): boolean => {
      if (element.isVisible || !element.snapshotNode || !element.snapshotNode.bounds) {
        return false
      }

      const computedStyles = element.snapshotNode.computedStyles || {}
      const display = (computedStyles.display || '').toLowerCase()
      const visibility = (computedStyles.visibility || '').toLowerCase()
      const opacity = computedStyles.opacity ?? '1'

      let cssHidden = display === 'none' || visibility === 'hidden'
      try {
        cssHidden = cssHidden || parseFloat(opacity) <= 0
      } catch {
        // ignore
      }

      return !cssHidden
    }

    const collectHiddenElements = (
      subtreeRoot: EnhancedDOMTreeNode,
      viewportHeight: number,
    ): HiddenElementInfo[] => {
      const hidden: HiddenElementInfo[] = []

      if (subtreeRoot.nodeType === NodeType.ELEMENT_NODE) {
        if (isInteractive(subtreeRoot) && isHiddenByThreshold(subtreeRoot)) {
          let text = ''
          if (subtreeRoot.axNode?.name) {
            text = subtreeRoot.axNode.name.slice(0, 40)
          } else if (subtreeRoot.attributes) {
            text = (
              subtreeRoot.attributes.placeholder ||
              subtreeRoot.attributes.title ||
              subtreeRoot.attributes['aria-label'] ||
              ''
            ).slice(0, 40)
          }

          let yPos = 0
          if (subtreeRoot.snapshotNode?.bounds) {
            yPos = subtreeRoot.snapshotNode.bounds.y
          }
          const pagesDown = viewportHeight > 0 ? Math.round((yPos / viewportHeight) * 10) / 10 : 0

          hidden.push({
            tag: subtreeRoot.tagName || '?',
            text: text || '(no label)',
            pages: pagesDown,
          })
        }
      }

      for (const child of subtreeRoot.childrenNodes || []) {
        hidden.push(...collectHiddenElements(child, viewportHeight))
      }
      for (const shadowRoot of subtreeRoot.shadowRoots || []) {
        hidden.push(...collectHiddenElements(shadowRoot, viewportHeight))
      }

      return hidden
    }

    const hasAnyHiddenContent = (subtreeRoot: EnhancedDOMTreeNode): boolean => {
      if (isHiddenByThreshold(subtreeRoot)) return true
      for (const child of subtreeRoot.childrenNodes || []) {
        if (hasAnyHiddenContent(child)) return true
      }
      for (const shadowRoot of subtreeRoot.shadowRoots || []) {
        if (hasAnyHiddenContent(shadowRoot)) return true
      }
      return false
    }

    const processNode = (currentNode: EnhancedDOMTreeNode): void => {
      if (
        currentNode.nodeType === NodeType.ELEMENT_NODE &&
        currentNode.tagName &&
        (currentNode.tagName.toUpperCase() === 'IFRAME' || currentNode.tagName.toUpperCase() === 'FRAME') &&
        currentNode.contentDocument
      ) {
        let viewportHeight = 0
        if (currentNode.snapshotNode?.clientRects) {
          viewportHeight = currentNode.snapshotNode.clientRects.height
        }

        const hidden = collectHiddenElements(currentNode.contentDocument, viewportHeight)
        hidden.sort((a, b) => a.pages - b.pages)
        currentNode.hiddenElementsInfo = hidden.slice(0, 10)

        if (!hidden.length && hasAnyHiddenContent(currentNode.contentDocument)) {
          currentNode.hasHiddenContent = true
        }
      }

      for (const child of currentNode.childrenNodes || []) {
        processNode(child)
      }
      if (currentNode.contentDocument) {
        processNode(currentNode.contentDocument)
      }
      for (const shadowRoot of currentNode.shadowRoots || []) {
        processNode(shadowRoot)
      }
    }

    processNode(node)
  }

  private buildEnhancedAxNode(axNode: CdpAxNode): EnhancedAXNode {
    let properties: EnhancedAXProperty[] | null = null
    if (axNode.properties?.length) {
      properties = []
      for (const property of axNode.properties) {
        try {
          properties.push({
            name: property.name as EnhancedAXProperty['name'],
            value: property.value?.value ?? null,
          })
        } catch {
          // Chrome sometimes returns unknown property names
        }
      }
    }

    return {
      axNodeId: axNode.nodeId,
      ignored: axNode.ignored,
      role: axNode.role?.value ?? null,
      name: axNode.name?.value ?? null,
      description: axNode.description?.value ?? null,
      properties,
      childIds: axNode.childIds?.length ? axNode.childIds : null,
    }
  }

  private async getViewportRatio(): Promise<number> {
    try {
      const metrics = (await this.cdp.send('Page.getLayoutMetrics')) as {
        visualViewport?: { clientWidth?: number }
        cssVisualViewport?: { clientWidth?: number }
        cssLayoutViewport?: { clientWidth?: number }
      }

      const visualViewport = metrics.visualViewport || {}
      const cssVisualViewport = metrics.cssVisualViewport || {}
      const cssLayoutViewport = metrics.cssLayoutViewport || {}

      const width = cssVisualViewport.clientWidth ?? cssLayoutViewport.clientWidth ?? 1920
      const deviceWidth = visualViewport.clientWidth ?? width
      const cssWidth = cssVisualViewport.clientWidth ?? width
      const devicePixelRatio = cssWidth > 0 ? deviceWidth / cssWidth : 1.0

      return devicePixelRatio
    } catch {
      return 1.0
    }
  }

  /**
   * Check if the element is visible according to all its parent HTML frames.
   */
  static isElementVisibleAccordingToAllParents(
    node: EnhancedDOMTreeNode,
    htmlFrames: EnhancedDOMTreeNode[],
    viewportThreshold: number | null = 1000,
  ): boolean {
    if (!node.snapshotNode) return false

    const computedStyles = node.snapshotNode.computedStyles || {}
    const display = (computedStyles.display || '').toLowerCase()
    const visibility = (computedStyles.visibility || '').toLowerCase()
    const opacity = computedStyles.opacity ?? '1'

    if (display === 'none' || visibility === 'hidden') return false

    try {
      if (parseFloat(opacity) <= 0) return false
    } catch {
      // ignore
    }

    if (!node.snapshotNode.bounds) return false

    // Work on a copy: snapshot bounds are shared
    const currentBounds = copyDOMRect(node.snapshotNode.bounds)

    if (viewportThreshold === null) return true

    for (let i = htmlFrames.length - 1; i >= 0; i--) {
      const frame = htmlFrames[i]
      // skip self: a frame node appears in its own frame chain
      if (frame === node) continue

      if (
        frame.nodeType === NodeType.ELEMENT_NODE &&
        (frame.nodeName.toUpperCase() === 'IFRAME' || frame.nodeName.toUpperCase() === 'FRAME') &&
        frame.snapshotNode?.bounds
      ) {
        const iframeBounds = frame.snapshotNode.bounds
        currentBounds.x += iframeBounds.x
        currentBounds.y += iframeBounds.y
      }

      if (
        frame.nodeType === NodeType.ELEMENT_NODE &&
        frame.nodeName === 'HTML' &&
        frame.snapshotNode?.scrollRects &&
        frame.snapshotNode?.clientRects
      ) {
        const viewportLeft = 0
        const viewportTop = 0
        const viewportRight = frame.snapshotNode.clientRects.width
        const viewportBottom = frame.snapshotNode.clientRects.height

        const adjustedX = currentBounds.x - frame.snapshotNode.scrollRects.x
        const adjustedY = currentBounds.y - frame.snapshotNode.scrollRects.y

        const frameIntersects =
          adjustedX < viewportRight &&
          adjustedX + currentBounds.width > viewportLeft &&
          adjustedY < viewportBottom + viewportThreshold &&
          adjustedY + currentBounds.height > viewportTop - viewportThreshold

        if (!frameIntersects) return false

        currentBounds.x -= frame.snapshotNode.scrollRects.x
        currentBounds.y -= frame.snapshotNode.scrollRects.y
      }
    }

    return true
  }

  private async getAxTreeForAllFrames(): Promise<{ nodes: CdpAxNode[] }> {
    const frameTreeResult = (await this.cdp.send('Page.getFrameTree')) as {
      frameTree: FrameTreeNode
    }

    const collectAllFrameIds = (frameTreeNode: FrameTreeNode): string[] => {
      const frameIds = [frameTreeNode.frame.id]
      if (frameTreeNode.childFrames?.length) {
        for (const child of frameTreeNode.childFrames) {
          frameIds.push(...collectAllFrameIds(child))
        }
      }
      return frameIds
    }

    const allFrameIds = collectAllFrameIds(frameTreeResult.frameTree)

    const axTreeResults = await Promise.all(
      allFrameIds.map(async (frameId) => {
        try {
          return (await this.cdp.send('Accessibility.getFullAXTree', { frameId })) as {
            nodes: CdpAxNode[]
          }
        } catch (err) {
          return err as Error
        }
      }),
    )

    const rootResult = axTreeResults[0]
    if (rootResult instanceof Error) {
      throw rootResult
    }

    const mergedNodes: CdpAxNode[] = [...rootResult.nodes]
    for (let i = 1; i < axTreeResults.length; i++) {
      const axTree = axTreeResults[i]
      if (axTree instanceof Error) {
        continue
      }
      mergedNodes.push(...axTree.nodes)
    }

    return { nodes: mergedNodes }
  }

  private async detectJsClickListeners(): Promise<{
    backendIds: Set<number>
    timingMs: number
  }> {
    const start = nowMs()
    const jsClickListenerBackendIds = new Set<number>()

    try {
      const expression = `
					(() => {
						if (typeof getEventListeners !== 'function') {
							return null;
						}

						const allElements = document.querySelectorAll('*');

						if (allElements.length > 10000) {
							return null;
						}

						const elementsWithListeners = [];

						for (const el of allElements) {
							try {
								const listeners = getEventListeners(el);
								if (listeners.click || listeners.mousedown || listeners.mouseup || listeners.pointerdown || listeners.pointerup) {
									elementsWithListeners.push(el);
									if (elementsWithListeners.length > ${MAX_JS_CLICK_LISTENER_ELEMENTS}) {
										return ${JSON.stringify(JS_CLICK_LISTENER_OVERFLOW)};
									}
								}
							} catch (e) {
								// Ignore errors for individual elements
							}
						}

						return elementsWithListeners;
					})()
					`

      const jsListenerResult = (await this.cdp.send('Runtime.evaluate', {
        expression,
        includeCommandLineAPI: true,
        returnByValue: false,
      })) as {
        result?: { value?: unknown; objectId?: string }
      }

      if (jsListenerResult.result?.value === JS_CLICK_LISTENER_OVERFLOW) {
        return { backendIds: jsClickListenerBackendIds, timingMs: nowMs() - start }
      }

      const resultObjectId = jsListenerResult.result?.objectId
      if (resultObjectId) {
        const arrayProps = (await this.cdp.send('Runtime.getProperties', {
          objectId: resultObjectId,
          ownProperties: true,
        })) as {
          result?: Array<{ name?: string; value?: { objectId?: string } }>
        }

        const elementObjectIds: string[] = []
        for (const prop of arrayProps.result || []) {
          const propName = prop.name || ''
          if (/^\d+$/.test(propName)) {
            const objectId = prop.value?.objectId
            if (objectId) elementObjectIds.push(objectId)
          }
        }

        const getBackendNodeId = async (objectId: string): Promise<number | null> => {
          try {
            const nodeInfo = (await this.cdp.send('DOM.describeNode', { objectId })) as {
              node?: { backendNodeId?: number }
            }
            return nodeInfo.node?.backendNodeId ?? null
          } catch {
            return null
          }
        }

        for (let batchStart = 0; batchStart < elementObjectIds.length; batchStart += DESCRIBE_NODE_BATCH_SIZE) {
          const batch = elementObjectIds.slice(batchStart, batchStart + DESCRIBE_NODE_BATCH_SIZE)
          const backendIds = await Promise.all(batch.map((id) => getBackendNodeId(id)))
          for (const bid of backendIds) {
            if (bid != null) jsClickListenerBackendIds.add(bid)
          }
        }

        try {
          await this.cdp.send('Runtime.releaseObject', { objectId: resultObjectId })
        } catch {
          // best-effort cleanup
        }
      }
    } catch {
      // listener detection is optional
    }

    return { backendIds: jsClickListenerBackendIds, timingMs: nowMs() - start }
  }

  private async getAllTrees(): Promise<TargetAllTrees> {
    try {
      await this.cdp.send('Runtime.evaluate', { expression: 'document.readyState' })
    } catch {
      // page might not be ready yet
    }

    const startIframeScroll = nowMs()
    try {
      await this.cdp.send('Runtime.evaluate', {
        expression: `
					(() => {
						const scrollData = {};
						const iframes = document.querySelectorAll('iframe');
						iframes.forEach((iframe, index) => {
							try {
								const doc = iframe.contentDocument || iframe.contentWindow.document;
								if (doc) {
									scrollData[index] = {
										scrollTop: doc.documentElement.scrollTop || doc.body.scrollTop || 0,
										scrollLeft: doc.documentElement.scrollLeft || doc.body.scrollLeft || 0
									};
								}
							} catch (e) {
								// Cross-origin iframe, can't access
							}
						});
						return scrollData;
					})()
					`,
        returnByValue: true,
      })
    } catch {
      // optional
    }
    const iframeScrollMs = nowMs() - startIframeScroll

    const { backendIds: jsClickListenerBackendIds, timingMs: jsListenerDetectionMs } =
      await this.detectJsClickListeners()

    const createSnapshotRequest = () =>
      this.cdp.send('DOMSnapshot.captureSnapshot', {
        computedStyles: REQUIRED_COMPUTED_STYLES,
        includePaintOrder: true,
        includeDOMRects: true,
        includeBlendedBackgroundColors: false,
        includeTextColorOpacities: false,
      })

    const createDomTreeRequest = () =>
      this.cdp.send('DOM.getDocument', {
        depth: -1,
        pierce: true,
      })

    const startCdpCalls = nowMs()

    type TreeKey = 'snapshot' | 'domTree' | 'axTree' | 'devicePixelRatio'
    const factories: Record<TreeKey, () => Promise<unknown>> = {
      snapshot: createSnapshotRequest,
      domTree: createDomTreeRequest,
      axTree: () => this.getAxTreeForAllFrames(),
      devicePixelRatio: () => this.getViewportRatio(),
    }

    const runKeys = async (
      keys: TreeKey[],
      timeoutMs: number,
    ): Promise<Partial<Record<TreeKey, unknown>>> => {
      const settled = await Promise.all(
        keys.map(async (key) => {
          try {
            const value = await withTimeout(factories[key](), timeoutMs, key)
            return [key, { ok: true as const, value }] as const
          } catch {
            return [key, { ok: false as const }] as const
          }
        }),
      )

      const out: Partial<Record<TreeKey, unknown>> = {}
      for (const [key, outcome] of settled) {
        if (outcome.ok) out[key] = outcome.value
      }
      return out
    }

    const allKeys: TreeKey[] = ['snapshot', 'domTree', 'axTree', 'devicePixelRatio']
    let results = await runKeys(allKeys, CDP_PARALLEL_TIMEOUT_MS)

    const missing = allKeys.filter((k) => results[k] === undefined)
    if (missing.length) {
      results = { ...results, ...(await runKeys(missing, CDP_RETRY_TIMEOUT_MS)) }
    }

    // AX tree is optional enrichment — fall back to empty
    if (results.axTree === undefined) {
      results.axTree = { nodes: [] }
    }

    const failed = (['snapshot', 'domTree', 'devicePixelRatio'] as TreeKey[]).filter(
      (k) => results[k] === undefined,
    )
    if (failed.length) {
      throw new Error(`CDP requests failed or timed out: ${failed.join(', ')}`)
    }

    const snapshot = results.snapshot as TargetAllTrees['snapshot'] & {
      documents?: unknown[]
    }
    const domTree = results.domTree as TargetAllTrees['domTree']
    const axTree = results.axTree as { nodes: CdpAxNode[] }
    const devicePixelRatio = results.devicePixelRatio as number

    const cdpCallsMs = nowMs() - startCdpCalls

    const startSnapshotProcessing = nowMs()
    if (snapshot?.documents && Array.isArray(snapshot.documents)) {
      if (snapshot.documents.length > this.maxIframes) {
        snapshot.documents = snapshot.documents.slice(0, this.maxIframes)
      }
    }
    const snapshotProcessingMs = nowMs() - startSnapshotProcessing

    return {
      snapshot,
      domTree,
      axTree,
      devicePixelRatio,
      cdpTiming: {
        iframe_scroll_detection_ms: iframeScrollMs,
        js_listener_detection_ms: jsListenerDetectionMs,
        cdp_parallel_calls_ms: cdpCallsMs,
        snapshot_processing_ms: snapshotProcessingMs,
      },
      jsClickListenerBackendIds: jsClickListenerBackendIds.size ? jsClickListenerBackendIds : null,
    } as TargetAllTrees
  }

  async getDomTree(options?: {
    initialHtmlFrames?: EnhancedDOMTreeNode[] | null
    initialTotalFrameOffset?: DOMRect | null
    iframeDepth?: number
  }): Promise<{ root: EnhancedDOMTreeNode; timing: Record<string, number> }> {
    const iframeDepth = options?.iframeDepth ?? 0
    const initialHtmlFrames = options?.initialHtmlFrames ?? null
    const initialTotalFrameOffset = options?.initialTotalFrameOffset ?? null

    const timingInfo: Record<string, number> = {}
    const timingStartTotal = nowMs()

    const startGetTrees = nowMs()
    const trees = await this.getAllTrees()
    timingInfo.get_all_trees_total_ms = nowMs() - startGetTrees
    Object.assign(timingInfo, trees.cdpTiming)

    const domTree = trees.domTree as { root: CdpDomNode }
    const axTree = trees.axTree as { nodes: CdpAxNode[] }
    const snapshot = trees.snapshot
    const devicePixelRatio = trees.devicePixelRatio
    const jsClickListenerBackendIds: Set<number> = trees.jsClickListenerBackendIds ?? new Set()

    const startAx = nowMs()
    const axTreeLookup = new Map<number, CdpAxNode>()
    for (const axNode of axTree.nodes || []) {
      if (axNode.backendDOMNodeId != null) {
        axTreeLookup.set(axNode.backendDOMNodeId, axNode)
      }
    }
    timingInfo.build_ax_lookup_ms = nowMs() - startAx

    const enhancedDomTreeNodeLookup = new Map<number, EnhancedDOMTreeNode>()

    const startSnapshot = nowMs()
    const snapshotLookup = buildSnapshotLookup(snapshot, devicePixelRatio)
    timingInfo.build_snapshot_lookup_ms = nowMs() - startSnapshot

    const lookupSnapshot = (backendNodeId: number) => {
      if (snapshotLookup instanceof Map) {
        return snapshotLookup.get(backendNodeId) ?? null
      }
      return (snapshotLookup as Record<number, EnhancedDOMTreeNode['snapshotNode']>)[backendNodeId] ?? null
    }

    const constructEnhancedNode = async (
      node: CdpDomNode,
      htmlFrames: EnhancedDOMTreeNode[] | null,
      totalFrameOffset: DOMRect | null,
    ): Promise<EnhancedDOMTreeNode> => {
      let frames = htmlFrames
      if (frames === null) frames = []

      let offset: DOMRect
      if (totalFrameOffset === null) {
        offset = createDOMRect(0, 0, 0, 0)
      } else {
        offset = copyDOMRect(totalFrameOffset)
      }

      const existing = enhancedDomTreeNodeLookup.get(node.nodeId)
      if (existing) return existing

      const axNode = axTreeLookup.get(node.backendNodeId)
      const enhancedAxNode = axNode ? this.buildEnhancedAxNode(axNode) : null

      let attributes: Record<string, string> | undefined
      if (node.attributes?.length) {
        attributes = {}
        for (let i = 0; i < node.attributes.length; i += 2) {
          attributes[node.attributes[i]] = node.attributes[i + 1]
        }
      }

      const shadowRootType = node.shadowRootType || null
      const snapshotData = lookupSnapshot(node.backendNodeId)

      let absolutePosition: DOMRect | null = null
      if (snapshotData?.bounds) {
        absolutePosition = createDOMRect(
          snapshotData.bounds.x + offset.x,
          snapshotData.bounds.y + offset.y,
          snapshotData.bounds.width,
          snapshotData.bounds.height,
        )
      }

      const domTreeNode = createEnhancedNode({
        nodeId: node.nodeId,
        backendNodeId: node.backendNodeId,
        nodeType: node.nodeType as NodeType,
        nodeName: node.nodeName,
        nodeValue: node.nodeValue,
        attributes: attributes || {},
        isScrollable: node.isScrollable ?? null,
        frameId: node.frameId ?? null,
        sessionId: null,
        targetId: '',
        contentDocument: null,
        shadowRootType,
        shadowRoots: null,
        parentNode: null,
        childrenNodes: null,
        axNode: enhancedAxNode,
        snapshotNode: snapshotData,
        isVisible: null,
        hasJsClickListener: jsClickListenerBackendIds.has(node.backendNodeId),
        absolutePosition,
      })

      enhancedDomTreeNodeLookup.set(node.nodeId, domTreeNode)

      if (node.parentId != null) {
        const parent = enhancedDomTreeNodeLookup.get(node.parentId)
        if (parent) domTreeNode.parentNode = parent
      }

      const updatedHtmlFrames = [...frames]
      if (node.nodeType === NodeType.ELEMENT_NODE && node.nodeName === 'HTML' && node.frameId != null) {
        updatedHtmlFrames.push(domTreeNode)

        if (snapshotData?.scrollRects) {
          offset.x -= snapshotData.scrollRects.x
          offset.y -= snapshotData.scrollRects.y
        }
      }

      const tagUpper = node.nodeName.toUpperCase()
      if ((tagUpper === 'IFRAME' || tagUpper === 'FRAME') && snapshotData?.bounds) {
        updatedHtmlFrames.push(domTreeNode)
        offset.x += snapshotData.bounds.x
        offset.y += snapshotData.bounds.y
      }

      if (node.contentDocument) {
        domTreeNode.contentDocument = await constructEnhancedNode(
          node.contentDocument,
          updatedHtmlFrames,
          offset,
        )
        domTreeNode.contentDocument.parentNode = domTreeNode
      }

      if (node.shadowRoots?.length) {
        domTreeNode.shadowRoots = []
        for (const shadowRoot of node.shadowRoots) {
          const shadowRootNode = await constructEnhancedNode(shadowRoot, updatedHtmlFrames, offset)
          shadowRootNode.parentNode = domTreeNode
          domTreeNode.shadowRoots.push(shadowRootNode)
        }
      }

      if (node.children?.length) {
        domTreeNode.childrenNodes = []
        const shadowRootNodeIds = new Set<number>()
        if (node.shadowRoots?.length) {
          for (const shadowRoot of node.shadowRoots) {
            shadowRootNodeIds.add(shadowRoot.nodeId)
          }
        }

        for (const child of node.children) {
          if (shadowRootNodeIds.has(child.nodeId)) continue
          domTreeNode.childrenNodes.push(
            await constructEnhancedNode(child, updatedHtmlFrames, offset),
          )
        }
      }

      domTreeNode.isVisible = DomService.isElementVisibleAccordingToAllParents(
        domTreeNode,
        updatedHtmlFrames,
        this.viewportThreshold,
      )

      // Cross-origin iframes require a separate CDP target/session.
      // This port only has the focused page CDPSession, so we skip recursive target fetch.
      if (
        this.crossOriginIframes &&
        tagUpper === 'IFRAME' &&
        node.contentDocument == null &&
        iframeDepth < this.maxIframeDepth
      ) {
        if (domTreeNode.isVisible && domTreeNode.snapshotNode?.bounds) {
          const { width, height } = domTreeNode.snapshotNode.bounds
          if (isCrossOriginIframeSizeEligible(width, height)) {
            // Intentionally no-op: would need BrowserSession / multi-target CDP.
          }
        }
      }

      return domTreeNode
    }

    const startConstruct = nowMs()
    const enhancedDomTreeNode = await constructEnhancedNode(
      domTree.root,
      initialHtmlFrames,
      initialTotalFrameOffset,
    )
    timingInfo.construct_enhanced_tree_ms = nowMs() - startConstruct

    this.countHiddenElementsInIframes(enhancedDomTreeNode)

    const totalGetDomTreeMs = nowMs() - timingStartTotal
    timingInfo.get_dom_tree_total_ms = totalGetDomTreeMs

    const trackedSubOperationsMs =
      (timingInfo.get_all_trees_total_ms || 0) +
      (timingInfo.build_ax_lookup_ms || 0) +
      (timingInfo.build_snapshot_lookup_ms || 0) +
      (timingInfo.construct_enhanced_tree_ms || 0)
    const overhead = totalGetDomTreeMs - trackedSubOperationsMs
    if (overhead > 0.1) {
      timingInfo.get_dom_tree_overhead_ms = overhead
    }

    return { root: enhancedDomTreeNode, timing: timingInfo }
  }

  async getSerializedDomTree(): Promise<{
    serialized: SerializedDOMState
    root: EnhancedDOMTreeNode
    timing: Record<string, number>
  }> {
    const timingInfo: Record<string, number> = {}
    const startTotal = nowMs()

    const { root: enhancedDomTree, timing: domTreeTiming } = await this.getDomTree()
    Object.assign(timingInfo, domTreeTiming)

    const startSerialize = nowMs()
    const [serialized, serializerTiming] = new DOMTreeSerializer(
      enhancedDomTree,
      null,
      true,
      null,
      this.paintOrderFiltering,
      null,
    ).serializeAccessibleElements()

    const totalSerializationMs = nowMs() - startSerialize

    // Serializer timings are in seconds (Python-compatible); convert to ms
    for (const [key, value] of Object.entries(serializerTiming)) {
      timingInfo[`${key}_ms`] = value * 1000
    }

    const trackedSerializationMs = Object.values(serializerTiming).reduce((sum, value) => sum + value * 1000, 0)
    const serializationOverheadMs = totalSerializationMs - trackedSerializationMs
    if (serializationOverheadMs > 0.1) {
      timingInfo.serialization_overhead_ms = serializationOverheadMs
    }

    const totalGetSerializedMs = nowMs() - startTotal
    timingInfo.get_serialized_dom_tree_total_ms = totalGetSerializedMs

    const trackedMajor = (timingInfo.get_dom_tree_total_ms || 0) + totalSerializationMs
    const getSerializedOverhead = totalGetSerializedMs - trackedMajor
    if (getSerializedOverhead > 0.1) {
      timingInfo.get_serialized_dom_tree_overhead_ms = getSerializedOverhead
    }

    return {
      serialized,
      root: enhancedDomTree,
      timing: timingInfo,
    }
  }
}
