import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { Cron } from 'croner'
import { launchBrowser } from '../browser/launcher'
import { runPostTaskCallbacks } from './postTaskHooks'
/** 确保浏览器收尾钩子已注册（即使用户只开调度页、未走过工具通道） */
import '../browser/postTaskCleanup'

export type JobStatus = 'running' | 'paused' | 'error'

export type ScheduleLog = {
  id: string
  jobId: string
  at: string
  ok: boolean
  message: string
  durationMs?: number
}

export type ScheduleJob = {
  jobId: string
  name: string
  /** 给大模型的任务提示词（到点执行时作为任务说明） */
  description: string
  /** 给用户看的备注（记忆/展示用，不驱动 Agent） */
  remark: string
  /**
   * 调度开关：running=启用（列表显示空闲/执行中），paused=暂停
   * error 仍表示上次失败，列表在未暂停时显示为空闲
   */
  status: JobStatus
  cron: string
  profileId: number | string
  url: string
  fingerprint?: Record<string, any>
  proxy?: Record<string, any> | null
  createdAt: string
  lastRunAt?: string
  lastError?: string
  /** 运行时：本轮是否正在执行（不落盘） */
  executing?: boolean
}

type Active = ScheduleJob & { task: Cron | null }

const jobs = new Map<string, Active>()
const logsByJob = new Map<string, ScheduleLog[]>()
/** 同任务禁止并行：执行中再次 cron/立即执行则跳过 */
const runningJobIds = new Set<string>()
/** 用户暂停时中止本轮执行 */
const jobCancelFlags = new Set<string>()
/** 本轮 Agent fetch 的 AbortController */
const jobAbortControllers = new Map<string, AbortController>()
const MAX_LOGS_PER_JOB = 200
const AGENT_CHAT_TIMEOUT_MS = 15 * 60 * 1000

class JobCancelledError extends Error {
  constructor(message = '任务已暂停并中止本次执行') {
    super(message)
    this.name = 'JobCancelledError'
  }
}

function isJobCancelled(jobId: string) {
  if (jobCancelFlags.has(jobId)) return true
  const active = jobs.get(jobId)
  return !!active && active.status === 'paused'
}

function requestCancelJobRun(jobId: string) {
  jobCancelFlags.add(jobId)
  const ctrl = jobAbortControllers.get(jobId)
  if (ctrl) {
    try {
      ctrl.abort()
    } catch (_) {}
  }
}

function throwIfCancelled(jobId: string) {
  if (isJobCancelled(jobId)) throw new JobCancelledError()
}

function jobsPath() {
  return path.join(app.getPath('userData'), 'scheduler-jobs.json')
}

function logsPath() {
  return path.join(app.getPath('userData'), 'scheduler-logs.json')
}

function persistJobs() {
  const list = [...jobs.values()].map(({ task: _t, ...meta }) => meta)
  fs.writeFileSync(jobsPath(), JSON.stringify(list, null, 2), 'utf-8')
}

function persistLogs() {
  const obj: Record<string, ScheduleLog[]> = {}
  for (const [k, v] of logsByJob) obj[k] = v
  fs.writeFileSync(logsPath(), JSON.stringify(obj, null, 2), 'utf-8')
}

