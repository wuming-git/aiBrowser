/**
 * 页面签名：用于动作前后对比。
 * 必须能感知：弹层内错误文案、表单填写、勾选状态等局部变化
 *（不能只取 body 文本前几十个字符，否则百度顶栏会盖住登录错误）。
 */
import type { Page } from 'puppeteer-core'

export type PageSignature = {
  url: string
  title: string
  hasDialog: boolean
  /** 短文本指纹（含弹层/错误优先） */
  textFingerprint: string
  /** 稳定对比键 */
  signature: string
}

export async function capturePageSignature(page: Page): Promise<PageSignature> {
  return page.evaluate(() => {
    const compact = (s: string, n: number) =>
      (s || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, n)

    const vw = window.innerWidth || 1
    const vh = window.innerHeight || 1

    const isVisibleDialog = (el: Element | null): el is HTMLElement => {
      if (!el || !(el instanceof HTMLElement)) return false
      const st = window.getComputedStyle(el)
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
        return false
      }
      const r = el.getBoundingClientRect()
      if (r.width < 160 || r.height < 100) return false
      // 接近全屏的根容器不算弹窗
      if (r.width * r.height >= vw * vh * 0.85) return false
      return true
    }

    // 收紧：role/dialog + 登录/passport 专用；去掉裸 [class*=modal]/[class*=login]
    const dialogCandidates = Array.from(
      document.querySelectorAll(
        [
          '[role="dialog"]',
          '[role="alertdialog"]',
          'dialog',
          '.passport-login-pop',
          '.passMod_dialog',
          '[class*="pass-form" i]',
          '[class*="login-form" i]',
          '[class*="tang-pass" i]',
          '[id*="TANGRAM__PSP" i]',
          '[class*="modal" i][class*="login" i]'
        ].join(',')
      )
    ) as HTMLElement[]

    const dialogEl = dialogCandidates.find(isVisibleDialog) || null
    const hasDialog = !!dialogEl

    // 错误/提示：优先从弹层与 alert 区域收集
    const errNodes = Array.from(
      document.querySelectorAll(
        [
          '[role="alert"]',
          '[aria-live]',
          '[class*="error" i]',
          '[class*="err" i]',
          '[class*="tip" i]',
          '[class*="toast" i]',
          '[class*="message" i]',
          '[class*="warn" i]',
          '.pass-form-item-error',
          '.passMod_error'
        ].join(',')
      )
    ) as HTMLElement[]
    const errText = compact(
      errNodes
        .map((el) => el.innerText || el.textContent || '')
        .filter(Boolean)
        .join(' | '),
      160
    )

    // 弹层可见文本（登录错误通常在这里，不在 body 开头）
    const dialogText = compact(dialogEl?.innerText || dialogEl?.textContent || '', 200)

    // 表单状态：输入长度/勾选，避免「已输入但签名不变」
    const formRoot = dialogEl || document
    const fields = Array.from(
      formRoot.querySelectorAll('input, textarea, select, [contenteditable="true"]')
    ) as HTMLElement[]
    const formBits = fields
      .slice(0, 24)
      .map((el) => {
        const tag = el.tagName.toLowerCase()
        const input = el as HTMLInputElement
        const type = (input.type || tag).toLowerCase()
        if (type === 'hidden') return ''
        const name = input.name || input.id || input.getAttribute('placeholder') || type
        const nameLow = String(name).toLowerCase()
        // 跳过 style/css 隐藏字段噪声（百度首页 s_*_css）
        if (/css|style|script|template/.test(nameLow)) return ''
        if (type === 'checkbox' || type === 'radio') {
          return `${name}:${input.checked ? 1 : 0}`
        }
        if (type === 'password') {
          const len = (input.value || '').length
          return `${name}:pwd${len}`
        }
        if (tag === 'select') {
          return `${name}:${(el as HTMLSelectElement).value || ''}`
        }
        if (el.isContentEditable) {
          return `${name}:c${compact(el.innerText || '', 20).length}`
        }
        const v = input.value || ''
        if (v.includes('<') || /<style/i.test(v)) return `${name}:t${v.length}`
        return `${name}:t${v.length}:${compact(v, 24)}`
      })
      .filter(Boolean)
      .join(',')

    const bodyHead = compact(document.body?.innerText || document.body?.textContent || '', 80)
    const title = document.title || ''

    // 指纹优先：错误 > 弹层 > 表单 > 正文头
    const textFingerprint = compact(
      [errText && `ERR:${errText}`, dialogText && `DLG:${dialogText}`, formBits && `FORM:${formBits}`, bodyHead]
        .filter(Boolean)
        .join(' || '),
      280
    )

    const signature = [
      location.origin + location.pathname,
      title.slice(0, 40),
      hasDialog ? 'dialog' : 'page',
      errText ? `e:${compact(errText, 64)}` : 'e:none',
      formBits ? `f:${compact(formBits, 72)}` : 'f:none',
      dialogText ? `d:${compact(dialogText, 64)}` : `b:${bodyHead.slice(0, 40)}`
    ].join('|')

    return {
      url: location.href,
      title,
      hasDialog,
      textFingerprint,
      signature
    }
  })
}

export function signatureChanged(before: PageSignature, after: PageSignature): boolean {
  return before.signature !== after.signature
}
