/**
 * Per-profile browser tool queue: serializes click/type/snapshot/etc so parallel
 * LLM tool_calls (e.g. type username + password) cannot race the same page.
 */
type QueueGate = {
  tail: Promise<void>
}

const gates = new Map<string, QueueGate>()

const BROWSER_TOOLS = new Set([
  'browser.launch',
  'browser.open',
  'browser.navigate',
  'browser.click',
  'browser.type',
  'browser.hover',
  'browser.scroll',
  'browser.waitFor',
  'browser.pressKey',
  'browser.extractText',
  'browser.snapshot',
  'browser.find',
  'browser.download',
  'browser.close',
  'browser.act',
  'browser.clickXy',
  'browser.screenshot',
  'browser.highlight',
  'browser.debugInfo'
])

/** Default: wait up to 90s in queue; execution uses its own timeouts. */
const DEFAULT_QUEUE_WAIT_MS = 90_000

function profileKey(tool: string, args: Record<string, any>): string | null {
  if (!BROWSER_TOOLS.has(tool)) return null
  const pid = args?.profileId
  if (pid == null || pid === '') return 'browser:default'
  return `browser:${String(pid)}`
}

function getGate(key: string): QueueGate {
  let g = gates.get(key)
  if (!g) {
    g = { tail: Promise.resolve() }
    gates.set(key, g)
  }
  return g
}

export function isBrowserTool(tool: string): boolean {
  return BROWSER_TOOLS.has(tool)
}

/**
 * Run fn exclusively for this profile's browser tools.
 * Later callers block until earlier ones finish or queueWaitMs elapses.
 */
export async function withBrowserQueue<T>(
  tool: string,
  args: Record<string, any>,
  fn: () => Promise<T>,
  opts?: { queueWaitMs?: number }
): Promise<T> {
  const key = profileKey(tool, args)
  if (!key) return fn()

  const waitMs = Math.max(1000, Number(opts?.queueWaitMs) || DEFAULT_QUEUE_WAIT_MS)
  const gate = getGate(key)

  let release!: () => void
  const mySlot = new Promise<void>((resolve) => {
    release = resolve
  })
  const prev = gate.tail
  gate.tail = prev.then(() => mySlot)

  let timedOut = false
  const waitPrev = Promise.race([
    prev,
    new Promise<void>((_, reject) => {
      setTimeout(() => {
        timedOut = true
        reject(new Error(`浏览器操作排队超时（>${Math.round(waitMs / 1000)}s）: ${tool}`))
      }, waitMs)
    })
  ])

  try {
    await waitPrev
    return await fn()
  } finally {
    release()
    // If we timed out before acquiring, still release so the chain continues
    if (timedOut) {
      // prev may still be running; our slot is released so successors can proceed after prev
    }
  }
}
