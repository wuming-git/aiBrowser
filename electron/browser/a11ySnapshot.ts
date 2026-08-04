/**
 * 精简无障碍快照 —— CDP Accessibility + 优先级排序。
 * 优先：弹层/对话框 > 登录等关键词 > 视口内 > 顶栏 > 其余。
 * 兼容自编译指纹 Chrome（remote-debugging-port）。
 */
import type { CDPSession, Page } from 'puppeteer-core'
import { capturePageSignature } from './pageSignature'

export const AI_REF_ATTR = 'data-ai-ref'

type AxValue = { type?: string; value?: string | boolean | number }
type AxNode = {
  nodeId: string
  ignored?: boolean
  role?: AxValue
  name?: AxValue
  description?: AxValue
  value?: AxValue
  backendDOMNodeId?: number
  childIds?: string[]
  properties?: Array<{ name: string; value?: AxValue }>
}

export type SnapshotNode = {
  ref: string
  role: string
  name: string
  value?: string
  states?: string[]
  depth: number
  score?: number
  reasons?: string[]
  inViewport?: boolean
  inDialog?: boolean
}

export type A11ySnapshotResult = {
  title: string
  url: string
  format: 'a11y-tree'
  tree: string
  nodes: SnapshotNode[]
  truncated: boolean
  maxNodes: number
  pageSignature: string
  hasDialog: boolean
  loginHints: string[]
  ctaCandidates: Array<{ ref: string; name: string; role: string }>
  scope: string
}

const INTERESTING_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'heading',
  'img',
  'image',
  'dialog',
  'alertdialog',
  'alert',
  'status',
  'progressbar',
  'treeitem'
])

const STATE_PROPS = new Set([
  'checked',
  'selected',
  'pressed',
  'expanded',
  'disabled',
  'readonly',
  'required',
  'modal',
  'busy',
  'invalid'
])

const PRIORITY_KEYWORDS =
  /登录|登陸|注册|註冊|账号|帳號|密码|密碼|验证码|驗證碼|短信|扫码|掃碼|同意|下一步|提交|确认|確定|手机号|手機|邮箱|郵箱|login|sign\s*in|sign\s*up|password|captcha|verify|account|logout|退出|头像|個人|个人中心|我的|有误|错误|失敗|失败|无效|無效|请重新|請重新|error|invalid|incorrect|failed/i

const CTA_KEYWORDS = /登录|登陸|注册|註冊|login|sign\s*in|sign\s*up|退出|logout/i
const ERROR_KEYWORDS =
  /有误|错误|失敗|失败|无效|無效|请重新|請重新|不正确|error|invalid|incorrect|failed|denied/i

function axStr(v?: AxValue): string {
  if (!v || v.value == null) return ''
  return String(v.value).trim()
}

function propMap(node: AxNode): Map<string, string | boolean | number> {
  const m = new Map<string, string | boolean | number>()
  for (const p of node.properties || []) {
    if (!p?.name || p.value?.value == null) continue
    m.set(p.name, p.value.value as string | boolean | number)
  }
  return m
}

function collectStates(node: AxNode): string[] {
  const props = propMap(node)
  const states: string[] = []
  for (const key of STATE_PROPS) {
    if (!props.has(key)) continue
    const v = props.get(key)
    if (v === true || v === 'true') states.push(key)
    else if (typeof v === 'string' && v && v !== 'false') states.push(`${key}=${v}`)
    else if (typeof v === 'number') states.push(`${key}=${v}`)
  }
  return states
}

function isInteresting(node: AxNode): boolean {
  if (node.ignored) return false
  const role = axStr(node.role).toLowerCase()
  if (!role || role === 'none' || role === 'generic' || role === 'Inline') return false
  if (INTERESTING_ROLES.has(role)) return true
  const name = axStr(node.name)
  if (name && (role === 'StaticText' || role === 'text' || role === 'LabelText')) return true
  return false
}

async function clearOldRefs(page: Page) {
  await page.evaluate((attr) => {
    document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr))
    document.querySelectorAll('[data-ai-tmp]').forEach((el) => el.removeAttribute('data-ai-tmp'))
  }, AI_REF_ATTR)
}

