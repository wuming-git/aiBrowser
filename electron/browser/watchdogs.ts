/**
 * Side-channel watchdogs adapted from browser-use PopupsWatchdog / DownloadsWatchdog ideas.
 * - Auto-handle native JS dialogs (alert/confirm/beforeunload)
 * - Track last download path via CDP events when available
 */
import type { Page, CDPSession } from 'puppeteer-core'

export type DialogPolicy = 'accept' | 'dismiss'

const dialogHandlers = new WeakMap<Page, (dialog: import('puppeteer-core').Dialog) => void>()

export async function ensurePopupWatchdog(
  page: Page,
  policy: DialogPolicy = 'accept'
): Promise<void> {
  if (dialogHandlers.has(page)) return

  const handler = async (dialog: import('puppeteer-core').Dialog) => {
    try {
      const type = dialog.type()
      if (policy === 'dismiss' || type === 'prompt') {
        await dialog.dismiss()
      } else {
        await dialog.accept()
      }
    } catch (_) {
      // dialog may already be handled
    }
  }
  page.on('dialog', handler)
  dialogHandlers.set(page, handler)
}

export type DownloadWatch = {
  client: CDPSession
  lastSuggestedFilename?: string
  lastUrl?: string
}

export async function attachDownloadWatchdog(
  page: Page,
  downloadPath: string
): Promise<DownloadWatch> {
  const client = await page.createCDPSession()
  const watch: DownloadWatch = { client }
  try {
    await client.send('Browser.setDownloadBehavior' as any, {
      behavior: 'allow',
      downloadPath,
      eventsEnabled: true
    })
  } catch (_) {
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath
    })
  }

  client.on('Browser.downloadWillBegin' as any, (evt: any) => {
    watch.lastSuggestedFilename = evt?.suggestedFilename
    watch.lastUrl = evt?.url
  })
  client.on('Page.downloadWillBegin' as any, (evt: any) => {
    watch.lastSuggestedFilename = evt?.suggestedFilename
    watch.lastUrl = evt?.url
  })
  return watch
}