function appendLog(jobId: string, ok: boolean, message: string, durationMs?: number) {
  const entry: ScheduleLog = {
    id: `log_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
    jobId,
    at: new Date().toISOString(),
    ok,
    message,
    durationMs
  }
  const list = logsByJob.get(jobId) || []
  list.unshift(entry)
  if (list.length > MAX_LOGS_PER_JOB) list.length = MAX_LOGS_PER_JOB
  logsByJob.set(jobId, list)
  persistLogs()
  return entry
}

function buildAgentMessage(job: ScheduleJob): string {
  const desc = (job.description || '').trim()
  return [
    `【定时任务】${job.name || job.jobId}`,
    desc,
    '',
    `请使用环境 profileId=${job.profileId}；起始页 ${job.url}。`,
    '完成后用简体中文汇报结果（含关键证据）。'
  ].join('\n')
}

async function invokeAgentForJob(job: ScheduleJob): Promise<{ reply: string; sessionId: string }> {
  // 动态导入避免 scheduler ↔ wsBridge ↔ toolRuntime 循环依赖
  const { getDesktopCredentials } = await import('./wsBridge')
  const cred = getDesktopCredentials()
  if (!cred) {
    throw new Error('桌面未连接后端（无 token/apiBase），无法调用大模型')
  }
  throwIfCancelled(job.jobId)
  const sessionId = `sched-${job.jobId}-${Date.now().toString(36)}`
  const profileId =
    typeof job.profileId === 'number'
      ? job.profileId
      : Number.isFinite(Number(job.profileId))
        ? Number(job.profileId)
        : undefined
  const body = {
    message: buildAgentMessage(job),
    sessionId,
    profileId: profileId ?? null,
    deviceId: cred.deviceId,
    history: [] as unknown[]
  }
  const ctrl = new AbortController()
  jobAbortControllers.set(job.jobId, ctrl)
  const timer = setTimeout(() => ctrl.abort(), AGENT_CHAT_TIMEOUT_MS)
  try {
    throwIfCancelled(job.jobId)
    const res = await fetch(`${cred.apiBase}/api/agent/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cred.token}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    throwIfCancelled(job.jobId)
    const json = (await res.json().catch(() => null)) as {
      code?: number
      message?: string
      data?: { reply?: string; sessionId?: string }
    } | null
    if (!res.ok) {
      throw new Error(`Agent HTTP ${res.status}: ${json?.message || res.statusText}`)
    }
    if (!json || json.code !== 0) {
      throw new Error(json?.message || 'Agent 调用失败')
    }
    const reply = String(json.data?.reply || '').trim() || '(无文本输出)'
    return { reply, sessionId: String(json.data?.sessionId || sessionId) }
  } catch (e: any) {
    if (isJobCancelled(job.jobId) || e?.name === 'AbortError') {
      throw new JobCancelledError()
    }
    throw e
  } finally {
    clearTimeout(timer)
    if (jobAbortControllers.get(job.jobId) === ctrl) {
      jobAbortControllers.delete(job.jobId)
    }
  }
}

async function runJob(jobId: string) {
  const active = jobs.get(jobId)
  if (!active || active.status === 'paused') return
  if (runningJobIds.has(jobId)) {
    appendLog(jobId, false, '跳过：同任务仍在执行中，禁止并行触发')
    console.warn('[Scheduler] skip parallel', jobId)
    return
  }
  jobCancelFlags.delete(jobId)
  runningJobIds.add(jobId)
  console.log('[Scheduler] fire', active.jobId, active.name)
  const started = Date.now()
  let ok = true
  let errMsg: string | undefined
  let agentSessionId: string | undefined
  let cancelled = false
  try {
    throwIfCancelled(jobId)
    await launchBrowser({
      profileId: active.profileId,
      name: active.name,
      fingerprint: active.fingerprint,
      proxy: active.proxy || null,
      startUrl: active.url
    })
    throwIfCancelled(jobId)
    appendLog(jobId, true, `打开 ${active.url} 成功`, Date.now() - started)

    const prompt = (active.description || '').trim()
    if (prompt) {
      const agentStarted = Date.now()
      appendLog(jobId, true, '检测到任务描述，开始调用大模型…')
      const { reply, sessionId } = await invokeAgentForJob(active)
      throwIfCancelled(jobId)
      agentSessionId = sessionId
      const preview = reply.length > 400 ? reply.slice(0, 400) + '…' : reply
      appendLog(
        jobId,
        true,
        `Agent 完成 session=${sessionId}\n` +
          `（本条为调度摘要；完整 system/LLM 对话见后端 logs/${sessionId}/chat.log）\n` +
          preview,
        Date.now() - agentStarted
      )
    }

    active.lastRunAt = new Date().toISOString()
    active.lastError = undefined
    if (active.status === 'error') active.status = 'running'
    persistJobs()
  } catch (e: any) {
    ok = false
    cancelled = e instanceof JobCancelledError || e?.name === 'JobCancelledError' || isJobCancelled(jobId)
    errMsg = cancelled ? '已暂停并中止本次执行' : e?.message || String(e)
    if (!cancelled) {
      // 执行中可能被 pause 改成 paused，需从 map 取最新状态（勿被入口处的类型收窄误导）
      const live = jobs.get(jobId) || active
      live.lastError = errMsg
      if (live.status !== 'paused') live.status = 'error'
      persistJobs()
      console.error('[Scheduler] job failed', jobId, e)
    } else {
      active.lastError = undefined
      persistJobs()
      console.warn('[Scheduler] job cancelled by pause', jobId)
    }
    appendLog(jobId, false, errMsg || '执行失败', Date.now() - started)
  } finally {
    // 程序级收尾：各工具注册的回调（非 LLM）
    try {
      const hookResults = await runPostTaskCallbacks({
        reason: 'scheduler.job',
        jobId,
        profileId: active.profileId,
        sessionId: agentSessionId,
        ok,
        error: errMsg,
        meta: {
          name: active.name,
          url: active.url,
          cron: active.cron,
          cancelled
        }
      })
      if (hookResults.length) {
        const summary = hookResults
          .map((r) => `${r.id}${r.ok ? '✓' : `✗(${r.error || 'fail'})`}`)
          .join(' · ')
        appendLog(jobId, hookResults.every((r) => r.ok), `收尾：${summary}`)
      }
    } catch (e: any) {
      appendLog(jobId, false, `收尾异常：${e?.message || String(e)}`)
      console.error('[Scheduler] postTask hooks failed', jobId, e)
    }
    runningJobIds.delete(jobId)
    jobCancelFlags.delete(jobId)
  }
}

