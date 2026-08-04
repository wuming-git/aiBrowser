/** 把工具调用参数/结果转成用户可读的执行叙述 */

import { toolLabel } from '@/utils/toolLabels'

function parseJson(raw?: string | null): any {
  if (!raw) return null
  const s = String(raw).trim()
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function toolKey(name?: string | null) {
  return String(name || '')
    .trim()
    .replace(/\./g, '_')
}

function shortenUrl(url?: string | null) {
  const u = String(url || '').trim()
  if (!u) return ''
  try {
    const parsed = new URL(u)
    return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname)
  } catch {
    return u.length > 48 ? `${u.slice(0, 48)}…` : u
  }
}

/** 跨步骤上下文：用最近一次 snapshot 的 loginHints 改善点击叙述 */
let lastCtaByRef: Record<string, string> = {}

export function resetNarrativeContext() {
  lastCtaByRef = {}
}

function rememberSnapshotHints(data: any) {
  const next: Record<string, string> = {}
  const hints = data?.loginHints
  if (Array.isArray(hints)) {
    for (const h of hints) {
      if (typeof h !== 'string') continue
      const m = h.match(/^[^:]*:([^[\]]+)\[(e\d+)\]/)
      if (m) next[m[2]] = m[1].trim()
    }
  }
  const ctas = data?.ctaCandidates
  if (Array.isArray(ctas)) {
    for (const c of ctas) {
      if (c?.ref && c?.name) next[String(c.ref)] = String(c.name)
    }
  }
  if (Object.keys(next).length) lastCtaByRef = { ...lastCtaByRef, ...next }
}

function pickResult(data: any): any {
  if (!data || typeof data !== 'object') return data
  return data.result && typeof data.result === 'object' ? data.result : data
}

