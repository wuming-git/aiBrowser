/**
 * 浏览器相关任务收尾（程序固定逻辑，非 LLM）。
 * 模块加载时自注册到 postTaskHooks。
 */
import { registerPostTaskCallback, type PostTaskContext } from '../desktop/postTaskHooks'
import { peekHumanSession, dropHumanSession } from './humanSession'
import { removeHighlights, hideDomObserveEffect } from './highlights'
import { closeBrowser } from './launcher'

async function browserPostTaskCleanup(ctx: PostTaskContext) {
  if (ctx.profileId == null || ctx.profileId === '') return
  const profileId = String(ctx.profileId)
  const session = peekHumanSession(profileId)
  if (session?.page) {
    await hideDomObserveEffect(session.page).catch(() => undefined)
    await removeHighlights(session.page).catch(() => undefined)
  }
  dropHumanSession(profileId)

  // 定时任务结束后关闭指纹浏览器；其它来源仅断 CDP
  if (ctx.reason === 'scheduler.job') {
    await closeBrowser(profileId)
  }
}

registerPostTaskCallback('browser.cleanup', browserPostTaskCleanup)
