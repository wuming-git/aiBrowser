/**
 * Dialog focus: prefer DOM of the popup roughly at viewport center.
 * Position is the primary signal; content heuristics are only a fallback.
 */
import type { Page } from 'puppeteer-core'

export type DomScope = 'auto' | 'dialog' | 'page' | 'full'

export type CenteredDialogHit = {
  /** data-ai-ref values inside the centered dialog subtree */
  refs: string[]
  /** element ids (for blocks that may not have stamped refs on the root) */
  ids: string[]
  centerScore: number
  width: number
  height: number
  tag?: string
  role?: string
}

export type DialogFocusResult = {
  tree: string
  scoped: boolean
  scope: DomScope
  reason?: string
  dialogScore?: number
  omittedBlocks?: number
}

type Block = {
  start: number
  text: string
  score: number
  kind: 'dialog' | 'ad' | 'chrome' | 'other'
}

const PROMOTE =
  /passport|tangram__psp|pass-phoenix|login-pop|passMod_|账号登录|密码登录|短信登录|扫码登录|用户名或密码|忘记密码|立即注册|阅读并接受|用户协议|隐私政策|type=password|placeholder=密码|placeholder=手机号|placeholder=邮箱|验证码|滑块|captcha|alertdialog|modal-login|auth-modal|登录弹窗|登录框|\bSign[\s-]?[Ii]n\b|\bLog[\s-]?[Ii]n\b/i

const DEMOTE_AD =
  /广告|adv-|advertise|advertisement|ad-modal|ad_popup|adpopup|promo|优惠券|红包|领取福利|限时特惠|弹窗广告|close-ad|ad-close|floating-ad|interstitial|今日推荐弹窗/i

const CHROME =
  /id=wrapper|id=head\b|hotsearch|s-top-left|chat-textarea|chat-submit|关于百度|京ICP|footer|s_qrcode_nologin/i

function splitTopLevelBlocks(tree: string): string[] {
  const lines = String(tree || '').split('\n')
  const blocks: string[] = []
  let cur: string[] = []
  for (const line of lines) {
    if (!line.trim()) {
      if (cur.length) cur.push(line)
      continue
    }
    // top-level: no leading whitespace (supports tab or single-space key-tree indent)
    const indentLen = (line.match(/^[ \t]*/)?.[0] || '').length
    const isTop = indentLen === 0
    if (isTop && cur.length) {
      blocks.push(cur.join('\n'))
      cur = [line]
    } else {
      cur.push(line)
    }
  }
  if (cur.length) blocks.push(cur.join('\n'))
  return blocks
}

function scoreBlock(text: string): { score: number; kind: Block['kind'] } {
  let score = 0
  score += (text.match(new RegExp(PROMOTE.source, 'gi')) || []).length * 8
  score -= (text.match(new RegExp(DEMOTE_AD.source, 'gi')) || []).length * 12
  if (/type=password|placeholder=密码|name=password|name=userName/i.test(text)) score += 25
  if (/账号登录|短信登录|扫码登录|\bSign[\s-]?[Ii]n\b|\bLog[\s-]?[Ii]n\b/i.test(text)) score += 18
  if (/用户名或密码有误|请重新输入|验证码|滑块/i.test(text)) score += 15
  if (/TANGRAM__PSP|passport-login|pass-phoenix/i.test(text)) score += 20
  if (DEMOTE_AD.test(text) && !/type=password|账号登录|passport/i.test(text)) {
    return { score: score - 30, kind: 'ad' }
  }
  if (score >= 30) return { score, kind: 'dialog' }
  if (CHROME.test(text) && score < 20) return { score: Math.min(score, 2), kind: 'chrome' }
  return { score, kind: 'other' }
}

/**
 * Find the best dialog/panel whose geometric center is near the viewport center.
 */
