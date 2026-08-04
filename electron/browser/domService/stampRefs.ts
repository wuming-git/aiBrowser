/**
 * Stamp data-ai-ref=e{index} onto interactive nodes via CDP.
 */
import type { CDPSession } from 'puppeteer-core'
import type { DOMSelectorMap } from './types'

export async function stampAiRefs(cdp: CDPSession, selectorMap: DOMSelectorMap): Promise<void> {
  try {
    await cdp.send('DOM.enable')
  } catch {
    return
  }

  for (const [index, node] of Object.entries(selectorMap)) {
    const backendId = node?.backendNodeId
    if (backendId == null) continue
    const ref = `e${Number(index)}`
    try {
      const pushed = (await cdp.send('DOM.pushNodesByBackendIdsToFrontend', {
        backendNodeIds: [Number(backendId)],
      })) as { nodeIds?: number[] }
      const nodeIds = pushed?.nodeIds || []
      if (!nodeIds.length) continue
      await cdp.send('DOM.setAttributeValue', {
        nodeId: Number(nodeIds[0]),
        name: 'data-ai-ref',
        value: ref,
      })
    } catch {
      // best-effort
    }
  }
}

export function rewriteIndexesToRefs(tree: string): string {
  return (tree || '').replace(/\[(\d+)\]/g, '[ref=e$1]')
}
