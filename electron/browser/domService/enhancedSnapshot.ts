/**
 * DOMSnapshot → EnhancedSnapshotNode lookup (browser-use enhanced_snapshot.py).
 */
import type { DOMRect, EnhancedSnapshotNode } from './types'

export const REQUIRED_COMPUTED_STYLES = [
  'display',
  'visibility',
  'opacity',
  'overflow',
  'overflow-x',
  'overflow-y',
  'cursor',
  'pointer-events',
  'position',
  'background-color',
]

function parseComputedStyles(strings: string[], styleIndices: number[]): Record<string, string> {
  const styles: Record<string, string> = {}
  for (let i = 0; i < styleIndices.length; i++) {
    const styleIndex = styleIndices[i]
    if (i < REQUIRED_COMPUTED_STYLES.length && styleIndex >= 0 && styleIndex < strings.length) {
      styles[REQUIRED_COMPUTED_STYLES[i]] = strings[styleIndex]
    }
  }
  return styles
}

function makeRect(x: number, y: number, w: number, h: number): DOMRect {
  return { x, y, width: w, height: h }
}

export function buildSnapshotLookup(
  snapshot: any,
  devicePixelRatio = 1.0,
): Map<number, EnhancedSnapshotNode> {
  const snapshotLookup = new Map<number, EnhancedSnapshotNode>()
  if (!snapshot?.documents?.length) return snapshotLookup

  const strings: string[] = snapshot.strings || []
  const dpr = devicePixelRatio || 1

  for (const document of snapshot.documents) {
    const nodes = document.nodes || {}
    const layout = document.layout || {}

    const backendNodeToSnapshotIndex = new Map<number, number>()
    if (nodes.backendNodeId) {
      for (let i = 0; i < nodes.backendNodeId.length; i++) {
        backendNodeToSnapshotIndex.set(nodes.backendNodeId[i], i)
      }
    }

    const layoutIndexMap = new Map<number, number>()
    if (layout.nodeIndex) {
      for (let layoutIdx = 0; layoutIdx < layout.nodeIndex.length; layoutIdx++) {
        const nodeIndex = layout.nodeIndex[layoutIdx]
        if (!layoutIndexMap.has(nodeIndex)) layoutIndexMap.set(nodeIndex, layoutIdx)
      }
    }

    const hasClickableData = !!nodes.isClickable
    const isClickableSet = new Set<number>(hasClickableData ? nodes.isClickable.index || [] : [])

    for (const [backendNodeId, snapshotIndex] of backendNodeToSnapshotIndex) {
      let isClickable: boolean | null = null
      if (hasClickableData) isClickable = isClickableSet.has(snapshotIndex)

      let cursorStyle: string | null = null
      let boundingBox: DOMRect | null = null
      let computedStyles: Record<string, string> = {}
      let paintOrder: number | null = null
      let clientRects: DOMRect | null = null
      let scrollRects: DOMRect | null = null
      let stackingContexts: number | null = null

      if (layoutIndexMap.has(snapshotIndex)) {
        const layoutIdx = layoutIndexMap.get(snapshotIndex)!
        const bounds = layout.bounds?.[layoutIdx]
        if (bounds && bounds.length >= 4) {
          boundingBox = makeRect(bounds[0] / dpr, bounds[1] / dpr, bounds[2] / dpr, bounds[3] / dpr)
        }

        if (layout.styles?.[layoutIdx]) {
          computedStyles = parseComputedStyles(strings, layout.styles[layoutIdx])
          cursorStyle = computedStyles.cursor ?? null
        }

        if (layout.paintOrders && layoutIdx < layout.paintOrders.length) {
          paintOrder = layout.paintOrders[layoutIdx]
        }

        const clientRectData = layout.clientRects?.[layoutIdx]
        if (clientRectData && clientRectData.length >= 4) {
          clientRects = makeRect(clientRectData[0], clientRectData[1], clientRectData[2], clientRectData[3])
        }

        const scrollRectData = layout.scrollRects?.[layoutIdx]
        if (scrollRectData && scrollRectData.length >= 4) {
          scrollRects = makeRect(scrollRectData[0], scrollRectData[1], scrollRectData[2], scrollRectData[3])
        }

        const stacking = layout.stackingContexts?.index
        if (stacking && layoutIdx < stacking.length) {
          stackingContexts = stacking[layoutIdx]
        }
      }

      snapshotLookup.set(backendNodeId, {
        isClickable,
        cursorStyle,
        bounds: boundingBox,
        clientRects,
        scrollRects,
        computedStyles: Object.keys(computedStyles).length ? computedStyles : null,
        paintOrder,
        stackingContexts,
      })
    }
  }

  return snapshotLookup
}