export async function detectCenteredDialog(page: Page): Promise<CenteredDialogHit | null> {
  try {
    return await page.evaluate(() => {
      const vw = window.innerWidth || 1
      const vh = window.innerHeight || 1
      const cx = vw / 2
      const cy = vh / 2

      type Cand = {
        el: Element
        centerScore: number
        area: number
        width: number
        height: number
        role: string
        z: number
      }

      const isVisible = (el: Element) => {
        const st = window.getComputedStyle(el)
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
          return false
        }
        const r = el.getBoundingClientRect()
        return r.width >= 80 && r.height >= 60
      }

      const centerDist = (r: DOMRect) => {
        const elCx = r.left + r.width / 2
        const elCy = r.top + r.height / 2
        const dx = Math.abs(elCx - cx) / vw
        const dy = Math.abs(elCy - cy) / vh
        return { dx, dy, score: 1 - (dx * 1.2 + dy * 1.2) }
      }

      const looksLikePanel = (el: Element, r: DOMRect) => {
        // reject near-fullscreen dimmers / page roots
        if (r.width >= vw * 0.96 && r.height >= vh * 0.96) return false
        if (el === document.body || el === document.documentElement) return false
        // reject tiny corner widgets
        if (r.width < 160 || r.height < 100) return false
        // reject wide short search bars / homepage hero forms (百度首页误判主因)
        const idCls = `${(el as HTMLElement).id || ''} ${(el as HTMLElement).className || ''}`.toLowerCase()
        if (
          r.height < 200 &&
          r.width > vw * 0.35 &&
          !/dialog|modal|popup|passport|login|pass-|tangram/i.test(idCls) &&
          (el.querySelector('textarea,[type=search],#chat-textarea,.s_ipt') ||
            /search|s_form|chat-textarea|kw\b|index-form/i.test(idCls))
        ) {
          return false
        }
        // roughly centered: within ~22% of viewport center
        const { dx, dy } = centerDist(r)
        return dx <= 0.22 && dy <= 0.28
      }

      const cands: Cand[] = []
      const seen = new Set<Element>()

      const consider = (el: Element | null) => {
        if (!el || seen.has(el) || !isVisible(el)) return
        let cur: Element | null = el
        while (cur && cur !== document.body) {
          if (seen.has(cur)) break
          seen.add(cur)
          const r = cur.getBoundingClientRect()
          if (!looksLikePanel(cur, r)) {
            cur = cur.parentElement
            continue
          }
          const st = window.getComputedStyle(cur)
          const role = (cur.getAttribute('role') || '').toLowerCase()
          const z = parseInt(st.zIndex || '0', 10) || 0
          const { score } = centerDist(r)
          const idCls = `${cur.id || ''} ${cur.className || ''}`.toLowerCase()
          const isDialogRole = role === 'dialog' || role === 'alertdialog' || cur.tagName === 'DIALOG'
          const isOverlay = st.position === 'fixed' || st.position === 'absolute'
          const hasPassword = !!cur.querySelector('input[type=password]')
          const loginish = /dialog|modal|popup|passport|login|pass-|tangram/i.test(idCls)
          // 普通居中内容区（搜索框）必须有弹层/登录信号，否则跳过
          if (!isDialogRole && !hasPassword && !loginish && !(isOverlay && z >= 10)) {
            cur = cur.parentElement
            continue
          }
          let boost = 0
          if (isDialogRole) boost += 0.35
          if (isOverlay) boost += 0.12
          if (hasPassword) boost += 0.2
          else if (cur.querySelector('input,textarea,button')) boost += 0.08
          if (loginish) boost += 0.12
          cands.push({
            el: cur,
            centerScore: score + boost,
            area: r.width * r.height,
            width: r.width,
            height: r.height,
            role,
            z
          })
          cur = cur.parentElement
        }
      }

      // 1) Hit-test viewport center (+ a few nearby points)
      const points: Array<[number, number]> = [
        [cx, cy],
        [cx, cy - vh * 0.08],
        [cx, cy + vh * 0.08],
        [cx - vw * 0.08, cy],
        [cx + vw * 0.08, cy]
      ]
      for (const [x, y] of points) {
        consider(document.elementFromPoint(x, y))
      }

      // 2) Explicit dialog roles + login/passport modals（避免裸 [class*=modal] 误伤首页）
      document
        .querySelectorAll(
          '[role="dialog"],[role="alertdialog"],dialog,.passport-login-pop,.passMod_dialog,[id*="passport" i],[id*="TANGRAM__PSP" i],[class*="login" i][class*="modal" i],[class*="login" i][class*="dialog" i],[class*="login" i][class*="popup" i]'
        )
        .forEach((el) => consider(el))

      // 3) High z-index fixed layers (capped — avoid scanning entire DOM)
      const fixedish = document.querySelectorAll('body > div, body > section, body > aside, [style*="fixed"], [style*="absolute"]')
      let scanned = 0
      for (const el of Array.from(fixedish)) {
        if (scanned++ > 80) break
        const st = window.getComputedStyle(el)
        if (st.position !== 'fixed' && st.position !== 'absolute') continue
        consider(el)
      }

      if (!cands.length) return null

      // Prefer most centered + dialog-like; break ties by smaller panel (content box > backdrop)
      cands.sort((a, b) => {
        if (b.centerScore !== a.centerScore) return b.centerScore - a.centerScore
        if (b.z !== a.z) return b.z - a.z
        return a.area - b.area
      })

      const best = cands[0]
      // Require a minimum center score so corner toasts / homepage chrome never win
      const minScore =
        best.role === 'dialog' || best.role === 'alertdialog' ? 0.45 : 0.62
      if (best.centerScore < minScore) return null

      // Expand root slightly: if parent is also a centered panel of similar size, use parent
      // so close buttons / title bars stay included.
      let root = best.el
      let parent = root.parentElement
      while (parent && parent !== document.body) {
        const r = parent.getBoundingClientRect()
        if (!looksLikePanel(parent, r)) break
        const { dx, dy } = centerDist(r)
        if (dx > 0.25 || dy > 0.3) break
        // don't jump to huge wrappers
        if (r.width * r.height > best.area * 2.8) break
        root = parent
        parent = parent.parentElement
      }

      // Also include sibling title/close bars that are near the dialog
      const roots: Element[] = [root]
      const rootRect = root.getBoundingClientRect()
      const parentOfRoot = root.parentElement
      if (parentOfRoot) {
        for (const sib of Array.from(parentOfRoot.children)) {
          if (sib === root || !(sib instanceof HTMLElement)) continue
          const r = sib.getBoundingClientRect()
          if (r.width < 20 || r.height < 16) continue
          const near =
            Math.abs(r.left + r.width / 2 - (rootRect.left + rootRect.width / 2)) < rootRect.width &&
            Math.abs(r.top + r.height / 2 - (rootRect.top + rootRect.height / 2)) <
              rootRect.height * 1.2
          if (
            near &&
            (/close|title|tangram__psp/i.test(sib.id + sib.className) ||
              sib.querySelector('[id*="close" i],.close,[aria-label*="关闭"]'))
          ) {
            roots.push(sib)
          }
        }
      }

      const refs = new Set<string>()
      const ids = new Set<string>()
      for (const node of roots) {
        if ((node as HTMLElement).id) ids.add((node as HTMLElement).id)
        node.querySelectorAll('[data-ai-ref]').forEach((el) => {
          const ref = el.getAttribute('data-ai-ref')
          if (ref) refs.add(ref)
        })
        const selfRef = node.getAttribute('data-ai-ref')
        if (selfRef) refs.add(selfRef)
        node.querySelectorAll('[id]').forEach((el) => {
          const id = (el as HTMLElement).id
          if (id && id.length < 80) ids.add(id)
        })
      }

      return {
        refs: Array.from(refs),
        ids: Array.from(ids).slice(0, 40),
        centerScore: Math.round(best.centerScore * 1000) / 1000,
        width: Math.round(best.width),
        height: Math.round(best.height),
        tag: root.tagName.toLowerCase(),
        role: best.role || undefined
      }
    })
  } catch {
    return null
  }
}

