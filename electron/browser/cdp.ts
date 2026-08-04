import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      server.close((err) => (err ? reject(err) : resolve(port)))
    })
    server.on('error', reject)
  })
}

export async function waitDevToolsPort(userDataDir: string, timeoutMs = 20000): Promise<number> {
  const file = path.join(userDataDir, 'DevToolsActivePort')
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if (fs.existsSync(file)) {
        const port = Number(fs.readFileSync(file, 'utf-8').trim().split(/\r?\n/)[0])
        if (port > 0) return port
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('等待 Chrome DevTools 端口超时')
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.json()
}

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch (_) {}
      reject(new Error('CDP WebSocket 连接超时'))
    }, 12000)
    ws.once('open', () => {
      clearTimeout(timer)
      resolve(ws)
    })
    ws.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

class PageCdp {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

  constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data)) as { id?: number; result?: any; error?: any }
        if (msg.id == null || !this.pending.has(msg.id)) return
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else p.resolve(msg.result)
      } catch (_) {}
    })
  }

  send(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP timeout: ${method}`))
        }
      }, 45000)
    })
  }

  close() {
    try {
      this.ws.close()
    } catch (_) {}
  }
}

async function openPageCdp(debugPort: number): Promise<PageCdp> {
  const list = (await fetchJson(`http://127.0.0.1:${debugPort}/json/list`)) as Array<{
    type: string
    webSocketDebuggerUrl?: string
    url?: string
  }>
  const page =
    list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url || '').startsWith('chrome')) ||
    list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page?.webSocketDebuggerUrl) {
    throw new Error('未找到可调试的 Chrome 页面目标')
  }
  const ws = await connectWs(page.webSocketDebuggerUrl)
  return new PageCdp(ws)
}

/** 通过 CDP 导航并提取页面可见文本 */
export async function navigateAndExtractText(
  debugPort: number,
  url: string,
  maxChars = 8000
): Promise<{ title: string; url: string; text: string }> {
  const cdp = await openPageCdp(debugPort)
  try {
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Page.navigate', { url })
    await new Promise((r) => setTimeout(r, 2800))

    const evalResult = await cdp.send('Runtime.evaluate', {
      expression: `(() => ({
        title: document.title || '',
        href: location.href || '',
        text: (document.body && (document.body.innerText || document.body.textContent)) || ''
      }))()`,
      returnByValue: true
    })
    const value = evalResult?.result?.value || {}
    let text = String(value.text || '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…(truncated)`
    return {
      title: String(value.title || ''),
      url: String(value.href || url),
      text
    }
  } finally {
    cdp.close()
  }
}
