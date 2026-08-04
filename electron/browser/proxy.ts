import ProxyChain from 'proxy-chain'

export type ProxyConfig = {
  enabled?: boolean
  type?: 'http' | 'https' | 'socks5'
  host?: string
  port?: number
  username?: string
  password?: string
}

type RunningProxy = {
  url: string
  server: InstanceType<typeof ProxyChain.Server>
}

const running = new Map<string, RunningProxy>()

export async function startLocalProxy(profileId: string, proxy?: ProxyConfig | null) {
  await stopLocalProxy(profileId)
  if (!proxy?.enabled || !proxy.host || !proxy.port) {
    return null
  }

  const auth =
    proxy.username && proxy.password
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
      : ''
  const type = proxy.type || 'http'
  const upstream = `${type}://${auth}${proxy.host}:${proxy.port}`

  const server = new ProxyChain.Server({
    port: 0,
    prepareRequestFunction: () => ({
      upstreamProxyUrl: upstream
    })
  })

  await server.listen()
  const port = server.port
  const url = `http://127.0.0.1:${port}`
  running.set(String(profileId), { url, server })
  return url
}

export async function stopLocalProxy(profileId: string) {
  const item = running.get(String(profileId))
  if (!item) return
  running.delete(String(profileId))
  try {
    await item.server.close(true)
  } catch (_) {}
}

export async function stopAllProxies() {
  const ids = [...running.keys()]
  await Promise.all(ids.map((id) => stopLocalProxy(id)))
}
