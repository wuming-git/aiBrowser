export type DesktopBridgeStatus = {
  connected: boolean
  connecting: boolean
  deviceId: string
  lastError?: string
  userId?: number
}

export type ScheduleJobStatus = 'running' | 'paused' | 'error'

export type ScheduleJob = {
  jobId: string
  name: string
  /** 大模型任务提示词 */
  description: string
  /** 用户备注 */
  remark: string
  status: ScheduleJobStatus
  cron: string
  profileId: number | string
  url: string
  createdAt: string
  lastRunAt?: string
  lastError?: string
  /** 本轮是否正在执行（列表显示「执行中」） */
  executing?: boolean
}

export type ScheduleLog = {
  id: string
  jobId: string
  at: string
  ok: boolean
  message: string
  durationMs?: number
}

export type ContentScoreResult = {
  score: number
  reasons: string[]
  hits: string[]
  hardStop: boolean
  needConsent: boolean
}

export type BrowserRuntimeInfo = { profileId: string; pid: number }

export type BrowserStatusEvent = {
  profileId: string
  running: boolean
  pid?: number
  browsers: BrowserRuntimeInfo[]
}

export type UpdateEventPayload =
  | { type: 'checking' }
  | { type: 'available'; version: string; releaseNotes?: string | null }
  | { type: 'not-available'; version: string }
  | { type: 'progress'; percent: number; transferred: number; total: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }
  | { type: 'dev-skip'; message: string }

export type AiBrowserApi = {
  launchBrowser: (payload: unknown) => Promise<{
    ok: boolean
    message?: string
    pid?: number
    running?: boolean
  }>
  closeBrowser: (profileId: string | number) => Promise<{ ok: boolean; running?: boolean }>
  listBrowsers: () => Promise<BrowserRuntimeInfo[]>
  onBrowserStatus: (cb: (p: BrowserStatusEvent) => void) => () => void
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
  contentScore: (text: string) => Promise<ContentScoreResult>
  getAppVersion: () => Promise<{ version: string; packaged: boolean }>
  checkForUpdates: () => Promise<{ ok: boolean; skipped?: boolean; message?: string; version?: string | null }>
  downloadUpdate: () => Promise<{ ok: boolean; skipped?: boolean; message?: string }>
  installUpdate: () => Promise<{ ok: boolean; message?: string }>
  onUpdateEvent: (cb: (payload: UpdateEventPayload) => void) => () => void
}

export function getDesktopApi(): AiBrowserApi | null {
  const w = window as unknown as Window & {
    aiBrowser?: AiBrowserApi
    browser168?: AiBrowserApi
    yuntuo?: AiBrowserApi
  }
  return w.aiBrowser || w.browser168 || w.yuntuo || null
}

/** Electron IPC 不能传 Vue Proxy，需转成可结构化克隆的纯对象 */
export function toIpcPayload<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}