function hintNames(hints: unknown): string[] {
  if (!Array.isArray(hints)) return []
  return hints
    .map((h) => {
      if (typeof h === 'string') {
        const m = h.match(/:([^[\]]+)(?:\[|$)/)
        return (m?.[1] || h).trim()
      }
      if (h && typeof h === 'object' && 'name' in h) return String((h as any).name || '').trim()
      return ''
    })
    .filter(Boolean)
}

/** 工具开始时的进行中叙述 */
export function narrativeOnStart(name?: string | null, detail?: string | null): string {
  const key = toolKey(name)
  const args = parseJson(detail) || {}
  const url = args.url || args.URL

  switch (key) {
    case 'list_profiles':
      return '正在查看可用的浏览器环境…'
    case 'create_profile':
      return '正在创建新的浏览器环境…'
    case 'browser_launch': {
      const u = args.url ? String(args.url).trim() : ''
      if (!u) return '正在启动环境并打开 browser168.com…'
      const many = /[,，;；|\n]/.test(u) || u.startsWith('[')
      return many ? `正在启动环境并打开多个网站…` : `正在启动环境并打开 ${shortenUrl(u)}…`
    }
    case 'browser_open': {
      const u = url ? String(url).trim() : ''
      if (!u) return '正在打开环境并访问 browser168.com…'
      const many = /[,，;；|\n]/.test(u) || u.startsWith('[')
      return many ? `正在打开环境并访问多个网站…` : `正在打开环境并访问 ${shortenUrl(u)}…`
    }
    case 'browser_navigate':
      return url ? `正在导航到 ${shortenUrl(url)}…` : '正在进行页面导航…'
    case 'browser_snapshot': {
      const scope = args.scope ? `（${args.scope === 'dialog' ? '对话框区域' : args.scope}）` : ''
      const mode = args.mode === 'errors' ? '错误提示' : args.mode === 'forms' ? '表单' : '页面结构'
      return `正在查看${mode}${scope}…`
    }
    case 'browser_find': {
      const q = String(args.query || '').trim()
      return q ? `正在按文案查找「${q.slice(0, 24)}」…` : '正在查找登录等入口文案…'
    }
    case 'search_tools':
      return '正在查找可用技能…'
    case 'call_tool': {
      const n = String(args.name || '').trim()
      return n ? `正在执行扩展能力「${n}」…` : '正在执行扩展能力…'
    }
    case 'browser_click': {
      const ref = String(args.ref || '')
      const label = ref && lastCtaByRef[ref] ? lastCtaByRef[ref] : ''
      if (label) return `正在点击「${label}」…`
      return args.ref || args.selector ? '正在点击页面元素…' : '正在执行点击…'
    }
    case 'browser_type':
      return '正在填写表单内容…'
    case 'browser_hover':
      return '正在悬停目标元素…'
    case 'browser_scroll':
      return '正在滚动页面…'
    case 'browser_wait_for':
      return '正在等待页面元素出现…'
    case 'browser_press_key':
      return `正在按下按键${args.key ? ` ${args.key}` : ''}…`
    case 'browser_extract_text':
      return '正在提取页面文本…'
    case 'browser_download':
      return '正在下载文件…'
    case 'browser_close':
      return '正在关闭浏览器环境…'
    case 'shell_exec':
      return '正在执行命令…'
    case 'scheduler_create':
      return '正在创建定时任务…'
    case 'scheduler_list':
      return '正在查看定时任务…'
    case 'scheduler_update':
      return '正在更新定时任务…'
    case 'scheduler_cancel':
      return '正在取消定时任务…'
    case 'fs_read':
      return '正在读取文件…'
    case 'fs_write':
      return '正在保存文件…'
    case 'fs_list':
      return '正在查看文件夹…'
    case 'fs_mkdir':
      return '正在创建文件夹…'
    case 'fs_delete':
      return '正在删除文件…'
    case 'fs_workspace':
      return '正在查看工作目录…'
    default:
      return `正在${toolLabel(name)}…`
  }
}

/** 工具结束后的完成叙述（尽量带页面/操作细节） */
export function narrativeOnEnd(
  name?: string | null,
  inputDetail?: string | null,
  resultDetail?: string | null
): string {
  const key = toolKey(name)
  const args = parseJson(inputDetail) || {}
  const raw = parseJson(resultDetail)
  const data = pickResult(raw)
  const ok = raw?.ok !== false && data?.ok !== false

  if (!ok && (raw?.error || data?.error || data?.message)) {
    const code = raw?.error || data?.error
    if (code === 'missing_progress_thought' || code === 'missing_report_progress') {
      return '该步骤被跳过：模型未在同轮附带进展说明（已不再拦截，请重试）。'
    }
    return `操作失败：${raw?.error || data?.error || data?.message}`
  }

  const title = data?.title || data?.result?.title
  const pageUrl = data?.url || data?.result?.url || args.url
  const pageBit =
    title || pageUrl
      ? `当前页「${title || '未命名'}」${pageUrl ? `（${shortenUrl(pageUrl)}）` : ''}`
      : ''

  switch (key) {
    case 'list_profiles': {
      let list: any[] = []
      if (Array.isArray(raw)) list = raw
      else if (Array.isArray(data)) list = data
      else if (Array.isArray(data?.profiles)) list = data.profiles
      else if (Array.isArray(raw?.data)) list = raw.data
      const n = list.length
      if (n <= 0) return '未找到浏览器环境。'
      if (n === 1) return `已找到 1 个环境「${list[0]?.name || list[0]?.id || ''}」，将使用该环境。`
      return `已找到 ${n} 个环境；用户未指定时将使用第一个环境。`
    }
    case 'create_profile':
      return `已创建环境${data?.name || data?.id ? `「${data.name || data.id}」` : ''}。`
    case 'browser_launch':
      return pageBit
        ? `浏览器已启动，${pageBit}。`
        : '浏览器环境已启动。'
    case 'browser_open':
    case 'browser_navigate':
      return pageBit ? `网站已加载完毕：${pageBit}。` : '页面导航完成。'
    case 'browser_snapshot': {
      rememberSnapshotHints(data)
      const loginHints = hintNames(data?.loginHints || data?.ctaCandidates)
      const errors = Array.isArray(data?.errorHints) ? data.errorHints.filter(Boolean) : []
      const parts: string[] = ['已查看当前页面']
      if (data?.hasDialog) parts.push('检测到弹层/对话框')
      if (loginHints.length) {
        const names = [...new Set(loginHints)].slice(0, 4).join('、')
        parts.push(`发现可操作项：${names}`)
      }
      if (errors.length) parts.push(`发现提示：${errors.slice(0, 2).join('、')}`)
      if (pageUrl) parts.push(`位于 ${shortenUrl(pageUrl)}`)
      return `${parts.join('；')}。`
    }
    case 'browser_find': {
      const matches = Array.isArray(data?.matches)
        ? data.matches
        : Array.isArray(raw?.matches)
          ? raw.matches
          : Array.isArray(data?.result?.matches)
            ? data.result.matches
            : []
      for (const m of matches) {
        if (m?.ref && m?.text) lastCtaByRef[String(m.ref)] = String(m.text).slice(0, 40)
      }
      const n = matches.length
      if (!n) return '未找到匹配的页面文案。'
      const names = matches
        .slice(0, 3)
        .map((m: any) => String(m.text || m.ref || '').trim())
        .filter(Boolean)
      return `已找到 ${n} 处匹配${names.length ? `：${names.join('、')}` : ''}。`
    }
    case 'browser_click': {
      const ref = String(args.ref || data?.ref || '')
      const label = ref && lastCtaByRef[ref] ? lastCtaByRef[ref] : ''
      if (label) return `已点击「${label}」。`
      return '已完成点击。'
    }
    case 'browser_type': {
      // 不回显用户输入的账号/密码明文
      return '表单内容已填写完成。'
    }
    case 'browser_hover':
      return '已悬停目标元素。'
    case 'browser_scroll':
      return '页面滚动完成。'
    case 'browser_wait_for':
      return '目标元素已出现。'
    case 'browser_press_key':
      return `已按下按键${args.key ? ` ${args.key}` : ''}。`
    case 'browser_extract_text':
      return '页面文本提取完成。'
    case 'browser_download':
      return '文件下载已触发。'
    case 'browser_close':
      return '浏览器环境已关闭。'
    case 'search_tools': {
      const tools = Array.isArray(data?.tools)
        ? data.tools
        : Array.isArray(raw?.tools)
          ? raw.tools
          : Array.isArray(data)
            ? data
            : []
      const n = tools.length
      if (n > 0) return `已找到 ${n} 项可用技能。`
      return '已完成技能目录检索。'
    }
    case 'call_tool': {
      const n = String(args.name || data?.name || '').trim()
      return n ? `扩展能力「${n}」已执行完成。` : '扩展能力已执行完成。'
    }
    case 'scheduler_create':
      return '定时任务已创建。'
    case 'scheduler_list':
      return '定时任务列表已获取。'
    case 'scheduler_update':
      return '定时任务已更新。'
    case 'scheduler_cancel':
      return '定时任务已取消。'
    case 'shell_exec':
      return '系统命令已执行完成。'
    case 'fs_read':
      return '文件读取完成。'
    case 'fs_write':
      return '文件已保存。'
    case 'fs_list':
      return '文件夹内容已列出。'
    case 'fs_mkdir':
      return '文件夹已创建。'
    case 'fs_delete':
      return '文件已删除。'
    case 'fs_workspace':
      return '工作目录信息已获取。'
    case 'progress_guard':
      return String(resultDetail || '进度护栏触发，已停止重复操作。')
    default:
      return `${toolLabel(name)}已完成。`
  }
}

export function narrativePreview(lines: string[], max = 2): string {
  const clean = lines.map((s) => s.replace(/[…。]+$/g, '')).filter(Boolean)
  if (!clean.length) return ''
  if (clean.length <= max) return clean.join('；') + '。'
  return `${clean.slice(0, max).join('；')}等 ${clean.length} 步`
}
