/**
 * Page overlays adapted from browser-use BrowserSession.add_highlights /
 * highlight_interaction_element / remove_highlights.
 * Uses data-ai-ref (our refs) instead of numeric indexes.
 */
import type { Page } from 'puppeteer-core'
import { AI_REF_ATTR } from './a11ySnapshot'

const HIGHLIGHT_ATTR = 'data-browser-use-highlight'
const INTERACTION_ATTR = 'data-browser-use-interaction-highlight'
const CONTAINER_ID = 'browser-use-debug-highlights'
/** DOM 采集观察层（扫描线 / 视口框） */
const OBSERVE_ATTR = 'data-browser-use-dom-observe'
const OBSERVE_ID = 'browser-use-dom-observe'
/** 观察层最短展示（含采集+区域高亮），避免一闪而过 */
const OBSERVE_MIN_MS = 2600
/** 区域描边高亮停留 */
const OBSERVE_PULSE_HOLD_MS = 1400
/** 区域亮起后再多留一会儿再撤层 */
const OBSERVE_HOLD_AFTER_PULSE_MS = 700

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

export async function removeHighlights(page: Page): Promise<void> {
  await page.evaluate(
    (params: {
      highlightAttr: string
      containerId: string
      interactionAttr: string
      observeAttr: string
      observeId: string
    }) => {
      const { highlightAttr, containerId, interactionAttr, observeAttr, observeId } = params
      document.querySelectorAll(`[${highlightAttr}]`).forEach((el) => el.remove())
      document.getElementById(containerId)?.remove()
      document.querySelectorAll(`[${interactionAttr}]`).forEach((el) => el.remove())
      document.getElementById(observeId)?.remove()
      document.querySelectorAll(`[${observeAttr}]`).forEach((el) => el.remove())
    },
    {
      highlightAttr: HIGHLIGHT_ATTR,
      containerId: CONTAINER_ID,
      interactionAttr: INTERACTION_ATTR,
      observeAttr: OBSERVE_ATTR,
      observeId: OBSERVE_ID
    }
  )
}

