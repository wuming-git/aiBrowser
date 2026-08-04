/**
 * 桌面 → Hub 回包压扁：去掉 before/after、双份 tree、nodes 大数组等，
 * 减少线上部署时的 WS 流量。后端 compact_result 仍可做 LLM 侧兜底。
 */

const HINTS_MAX = 8
const MATCHES_MAX = 12
const STEP_KEYS = [
  'index',
  'op',
  'action',
  'ok',
  'ref',
  'error',
  'length',
  'x',
  'y',
  'key',
  'url',
  'text',
  'deltaY',
  'ms'
] as const

function dropNone<T extends Record<string, any>>(obj: T): Partial<T> {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v
  }
  return out as Partial<T>
}

function compactSteps(steps: unknown): Record<string, any>[] | undefined {
  if (!Array.isArray(steps)) return undefined
  const out: Record<string, any>[] = []
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue
    const item: Record<string, any> = {}
    for (const k of STEP_KEYS) {
      if ((step as any)[k] !== undefined && (step as any)[k] !== null) {
        item[k] = (step as any)[k]
      }
    }
    if (item.op === 'type' || item.action === 'type') delete item.text
    if (Object.keys(item).length) out.push(item)
  }
  return out.length ? out : undefined
}

function omittedFromTree(tree: string | undefined): number | null {
  if (!tree) return null
  const m = tree.slice(0, 240).match(/omitted=(\d+)\s*blocks/)
  return m ? Number(m[1]) : null
}

function compactObservation(src: Record<string, any> | undefined, fallbackTree?: string) {
  if (!src && !fallbackTree) return undefined
  const tree =
    (typeof src?.tree === 'string' && src.tree.trim() ? src.tree : undefined) ||
    (typeof fallbackTree === 'string' && fallbackTree.trim() ? fallbackTree : undefined)
  if (!tree && !src) return undefined

  let dialogScoped = src?.dialogScoped === true
  const omitted = omittedFromTree(tree)
  if (dialogScoped && omitted === 0) dialogScoped = false

  return dropNone({
    mode: src?.mode,
    elementCount: src?.elementCount,
    truncated: src?.truncated,
    scope: src?.scope,
    dialogScoped: dialogScoped ? true : undefined,
    // domNote / format / source / fingerprint：LLM 侧不需要，后端会再剥一层
    tree
  })
}

/**
 * 压扁单次工具业务 payload（即将放入 ToolResult.result 的对象）。
 */
export function compactDesktopResult(raw: Record<string, any> | null | undefined): Record<string, any> {
  if (!raw || typeof raw !== 'object') return {}

  const obsSrc =
    raw.observation && typeof raw.observation === 'object'
      ? (raw.observation as Record<string, any>)
      : undefined
  const observation = compactObservation(obsSrc, typeof raw.tree === 'string' ? raw.tree : undefined)

  const out: Record<string, any> = {
    // 内部标记：后端识别已线侧压缩；发给 LLM 前会被剥离
    wireCompact: true
  }

  // 顶层动作元数据；pageFingerprint 仅供后端 loop nudge，LLM 侧会剥掉
  for (const key of [
    'changed',
    'url',
    'title',
    'hasDialog',
    'includeDom',
    'ref',
    'clicked',
    'typed',
    'navigated',
    'closed',
    'profileId',
    'mode',
    'scope',
    'ok',
    'error',
    'truncated',
    'treeCapped',
    'elementCount',
    'highlightAdded',
    'stopped',
    'openedTabs'
  ] as const) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '') {
      out[key] = raw[key]
    }
  }

  const fp = raw.pageFingerprint || obsSrc?.pageFingerprint
  if (fp) out.pageFingerprint = fp

  // 不传 pageSignature / domNote / hint（重复占 token，协议里已说明）

  if (observation) out.observation = observation

  if (!observation && typeof raw.tree === 'string' && raw.tree.trim()) {
    out.tree = raw.tree
  }

  if (raw.observationError) out.observationError = raw.observationError

  const steps = compactSteps(raw.steps)
  if (steps) out.steps = steps

  for (const key of ['loginHints', 'ctaCandidates', 'errorHints'] as const) {
    const val = raw[key]
    if (Array.isArray(val) && val.length) out[key] = val.slice(0, HINTS_MAX)
  }

  if (Array.isArray(raw.matches) && raw.matches.length) {
    out.matches = raw.matches.slice(0, MATCHES_MAX)
  }

  for (const key of [
    'image_b64',
    'imageB64',
    'fileName',
    'savedPath',
    'path',
    'mime',
    'urls',
    'created',
    'job',
    'jobs',
    'cancelled',
    'jobId',
    'stdout',
    'stderr',
    'exitCode',
    'content',
    'entries',
    'workspace',
    'debugPort',
    'wsUrl',
    'browserWSEndpoint',
    'fallbackError'
  ] as const) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '' && out[key] === undefined) {
      out[key] = raw[key]
    }
  }

  return out
}