async function markBackendNode(
  client: CDPSession,
  backendDOMNodeId: number,
  attr: string,
  value: string
): Promise<boolean> {
  try {
    const resolved = (await client.send('DOM.resolveNode', {
      backendNodeId: backendDOMNodeId
    })) as { object?: { objectId?: string } }
    const objectId = resolved?.object?.objectId
    if (!objectId) return false
    const result = (await client.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function (attr, value) {
        if (!this || this.nodeType !== 1) return false;
        this.setAttribute(attr, value);
        return true;
      }`,
      arguments: [{ value: attr }, { value }],
      returnByValue: true
    })) as { result?: { value?: boolean } }
    return !!result?.result?.value
  } catch {
    return false
  }
}

type RankMeta = {
  tmpId: string
  inViewport: boolean
  inDialog: boolean
  topBar: boolean
  keyword: boolean
  visible: boolean
}

async function rankMarkedNodes(page: Page): Promise<Map<string, RankMeta>> {
  const list = await page.evaluate(() => {
    const vh = window.innerHeight || 800
    const vw = window.innerWidth || 1200
    const out: Array<{
      tmpId: string
      inViewport: boolean
      inDialog: boolean
      topBar: boolean
      keyword: boolean
      visible: boolean
    }> = []
    const kw =
      /登录|登陸|注册|註冊|账号|帳號|密码|密碼|验证码|驗證碼|短信|扫码|掃碼|login|sign\s*in|sign\s*up|password|captcha|verify|logout|退出/i
    document.querySelectorAll('[data-ai-tmp]').forEach((el) => {
      const html = el as HTMLElement
      const tmpId = html.getAttribute('data-ai-tmp') || ''
      const style = window.getComputedStyle(html)
      const rect = html.getBoundingClientRect()
      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0
      const inViewport =
        visible && rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw
      const inDialog = !!html.closest(
        '[role="dialog"],[role="alertdialog"],[class*="login" i],[class*="modal" i],[class*="popup" i]'
      )
      const topBar = visible && rect.top >= 0 && rect.top < Math.min(120, vh * 0.18)
      const label = (
        html.getAttribute('aria-label') ||
        html.getAttribute('placeholder') ||
        html.textContent ||
        html.getAttribute('name') ||
        ''
      ).trim()
      out.push({
        tmpId,
        inViewport,
        inDialog,
        topBar,
        keyword: kw.test(label),
        visible
      })
    })
    return out
  })
  const map = new Map<string, RankMeta>()
  for (const item of list) map.set(item.tmpId, item)
  return map
}

function scoreNode(
  role: string,
  name: string,
  rank?: RankMeta
): { score: number; reasons: string[] } {
  let score = 0
  const reasons: string[] = []
  const r = role.toLowerCase()
  if (rank?.inDialog) {
    score += 100
    reasons.push('dialog')
  }
  if (rank?.keyword || PRIORITY_KEYWORDS.test(name)) {
    score += 80
    reasons.push('keyword')
  }
  if (ERROR_KEYWORDS.test(name) || r === 'alert' || r === 'status') {
    score += 90
    reasons.push('error')
  }
  if (rank?.topBar) {
    score += 40
    reasons.push('topbar')
  }
  if (rank?.inViewport) {
    score += 30
    reasons.push('viewport')
  }
  if (rank?.visible === false) score -= 50
  if (['button', 'textbox', 'searchbox', 'link', 'checkbox', 'combobox'].includes(r)) score += 10
  if (r === 'dialog' || r === 'alertdialog') score += 50
  if (r === 'heading') score += 5
  return { score, reasons }
}

function formatNodeLine(n: SnapshotNode): string {
  const name = n.name ? ` "${n.name.replace(/\s+/g, ' ').slice(0, 80)}"` : ''
  const value = n.value != null && n.value !== '' ? ` value="${String(n.value).slice(0, 60)}"` : ''
  const states = n.states?.length ? ` [${n.states.join(', ')}]` : ''
  const tags: string[] = []
  if (n.inDialog) tags.push('dialog')
  if (n.inViewport) tags.push('view')
  if (n.reasons?.includes('keyword')) tags.push('key')
  const tagStr = tags.length ? ` {${tags.join(',')}}` : ''
  return `- ${n.role}${name}${value}${states}${tagStr} [ref=${n.ref}]`
}

type Collected = {
  role: string
  name: string
  value: string
  states: string[]
  depth: number
  backendDOMNodeId?: number
  tmpId?: string
  marked: boolean
}

/**
 * 采集精简 a11y 树：先全量候选打分，再截取高优先级节点并分配 ref。
 */
export async function captureA11ySnapshot(
  page: Page,
  opts?: { maxNodes?: number; scope?: string }
): Promise<A11ySnapshotResult> {
  const maxNodes = Math.min(Math.max(Number(opts?.maxNodes) || 100, 20), 200)
  const scope = String(opts?.scope || 'auto').toLowerCase()
  const pageSig = await capturePageSignature(page)
  const title = pageSig.title
  const url = pageSig.url

  await clearOldRefs(page)

  const client = await page.createCDPSession()
  try {
    await client.send('Accessibility.enable').catch(() => undefined)
    const tree = (await client.send('Accessibility.getFullAXTree')) as { nodes?: AxNode[] }
    const axNodes = tree.nodes || []
    const byId = new Map(axNodes.map((n) => [n.nodeId, n]))

    const childOf = new Set<string>()
    for (const n of axNodes) {
      for (const c of n.childIds || []) childOf.add(c)
    }
    const roots = axNodes.filter((n) => !childOf.has(n.nodeId))
    const root = roots[0] || axNodes[0]
    if (!root) {
      return {
        title,
        url,
        format: 'a11y-tree',
        tree: '(空页面)',
        nodes: [],
        truncated: false,
        maxNodes,
        pageSignature: pageSig.signature,
        hasDialog: pageSig.hasDialog,
        loginHints: [],
        ctaCandidates: [],
        scope
      }
    }

    const collected: Collected[] = []
    let tmpSeq = 0
    const COLLECT_CAP = 400

    const walk = async (nodeId: string, depth: number) => {
      if (collected.length >= COLLECT_CAP) return
      const node = byId.get(nodeId)
      if (!node) return

      if (isInteresting(node)) {
        const role = axStr(node.role) || 'unknown'
        const name = axStr(node.name) || axStr(node.description)
        const value = axStr(node.value)
        const states = collectStates(node)
        let marked = false
        let tmpId: string | undefined
        if (node.backendDOMNodeId != null) {
          tmpSeq += 1
          tmpId = `t${tmpSeq}`
          marked = await markBackendNode(client, node.backendDOMNodeId, 'data-ai-tmp', tmpId)
          if (!marked) tmpId = undefined
        }
        const keep =
          marked ||
          !!name ||
          !!value ||
          role.toLowerCase() === 'heading' ||
          role.toLowerCase() === 'alert' ||
          role.toLowerCase() === 'status'
        if (keep) {
          collected.push({
            role,
            name,
            value,
            states,
            depth,
            backendDOMNodeId: node.backendDOMNodeId,
            tmpId,
            marked
          })
        }
      }

      for (const childId of node.childIds || []) {
        if (collected.length >= COLLECT_CAP) break
        await walk(childId, depth + (isInteresting(node) ? 1 : 0))
      }
    }

    await walk(root.nodeId, 0)

    const ranks = await rankMarkedNodes(page)

    type Scored = Collected & {
      score: number
      reasons: string[]
      inViewport?: boolean
      inDialog?: boolean
    }

    let scored: Scored[] = collected.map((c) => {
      const rank = c.tmpId ? ranks.get(c.tmpId) : undefined
      const { score, reasons } = scoreNode(c.role, c.name || c.value, rank)
      return {
        ...c,
        score,
        reasons,
        inViewport: rank?.inViewport,
        inDialog: rank?.inDialog
      }
    })

    if (scope === 'dialog') {
      scored = scored.filter((s) => s.inDialog || s.reasons.includes('keyword'))
    } else if (scope === 'nav' || scope === 'topbar') {
      scored = scored.filter((s) => s.reasons.includes('topbar') || s.reasons.includes('keyword'))
    }

    scored.sort((a, b) => b.score - a.score || a.depth - b.depth)
    const truncated = scored.length > maxNodes
    const top = scored.slice(0, maxNodes)

    // 清理临时标记，写入正式 ref（按优先级 e1 最高）
    await page.evaluate(() => {
      document.querySelectorAll('[data-ai-tmp]').forEach((el) => el.removeAttribute('data-ai-tmp'))
    })

    const out: SnapshotNode[] = []
    let refSeq = 0
    for (const item of top) {
      let ref = `i${out.length + 1}`
      if (item.marked && item.backendDOMNodeId != null) {
        refSeq += 1
        const candidate = `e${refSeq}`
        const ok = await markBackendNode(client, item.backendDOMNodeId, AI_REF_ATTR, candidate)
        if (ok) ref = candidate
        else refSeq -= 1
      }
      out.push({
        ref,
        role: item.role,
        name: item.name,
        depth: item.depth,
        score: item.score,
        reasons: item.reasons,
        inViewport: item.inViewport,
        inDialog: item.inDialog,
        ...(item.value ? { value: item.value } : {}),
        ...(item.states.length ? { states: item.states } : {})
      })
    }

    const loginHints: string[] = []
    const ctaCandidates: Array<{ ref: string; name: string; role: string }> = []
    for (const n of out) {
      const label = `${n.name} ${n.value || ''}`.trim()
      if (PRIORITY_KEYWORDS.test(label)) {
        loginHints.push(`${n.role}:${label.slice(0, 40)}[${n.ref}]`)
      }
      if (n.ref.startsWith('e') && CTA_KEYWORDS.test(label)) {
        ctaCandidates.push({ ref: n.ref, name: label.slice(0, 40), role: n.role })
      }
    }

    const lines = [
      `url: ${url}`,
      `title: ${title}`,
      `signature: ${pageSig.signature}`,
      `hasDialog: ${pageSig.hasDialog}`,
      truncated ? `note: showing top ${maxNodes}/${scored.length} by priority` : `nodes: ${out.length}`,
      loginHints.length ? `loginHints: ${loginHints.slice(0, 8).join(' | ')}` : 'loginHints: (none)',
      'nodes (priority order):',
      ...out.map(formatNodeLine)
    ]

    return {
      title,
      url,
      format: 'a11y-tree',
      tree: lines.join('\n'),
      nodes: out,
      truncated,
      maxNodes,
      pageSignature: pageSig.signature,
      hasDialog: pageSig.hasDialog,
      loginHints: loginHints.slice(0, 12),
      ctaCandidates: ctaCandidates.slice(0, 8),
      scope
    }
  } finally {
    await client.detach().catch(() => undefined)
  }
}

export function refSelector(ref: string): string {
  const r = String(ref || '').trim()
  if (!/^e\d+$/i.test(r)) throw new Error(`无效 ref: ${ref}（应为 snapshot 返回的 eN）`)
  return `[${AI_REF_ATTR}="${r}"]`
}
