/** 把模型原始进展/回复整理成普通人可读的句子 */

const FIELD_KEYS =
  'progress|evaluation|next_goal|memory|plan|thought|thinking|action|observation|reasoning|goal|status|result|analysis'

const FIELD_LINE = new RegExp(`^\\s*(?:${FIELD_KEYS})\\s*[:：]\\s*.+$`, 'gim')

const FIELD_SPLIT = new RegExp(
  `(?:^|[\\s;；。])(?:${FIELD_KEYS})\\s*[:：]\\s*`,
  'i'
)

const FIELD_GLOBAL = new RegExp(`(?:^|\\s)(?:${FIELD_KEYS})\\s*[:：]\\s*`, 'gi')

/** 提取 progress 字段；用于「执行过程」时间线 */
export function humanizeAgentText(raw?: string | null): string {
  let s = String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  if (!s) return ''

  const progressHit = s.match(
    new RegExp(
      `(?:^|\\s|[;；])progress\\s*[:：]\\s*([\\s\\S]*?)(?=\\s*(?:${FIELD_KEYS})\\s*[:：]|$)`,
      'i'
    )
  )
  if (progressHit?.[1]?.trim()) {
    s = progressHit[1].trim()
  } else if (FIELD_SPLIT.test(s)) {
    const parts = s
      .split(new RegExp(`(?=(?:${FIELD_KEYS})\\s*[:：])`, 'i'))
      .map((part) => part.replace(FIELD_GLOBAL, '').trim())
      .filter(Boolean)
    parts.sort((a, b) => b.length - a.length)
    s = parts[0] || s.replace(FIELD_GLOBAL, '').trim()
  }

  s = s
    .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gi, ' ')
    .replace(/\b(act|ok|true|false|null|undefined)\b/gi, ' ')
    .replace(/快照确认/g, '已确认')
    .replace(/结果页\s*URL\s*为/gi, '结果页为')
    .replace(/URL\s*已?变为?/gi, '页面已跳转到')
    .replace(/\bURL\s*为/gi, '地址为')
    .replace(/\bURL\b/gi, '页面地址')
    .replace(/无前置目标/g, '')
    .replace(/初始状态[；;，,]?/g, '')
    .replace(/[（(]\s*[eE]\d+\s*[）)]/g, '')
    .replace(/\s*[·•|]\s*/g, '，')
    .replace(/[;；]{2,}/g, '；')
    .replace(/[，,]{2,}/g, '，')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[，,；;。.\s]+|[，,；;。.\s]+$/g, '')
    .trim()

  if (!s) return ''
  if (!/[。！？…]$/.test(s) && !/\.{3}$/.test(s)) s = `${s}。`
  return s
}

/**
 * 最终「回复」：去掉步进协议头，保留给用户看的正文
 *（与 chat.log 里模型完整回复的正文一致）
 */
export function displayAgentReply(raw?: string | null): string {
  let s = String(raw || '')
    .replace(/\r\n/g, '\n')
    .trim()
  if (!s) return '…'

  const lines = s.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i].trim()
    if (!line) {
      i += 1
      continue
    }
    if (new RegExp(`^(?:${FIELD_KEYS})\\s*[:：]`, 'i').test(line)) {
      i += 1
      continue
    }
    break
  }
  s = lines.slice(i).join('\n').trim()
  s = s.replace(FIELD_LINE, '').replace(/\n{3,}/g, '\n\n').trim()

  if (!s) return humanizeAgentText(raw) || '…'
  return s
}

/** 折叠条摘要：短句 + 步数 */
export function humanizeSummary(raw: string, stepBit?: string): string {
  const text = humanizeAgentText(raw)
  if (!text && !stepBit) return ''
  const short = text.length > 42 ? `${text.slice(0, 42)}…` : text.replace(/。$/, '')
  if (short && stepBit) return `${short} · ${stepBit}`
  return short || stepBit || ''
}
