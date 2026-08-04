/**
 * 任务结束后的程序级回调（非 LLM）。
 * 各工具模块在加载时 registerPostTaskCallback；调度/任务收尾时统一 run。
 * 不对大模型暴露，勿写入 tool catalog / Skill。
 */

export type PostTaskContext = {
  /** 触发来源 */
  reason: 'scheduler.job' | string
  jobId?: string
  profileId?: string | number
  sessionId?: string
  ok: boolean
  error?: string
  /** 任务元信息（可选） */
  meta?: Record<string, unknown>
}

export type PostTaskCallback = (ctx: PostTaskContext) => void | Promise<void>

export type PostTaskHookResult = {
  id: string
  ok: boolean
  error?: string
  durationMs: number
}

const hooks = new Map<string, PostTaskCallback>()

/** 注册收尾回调；同 id 覆盖。返回取消注册函数。 */
export function registerPostTaskCallback(id: string, fn: PostTaskCallback): () => void {
  const key = String(id || '').trim()
  if (!key) throw new Error('postTask hook id 不能为空')
  hooks.set(key, fn)
  return () => {
    if (hooks.get(key) === fn) hooks.delete(key)
  }
}

export function listPostTaskCallbackIds(): string[] {
  return [...hooks.keys()]
}

/** 依次执行已注册回调；单个失败不影响后续。 */
export async function runPostTaskCallbacks(ctx: PostTaskContext): Promise<PostTaskHookResult[]> {
  const results: PostTaskHookResult[] = []
  for (const [id, fn] of hooks) {
    const t0 = Date.now()
    try {
      await fn(ctx)
      results.push({ id, ok: true, durationMs: Date.now() - t0 })
    } catch (e: any) {
      const error = e?.message || String(e)
      console.warn('[postTaskHooks] hook failed', id, error)
      results.push({ id, ok: false, error, durationMs: Date.now() - t0 })
    }
  }
  return results
}
