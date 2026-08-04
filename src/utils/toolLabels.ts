/** 工具英文名 → 普通人能看懂的中文（兼容下划线名与点分名） */
const TOOL_LABELS: Record<string, string> = {
  list_profiles: '查看可用环境',
  create_profile: '创建浏览器环境',

  browser_launch: '启动浏览器',
  'browser.launch': '启动浏览器',
  browser_open: '打开网页',
  'browser.open': '打开网页',
  browser_navigate: '打开页面',
  'browser.navigate': '打开页面',
  browser_click: '点击页面',
  'browser.click': '点击页面',
  browser_type: '输入内容',
  'browser.type': '输入内容',
  browser_hover: '悬停页面',
  'browser.hover': '悬停页面',
  browser_scroll: '滚动页面',
  'browser.scroll': '滚动页面',
  browser_wait_for: '等待页面加载',
  'browser.waitFor': '等待页面加载',
  browser_press_key: '按下按键',
  'browser.pressKey': '按下按键',
  browser_extract_text: '读取页面文字',
  'browser.extractText': '读取页面文字',
  browser_snapshot: '查看当前页面',
  'browser.snapshot': '查看当前页面',
  browser_find: '查找页面内容',
  'browser.find': '查找页面内容',
  search_tools: '查找可用能力',
  call_tool: '执行扩展操作',
  browser_download: '下载文件',
  'browser.download': '下载文件',
  browser_close: '关闭浏览器',
  'browser.close': '关闭浏览器',

  scheduler_create: '创建定时任务',
  'scheduler.create': '创建定时任务',
  scheduler_list: '查看定时任务',
  'scheduler.list': '查看定时任务',
  scheduler_update: '编辑定时任务',
  'scheduler.update': '编辑定时任务',
  scheduler_cancel: '取消定时任务',
  'scheduler.cancel': '取消定时任务',

  shell_exec: '执行系统命令',
  'shell.exec': '执行系统命令',
  fs_read: '读取文件',
  'fs.read': '读取文件',
  fs_write: '保存文件',
  'fs.write': '保存文件',
  fs_list: '查看文件夹',
  'fs.list': '查看文件夹',
  fs_mkdir: '创建文件夹',
  'fs.mkdir': '创建文件夹',
  fs_delete: '删除文件',
  'fs.delete': '删除文件',
  fs_workspace: '查看工作目录',
  'fs.workspace': '查看工作目录',

  progress_guard: '进度检查'
}

function normalizeToolKey(name: string): string {
  return String(name || '')
    .trim()
    .replace(/\s+/g, '_')
}

/** 展示给用户的中文操作名；未知工具用中性描述 */
export function toolLabel(name?: string | null): string {
  const raw = normalizeToolKey(name || '')
  if (!raw) return '一项操作'
  if (TOOL_LABELS[raw]) return TOOL_LABELS[raw]

  const altDot = raw.replace(/_/g, '.')
  if (TOOL_LABELS[altDot]) return TOOL_LABELS[altDot]
  const altUnder = raw.replace(/\./g, '_')
  if (TOOL_LABELS[altUnder]) return TOOL_LABELS[altUnder]

  return '一项操作'
}
