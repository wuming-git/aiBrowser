import { cancelJob, createJob, listJobs, updateJob, type ScheduleJob } from './scheduler'
import * as human from '../browser/humanTools'
import * as fsShell from './fsShellTools'
/** 侧效：注册浏览器任务收尾回调（不对 LLM 暴露） */
import '../browser/postTaskCleanup'
import { withBrowserQueue } from './browserQueue'
import { captureSimplifiedObservation, shouldAttachDom } from '../browser/simplifiedDom'
import { ensureHumanSession } from '../browser/humanSession'
import { compactDesktopResult } from './compactResult'

const ALLOWED = new Set([
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
  'browser.debugInfo',
  'scheduler.create',
  'scheduler.list',
  'scheduler.update',
  'scheduler.cancel',
  'shell.exec',
  'fs.read',
  'fs.write',
  'fs.list',
  'fs.mkdir',
  'fs.delete',
  'fs.workspace'
])

export type ToolInvocation = {
  invocationId: string
  sessionId?: string
  userId?: number
  deviceId?: string
  tool: string
  arguments?: Record<string, any>
  issuedAt?: string
  expiresAt?: string
}

export type ToolResult = {
  invocationId: string
  ok: boolean
  result?: Record<string, any>
  error?: string | null
  durationMs?: number
}

function ensureUrl(url: unknown): string {
  const s = String(url || '').trim()
  if (!s) throw new Error('缺少 url')
  if (!/^https?:\/\//i.test(s)) throw new Error('url 必须以 http(s):// 开头')
  return s
}

function coerceBool(v: unknown, defaultValue = false): boolean {
  if (v === true || v === 1) return true
  if (v === false || v === 0) return false
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true
    if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false
  }
  return defaultValue
}

function execSchedulerCreate(args: Record<string, any>) {
  const profileId = args.profileId
  if (profileId == null) throw new Error('缺少 profileId')
  const allowDuplicate = coerceBool(
    args.allowDuplicate ?? args.allow_duplicate,
    false
  )
  const job = createJob({
    name: String(args.name || 'job'),
    cron: String(args.cron || ''),
    profileId,
    url: ensureUrl(args.url),
    description:
      args.description != null && args.description !== ''
        ? String(args.description)
        : undefined,
    remark: args.remark != null && args.remark !== '' ? String(args.remark) : undefined,
    allowDuplicate,
    fingerprint: args.fingerprint,
    proxy: args.proxy || null
  })
  const already = Boolean((job as any).alreadyExists)
  const { alreadyExists: _a, ...clean } = job as ScheduleJob & { alreadyExists?: boolean }
  return {
    created: !already,
    alreadyExists: already,
    allowDuplicate,
    job: clean
  }
}

async function dispatchTool(tool: string, args: Record<string, any>): Promise<Record<string, any>> {
  switch (tool) {
    case 'browser.launch':
      return human.browserLaunch(args)
    case 'browser.open':
      return human.browserOpen(args)
    case 'browser.navigate':
      return human.browserNavigate(args)
    case 'browser.click':
      return human.browserClick(args)
    case 'browser.type':
      return human.browserType(args)
    case 'browser.hover':
      return human.browserHover(args)
    case 'browser.scroll':
      return human.browserScroll(args)
    case 'browser.waitFor':
      return human.browserWaitFor(args)
    case 'browser.pressKey':
      return human.browserPressKey(args)
    case 'browser.extractText':
      return human.browserExtractText(args)
    case 'browser.snapshot':
      return human.browserSnapshot(args)
    case 'browser.find':
      return human.browserFind(args)
    case 'browser.download':
      return human.browserDownload(args)
    case 'browser.act':
      return human.browserAct(args)
    case 'browser.clickXy':
      return human.browserClickXy(args)
    case 'browser.screenshot':
      return human.browserScreenshot(args)
    case 'browser.highlight':
      return human.browserHighlight(args)
    case 'browser.debugInfo':
      return human.browserDebugInfo(args)
    case 'browser.close': {
      const profileId = args.profileId
      if (profileId == null) throw new Error('缺少 profileId')
      const { closeBrowser } = await import('../browser/launcher')
      const closed = await closeBrowser(profileId)
      return { closed: true, profileId, ...closed }
    }
    case 'scheduler.create':
      return execSchedulerCreate(args)
    case 'scheduler.list':
      return { jobs: listJobs() }
    case 'scheduler.update': {
      const jobId = String(args.jobId || '')
      if (!jobId) throw new Error('缺少 jobId')
      const patch: Record<string, any> = {}
      for (const k of [
        'name',
        'cron',
        'url',
        'description',
        'remark',
        'status',
        'fingerprint',
        'proxy'
      ] as const) {
        if (args[k] !== undefined && args[k] !== null && args[k] !== '') patch[k] = args[k]
      }
      // 允许显式清空 description / remark（传空字符串）
      if (args.description === '') patch.description = ''
      if (args.remark === '') patch.remark = ''
      if (args.profileId !== undefined && args.profileId !== null && args.profileId !== '') {
        patch.profileId = args.profileId
      }
      if (!Object.keys(patch).length) throw new Error('缺少要更新的字段（name/cron/url/profileId/status/…）')
      return { updated: true, job: updateJob(jobId, patch) }
    }
    case 'scheduler.cancel': {
      const jobId = String(args.jobId || '')
      if (!jobId) throw new Error('缺少 jobId')
      return { cancelled: cancelJob(jobId), jobId }
    }
    case 'shell.exec':
      return fsShell.shellExec(args)
    case 'fs.read':
      return fsShell.fsRead(args)
    case 'fs.write':
      return fsShell.fsWrite(args)
    case 'fs.list':
      return fsShell.fsList(args)
    case 'fs.mkdir':
      return fsShell.fsMkdir(args)
    case 'fs.delete':
      return fsShell.fsDelete(args)
    case 'fs.workspace':
      return fsShell.fsWorkspaceInfo()
    default:
      throw new Error(`未实现工具: ${tool}`)
  }
}

