import { getDesktopApi } from '@/utils/desktopApi'

const apiBase = () => import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8080'

/** 登录后把 JWT 交给主进程，建立 /ws/desktop 混合工具通道 */
export async function connectDesktopSession(token: string) {
  const api = getDesktopApi()
  if (!api?.desktopConnect || !token) return null
  return api.desktopConnect({ token, apiBase: apiBase() })
}

export async function disconnectDesktopSession() {
  const api = getDesktopApi()
  if (!api?.desktopDisconnect) return null
  return api.desktopDisconnect()
}

export async function getPersistedDeviceId(): Promise<string> {
  const api = getDesktopApi()
  if (api?.getDeviceId) return api.getDeviceId()
  let id = localStorage.getItem('aiBrowser_deviceId')
  if (!id) {
    id = `web-${Math.random().toString(36).slice(2, 10)}`
    localStorage.setItem('aiBrowser_deviceId', id)
  }
  return id
}
