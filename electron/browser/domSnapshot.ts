/**
 * 多模式 DOM / 页面采集 —— 由 Agent 选择需要的视图。
 * mode:
 *   a11y        精简无障碍树（默认，带优先级）
 *   interactive 可交互控件（a/button/input/select…）
 *   buttons     仅按钮
 *   forms       表单控件
 *   errors      错误/警告/状态提示（含「有误|失败|错误」等）
 *   text        可见文本大纲
 *   full        区域简化 HTML（有体积上限，仍尽量给可点 ref）
 */
import type { Page } from 'puppeteer-core'
import { captureA11ySnapshot, type A11ySnapshotResult, AI_REF_ATTR } from './a11ySnapshot'
import { capturePageSignature } from './pageSignature'

export const DOM_MODES = [
  'a11y',
  'interactive',
  'buttons',
  'forms',
  'errors',
  'text',
  'full'
] as const

export type DomMode = (typeof DOM_MODES)[number]

export type DomSnapshotResult = {
  title: string
  url: string
  mode: DomMode
  scope: string
  format: string
  tree: string
  truncated: boolean
  maxNodes: number
  pageSignature: string
  hasDialog: boolean
  loginHints: string[]
  ctaCandidates: Array<{ ref: string; name: string; role: string }>
  errorHints: string[]
  nodes?: Array<Record<string, any>>
  source: string
}

function normalizeMode(raw: unknown): DomMode {
  const m = String(raw || 'a11y')
    .trim()
    .toLowerCase()
    .replace(/[_-]/g, '')
  if (m === 'a11y' || m === 'accessibility' || m === 'ax') return 'a11y'
  if (m === 'interactive' || m === 'controls' || m === 'actionable') return 'interactive'
  if (m === 'buttons' || m === 'button') return 'buttons'
  if (m === 'forms' || m === 'form' || m === 'inputs') return 'forms'
  if (m === 'errors' || m === 'error' || m === 'alerts' || m === 'messages') return 'errors'
  if (m === 'text' || m === 'visibletext' || m === 'content') return 'text'
  if (m === 'full' || m === 'html' || m === 'raw' || m === 'dom') return 'full'
  return 'a11y'
}

type EvalNode = {
  ref: string
  tag: string
  role?: string
  name?: string
  text: string
  type?: string
  href?: string
}

async function clearRefs(page: Page) {
  await page.evaluate((attr) => {
    document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr))
  }, AI_REF_ATTR)
}