/** 在视口展示「正在采集 DOM」观察特效（扫描带 + 四角标） */
export async function showDomObserveEffect(page: Page): Promise<void> {
  await page.evaluate(
    (params: { observeAttr: string; observeId: string }) => {
      const { observeAttr, observeId } = params
      document.getElementById(observeId)?.remove()
      document.querySelectorAll(`[${observeAttr}]`).forEach((el) => el.remove())

      const root = document.createElement('div')
      root.id = observeId
      root.setAttribute(observeAttr, 'root')
      root.style.cssText = `
        position: fixed; inset: 0; pointer-events: none;
        z-index: 2147483646; overflow: hidden;
        font-family: ui-sans-serif, system-ui, sans-serif;
      `

      const dim = document.createElement('div')
      dim.setAttribute(observeAttr, 'dim')
      dim.style.cssText = `
        position: absolute; inset: 0;
        background: radial-gradient(ellipse at center,
          rgba(14, 116, 144, 0.04) 0%,
          rgba(15, 23, 42, 0.18) 70%,
          rgba(15, 23, 42, 0.32) 100%);
      `
      root.appendChild(dim)

      const frame = document.createElement('div')
      frame.setAttribute(observeAttr, 'frame')
      frame.style.cssText = `
        position: absolute; inset: 10px;
        border: 1.5px solid rgba(34, 211, 238, 0.55);
        box-shadow: inset 0 0 0 1px rgba(34, 211, 238, 0.15);
        border-radius: 2px;
      `
      root.appendChild(frame)

      const cornerSize = 22
      const cornerColor = '#22d3ee'
      const corners = [
        { top: '10px', left: '10px', bt: true, bl: true },
        { top: '10px', right: '10px', bt: true, br: true },
        { bottom: '10px', left: '10px', bb: true, bl: true },
        { bottom: '10px', right: '10px', bb: true, br: true }
      ] as Array<Record<string, any>>
      for (const c of corners) {
        const el = document.createElement('div')
        el.setAttribute(observeAttr, 'corner')
        el.style.cssText = `
          position: absolute; width: ${cornerSize}px; height: ${cornerSize}px;
          ${c.top != null ? `top:${c.top};` : ''}
          ${c.bottom != null ? `bottom:${c.bottom};` : ''}
          ${c.left != null ? `left:${c.left};` : ''}
          ${c.right != null ? `right:${c.right};` : ''}
          ${c.bt ? `border-top:3px solid ${cornerColor};` : ''}
          ${c.bb ? `border-bottom:3px solid ${cornerColor};` : ''}
          ${c.bl ? `border-left:3px solid ${cornerColor};` : ''}
          ${c.br ? `border-right:3px solid ${cornerColor};` : ''}
        `
        root.appendChild(el)
      }

      const band = document.createElement('div')
      band.setAttribute(observeAttr, 'scan')
      band.style.cssText = `
        position: absolute; left: 0; width: 100%; height: 72px;
        top: -72px;
        background: linear-gradient(180deg,
          rgba(34, 211, 238, 0) 0%,
          rgba(34, 211, 238, 0.14) 40%,
          rgba(34, 211, 238, 0.38) 50%,
          rgba(34, 211, 238, 0.14) 60%,
          rgba(34, 211, 238, 0) 100%);
        box-shadow: 0 0 24px rgba(34, 211, 238, 0.25);
      `
      root.appendChild(band)

      const badge = document.createElement('div')
      badge.setAttribute(observeAttr, 'badge')
      badge.textContent = 'DOM 观察中 · 正在采集页面结构'
      badge.style.cssText = `
        position: absolute; top: 18px; left: 50%; transform: translateX(-50%);
        padding: 6px 14px; border-radius: 999px;
        background: rgba(15, 23, 42, 0.82); color: #a5f3fc;
        font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
        border: 1px solid rgba(34, 211, 238, 0.45);
        box-shadow: 0 4px 16px rgba(0,0,0,0.25);
        white-space: nowrap;
      `
      root.appendChild(badge)

      document.documentElement.appendChild(root)

      let raf = 0
      let start = performance.now()
      const cycleMs = 1800
      const tick = (now: number) => {
        if (!document.getElementById(observeId)) return
        const t = ((now - start) % cycleMs) / cycleMs
        const y = -72 + t * (window.innerHeight + 72)
        band.style.top = `${y}px`
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
      ;(root as any).__buObserveRaf = raf
    },
    { observeAttr: OBSERVE_ATTR, observeId: OBSERVE_ID }
  )
}

export async function hideDomObserveEffect(page: Page): Promise<void> {
  await page.evaluate(
    (params: { observeAttr: string; observeId: string }) => {
      const root = document.getElementById(params.observeId) as any
      if (root?.__buObserveRaf) {
        try {
          cancelAnimationFrame(root.__buObserveRaf)
        } catch (_) {}
      }
      root?.remove()
      document.querySelectorAll(`[${params.observeAttr}]`).forEach((el) => el.remove())
    },
    { observeAttr: OBSERVE_ATTR, observeId: OBSERVE_ID }
  )
}

/**
 * 采集 DOM 期间展示观察特效；结束后至少展示一小段时间，避免一闪而过。
 * 采集完成后短暂标出视口内已打标的 [data-ai-ref] 区域。
 */
export async function withDomObserveEffect<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now()
  await showDomObserveEffect(page).catch(() => undefined)
  try {
    const result = await fn()
    await pulseObservedRegions(page).catch(() => undefined)
    await sleep(OBSERVE_HOLD_AFTER_PULSE_MS)
    return result
  } finally {
    const left = OBSERVE_MIN_MS - (Date.now() - t0)
    if (left > 0) await sleep(left)
    await hideDomObserveEffect(page).catch(() => undefined)
  }
}

