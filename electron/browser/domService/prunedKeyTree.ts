/**
 * Ultra-compact "key node" DOM tree for LLM context.
 * Keeps hierarchy of interactive / error / short status nodes (+ few section shells),
 * with optional @x,y wxh and semantic c=/bg= colors.
 * Shape matches dom-compact-demo output/test.tree.key.txt.
 */
import type { EnhancedDOMTreeNode, SerializedDOMState, SimplifiedNode } from './types'
import { NodeType } from './types'

export type KeyTreeResult = {
  tree: string
  elementCount: number
  format: 'pruned-key-dom-tree-compact'
}

function normSpace(s: string): string {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function attr(node: EnhancedDOMTreeNode, ...names: string[]): string {
  const a = node.attributes || {}
  for (const n of names) {
    const v = a[n]
    if (v != null && String(v).trim()) return normSpace(String(v))
  }
  return ''
}

function shortId(elId: string): string {
  let s = elId || ''
  s = s.replace(/^TANGRAM__PSP_\d+__/i, '')
  s = s.replace(/^(pass-|passport-|tangram-)/i, '')
  if (s.length > 28) s = s.slice(0, 28)
  return s
}

function ownText(node: EnhancedDOMTreeNode, limit = 80): string {
  const parts: string[] = []
  for (const c of node.childrenNodes || []) {
    if (c.nodeType === NodeType.TEXT_NODE) {
      const t = normSpace(c.nodeValue || '')
      if (t) parts.push(t)
    }
  }
  return normSpace(parts.join(' ')).slice(0, limit)
}

function visibleText(node: EnhancedDOMTreeNode, limit = 80): string {
  const parts: string[] = []
  const walk = (n: EnhancedDOMTreeNode) => {
    if (n.nodeType === NodeType.TEXT_NODE) {
      const t = normSpace(n.nodeValue || '')
      if (t) parts.push(t)
      return
    }
    for (const c of n.childrenAndShadowRoots || []) walk(c)
  }
  walk(node)
  return normSpace(parts.join(' ')).slice(0, limit)
}

function childTagCount(node: EnhancedDOMTreeNode): number {
  return (node.childrenNodes || []).filter((c) => c.nodeType === NodeType.ELEMENT_NODE).length
}

function isHiddenNode(node: EnhancedDOMTreeNode): boolean {
  if (node.isVisible === false) return true
  const typ = attr(node, 'type').toLowerCase()
  if (typ === 'hidden') return true
  if (attr(node, 'aria-hidden').toLowerCase() === 'true') return true
  if (node.attributes && 'hidden' in node.attributes) return true
  const st = node.snapshotNode?.computedStyles || {}
  const display = String(st.display || '').toLowerCase()
  const vis = String(st.visibility || '').toLowerCase()
  if (display === 'none' || vis === 'hidden') return true
  const cls = attr(node, 'class').toLowerCase()
  if (/(^|[\s_-])(hidden|hide|invisible|pass-hide|ng-hide)([\s_-]|$)/.test(cls)) return true
  return false
}

function isErrorNode(node: EnhancedDOMTreeNode): boolean {
  const cls = attr(node, 'class').toLowerCase()
  const elId = attr(node, 'id').toLowerCase()
  const st = node.snapshotNode?.computedStyles || {}
  const color = String(st.color || '').toLowerCase().replace(/\s/g, '')
  const hinted =
    /error|errormsg|pass-error/.test(cls) ||
    /error/.test(elId) ||
    /rgb\(\s*2?\d{2},\s*[0-8]?\d,\s*[0-8]?\d/.test(color) ||
    color.includes('#f') && /red|e22|d33|c00|ff4|f443/.test(color)
  if (!hinted) return false
  const text = ownText(node, 100) || visibleText(node, 100)
  const descendants = countDescendants(node)
  if (descendants > 12) return false
  return text.length >= 2 && text.length <= 100
}

function countDescendants(node: EnhancedDOMTreeNode): number {
  let n = 0
  const walk = (el: EnhancedDOMTreeNode) => {
    for (const c of el.childrenAndShadowRoots || []) {
      if (c.nodeType === NodeType.ELEMENT_NODE) {
        n++
        walk(c)
      }
    }
  }
  walk(node)
  return n
}

function isKeyInteractive(sn: SimplifiedNode): boolean {
  if (sn.isInteractive && sn.selectorIndex != null) return true
  const node = sn.originalNode
  const tag = (node.tagName || '').toLowerCase()
  if (['a', 'button', 'input', 'textarea', 'select', 'label'].includes(tag)) {
    if (tag === 'input' && attr(node, 'type').toLowerCase() === 'hidden') return false
    return true
  }
  const role = attr(node, 'role').toLowerCase()
  if (['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'textbox', 'switch'].includes(role)) {
    return true
  }
  if (['span', 'div', 'li', 'p'].includes(tag)) {
    const elId = attr(node, 'id')
    const cid = `${elId} ${attr(node, 'class')}`.toLowerCase()
    if (/(wrapper|content|parent|container|main)$/i.test(elId)) return false
    if (isErrorNode(node)) return false
    if (/clearbtn|closebtn|close-btn|change|refreshbtn|timer/.test(cid)) return true
    if (/(^|[\s_-])(btn|button|link)([\s_-]|$)/.test(cid)) {
      const own = ownText(node, 20)
      if (own || childTagCount(node) <= 1) return true
    }
    // tab container vs tab item
    if (/(^|[\s_-])tab([\s_-]|$)/.test(cid)) {
      const own = ownText(node, 20)
      if (own || childTagCount(node) <= 1) return true
    }
    const own = ownText(node, 40)
    if (elId && own.length >= 1 && own.length <= 8 && countDescendants(node) <= 1) {
      if (!/(wrapper|content|main|form|tips?|error)$/i.test(elId)) return true
    }
  }
  return false
}

function isKeyLeaf(sn: SimplifiedNode): boolean {
  const node = sn.originalNode
  const tag = (node.tagName || '').toLowerCase()
  if (['script', 'style', 'noscript', 'svg', 'path', 'meta', 'link', 'img'].includes(tag)) {
    return false
  }
  // DomService 已标记可交互：优先保留（不要被 isVisible/壳层误杀）
  if (sn.isInteractive && sn.selectorIndex != null) return true
  if (isHiddenNode(node)) return false
  if (isKeyInteractive(sn) || isErrorNode(node)) return true
  if (tag === 'label') return true
  const own = ownText(node, 60)
  if (['p', 'span', 'div', 'h1', 'h2', 'h3', 'h4', 'li', 'strong', 'em'].includes(tag) && own) {
    if (own.length >= 2 && own.length <= 40 && childTagCount(node) <= 1 && countDescendants(node) <= 3) {
      return true
    }
  }
  return false
}

function isStructuralKeep(sn: SimplifiedNode): boolean {
  const node = sn.originalNode
  const role = attr(node, 'role').toLowerCase()
  if (role === 'dialog' || role === 'alertdialog') return true
  const elId = attr(node, 'id').toLowerCase()
  if (!elId) return false
  if (/(hidden|staticpage|wrapper|content|tip)/.test(elId)) return false
  if (
    /(passport-login|login-pop|componseleft|componseright|composeleft|composeright)/.test(elId)
  ) {
    return true
  }
  const tag = (node.tagName || '').toLowerCase()
  if (tag === 'form' && !elId.endsWith('sms')) return true
  return false
}

function isPassthrough(sn: SimplifiedNode): boolean {
  if (isKeyLeaf(sn) || isStructuralKeep(sn)) return false
  return true
}

function rgbToken(r: number, g: number, b: number): string {
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  if (mx < 40) return 'black'
  if (mn > 230) return 'white'
  if (mx - mn < 28) return 'gray'
  if (r >= g && r >= b && r - Math.max(g, b) >= 40) return g > 90 ? 'orange' : 'red'
  if (b >= r && b >= g && b - Math.max(r, g) >= 30) return 'blue'
  if (g >= r && g >= b && g - Math.max(r, b) >= 35) return 'green'
  if (r > 180 && g > 100 && b < 90) return 'orange'
  return 'gray'
}

function cssColorToken(css: string | undefined | null): string | null {
  if (!css) return null
  const s = String(css).trim().toLowerCase()
  if (!s || s === 'transparent' || s === 'inherit' || s === 'currentcolor') return null
  const m = s.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?/)
  if (!m) return null
  const r = +m[1]
  const g = +m[2]
  const b = +m[3]
  const a = m[4] !== undefined ? +m[4] : 1
  if (a < 0.08) return null
  return rgbToken(r, g, b)
}

function nodeBox(node: EnhancedDOMTreeNode): { x: number; y: number; w: number; h: number } | null {
  const b = node.snapshotNode?.bounds || node.absolutePosition
  if (!b) return null
  const w = Math.round(b.width || 0)
  const h = Math.round(b.height || 0)
  if (w < 1 && h < 1) return null
  return { x: Math.round(b.x || 0), y: Math.round(b.y || 0), w, h }
}

function formatBox(box: { x: number; y: number; w: number; h: number } | null): string {
  if (!box || (box.w <= 0 && box.h <= 0)) return ''
  return ` @${box.x},${box.y} ${box.w}x${box.h}`
}

function formatColor(c: string | null, bg: string | null, forceRed = false): string {
  const parts: string[] = []
  const fg = forceRed ? 'red' : c
  if (fg && fg !== 'black') parts.push(`c=${fg}`)
  if (bg && bg !== 'white' && bg !== 'transparent') parts.push(`bg=${bg}`)
  return parts.length ? ` ${parts.join(' ')}` : ''
}

function compactLine(sn: SimplifiedNode, depth: number): string | null {
  const node = sn.originalNode
  const tag = (node.tagName || '?').toLowerCase()
  const typ = attr(node, 'type').toLowerCase()
  const ph = attr(node, 'placeholder')
  const name = attr(node, 'name')
  const elId = attr(node, 'id')
  const role = attr(node, 'role')
  const aria = attr(node, 'aria-label', 'title')

  let text = ''
  if (tag === 'input') {
    if (typ === 'password') text = ''
    else if (typ === 'submit' || typ === 'button') text = attr(node, 'value')
    else text = attr(node, 'value')
  } else if (isErrorNode(node)) {
    text = visibleText(node, 40)
  } else {
    text = ownText(node, 40)
  }
  if (!text && aria) text = aria.slice(0, 24)
  if (['和', '或', '|', '/', '·'].includes(text)) text = ''

  if (tag === 'input' && typ === 'submit' && !text) text = '登录'
  if (elId && /clearbtn/i.test(elId) && !text) text = '清除'

  const attrParts: string[] = []
  if (role) attrParts.push(`role=${role}`)
  let needId = false
  if (elId) {
    const low = elId.toLowerCase()
    if (tag === 'form' || tag === 'div' || /login-pop|passport/.test(low)) needId = true
    else if (!text && !ph) needId = true
    else if (/clearbtn|close/.test(low)) needId = true
  }
  if (needId && elId) attrParts.push(`id=${shortId(elId)}`)
  if (name && tag === 'input') {
    const sid = elId ? shortId(elId) : ''
    if (name !== sid && !sid.toLowerCase().includes(name.toLowerCase())) {
      attrParts.push(`name=${name.slice(0, 20)}`)
    }
  }
  if (typ && typ !== 'text') attrParts.push(`type=${typ}`)
  if (ph) attrParts.push(`placeholder=${ph.slice(0, 28)}`)
  if (attr(node, 'checked') || node.attributes?.checked != null) {
    const ch = attr(node, 'checked').toLowerCase()
    if (!ch || ch === 'true' || ch === '') attrParts.push('checked')
  }

  let open = `<${tag}`
  if (attrParts.length) open += ` ${attrParts.join(' ')}`

  const ref =
    sn.selectorIndex != null ? `[ref=e${sn.selectorIndex}]` : ''

  let line: string
  if (tag === 'input' && !text) {
    line = `${ref}${open} />`
  } else if (text) {
    line = `${ref}${open}> ${text.slice(0, 40)}`
  } else {
    line = `${ref}${open} />`
  }

  const box = nodeBox(node)
  const st = node.snapshotNode?.computedStyles || {}
  const c = cssColorToken(st.color)
  const bg = cssColorToken(st.backgroundColor || st['background-color'])
  const leaf = isKeyLeaf(sn)
  const structural = isStructuralKeep(sn)
  if (leaf || structural) {
    line += formatBox(box)
    if (leaf || isErrorNode(node)) {
      line += formatColor(c, bg, isErrorNode(node))
    } else if (bg && bg !== 'white' && bg !== 'gray') {
      line += formatColor(null, bg)
    }
  }

  // drop empty shells without id/type/placeholder
  if (
    !leaf &&
    !structural &&
    /<(div|p|span|li)\s*\/>\s*$/.test(line.replace(/\s+@.*$/, '').replace(/\s+c=.*$/, ''))
  ) {
    return null
  }

  return `${' '.repeat(depth)}${line}`
}

function isHardSkip(sn: SimplifiedNode): boolean {
  /** 永不进入的节点（连子树也不看） */
  const tag = (sn.originalNode.tagName || '').toLowerCase()
  const nt = sn.originalNode.nodeType
  if (nt === NodeType.DOCUMENT_FRAGMENT_NODE) return false // shadow root：要往下走
  if (['script', 'style', 'noscript', 'svg', 'path', 'img', 'meta', 'link'].includes(tag)) {
    return true
  }
  return false
}

function isTransparentShell(sn: SimplifiedNode): boolean {
  /**
   * 与 browser_use serializeTree 对齐：
   * 壳自己不输出，但必须继续递归子节点（否则弹窗外包一层 shouldDisplay=false 会剪成空树）。
   */
  if (!sn.shouldDisplay) return true
  if (sn.excludedByParent) return true
  // 被 paint-order 忽略的非交互壳：不输出，仍看孩子
  if (sn.ignoredByPaintOrder && !(sn.isInteractive && sn.selectorIndex != null)) return true
  return false
}

/**
 * Build ultra-compact key DOM tree from DomService serialized state.
 */
export function keyTreeRepresentation(state: SerializedDOMState): KeyTreeResult {
  const root = state._root
  if (!root) {
    return {
      tree: 'Empty DOM tree (you might have to wait for the page to load)',
      elementCount: 0,
      format: 'pruned-key-dom-tree-compact',
    }
  }

  const keepCache = new WeakMap<SimplifiedNode, boolean>()

  const subtreeHasKey = (sn: SimplifiedNode): boolean => {
    if (keepCache.has(sn)) return keepCache.get(sn)!
    if (isHardSkip(sn)) {
      keepCache.set(sn, false)
      return false
    }
    // 透明壳：不看自己是否 leaf，只看子孙（对齐 browser_use 对 shouldDisplay=false 的处理）
    if (!isTransparentShell(sn) && isKeyLeaf(sn)) {
      keepCache.set(sn, true)
      return true
    }
    let ok = false
    for (const child of sn.children || []) {
      if (subtreeHasKey(child)) {
        ok = true
        break
      }
    }
    keepCache.set(sn, ok)
    return ok
  }

  const lines: string[] = []
  let emitted = 0

  const walk = (sn: SimplifiedNode, depth: number) => {
    if (depth > 18) return
    if (isHardSkip(sn)) return

    // 壳：不输出，同深度继续挖子节点
    if (isTransparentShell(sn)) {
      for (const child of sn.children || []) walk(child, depth)
      return
    }

    if (!subtreeHasKey(sn)) return

    if (isPassthrough(sn)) {
      for (const child of sn.children || []) walk(child, depth)
      return
    }

    const line = compactLine(sn, depth)
    if (!line) {
      for (const child of sn.children || []) walk(child, depth)
      return
    }

    // empty self-closing non-leaf → lift children
    const bare = line.trim()
    const selfClosing = / \/>\s*$/.test(bare.split(' @')[0] || bare)
    if (
      selfClosing &&
      !isKeyLeaf(sn) &&
      !isStructuralKeep(sn) &&
      !bare.includes('type=') &&
      !bare.includes('placeholder=')
    ) {
      for (const child of sn.children || []) walk(child, depth)
      return
    }

    lines.push(line)
    emitted++

    if (isErrorNode(sn.originalNode)) {
      for (const child of sn.children || []) {
        if (isHardSkip(child) || isTransparentShell(child)) {
          walk(child, depth + 1)
          continue
        }
        if (!isKeyInteractive(child) && !isKeyLeaf(child)) {
          // 仍可能包着可点链接
          if (subtreeHasKey(child)) walk(child, depth + 1)
          continue
        }
        const cl = compactLine(child, depth + 1)
        if (cl) {
          lines.push(cl)
          emitted++
        } else {
          walk(child, depth + 1)
        }
      }
      return
    }

    for (const child of sn.children || []) walk(child, depth + 1)
  }

  walk(root, 0)

  return {
    tree: lines.join('\n'),
    elementCount: emitted,
    format: 'pruned-key-dom-tree-compact',
  }
}

/** Fallback: compress an existing browser-use LLM tree string into a flatter key-ish list. */
export function pruneLlmTreeText(tree: string, maxLines = 80): string {
  const lines = String(tree || '').split('\n')
  const out: string[] = []
  for (const line of lines) {
    const t = line.trimEnd()
    if (!t.trim()) continue
    // keep interactive refs, errors, short text rows, forms/dialogs
    if (
      /\[ref=e\d+\]/.test(t) ||
      /type=password|type=submit|type=checkbox|placeholder=|role=dialog/i.test(t) ||
      /用户名或密码|登录|验证码|忘记密码|阅读并接受|error/i.test(t)
    ) {
      // normalize tab indent → single spaces by depth
      const m = t.match(/^(\t*)/)
      const depth = m ? m[1].length : 0
      out.push(`${' '.repeat(depth)}${t.replace(/^\t+/, '')}`)
    }
    if (out.length >= maxLines) break
  }
  return out.join('\n')
}
