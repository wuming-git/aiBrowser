import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CANDIDATES = [
  process.env.BROWSER168_CHROME_PATH,
  process.env.YUNTUO_CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean) as string[]

export function resolveChromePath(): string {
  for (const p of CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p
    } catch (_) {}
  }
  throw new Error('未找到 Chrome，请设置环境变量 BROWSER168_CHROME_PATH')
}