function cropTreeByCenteredHit(tree: string, hit: CenteredDialogHit): DialogFocusResult | null {
  const parts = splitTopLevelBlocks(tree)
  if (!parts.length) return null

  const refSet = new Set<string>()
  for (const r of hit.refs) {
    const s = String(r || '').trim()
    if (!s) continue
    if (/^e\d+$/i.test(s)) refSet.add(s.toLowerCase())
    else if (/^\d+$/.test(s)) refSet.add(`e${s}`)
    else refSet.add(s)
  }
  const idSet = new Set(hit.ids.filter(Boolean))

  const matchesHit = (text: string) => {
    for (const ref of refSet) {
      if (text.includes(`[ref=${ref}]`) || text.includes(`ref=${ref}`)) return true
    }
    for (const id of idSet) {
      if (text.includes(`id=${id}`) || text.includes(`id="${id}"`)) return true
    }
    return false
  }

  const matched = parts
    .map((text, i) => ({ text, i }))
    .filter((b) => matchesHit(b.text))

  if (!matched.length) return null

  // Grow to include adjacent close/title blocks even if id/ref missed
  const indices = new Set(matched.map((m) => m.i))
  const minI = Math.min(...indices)
  const maxI = Math.max(...indices)
  for (let i = Math.max(0, minI - 2); i <= Math.min(parts.length - 1, maxI + 2); i++) {
    if (indices.has(i)) continue
    const t = parts[i]
    if (/closeBtn|titleButtons|close-btn|关闭|aria-label=关闭|TANGRAM__PSP/i.test(t)) {
      indices.add(i)
    }
  }

  const ordered = parts.filter((_, i) => indices.has(i))
  const omitted = parts.length - ordered.length
  // If crop kept almost everything (incl. single big homepage block), don't claim scoped
  if (omitted <= 0) return null
  if (ordered.length >= parts.length && parts.length > 2) return null

  const cropped = ordered.join('\n')
  const header =
    `<!-- scope=dialog center=${hit.centerScore} size=${hit.width}x${hit.height} ` +
    `omitted=${omitted} blocks; use browser_snapshot(scope=page) for full DOM -->\n`

  return {
    tree: header + cropped,
    scoped: true,
    scope: 'dialog',
    reason: 'centered_dialog',
    dialogScore: hit.centerScore,
    omittedBlocks: omitted
  }
}

