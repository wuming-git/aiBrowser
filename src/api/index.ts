import axios from 'axios'
import { useAuthStore } from '@/stores/auth'

const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8080',
  timeout: 20000
})

http.interceptors.request.use((config) => {
  const auth = useAuthStore()
  if (auth.token) {
    config.headers.Authorization = `Bearer ${auth.token}`
  }
  return config
})

http.interceptors.response.use((res) => {
  const body = res.data
  if (body && typeof body.code === 'number' && body.code !== 0) {
    return Promise.reject(new Error(body.message || '请求失败'))
  }
  return body
})

export type ApiR<T> = { code: number; message: string; data: T }

export const authApi = {
  sendCode: (email: string, scene = 'register') =>
    http.post('/api/auth/send-code', { email, scene }) as Promise<ApiR<null>>,
  register: (payload: { email: string; password: string; code?: string }) =>
    http.post('/api/auth/register', payload) as Promise<ApiR<{ token: string; email: string; userId: number }>>,
  login: (payload: { email: string; password: string }) =>
    http.post('/api/auth/login', payload) as Promise<ApiR<{ token: string; email: string; userId: number }>>
}

export type Profile = {
  id: number
  name: string
  fingerprint?: Record<string, any>
  proxy?: Record<string, any>
  remark?: string
  updatedAt?: string
}

export const profileApi = {
  list: () => http.get('/api/profiles') as Promise<ApiR<Profile[]>>,
  get: (id: number) => http.get(`/api/profiles/${id}`) as Promise<ApiR<Profile>>,
  create: (payload: Partial<Profile>) => http.post('/api/profiles', payload) as Promise<ApiR<Profile>>,
  update: (id: number, payload: Partial<Profile>) =>
    http.put(`/api/profiles/${id}`, payload) as Promise<ApiR<Profile>>,
  remove: (id: number) => http.delete(`/api/profiles/${id}`) as Promise<ApiR<null>>,
  generateFp: (payload: { os?: string; region?: string; purpose?: string }) =>
    http.post('/api/ai/fingerprint/generate', payload) as Promise<ApiR<Record<string, any>>>
}

export type AgentStatus = {
  enabled: boolean
  ready: boolean
  model?: string
  baseUrl?: string
  useCustom?: boolean
  message?: string
  desktopOnline?: boolean
  desktopDevices?: number
}

export type LlmConfig = {
  useCustom: boolean
  baseUrl: string
  model: string
  apiKeyMasked?: string
  hasApiKey: boolean
  effective?: {
    baseUrl: string
    model: string
    source: string
    hasApiKey: boolean
  }
}

export type TokenUsageRecord = {
  id: number
  sessionId: string
  model?: string | null
  source: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  createdAt?: string | null
}

export type TokenUsagePayload = {
  freeQuota: number
  freeUsed: number
  freeRemaining: number
  exhausted: boolean
  percent: number
  records: TokenUsageRecord[]
  note?: string
}

export type AgentChatResult = {
  reply: string
  sessionId: string
  ready: boolean
  model?: string
  desktopOnline?: boolean
}

export type ChatHistoryItem = {
  role: 'user' | 'assistant'
  content: string
}

export type AgentStreamHandlers = {
  onToken?: (text: string) => void
  onThinking?: (text: string) => void
  /** 模型同轮思考/进展文本 */
  onProgress?: (text: string) => void
  onTool?: (payload: { phase: 'start' | 'end'; name?: string; detail?: string }) => void
}

type ChatPayload = {
  message: string
  sessionId?: string
  profileId?: number | null
  deviceId?: string | null
  /** 当前消息之前的对话上下文（同一对话框内最近若干条） */
  history?: ChatHistoryItem[]
}

function apiBase() {
  return import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8080'
}