/** 操作完成后附带精简 DOM；仅当模型显式 includeDom=true 时挂载 */
async function attachObservationIfNeeded(
  tool: string,
  args: Record<string, any>,
  result: Record<string, any>
): Promise<Record<string, any>> {
  if (!shouldAttachDom(tool, args)) {
    return { ...result, includeDom: false }
  }
  if (result?.observation?.tree) return result
  if (args.profileId == null) return result

  try {
    const session = await ensureHumanSession({
      profileId: args.profileId,
      fingerprint: args.fingerprint,
      proxy: args.proxy,
      profileName: args.profileName
    })
    // includeDom=true 时附带超精简关键 DOM（key）；可用 treeFormat=browser_use 要完整精简树
    const formatOverride = String(args.treeFormat || args.domFormat || '')
      .trim()
      .toLowerCase()
    const treeFormat =
      formatOverride === 'browser_use' ||
      formatOverride === 'browser-use' ||
      formatOverride === 'bu'
        ? 'browser-use'
        : 'key'
    const obs = await captureSimplifiedObservation({
      page: session.page,
      profileId: args.profileId,
      maxChars: Number(args.maxTreeChars) || 40000,
      preferBrowserUse: args.preferBrowserUse !== false,
      treeFormat,
      args
    })
    if (!obs.ok) {
      return { ...result, includeDom: true, observationError: obs.error || 'dom_capture_failed' }
    }
    // pageFingerprint 顶层一份供后端 loop nudge；domNote/hint/source/format 不进 observation（协议已说明）
    return {
      ...result,
      includeDom: true,
      pageFingerprint: obs.pageFingerprint,
      observation: {
        mode: obs.mode,
        url: obs.url,
        title: obs.title,
        tree: obs.tree,
        truncated: obs.truncated,
        elementCount: obs.elementCount,
        scope: obs.scope,
        ...(obs.dialogScoped ? { dialogScoped: true } : {})
      }
    }
  } catch (e: any) {
    return { ...result, includeDom: true, observationError: e?.message || String(e) }
  }
}

/** 定时任务触发的 Agent 会话（sessionId 以 sched- 开头） */
function isSchedulerTriggeredSession(sessionId?: string | null): boolean {
  return !!sessionId && String(sessionId).startsWith('sched-')
}

export async function executeTool(invocation: ToolInvocation): Promise<ToolResult> {
  const started = Date.now()
  const invocationId = invocation.invocationId
  try {
    if (!invocationId) throw new Error('缺少 invocationId')
    if (invocation.expiresAt) {
      const exp = Date.parse(invocation.expiresAt)
      if (Number.isFinite(exp) && Date.now() > exp) {
        throw new Error('调用已过期')
      }
    }
    const tool = String(invocation.tool || '')
    if (!ALLOWED.has(tool)) {
      throw new Error(`未授权工具: ${tool}`)
    }
    // 定时任务会话程序屏蔽创建，防止循环建任务（不依赖提示词）
    if (tool === 'scheduler.create' && isSchedulerTriggeredSession(invocation.sessionId)) {
      return {
        invocationId,
        ok: false,
        result: {
          blocked: true,
          error: 'scheduler_create_blocked',
          sessionId: invocation.sessionId
        },
        error: '当前为定时任务触发的 Agent 会话，已程序屏蔽创建定时任务，防止循环创建',
        durationMs: Date.now() - started
      }
    }
    const args = invocation.arguments || {}
    const queueWaitMs = Number(args.queueWaitMs) || undefined
    let result = await withBrowserQueue(tool, args, () => dispatchTool(tool, args), {
      queueWaitMs
    })
    result = await attachObservationIfNeeded(tool, args, result)
    // 上线前在桌面侧压扁：去掉 before/after、双份 tree、nodes 等，降低 Hub WS 流量
    const lean = compactDesktopResult(result)
    return {
      invocationId,
      ok: true,
      result: lean,
      error: null,
      durationMs: Date.now() - started
    }
  } catch (e: any) {
    return {
      invocationId: invocationId || 'unknown',
      ok: false,
      result: {},
      error: e?.message || String(e),
      durationMs: Date.now() - started
    }
  }
}