/** 停止调度；若正在执行则中止本轮（abort Agent + 走收尾关浏览器） */
function pauseJobInternal(jobId: string, active: Active) {
  try {
    active.task?.stop()
  } catch (_) {}
  active.task = null
  active.status = 'paused'
  persistJobs()
  const wasExecuting = runningJobIds.has(jobId)
  if (wasExecuting) {
    requestCancelJobRun(jobId)
    appendLog(jobId, true, '任务已暂停：已停止调度，并中止当前执行')
  } else {
    appendLog(jobId, true, '任务已暂停：已停止调度')
  }
}

function attachCron(meta: ScheduleJob): Active {
  let task: Cron | null = null
  if (meta.status !== 'paused') {
    task = new Cron(meta.cron, { paused: false }, () => {
      void runJob(meta.jobId)
    })
  }
  const active: Active = { ...meta, task }
  jobs.set(meta.jobId, active)
  return active
}

export function restoreScheduler() {
  try {
    const lp = logsPath()
    if (fs.existsSync(lp)) {
      const obj = JSON.parse(fs.readFileSync(lp, 'utf-8')) as Record<string, ScheduleLog[]>
      for (const [k, v] of Object.entries(obj || {})) {
        if (Array.isArray(v)) logsByJob.set(k, v)
      }
    }
  } catch (e) {
    console.warn('[Scheduler] restore logs failed', e)
  }

  try {
    const p = jobsPath()
    if (!fs.existsSync(p)) return
    const list = JSON.parse(fs.readFileSync(p, 'utf-8')) as ScheduleJob[]
    for (const raw of list) {
      if (!raw?.jobId || !raw.cron) continue
      const meta: ScheduleJob = {
        ...raw,
        name: raw.name || 'unnamed',
        description: typeof raw.description === 'string' ? raw.description : '',
        remark: typeof (raw as any).remark === 'string' ? (raw as any).remark : '',
        status: raw.status === 'paused' ? 'paused' : raw.status === 'error' ? 'error' : 'running'
      }
      try {
        attachCron(meta)
      } catch (e) {
        console.warn('[Scheduler] restore skip', meta.jobId, e)
      }
    }
    console.log('[Scheduler] restored', jobs.size)
  } catch (e) {
    console.warn('[Scheduler] restore failed', e)
  }
}

