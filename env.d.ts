/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE: string
  /** 可选：更新源说明（实际检查由主进程 UPDATE_FEED_URL / 默认域名完成） */
  readonly VITE_UPDATE_FEED_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

type DesktopBridgeStatus = {
  connected: boolean
  connecting: boolean
  deviceId: string
  lastError?: string
  userId?: number
}

type ScheduleJobStatus = 'running' | 'paused' | 'error'

type ScheduleJob = {
  jobId: string
  name: string
  description: string
  remark: string
  status: ScheduleJobStatus
  cron: string
  profileId: number | string
  url: string
  createdAt: string
  lastRunAt?: string
  lastError?: string
  executing?: boolean
}

type ScheduleLog = {
  id: string
  jobId: string
  at: string
  ok: boolean
  message: string
  durationMs?: number
}

type AiBrowserApi = {
  launchBrowser: (payload: unknown) => Promise<{
    ok: boolean
    message?: string
    pid?: number
    running?: boolean
  }>
  closeBrowser: (profileId: string | number) => Promise<{ ok: boolean; running?: boolean }>
  listBrowsers: () => Promise<Array<{ profileId: string; pid: number }>>
  onBrowserStatus: (
    cb: (p: {
      profileId: string
      running: boolean
      pid?: number
      browsers: Array<{ profileId: string; pid: number }>
    }) => void
  ) => () => void
  getDeviceId: () => Promise<string>
  desktopStatus: () => Promise<DesktopBridgeStatus>
  desktopConnect: (opts: { token: string; apiBase: string }) => Promise<DesktopBridgeStatus>
  desktopDisconnect: () => Promise<DesktopBridgeStatus>
  schedulerList: () => Promise<ScheduleJob[]>
  schedulerLogs: (jobId: string, limit?: number) => Promise<ScheduleLog[]>
  schedulerSetStatus: (jobId: string, status: 'running' | 'paused') => Promise<ScheduleJob | null>
  schedulerCancel: (jobId: string) => Promise<{ ok: boolean }>
  schedulerRunNow: (jobId: string) => Promise<{ ok: boolean }>
  schedulerUpdate: (
    jobId: string,
    patch: {
      name?: string
      cron?: string
      url?: string
      profileId?: number | string
      description?: string
      remark?: string
      status?: 'running' | 'paused'
    }
  ) => Promise<ScheduleJob>
  filterSensitive: (text: string) => Promise<{ blocked: boolean; sensitiveHits: string[] }>
  contentScore: (text: string) => Promise<{
    score: number
    reasons: string[]
    hits: string[]
    hardStop: boolean
    needConsent: boolean
  }>
  getAppVersion: () => Promise<{ version: string; packaged: boolean }>
  checkForUpdates: () => Promise<{ ok: boolean; skipped?: boolean; message?: string; version?: string | null }>
  downloadUpdate: () => Promise<{ ok: boolean; skipped?: boolean; message?: string }>
  installUpdate: () => Promise<{ ok: boolean; message?: string }>
  onUpdateEvent: (
    cb: (
      payload:
        | { type: 'checking' }
        | { type: 'available'; version: string; releaseNotes?: string | null }
        | { type: 'not-available'; version: string }
        | { type: 'progress'; percent: number; transferred: number; total: number }
        | { type: 'downloaded'; version: string }
        | { type: 'error'; message: string }
        | { type: 'dev-skip'; message: string }
    ) => void
  ) => () => void
}

interface Window {
  aiBrowser: AiBrowserApi
  browser168: AiBrowserApi
  /** @deprecated 兼容旧名，请使用 browser168 / aiBrowser */
  yuntuo: AiBrowserApi
}
