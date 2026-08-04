/**
 * Windows 终端默认常为 GBK(936)，而 Node/Electron 日志是 UTF-8，
 * 会导致中文变成「宸茬紦…」这类乱码。启动时切到 UTF-8 代码页。
 */
import { execFileSync } from 'node:child_process'
import { inspect } from 'node:util'

let ready = false

export function ensureUtf8Console() {
  if (ready) return
  ready = true
  try {
    process.env.PYTHONIOENCODING = 'utf-8'
    if (typeof process.stdout?.setDefaultEncoding === 'function') {
      process.stdout.setDefaultEncoding('utf8')
    }
    if (typeof process.stderr?.setDefaultEncoding === 'function') {
      process.stderr.setDefaultEncoding('utf8')
    }
  } catch (_) {}

  if (process.platform === 'win32') {
    try {
      execFileSync('cmd.exe', ['/c', 'chcp', '65001'], {
        stdio: 'ignore',
        windowsHide: true
      })
    } catch (_) {}
  }
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.stack || arg.message
  try {
    return inspect(arg, {
      depth: 6,
      colors: false,
      breakLength: 100,
      maxArrayLength: 50,
      compact: false
    })
  } catch {
    return String(arg)
  }
}

/** 统一用 UTF-8 写出，避免 console 在部分 Windows 终端二次转码异常 */
export function writeUtf8Line(stream: NodeJS.WritableStream, ...args: unknown[]) {
  const line = args.map(formatArg).join(' ') + '\n'
  try {
    stream.write(Buffer.from(line, 'utf8'))
  } catch {
    // fallback
    try {
      stream.write(line)
    } catch (_) {}
  }
}
