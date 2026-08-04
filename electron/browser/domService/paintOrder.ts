/**
 * Paint-order filtering (browser-use paint_order.py).
 */
import type { SimplifiedNode } from './types'

type Rect = { x1: number; y1: number; x2: number; y2: number }

function rectArea(r: Rect): number {
  return (r.x2 - r.x1) * (r.y2 - r.y1)
}

function intersects(a: Rect, b: Rect): boolean {
  return !(a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1)
}

function contains(a: Rect, b: Rect): boolean {
  return a.x1 <= b.x1 && a.y1 <= b.y1 && a.x2 >= b.x2 && a.y2 >= b.y2
}

function splitDiff(a: Rect, b: Rect): Rect[] {
  const parts: Rect[] = []
  if (a.y1 < b.y1) parts.push({ x1: a.x1, y1: a.y1, x2: a.x2, y2: b.y1 })
  if (b.y2 < a.y2) parts.push({ x1: a.x1, y1: b.y2, x2: a.x2, y2: a.y2 })
  const yLo = Math.max(a.y1, b.y1)
  const yHi = Math.min(a.y2, b.y2)
  if (a.x1 < b.x1) parts.push({ x1: a.x1, y1: yLo, x2: b.x1, y2: yHi })
  if (b.x2 < a.x2) parts.push({ x1: b.x2, y1: yLo, x2: a.x2, y2: yHi })
  return parts
}

class RectUnionPure {
  private _rects: Rect[] = []
  private static _MAX_RECTS = 5000

  contains(r: Rect): boolean {
    if (!this._rects.length) return false
    let stack = [r]
    for (const s of this._rects) {
      const newStack: Rect[] = []
      for (const piece of stack) {
        if (contains(s, piece)) continue
        if (intersects(piece, s)) newStack.push(...splitDiff(piece, s))
        else newStack.push(piece)
      }
      if (!newStack.length) return true
      stack = newStack
    }
    return false
  }

  add(r: Rect): boolean {
    if (this._rects.length >= RectUnionPure._MAX_RECTS) return false
    if (this.contains(r)) return false
    let pending = [r]
    for (let i = 0; i < this._rects.length; i++) {
      const s = this._rects[i]
      const newPending: Rect[] = []
      for (const piece of pending) {
        if (intersects(piece, s)) newPending.push(...splitDiff(piece, s))
        else newPending.push(piece)
      }
      pending = newPending
    }
    this._rects.push(...pending)
    return true
  }
}

export class PaintOrderRemover {
  constructor(private root: SimplifiedNode) {}

  private static documentContext(node: SimplifiedNode): [string | null, string | null] {
    const originalNode = node.originalNode
    let parent = originalNode.parentNode
    while (parent) {
      if (parent.tagName === 'iframe' || parent.tagName === 'frame') {
        return [originalNode.sessionId != null ? String(originalNode.sessionId) : null, parent.frameId]
      }
      parent = parent.parentNode
    }
    return [originalNode.sessionId != null ? String(originalNode.sessionId) : null, null]
  }

  calculatePaintOrder(): void {
    const withPaint: SimplifiedNode[] = []
    const collect = (node: SimplifiedNode) => {
      if (
        node.originalNode.snapshotNode &&
        node.originalNode.snapshotNode.paintOrder != null &&
        node.originalNode.snapshotNode.bounds != null
      ) {
        withPaint.push(node)
      }
      for (const child of node.children) collect(child)
    }
    collect(this.root)

    const grouped = new Map<number, SimplifiedNode[]>()
    for (const node of withPaint) {
      const po = node.originalNode.snapshotNode!.paintOrder!
      if (!grouped.has(po)) grouped.set(po, [])
      grouped.get(po)!.push(node)
    }

    const rectUnions = new Map<string, RectUnionPure>()
    const ctxKey = (c: [string | null, string | null]) => `${c[0] ?? ''}|${c[1] ?? ''}`

    const sorted = [...grouped.entries()].sort((a, b) => b[0] - a[0])
    for (const [, nodes] of sorted) {
      const rectsToAdd = new Map<string, Rect[]>()

      for (const node of nodes) {
        const snap = node.originalNode.snapshotNode
        if (!snap?.bounds) continue
        const rect: Rect = {
          x1: snap.bounds.x,
          y1: snap.bounds.y,
          x2: snap.bounds.x + snap.bounds.width,
          y2: snap.bounds.y + snap.bounds.height,
        }
        const context = PaintOrderRemover.documentContext(node)
        const key = ctxKey(context)
        if (!rectUnions.has(key)) rectUnions.set(key, new RectUnionPure())

        if (rectUnions.get(key)!.contains(rect)) {
          node.ignoredByPaintOrder = true
        }

        const styles = snap.computedStyles
        if (
          (styles && (styles['background-color'] ?? 'rgba(0, 0, 0, 0)') === 'rgba(0, 0, 0, 0)') ||
          (styles && parseFloat(styles.opacity ?? '1') < 0.8)
        ) {
          continue
        }

        if (!rectsToAdd.has(key)) rectsToAdd.set(key, [])
        rectsToAdd.get(key)!.push(rect)
      }

      for (const [key, rects] of rectsToAdd) {
        if (!rectUnions.has(key)) rectUnions.set(key, new RectUnionPure())
        for (const rect of rects) rectUnions.get(key)!.add(rect)
      }
    }

    void rectArea
  }
}
