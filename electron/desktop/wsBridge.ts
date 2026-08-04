import WebSocket from 'ws'
import { getDeviceId } from './deviceId'
import { executeTool, type ToolInvocation } from './toolRuntime'

export type DesktopBridgeStatus = {
  connected: boolean
  connecting: boolean
  deviceId: string
  lastError?: string
  userId?: number
}

type ConnectOpts = {
  token: string
  apiBase: string
}

let socket: WebSocket | null = null
let pingTimer: NodeJS.Timeout | null = null
let reconnectTimer: NodeJS.Timeout | null = null
let reconnectAttempt = 0
let intentionalClose = false
let currentOpts: ConnectOpts | null = null
let status: DesktopBridgeStatus = {
  connected: false,
  connecting: false,
  deviceId: ''
}

function toWsBase(apiBase: string): string {
  const u = new URL(apiBase)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/ws/desktop'
  u.search = ''
  u.hash = ''
  return u.toString().replace(/\/$/, '')
}

function setStatus(patch: Partial<DesktopBridgeStatus>) {
  status = { ...status, ...patch }
  console.log('[DesktopWS]', status.connected ? 'online' : status.connecting ? 'connecting' : 'offline', {
    deviceId: status.deviceId,
    err: status.lastError
  })
}

function clearTimers() {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function send(obj: unknown) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify(obj))
}

async function handleMessage(raw: string) {
  let msg: any
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  const type = msg?.type
  if (type === 'connected') {
    setStatus({
      connected: true,
      connecting: false,
      userId: msg.userId,
      lastError: undefined
    })
    return
  }
  if (type === 'ping') {
    send({ type: 'pong' })
    return
  }
  if (type === 'pong') return
  if (type === 'tool.invoke') {
    const invocation = msg.payload as ToolInvocation
    console.log('[DesktopWS] tool.invoke', invocation?.tool, invocation?.invocationId)
    const result = await executeTool(invocation)
    send({ type: 'tool.result', payload: result })
    console.log('[DesktopWS] tool.result', result.ok, result.error || 'ok', `${result.durationMs}ms`)
  }
}

function scheduleReconnect() {
  if (intentionalClose || !currentOpts) return
  const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempt))
  reconnectAttempt += 1
  console.log(`[DesktopWS] reconnect in ${delay}ms (attempt ${reconnectAttempt})`)
  reconnectTimer = setTimeout(() => {
    void connectDesktop(currentOpts!)
  }, delay)
}

export function getDesktopStatus(): DesktopBridgeStatus {
  if (!status.deviceId) {
    try {
      status.deviceId = getDeviceId()
    } catch (_) {
      status.deviceId = 'unknown'
    }
  }
  return { ...status }
}

/** 定时任务触发 Agent 时复用桌面已登录凭据 */
export function getDesktopCredentials(): {
  token: string
  apiBase: string
  deviceId: string
} | null {
  if (!currentOpts?.token || !currentOpts?.apiBase) return null
  if (!status.deviceId) {
    try {
      status.deviceId = getDeviceId()
    } catch (_) {
      status.deviceId = 'unknown'
    }
  }
  return {
    token: currentOpts.token,
    apiBase: currentOpts.apiBase.replace(/\/$/, ''),
    deviceId: status.deviceId
  }
}

export async function connectDesktop(opts: ConnectOpts): Promise<DesktopBridgeStatus> {
  intentionalClose = false
  currentOpts = opts
  if (!status.deviceId) status.deviceId = getDeviceId()

  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return getDesktopStatus()
  }

  clearTimers()
  setStatus({ connecting: true, connected: false, lastError: undefined })

  const url = `${toWsBase(opts.apiBase)}?token=${encodeURIComponent(opts.token)}&deviceId=${encodeURIComponent(status.deviceId)}`
  console.log('[DesktopWS] connecting', url.replace(/token=[^&]+/, 'token=***'))

  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(url)
      socket = ws

      ws.on('open', () => {
        reconnectAttempt = 0
        setStatus({ connecting: false, connected: true, lastError: undefined })
        pingTimer = setInterval(() => send({ type: 'ping' }), 25000)
        resolve(getDesktopStatus())
      })

      ws.on('message', (data) => {
        void handleMessage(String(data))
      })

      ws.on('close', () => {
        socket = null
        clearTimers()
        setStatus({ connected: false, connecting: false })
        scheduleReconnect()
      })

      ws.on('error', (err) => {
        setStatus({ lastError: err.message || String(err), connecting: false })
        console.error('[DesktopWS] error', err.message)
      })

      setTimeout(() => {
        if (!status.connected) resolve(getDesktopStatus())
      }, 8000)
    } catch (e: any) {
      setStatus({
        connecting: false,
        connected: false,
        lastError: e?.message || String(e)
      })
      scheduleReconnect()
      resolve(getDesktopStatus())
    }
  })
}

export async function disconnectDesktop(): Promise<DesktopBridgeStatus> {
  intentionalClose = true
  currentOpts = null
  clearTimers()
  if (socket) {
    try {
      socket.close()
    } catch (_) {}
    socket = null
  }
  setStatus({ connected: false, connecting: false })
  return getDesktopStatus()
}