export function createJob(input: {
  name: string
  cron: string
  profileId: number | string
  url: string
  /** 大模型任务提示词 */
  description?: string
  /** 用户备注 */
  remark?: string
  /** false（默认）：存在相同 cron+url+环境时不新建，返回已有任务；true：允许再建一条 */
  allowDuplicate?: boolean
  fingerprint?: Record<string, any>
  proxy?: Record<string, any> | null
}): ScheduleJob & { alreadyExists?: boolean } {
  try {
    const probe = new Cron(input.cron)
    probe.stop()
  } catch {
    throw new Error(`非法 cron 表达式: ${input.cron}`)
  }
  const allowDuplicate = input.allowDuplicate === true
  const urlNorm = String(input.url || '').trim()
  const cronNorm = String(input.cron || '').trim()
  const pidNorm = String(input.profileId)
  if (!allowDuplicate) {
    for (const active of jobs.values()) {
      if (
        String(active.cron).trim() === cronNorm &&
        String(active.url).trim() === urlNorm &&
        String(active.profileId) === pidNorm
      ) {
        return { ...toPublicJob(active), alreadyExists: true }
      }
    }
  }
  const meta: ScheduleJob = {
    jobId: `job_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    name: input.name || 'unnamed',
    description: (input.description || '').trim(),
    remark: (input.remark || '').trim(),
    status: 'running',
    cron: input.cron,
    profileId: input.profileId,
    url: input.url,
    fingerprint: input.fingerprint,
    proxy: input.proxy ?? null,
    createdAt: new Date().toISOString()
  }
  attachCron(meta)
  persistJobs()
  appendLog(meta.jobId, true, '任务已创建并开始调度')
  return toPublicJob(jobs.get(meta.jobId)!)
}

function toPublicJob(active: Active): ScheduleJob {
  const { task: _t, ...meta } = active
  return {
    ...meta,
    executing: runningJobIds.has(meta.jobId)
  }
}

export function listJobs(): ScheduleJob[] {
  return [...jobs.values()]
    .map((j) => toPublicJob(j))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

export function getJob(jobId: string): ScheduleJob | null {
  const active = jobs.get(jobId)
  if (!active) return null
  return toPublicJob(active)
}

export function listJobLogs(jobId: string, limit = 100): ScheduleLog[] {
  const list = logsByJob.get(jobId) || []
  return list.slice(0, Math.max(1, Math.min(limit, MAX_LOGS_PER_JOB)))
}

export function setJobStatus(jobId: string, status: 'running' | 'paused'): ScheduleJob | null {
  const active = jobs.get(jobId)
  if (!active) return null
  if (status === 'paused') {
    pauseJobInternal(jobId, active)
  } else {
    jobCancelFlags.delete(jobId)
    try {
      active.task?.stop()
    } catch (_) {}
    active.task = new Cron(active.cron, { paused: false }, () => {
      void runJob(jobId)
    })
    active.status = 'running'
    if (active.lastError) active.lastError = undefined
    persistJobs()
    appendLog(jobId, true, '任务已恢复调度（空闲）')
  }
  return toPublicJob(active)
}

export function updateJob(
  jobId: string,
  patch: {
    name?: string
    cron?: string
    url?: string
    profileId?: number | string
    description?: string
    remark?: string
    status?: 'running' | 'paused'
    fingerprint?: Record<string, any>
    proxy?: Record<string, any> | null
  }
): ScheduleJob {
  const active = jobs.get(jobId)
  if (!active) throw new Error(`任务不存在: ${jobId}`)

  if (patch.cron != null && String(patch.cron).trim()) {
    const cron = String(patch.cron).trim()
    try {
      const probe = new Cron(cron)
      probe.stop()
    } catch {
      throw new Error(`非法 cron 表达式: ${cron}`)
    }
    active.cron = cron
  }
  if (patch.name != null && String(patch.name).trim()) {
    active.name = String(patch.name).trim()
  }
  if (patch.url != null && String(patch.url).trim()) {
    const url = String(patch.url).trim()
    if (!/^https?:\/\//i.test(url)) throw new Error('url 必须以 http(s):// 开头')
    active.url = url
  }
  if (patch.profileId != null && patch.profileId !== '') {
    active.profileId = patch.profileId
  }
  // description / remark 仅在显式传入时更新，避免改 cron 时冲掉模型提示词
  if (patch.description !== undefined) {
    active.description = String(patch.description ?? '').trim()
  }
  if (patch.remark !== undefined) {
    active.remark = String(patch.remark ?? '').trim()
  }
  if (active.remark == null) active.remark = ''
  if (patch.fingerprint !== undefined) active.fingerprint = patch.fingerprint
  if (patch.proxy !== undefined) active.proxy = patch.proxy

  const wantStatus = patch.status
  // 重建 cron：cron/恢复运行时需要；暂停则停表并中止在途执行
  try {
    active.task?.stop()
  } catch (_) {}
  active.task = null

  if (wantStatus === 'paused' || (wantStatus == null && active.status === 'paused')) {
    pauseJobInternal(jobId, active)
  } else {
    jobCancelFlags.delete(jobId)
    active.task = new Cron(active.cron, { paused: false }, () => {
      void runJob(jobId)
    })
    active.status = 'running'
    if (active.lastError) active.lastError = undefined
    persistJobs()
    appendLog(jobId, true, '任务已更新并调度')
  }

  return toPublicJob(active)
}

export function cancelJob(jobId: string): boolean {
  const active = jobs.get(jobId)
  if (!active) return false
  try {
    active.task?.stop()
  } catch (_) {}
  jobs.delete(jobId)
  persistJobs()
  appendLog(jobId, true, '任务已取消/删除')
  return true
}

export function runJobNow(jobId: string): boolean {
  if (!jobs.has(jobId)) return false
  void runJob(jobId)
  return true
}

export function shutdownScheduler() {
  for (const j of jobs.values()) {
    try {
      j.task?.stop()
    } catch (_) {}
  }
  for (const id of [...runningJobIds]) {
    requestCancelJobRun(id)
  }
  jobs.clear()
  runningJobIds.clear()
  jobCancelFlags.clear()
  jobAbortControllers.clear()
}