/** 采集结束后：在视口内已标记节点上扫过一圈描边，示意观察区域 */
async function pulseObservedRegions(page: Page): Promise<void> {
  const count = await page.evaluate(
    (params: { refAttr: string; observeAttr: string; observeId: string }) => {
      const { refAttr, observeAttr, observeId } = params
      const root = document.getElementById(observeId)
      if (!root) return 0

      const nodes = Array.from(document.querySelectorAll(`[${refAttr}^="e"]`)) as HTMLElement[]
      const vh = window.innerHeight
      const vw = window.innerWidth
      const boxes: HTMLElement[] = []
      for (const el of nodes) {
        const r = el.getBoundingClientRect()
        if (r.width < 4 || r.height < 4) continue
        if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue
        const box = document.createElement('div')
        box.setAttribute(observeAttr, 'region')
        box.style.cssText = `
          position: fixed;
          left: ${Math.max(0, r.left)}px;
          top: ${Math.max(0, r.top)}px;
          width: ${Math.min(r.width, vw - Math.max(0, r.left))}px;
          height: ${Math.min(r.height, vh - Math.max(0, r.top))}px;
          outline: 2px solid rgba(34, 211, 238, 0.85);
          outline-offset: 1px;
          background: rgba(34, 211, 238, 0.08);
          pointer-events: none;
          opacity: 0;
          transition: opacity 120ms ease;
          z-index: 2147483647;
        `
        root.appendChild(box)
        boxes.push(box)
      }

      if (!boxes.length) return 0

      boxes
        .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))
        .forEach((box, i) => {
          setTimeout(() => {
            box.style.opacity = '1'
          }, Math.min(i * 12, 280))
        })

      const badge = root.querySelector(`[${observeAttr}="badge"]`) as HTMLElement | null
      if (badge) badge.textContent = `已观察 ${boxes.length} 个可交互区域`
      return boxes.length
    },
    { refAttr: AI_REF_ATTR, observeAttr: OBSERVE_ATTR, observeId: OBSERVE_ID }
  )
  if (count > 0) await sleep(OBSERVE_PULSE_HOLD_MS)
}

/** Draw dashed boxes + labels for all [data-ai-ref=eN] elements. */
export async function addRefHighlights(page: Page): Promise<{ added: number }> {
  await removeHighlights(page)
  const added = await page.evaluate(
    (params: { refAttr: string; highlightAttr: string; containerId: string }) => {
      const { refAttr, highlightAttr, containerId } = params
      const nodes = Array.from(document.querySelectorAll(`[${refAttr}^="e"]`)) as HTMLElement[]
      if (!nodes.length) return 0

      const HIGHLIGHT_Z_INDEX = 2147483647
      const container = document.createElement('div')
      container.id = containerId
      container.setAttribute(highlightAttr, 'container')
      container.style.cssText = `
        position: absolute; top: 0; left: 0; width: 100vw; height: 100vh;
        pointer-events: none; z-index: ${HIGHLIGHT_Z_INDEX}; overflow: visible;
        margin: 0; padding: 0; border: none; background: none;
      `

      const scrollX = window.pageXOffset || document.documentElement.scrollLeft || 0
      const scrollY = window.pageYOffset || document.documentElement.scrollTop || 0

      let count = 0
      for (const el of nodes) {
        const ref = el.getAttribute(refAttr) || ''
        if (!/^e\d+$/i.test(ref)) continue
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue

        const highlight = document.createElement('div')
        highlight.setAttribute(highlightAttr, 'element')
        highlight.setAttribute('data-element-id', ref)
        highlight.style.cssText = `
          position: absolute;
          left: ${rect.left + scrollX}px;
          top: ${rect.top + scrollY}px;
          width: ${rect.width}px;
          height: ${rect.height}px;
          outline: 2px dashed #4a90e2;
          outline-offset: -2px;
          background: transparent;
          pointer-events: none;
          box-sizing: content-box;
        `

        const label = document.createElement('div')
        label.textContent = ref
        label.style.cssText = `
          position: absolute; top: -20px; left: 0;
          background-color: #4a90e2; color: white;
          padding: 2px 6px; font-size: 11px; font-weight: bold;
          font-family: Monaco, Menlo, monospace; border-radius: 3px;
          white-space: nowrap; z-index: ${HIGHLIGHT_Z_INDEX + 1};
          box-shadow: 0 2px 4px rgba(0,0,0,0.3); line-height: 1.2;
        `
        highlight.appendChild(label)
        container.appendChild(highlight)
        count += 1
      }

      document.body.appendChild(container)
      return count
    },
    { refAttr: AI_REF_ATTR, highlightAttr: HIGHLIGHT_ATTR, containerId: CONTAINER_ID }
  )
  return { added: Number(added) || 0 }
}

