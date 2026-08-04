/**
 * 按可见文案查找可点击/可聚焦 DOM，并打上 data-ai-ref。
 * 用于登录入口（「登录」「Sign in」等）不一定是 button 的场景。
 */
import type { Page } from 'puppeteer-core'
import { AI_REF_ATTR } from './a11ySnapshot'
import { capturePageSignature } from './pageSignature'

export type FindMatch = {
  ref: string
  tag: string
  role: string
  text: string
  href?: string
  score: number
  reason: string
}

export type FindByTextResult = {
  ok: true
  query: string[]
  matchMode: string
  count: number
  matches: FindMatch[]
  hint: string
  title: string
  url: string
  pageSignature: string
  hasDialog: boolean
}

/** 登录入口默认关键词（中英） */
export const LOGIN_ENTRY_QUERIES = [
  '登录',
  '登陸',
  '登入',
  'Sign in',
  'Sign In',
  'Log in',
  'Log In',
  'Login',
  'signin',
  'log in'
]

function splitQueries(query: string): string[] {
  const raw = String(query || '').trim()
  if (!raw) return [...LOGIN_ENTRY_QUERIES]
  return raw
    .split(/[|,，、]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20)
}

export async function findElementsByText(
  page: Page,
  opts?: {
    query?: string
    match?: string
    maxResults?: number
  }
): Promise<FindByTextResult> {
  const queries = splitQueries(opts?.query || '')
  const matchMode = String(opts?.match || 'contains').toLowerCase()
  const maxResults = Math.min(Math.max(Number(opts?.maxResults) || 12, 1), 40)
  const pageSig = await capturePageSignature(page)

  const payload = await page.evaluate(
    (params: {
      queries: string[]
      matchMode: string
      maxResults: number
      attr: string
    }) => {
      const { queries, matchMode, maxResults, attr } = params

      const isVisible = (el: Element) => {
        const html = el as HTMLElement
        const style = window.getComputedStyle(html)
        const rect = html.getBoundingClientRect()
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) !== 0 &&
          rect.width > 0 &&
          rect.height > 0
        )
      }

      const ownLabel = (el: Element) => {
        const html = el as HTMLElement
        const aria = html.getAttribute('aria-label') || ''
        const title = html.getAttribute('title') || ''
        const placeholder = html.getAttribute('placeholder') || ''
        const value = (html as HTMLInputElement).value || ''
        // 优先短标签：避免整块 nav 的 innerText 吞掉「登录」
        let text = ''
        if (html.childElementCount === 0) {
          text = (html.innerText || html.textContent || '').trim()
        } else {
          // 取直接文本节点
          const parts: string[] = []
          html.childNodes.forEach((n) => {
            if (n.nodeType === Node.TEXT_NODE) {
              const t = (n.textContent || '').trim()
              if (t) parts.push(t)
            }
          })
          text = parts.join(' ').trim()
          if (!text && html.children.length <= 2) {
            text = (html.innerText || '').replace(/\s+/g, ' ').trim()
          }
        }
        return (aria || title || placeholder || value || text).replace(/\s+/g, ' ').trim().slice(0, 80)
      }

      const matchText = (label: string, q: string) => {
        if (!label || !q) return false
        const a = label.toLowerCase()
        const b = q.toLowerCase()
        if (matchMode === 'exact') return a === b
        if (matchMode === 'regex') {
          try {
            return new RegExp(q, 'i').test(label)
          } catch {
            return a.includes(b)
          }
        }
        // contains：整词优先（「登录」不要误匹配超长段落里的噪声也可，但仍用 includes）
        return a.includes(b)
      }

      const clickableAncestor = (el: Element): Element => {
        let cur: Element | null = el
        for (let i = 0; i < 5 && cur; i++) {
          const tag = cur.tagName.toLowerCase()
          const role = (cur.getAttribute('role') || '').toLowerCase()
          const href = cur.getAttribute('href')
          if (
            tag === 'a' ||
            tag === 'button' ||
            tag === 'summary' ||
            role === 'button' ||
            role === 'link' ||
            role === 'menuitem' ||
            role === 'tab' ||
            (tag === 'input' &&
              ['button', 'submit', 'image'].includes(
                ((cur as HTMLInputElement).type || '').toLowerCase()
              )) ||
            cur.hasAttribute('onclick') ||
            (cur as HTMLElement).tabIndex >= 0
          ) {
            return cur
          }
          // 百度等站点常用 span/div 包一层可点父级
          if (href) return cur
          cur = cur.parentElement
        }
        return el
      }

      const scoreOf = (el: Element, label: string, q: string) => {
        let score = 10
        const tag = el.tagName.toLowerCase()
        const role = (el.getAttribute('role') || '').toLowerCase()
        if (tag === 'a' || tag === 'button' || role === 'button' || role === 'link') score += 40
        if (label.toLowerCase() === q.toLowerCase()) score += 30
        else if (label.length <= q.length + 6) score += 15
        const rect = (el as HTMLElement).getBoundingClientRect()
        // 顶栏/右上角登录入口加分（百度「登录」常见于此）
        if (rect.top < 120) score += 20
        if (rect.left > window.innerWidth * 0.55) score += 15
        // 搜索框/大 textarea 降权
        if (tag === 'textarea' || (tag === 'input' && (el as HTMLInputElement).type === 'search')) {
          score -= 50
        }
        if (role === 'searchbox' || role === 'textbox') score -= 30
        return score
      }

      // 清掉旧 ref，避免与上次 find/snapshot 冲突
      document.querySelectorAll(`[${attr}]`).forEach((n) => n.removeAttribute(attr))

      type Cand = {
        el: Element
        label: string
        q: string
        score: number
        reason: string
      }
      const cands: Cand[] = []
      const seen = new Set<Element>()

      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT)
      let node = walker.nextNode()
      while (node) {
        const el = node as Element
        if (isVisible(el)) {
          const label = ownLabel(el)
          if (label && label.length <= 40) {
            for (const q of queries) {
              if (!matchText(label, q)) continue
              const target = clickableAncestor(el)
              if (seen.has(target)) break
              seen.add(target)
              const tLabel = ownLabel(target) || label
              cands.push({
                el: target,
                label: tLabel,
                q,
                score: scoreOf(target, tLabel, q),
                reason: `text~"${q}"`
              })
              break
            }
          }
        }
        node = walker.nextNode()
      }

      cands.sort((a, b) => b.score - a.score)
      const top = cands.slice(0, maxResults)
      const matches = top.map((c, i) => {
        const ref = `e${i + 1}`
        ;(c.el as HTMLElement).setAttribute(attr, ref)
        const html = c.el as HTMLElement
        return {
          ref,
          tag: html.tagName.toLowerCase(),
          role: html.getAttribute('role') || html.tagName.toLowerCase(),
          text: c.label,
          href: (html as HTMLAnchorElement).href || undefined,
          score: c.score,
          reason: c.reason
        }
      })

      return { matches, queries }
    },
    {
      queries,
      matchMode,
      maxResults,
      attr: AI_REF_ATTR
    }
  )

  return {
    ok: true,
    query: payload.queries,
    matchMode,
    count: payload.matches.length,
    matches: payload.matches,
    hint:
      payload.matches.length > 0
        ? '优先点击 score 最高且文案贴近目标的 ref，再用 browser_click(ref=...)。'
        : '未找到匹配文案。可换 query（如「登录|Sign in」），或 browser_snapshot(mode=a11y|buttons|interactive)。',
    title: pageSig.title,
    url: pageSig.url,
    pageSignature: pageSig.signature,
    hasDialog: pageSig.hasDialog
  }
}
