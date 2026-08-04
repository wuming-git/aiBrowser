/**
 * 桌面端命令行 / 文件工具（供后端 Agent 经 WS 调用）
 * 文件操作限制在 userData/AgentWorkspace 沙箱内，防止任意路径读写。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'

const execFileAsync = promisify(execFile)

const MAX_STDOUT = 80_000
const MAX_STDERR = 40_000
const MAX_READ_BYTES = 512 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000

export function getAgentWorkspaceRoot(): string {
  return path.join(app.getPath('userData'), 'AgentWorkspace')
}

async function ensureWorkspace(): Promise<string> {
  const root = getAgentWorkspaceRoot()
  await fs.mkdir(root, { recursive: true })
  return root
}

/** 将相对/绝对路径解析到沙箱内；越界则抛错 */
export async function resolveWorkspacePath(input: unknown, opts?: { allowMissing?: boolean }): Promise<string> {
  const root = await ensureWorkspace()
  const raw = String(input || '').trim()
  if (!raw || raw === '.' || raw === './') return root

  const target = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw)
  const rel = path.relative(root, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径超出 AgentWorkspace 沙箱: ${raw}`)
  }
  if (!opts?.allowMissing) {
    // 读操作时可由调用方再 stat；这里只做路径校验
  }
  return target
}

function clip(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + `\n…(truncated, total=${s.length})`
}

function toPosixRel(root: string, abs: string): string {
  const rel = path.relative(root, abs)
  return rel.split(path.sep).join('/') || '.'
}

export async function shellExec(args: Record<string, any>) {
  const command = String(args.command || args.cmd || '').trim()
  if (!command) throw new Error('缺少 command')

  const root = await ensureWorkspace()
  let cwd = root
  if (args.cwd != null && String(args.cwd).trim()) {
    cwd = await resolveWorkspacePath(args.cwd, { allowMissing: true })
    await fs.mkdir(cwd, { recursive: true })
  }

  const timeoutMs = Math.min(
    Math.max(Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000),
    MAX_TIMEOUT_MS
  )

  // Windows: 用 cmd /c；其它平台用 sh -c
  const isWin = process.platform === 'win32'
  const file = isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
  const fileArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command]

  const started = Date.now()
  try {
    const { stdout, stderr } = await execFileAsync(file, fileArgs, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_STDOUT + MAX_STDERR,
      windowsHide: true,
      env: {
        ...process.env,
        // 避免把 Electron/Chromium 相关环境干扰子进程（可选）
      }
    })
    return {
      ok: true,
      command,
      cwd: toPosixRel(root, cwd),
      workspace: root,
      exitCode: 0,
      stdout: clip(String(stdout || ''), MAX_STDOUT),
      stderr: clip(String(stderr || ''), MAX_STDERR),
      durationMs: Date.now() - started
    }
  } catch (e: any) {
    const killed = e?.killed || e?.signal === 'SIGTERM'
    const code = typeof e?.code === 'number' ? e.code : killed ? null : 1
    return {
      ok: false,
      command,
      cwd: toPosixRel(root, cwd),
      workspace: root,
      exitCode: code,
      killed: !!killed,
      stdout: clip(String(e?.stdout || ''), MAX_STDOUT),
      stderr: clip(String(e?.stderr || e?.message || e), MAX_STDERR),
      durationMs: Date.now() - started,
      error: killed ? `命令超时（>${timeoutMs}ms）` : e?.message || String(e)
    }
  }
}

export async function fsRead(args: Record<string, any>) {
  const root = await ensureWorkspace()
  const abs = await resolveWorkspacePath(args.path ?? args.file)
  const encoding = (String(args.encoding || 'utf-8').toLowerCase() === 'base64' ? 'base64' : 'utf-8') as
    | 'utf-8'
    | 'base64'
  const maxBytes = Math.min(Math.max(Number(args.maxBytes) || MAX_READ_BYTES, 1), MAX_READ_BYTES)

  const st = await fs.stat(abs)
  if (!st.isFile()) throw new Error('不是文件')
  if (st.size > maxBytes) {
    // 仍可读前 maxBytes
    const fh = await fs.open(abs, 'r')
    try {
      const buf = Buffer.alloc(maxBytes)
      const { bytesRead } = await fh.read(buf, 0, maxBytes, 0)
      const slice = buf.subarray(0, bytesRead)
      return {
        path: toPosixRel(root, abs),
        size: st.size,
        truncated: true,
        maxBytes,
        encoding,
        content: encoding === 'base64' ? slice.toString('base64') : slice.toString('utf-8')
      }
    } finally {
      await fh.close()
    }
  }

  const buf = await fs.readFile(abs)
  return {
    path: toPosixRel(root, abs),
    size: st.size,
    truncated: false,
    maxBytes,
    encoding,
    content: encoding === 'base64' ? buf.toString('base64') : buf.toString('utf-8')
  }
}

export async function fsWrite(args: Record<string, any>) {
  const root = await ensureWorkspace()
  const abs = await resolveWorkspacePath(args.path ?? args.file, { allowMissing: true })
  if (args.content == null) throw new Error('缺少 content')
  const content = String(args.content)
  const append = args.append === true
  const encoding = (String(args.encoding || 'utf-8').toLowerCase() === 'base64' ? 'base64' : 'utf-8') as
    | 'utf-8'
    | 'base64'

  await fs.mkdir(path.dirname(abs), { recursive: true })
  const data = encoding === 'base64' ? Buffer.from(content, 'base64') : content
  if (append) await fs.appendFile(abs, data)
  else await fs.writeFile(abs, data)

  const st = await fs.stat(abs)
  return {
    written: true,
    append,
    path: toPosixRel(root, abs),
    size: st.size,
    workspace: root
  }
}

export async function fsList(args: Record<string, any>) {
  const root = await ensureWorkspace()
  const abs = await resolveWorkspacePath(args.path ?? args.dir ?? '.')
  const st = await fs.stat(abs)
  if (!st.isDirectory()) throw new Error('不是目录')

  const entries = await fs.readdir(abs, { withFileTypes: true })
  const items = await Promise.all(
    entries.slice(0, 500).map(async (ent) => {
      const full = path.join(abs, ent.name)
      let size: number | undefined
      try {
        if (ent.isFile()) size = (await fs.stat(full)).size
      } catch {
        /* ignore */
      }
      return {
        name: ent.name,
        type: ent.isDirectory() ? 'dir' : ent.isFile() ? 'file' : 'other',
        size
      }
    })
  )

  return {
    path: toPosixRel(root, abs),
    workspace: root,
    count: items.length,
    truncated: entries.length > items.length,
    items
  }
}

export async function fsMkdir(args: Record<string, any>) {
  const root = await ensureWorkspace()
  const abs = await resolveWorkspacePath(args.path ?? args.dir, { allowMissing: true })
  await fs.mkdir(abs, { recursive: true })
  return { created: true, path: toPosixRel(root, abs), workspace: root }
}

export async function fsDelete(args: Record<string, any>) {
  const root = await ensureWorkspace()
  const abs = await resolveWorkspacePath(args.path ?? args.file)
  if (abs === root) throw new Error('不能删除工作区根目录')
  const recursive = args.recursive === true
  await fs.rm(abs, { recursive, force: false })
  return { deleted: true, path: toPosixRel(root, abs) }
}

export async function fsWorkspaceInfo() {
  const root = await ensureWorkspace()
  return {
    workspace: root,
    hint: '文件路径请使用相对 AgentWorkspace 的路径；shell 默认 cwd 也在此目录'
  }
}