function cropTreeByContentFallback(tree: string, scope: DomScope): DialogFocusResult {
  const raw = String(tree || '')
  const parts = splitTopLevelBlocks(raw)
  if (parts.length <= 1) {
    return { tree: raw, scoped: false, scope, reason: 'single_block' }
  }

  const scored: Block[] = parts.map((text, i) => {
    const { score, kind } = scoreBlock(text)
    return { start: i, text, score, kind }
  })

  const best = scored.reduce((a, b) => (b.score > a.score ? b : a), scored[0])
  const threshold = scope === 'dialog' ? 20 : 35
  const seed =
    best.kind === 'dialog' && best.score >= threshold
      ? best
      : scored
          .filter((b) => b.kind === 'dialog' && b.score >= threshold)
          .sort((a, b) => b.score - a.score)[0]

  if (!seed) {
    return {
      tree: raw,
      scoped: false,
      scope,
      reason: 'no_task_dialog',
      dialogScore: best.score
    }
  }

  const indices = new Set<number>([seed.start])
  for (const b of scored) {
    if (indices.has(b.start)) continue
    const dist = Math.abs(b.start - seed.start)
    if (dist > 2) continue
    if (/closeBtn|titleButtons|close-btn|关闭|aria-label=关闭/i.test(b.text)) {
      indices.add(b.start)
      continue
    }
    if (b.kind === 'dialog' && b.score >= threshold * 0.6) indices.add(b.start)
  }

  const ordered = scored.filter((b) => indices.has(b.start)).sort((a, b) => a.start - b.start)
  const omitted = parts.length - ordered.length
  if (omitted <= 0) {
    return {
      tree: raw,
      scoped: false,
      scope,
      reason: 'no_omitted_blocks',
      dialogScore: best.score,
      omittedBlocks: 0
    }
  }
  const cropped = ordered.map((b) => b.text).join('\n')
  const header =
    `<!-- scope=dialog score=${Math.max(...ordered.map((b) => b.score))} ` +
    `omitted=${omitted} blocks; use browser_snapshot(scope=page) for full DOM -->\n`

  return {
    tree: header + cropped,
    scoped: true,
    scope: 'dialog',
    reason: 'content_fallback',
    dialogScore: Math.max(...ordered.map((b) => b.score)),
    omittedBlocks: omitted
  }
}

/**
 * Crop LLM tree to the centered dialog when present.
 * - Primary: viewport-center geometry (from detectCenteredDialog)
 * - Fallback: content heuristics (login/forms)
 * - page|full: never crop
 */
export function applyDialogFocus(
  tree: string,
  scope: DomScope = 'auto',
  centered?: CenteredDialogHit | null
): DialogFocusResult {
  const raw = String(tree || '')
  if (!raw.trim()) {
    return { tree: raw, scoped: false, scope }
  }
  if (scope === 'page' || scope === 'full') {
    return { tree: raw, scoped: false, scope }
  }

  if (centered && (centered.refs.length || centered.ids.length)) {
    const byPos = cropTreeByCenteredHit(raw, centered)
    if (byPos) return byPos
  }

  // Force dialog scope: still try content fallback
  if (scope === 'dialog' || scope === 'auto') {
    return cropTreeByContentFallback(raw, scope)
  }

  return { tree: raw, scoped: false, scope }
}

export function resolveDomScope(args: Record<string, any> | undefined): DomScope {
  const raw = String(args?.domScope ?? args?.scope ?? 'auto').toLowerCase()
  if (raw === 'dialog' || raw === 'page' || raw === 'full' || raw === 'auto') return raw
  return 'auto'
}