/** DOM 选择器模式采集（interactive / buttons / forms / errors / text / full） */
async function captureSelectorMode(
  page: Page,
  opts: {
    mode: Exclude<DomMode, 'a11y'>
    maxNodes: number
    scope: string
    selector?: string
    maxChars?: number
  }
): Promise<DomSnapshotResult> {
  const pageSig = await capturePageSignature(page)
  await clearRefs(page)

  const payload = await page.evaluate(
    (params: {
      mode: string
      maxNodes: number
      scope: string
      selector: string
      maxChars: number
      attr: string
    }) => {
      const { mode, maxNodes, scope, selector, maxChars, attr } = params
      const root: Element =
        (selector && document.querySelector(selector)) ||
        (scope === 'dialog'
          ? document.querySelector('[role="dialog"],[role="alertdialog"],[class*="login" i],[class*="modal" i]') ||
            document.body
          : document.body) ||
        document.documentElement

      const errRe =
        /有误|错误|失敗|失败|无效|無效|不正确|不正确|请重新|請重新|验证失败|驗證失敗|error|invalid|incorrect|failed|denied|拒绝|拒絕|不存在|已锁定|已鎖定/i
      const loginRe = /登录|登陸|注册|註冊|login|sign\s*in|退出|logout/i

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

      const labelOf = (el: Element) => {
        const html = el as HTMLElement
        return (
          html.getAttribute('aria-label') ||
          html.getAttribute('placeholder') ||
          html.getAttribute('title') ||
          (html as HTMLInputElement).value ||
          html.innerText ||
          html.textContent ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120)
      }

      let query = ''
      if (mode === 'buttons') {
        query = 'button, [role="button"], input[type="button"], input[type="submit"], a.button'
      } else if (mode === 'forms') {
        query =
          'input, textarea, select, label, [role="textbox"], [role="combobox"], [contenteditable="true"]'
      } else if (mode === 'errors') {
        query =
          '[role="alert"],[role="status"],[aria-live],.error,[class*="error" i],[class*="err" i],[class*="tip" i],[class*="toast" i],[class*="message" i],[class*="warn" i]'
      } else if (mode === 'interactive') {
        // Expanded heuristics inspired by browser-use ClickableElementDetector
        query = [
          'a',
          'button',
          'input',
          'textarea',
          'select',
          'summary',
          'details',
          'option',
          '[role="button"]',
          '[role="link"]',
          '[role="textbox"]',
          '[role="searchbox"]',
          '[role="combobox"]',
          '[role="menuitem"]',
          '[role="tab"]',
          '[role="checkbox"]',
          '[role="radio"]',
          '[role="switch"]',
          '[role="option"]',
          '[contenteditable="true"]',
          '[onclick]',
          '[tabindex]:not([tabindex="-1"])',
          '[class*="search" i]',
          'label'
        ].join(',')
      } else if (mode === 'text') {
        query = 'h1,h2,h3,h4,p,li,label,[role="heading"],[role="alert"],[role="status"]'
      }

      const nodes: Array<{
        ref: string
        tag: string
        role?: string
        name?: string
        text: string
        type?: string
        href?: string
      }> = []

      const pushEl = (el: Element) => {
        if (nodes.length >= maxNodes) return
        if (!isVisible(el) && mode !== 'errors') return
        const html = el as HTMLElement
        const text = labelOf(el)
        if (mode === 'errors') {
          if (!text) return
          // errors 模式：无关键字也可保留 role=alert；其它需命中失败词或红/醒目色
          const role = (html.getAttribute('role') || '').toLowerCase()
          const color = window.getComputedStyle(html).color
          const looksRed = /rgb\(\s*(2\d{2}|1[89]\d)\s*,\s*\d+/.test(color) || /#([ef][0-9a-f]{2}|c00|f00)/i.test(color)
          if (role !== 'alert' && role !== 'status' && !errRe.test(text) && !looksRed) return
        } else if (mode === 'text') {
          if (!text || text.length < 2) return
        } else if (!text && html.tagName !== 'INPUT' && html.tagName !== 'TEXTAREA' && html.tagName !== 'SELECT') {
          return
        }

        const ref = `e${nodes.length + 1}`
        html.setAttribute(attr, ref)
        nodes.push({
          ref,
          tag: html.tagName.toLowerCase(),
          role: html.getAttribute('role') || undefined,
          name: html.getAttribute('name') || undefined,
          type: html.getAttribute('type') || undefined,
          href: (html as HTMLAnchorElement).href || undefined,
          text
        })
      }

      if (mode === 'full') {
        // 简化 HTML：去掉 script/style，截断属性，保留可见结构
        const clone = root.cloneNode(true) as HTMLElement
        clone.querySelectorAll('script,style,noscript,svg,canvas,video,iframe').forEach((n) => n.remove())
        const walkStrip = (el: Element) => {
          ;[...el.attributes].forEach((a) => {
            const n = a.name.toLowerCase()
            if (
              n === 'href' ||
              n === 'name' ||
              n === 'type' ||
              n === 'role' ||
              n === 'placeholder' ||
              n === 'aria-label' ||
              n === 'value' ||
              n.startsWith('data-')
            ) {
              if ((a.value || '').length > 80) el.setAttribute(a.name, a.value.slice(0, 80) + '…')
              return
            }
            if (n === 'class' || n === 'id') {
              if ((a.value || '').length > 60) el.setAttribute(a.name, a.value.slice(0, 60) + '…')
              return
            }
            el.removeAttribute(a.name)
          })
          ;[...el.children].forEach((c) => walkStrip(c))
        }
        walkStrip(clone)
        let html = clone.innerHTML.replace(/\s+/g, ' ').trim()
        const truncated = html.length > maxChars
        if (truncated) html = html.slice(0, maxChars) + '\n<!-- truncated -->'

        // 同时给区域内可交互元素打 ref，便于操作
        const actionable = root.querySelectorAll(
          'a,button,input,textarea,select,[role="button"],[role="textbox"]'
        )
        actionable.forEach((el) => {
          if (nodes.length >= Math.min(maxNodes, 80)) return
          if (!isVisible(el)) return
          pushEl(el)
        })

        const tree = [
          `url: ${location.href}`,
          `title: ${document.title}`,
          `mode: full`,
          `html:`,
          html,
          nodes.length ? 'actionable:' : '',
          ...nodes.map((n) => `- ${n.tag}${n.text ? ` "${n.text}"` : ''} [ref=${n.ref}]`)
        ]
          .filter(Boolean)
          .join('\n')

        return {
          format: 'full-html',
          tree,
          nodes,
          truncated,
          errorHints: nodes.filter((n) => errRe.test(n.text)).map((n) => `${n.tag}:${n.text}[${n.ref}]`),
          loginHints: nodes.filter((n) => loginRe.test(n.text)).map((n) => `${n.tag}:${n.text}[${n.ref}]`),
          ctaCandidates: nodes
            .filter((n) => loginRe.test(n.text) && (n.tag === 'button' || n.role === 'button' || n.tag === 'a'))
            .map((n) => ({ ref: n.ref, name: n.text, role: n.role || n.tag }))
        }
      }

      // 非 full：按 query 收集
      const list = Array.from(root.querySelectorAll(query))
      // errors：额外扫可见文本节点父级
      if (mode === 'errors') {
        const extras: Element[] = []
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
        let cur = walker.nextNode()
        while (cur) {
          const el = cur as Element
          const t = labelOf(el)
          if (t && errRe.test(t) && isVisible(el) && (el as HTMLElement).children.length <= 3) {
            extras.push(el)
          }
          cur = walker.nextNode()
        }
        const merged = [...new Set([...list, ...extras])]
        merged.forEach((el) => pushEl(el))
      } else {
        list.forEach((el) => pushEl(el))
      }

      const tree = [
        `url: ${location.href}`,
        `title: ${document.title}`,
        `mode: ${mode}`,
        `nodes: ${nodes.length}`,
        ...nodes.map((n) => {
          const extra = [
            n.role ? `role=${n.role}` : '',
            n.type ? `type=${n.type}` : '',
            n.name ? `name=${n.name}` : ''
          ]
            .filter(Boolean)
            .join(' ')
          return `- ${n.tag}${extra ? `(${extra})` : ''}${n.text ? ` "${n.text}"` : ''} [ref=${n.ref}]`
        })
      ].join('\n')

      return {
        format: `dom-${mode}`,
        tree,
        nodes,
        truncated: list.length > nodes.length,
        errorHints: nodes.filter((n) => errRe.test(n.text)).map((n) => `${n.tag}:${n.text.slice(0, 60)}[${n.ref}]`),
        loginHints: nodes.filter((n) => loginRe.test(n.text)).map((n) => `${n.tag}:${n.text.slice(0, 40)}[${n.ref}]`),
        ctaCandidates: nodes
          .filter((n) => loginRe.test(n.text))
          .slice(0, 8)
          .map((n) => ({ ref: n.ref, name: n.text.slice(0, 40), role: n.role || n.tag }))
      }
    },
    {
      mode: opts.mode,
      maxNodes: opts.maxNodes,
      scope: opts.scope,
      selector: opts.selector || '',
      maxChars: Math.min(Math.max(Number(opts.maxChars) || 12000, 2000), 40000),
      attr: AI_REF_ATTR
    }
  )

  return {
    title: pageSig.title,
    url: pageSig.url,
    mode: opts.mode,
    scope: opts.scope,
    format: payload.format,
    tree: payload.tree,
    truncated: !!payload.truncated,
    maxNodes: opts.maxNodes,
    pageSignature: pageSig.signature,
    hasDialog: pageSig.hasDialog,
    loginHints: payload.loginHints || [],
    ctaCandidates: payload.ctaCandidates || [],
    errorHints: payload.errorHints || [],
    nodes: payload.nodes,
    source: 'dom-mode'
  }
}

export async function captureDomSnapshot(
  page: Page,
  opts?: {
    mode?: string
    maxNodes?: number
    scope?: string
    selector?: string
    maxChars?: number
    maxTreeChars?: number
  }
): Promise<DomSnapshotResult> {
  const mode = normalizeMode(opts?.mode)
  const maxNodes = Math.min(Math.max(Number(opts?.maxNodes) || 100, 10), 250)
  const scope = String(opts?.scope || 'auto').toLowerCase()

  const maxTreeChars = Math.min(Math.max(Number(opts?.maxTreeChars) || 40000, 2000), 80000)

  const capTree = <T extends DomSnapshotResult>(snap: T): T => {
    if (!snap.tree || snap.tree.length <= maxTreeChars) return snap
    return {
      ...snap,
      tree: snap.tree.slice(0, maxTreeChars) + '\n…(tree truncated)',
      truncated: true
    }
  }

  if (mode === 'a11y') {
    const ax: A11ySnapshotResult = await captureA11ySnapshot(page, { maxNodes, scope })
    // 从 tree/nodes 里抽错误提示
    const errRe =
      /有误|错误|失敗|失败|无效|無效|请重新|請重新|error|invalid|incorrect|failed/i
    const errorHints: string[] = []
    for (const n of ax.nodes || []) {
      const label = `${n.name || ''} ${n.value || ''}`.trim()
      if (errRe.test(label) || n.role === 'alert' || n.role === 'status') {
        errorHints.push(`${n.role}:${label.slice(0, 60)}[${n.ref}]`)
      }
    }
    return capTree({
      title: ax.title,
      url: ax.url,
      mode: 'a11y',
      scope: ax.scope,
      format: ax.format,
      tree: ax.tree + (errorHints.length ? `\nerrorHints: ${errorHints.slice(0, 8).join(' | ')}` : '\nerrorHints: (none)'),
      truncated: ax.truncated,
      maxNodes: ax.maxNodes,
      pageSignature: ax.pageSignature,
      hasDialog: ax.hasDialog,
      loginHints: ax.loginHints,
      ctaCandidates: ax.ctaCandidates,
      errorHints: errorHints.slice(0, 12),
      nodes: ax.nodes,
      source: 'cdp-accessibility'
    })
  }

  return capTree(
    await captureSelectorMode(page, {
      mode,
      maxNodes,
      scope,
      selector: opts?.selector,
      maxChars: opts?.maxChars
    })
  )
}