/** Corner-bracket flash on the element about to be interacted with. */
export async function highlightInteraction(
  page: Page,
  selector: string,
  opts?: { color?: string; durationMs?: number }
): Promise<void> {
  const color = opts?.color || '#FF5F1F'
  const durationMs = opts?.durationMs ?? 800
  await page.evaluate(
    (params: { selector: string; color: string; duration: number; attr: string }) => {
      const el = document.querySelector(params.selector) as HTMLElement | null
      if (!el) return
      const rect = el.getBoundingClientRect()
      const scrollX = window.pageXOffset || document.documentElement.scrollLeft || 0
      const scrollY = window.pageYOffset || document.documentElement.scrollTop || 0
      const maxCorner = 20
      const minCorner = 8
      const cornerSize = Math.max(
        minCorner,
        Math.min(maxCorner, Math.min(rect.width, rect.height) * 0.35)
      )
      const borderWidth = 3
      const startOffset = 10
      const finalOffset = -3

      const container = document.createElement('div')
      container.setAttribute(params.attr, 'true')
      container.style.cssText = `
        position: absolute;
        left: ${rect.left + scrollX}px;
        top: ${rect.top + scrollY}px;
        width: ${rect.width}px;
        height: ${rect.height}px;
        pointer-events: none;
        z-index: 2147483647;
      `

      const corners = [
        { pos: 'top-left', startX: -startOffset, startY: -startOffset, finalX: finalOffset, finalY: finalOffset },
        { pos: 'top-right', startX: startOffset, startY: -startOffset, finalX: -finalOffset, finalY: finalOffset },
        { pos: 'bottom-left', startX: -startOffset, startY: startOffset, finalX: finalOffset, finalY: -finalOffset },
        { pos: 'bottom-right', startX: startOffset, startY: startOffset, finalX: -finalOffset, finalY: -finalOffset }
      ] as const

      for (const corner of corners) {
        const bracket = document.createElement('div')
        bracket.style.cssText = `
          position: absolute; width: ${cornerSize}px; height: ${cornerSize}px;
          pointer-events: none; transition: all 0.15s ease-out;
        `
        if (corner.pos === 'top-left') {
          bracket.style.top = '0'
          bracket.style.left = '0'
          bracket.style.borderTop = `${borderWidth}px solid ${params.color}`
          bracket.style.borderLeft = `${borderWidth}px solid ${params.color}`
        } else if (corner.pos === 'top-right') {
          bracket.style.top = '0'
          bracket.style.right = '0'
          bracket.style.borderTop = `${borderWidth}px solid ${params.color}`
          bracket.style.borderRight = `${borderWidth}px solid ${params.color}`
        } else if (corner.pos === 'bottom-left') {
          bracket.style.bottom = '0'
          bracket.style.left = '0'
          bracket.style.borderBottom = `${borderWidth}px solid ${params.color}`
          bracket.style.borderLeft = `${borderWidth}px solid ${params.color}`
        } else {
          bracket.style.bottom = '0'
          bracket.style.right = '0'
          bracket.style.borderBottom = `${borderWidth}px solid ${params.color}`
          bracket.style.borderRight = `${borderWidth}px solid ${params.color}`
        }
        bracket.style.transform = `translate(${corner.startX}px, ${corner.startY}px)`
        container.appendChild(bracket)
        setTimeout(() => {
          bracket.style.transform = `translate(${corner.finalX}px, ${corner.finalY}px)`
        }, 10)
      }

      document.body.appendChild(container)
      setTimeout(() => {
        container.style.opacity = '0'
        container.style.transition = 'opacity 0.2s ease'
        setTimeout(() => container.remove(), 220)
      }, params.duration)
    },
    { selector, color, duration: durationMs, attr: INTERACTION_ATTR }
  )
}

export async function highlightCoordinate(page: Page, x: number, y: number, durationMs = 700) {
  await page.evaluate(
    (params: { x: number; y: number; duration: number; attr: string }) => {
      const scrollX = window.pageXOffset || document.documentElement.scrollLeft || 0
      const scrollY = window.pageYOffset || document.documentElement.scrollTop || 0
      const ring = document.createElement('div')
      ring.setAttribute(params.attr, 'coord')
      ring.style.cssText = `
        position: absolute;
        left: ${params.x + scrollX - 18}px;
        top: ${params.y + scrollY - 18}px;
        width: 36px; height: 36px;
        border: 3px solid #FF5F1F; border-radius: 50%;
        pointer-events: none; z-index: 2147483647;
        box-shadow: 0 0 0 2px rgba(255,95,31,0.35);
      `
      document.body.appendChild(ring)
      setTimeout(() => ring.remove(), params.duration)
    },
    { x, y, duration: durationMs, attr: INTERACTION_ATTR }
  )
}