async function readAgentSse(
  path: string,
  body: unknown,
  handlers?: AgentStreamHandlers
): Promise<AgentChatResult> {
  const auth = useAuthStore()
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {})
    },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`流式请求失败 HTTP ${res.status}`)
  if (!res.body) throw new Error('浏览器不支持流式响应')

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let eventName = 'message'
  let dataLines: string[] = []
  let donePayload: AgentChatResult | null = null

  const flushEvent = () => {
    if (!dataLines.length) {
      eventName = 'message'
      return
    }
    const raw = dataLines.join('\n')
    dataLines = []
    const name = eventName
    eventName = 'message'
    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (name === 'done') donePayload = parsed as AgentChatResult
    else if (name === 'error') {
      const msg = String(parsed?.message || '流式对话失败')
      const err = new Error(msg) as Error & { code?: string }
      err.code = parsed?.code ? String(parsed.code) : 'stream_error'
      throw err
    } else if (name === 'progress' && parsed?.text) handlers?.onProgress?.(String(parsed.text))
    else if (name === 'token' && parsed?.text) handlers?.onToken?.(String(parsed.text))
    else if (name === 'thinking' && parsed?.text) handlers?.onThinking?.(String(parsed.text))
    else if (name === 'tool') {
      handlers?.onTool?.({
        phase: parsed?.phase === 'end' ? 'end' : 'start',
        name: parsed?.name ? String(parsed.name) : undefined,
        detail: parsed?.detail != null ? String(parsed.detail) : undefined
      })
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split(/\r?\n/)
    buffer = parts.pop() || ''
    for (const line of parts) {
      if (line === '') {
        flushEvent()
        continue
      }
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
  }
  flushEvent()
  if (!donePayload) throw new Error('流式对话未收到完成事件')
  return donePayload
}

export const agentApi = {
  status: () => http.get('/api/agent/status') as Promise<ApiR<AgentStatus>>,
  getLlmConfig: () => http.get('/api/agent/llm-config') as Promise<ApiR<LlmConfig>>,
  putLlmConfig: (payload: {
    useCustom: boolean
    baseUrl?: string
    apiKey?: string | null
    model?: string
  }) => http.put('/api/agent/llm-config', payload) as Promise<ApiR<LlmConfig>>,
  getTokenUsage: (limit = 30) =>
    http.get('/api/agent/token-usage', { params: { limit } }) as Promise<ApiR<TokenUsagePayload>>,
  chat: (payload: ChatPayload) =>
    http.post('/api/agent/chat', payload, { timeout: 180000 }) as Promise<ApiR<AgentChatResult>>,
  chatStream: (payload: ChatPayload, handlers?: AgentStreamHandlers) =>
    readAgentSse('/api/agent/chat/stream', payload, handlers),
  suggestTitle: (message: string) =>
    http.post('/api/agent/title', { message }, { timeout: 30000 }) as Promise<
      ApiR<{ title: string }>
    >,
  desktopStatus: () =>
    http.get('/api/desktop/status') as Promise<ApiR<{ online: boolean; devices: number }>>,
  manifest: () => http.get('/api/tools/manifest') as Promise<ApiR<ToolManifestItem[]>>
}

export type ToolManifestItem = {
  name: string
  description: string
  location: 'server' | 'desktop'
}

export type UserSkillSummary = {
  name: string
  description: string
  layer: string
  tools: string[]
  source: 'system' | 'override' | 'custom'
  canReset: boolean
  canDelete: boolean
  updatedAt?: string | null
}

export type UserSkillDetail = UserSkillSummary & {
  content: string
  systemContent?: string | null
}

export const skillsApi = {
  list: () => http.get('/api/skills') as Promise<ApiR<UserSkillSummary[]>>,
  get: (name: string) => http.get(`/api/skills/${encodeURIComponent(name)}`) as Promise<ApiR<UserSkillDetail>>,
  template: (name = 'my-skill') =>
    http.get('/api/skills/template', { params: { name } }) as Promise<ApiR<{ content: string }>>,
  create: (payload: { name: string; content: string }) =>
    http.post('/api/skills', payload) as Promise<ApiR<UserSkillDetail>>,
  save: (name: string, content: string) =>
    http.put(`/api/skills/${encodeURIComponent(name)}`, { content }) as Promise<ApiR<UserSkillDetail>>,
  remove: (name: string) =>
    http.delete(`/api/skills/${encodeURIComponent(name)}`) as Promise<
      ApiR<{ deleted?: boolean; reset?: boolean; name: string }>
    >
}

export default http
