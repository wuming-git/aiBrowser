/**
 * 小白友好调度 ↔ 5 段 cron（分 时 日 月 周）
 * 周：0=周日 … 6=周六（与 croner 常见约定一致）
 */

export type SimpleFrequency = 'daily' | 'weekdays' | 'weekly' | 'hourly' | 'everyMinutes'

export type SimpleSchedule = {
  frequency: SimpleFrequency
  hour: number
  minute: number
  /** weekly：0–6 */
  weekday: number
  /** hourly：每隔几小时 */
  everyHours: number
  /** everyMinutes：每隔几分钟 */
  everyMinutes: number
}

export const WEEKDAY_OPTIONS = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' }
] as const

export const EVERY_MINUTES_OPTIONS = [5, 10, 15, 20, 30] as const
export const EVERY_HOURS_OPTIONS = [1, 2, 3, 4, 6, 8, 12] as const

export function defaultSimpleSchedule(): SimpleSchedule {
  return {
    frequency: 'daily',
    hour: 9,
    minute: 0,
    weekday: 1,
    everyHours: 2,
    everyMinutes: 30
  }
}

function clampInt(n: unknown, min: number, max: number, fallback: number) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(v)))
}

export function buildCronFromSimple(s: SimpleSchedule): string {
  const minute = clampInt(s.minute, 0, 59, 0)
  const hour = clampInt(s.hour, 0, 23, 9)
  switch (s.frequency) {
    case 'daily':
      return `${minute} ${hour} * * *`
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`
    case 'weekly': {
      const wd = clampInt(s.weekday, 0, 6, 1)
      return `${minute} ${hour} * * ${wd}`
    }
    case 'hourly': {
      const n = clampInt(s.everyHours, 1, 23, 2)
      return `${minute} */${n} * * *`
    }
    case 'everyMinutes': {
      const n = clampInt(s.everyMinutes, 1, 59, 30)
      return `*/${n} * * * *`
    }
    default:
      return `${minute} ${hour} * * *`
  }
}

export function describeSimpleSchedule(s: SimpleSchedule): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(s.hour)}:${pad(s.minute)}`
  switch (s.frequency) {
    case 'daily':
      return `每天 ${hm}`
    case 'weekdays':
      return `工作日（周一至周五） ${hm}`
    case 'weekly': {
      const label = WEEKDAY_OPTIONS.find((x) => x.value === s.weekday)?.label || '周一'
      return `每${label} ${hm}`
    }
    case 'hourly':
      return `每 ${s.everyHours} 小时（在第 ${s.minute} 分）`
    case 'everyMinutes':
      return `每 ${s.everyMinutes} 分钟`
    default:
      return hm
  }
}

/** 尝试把 cron 解析成简单调度；无法识别则返回 null */
export function parseCronToSimple(cron: string): SimpleSchedule | null {
  const parts = String(cron || '')
    .trim()
    .split(/\s+/)
  if (parts.length !== 5) return null
  const [min, hour, dom, mon, dow] = parts
  if (dom !== '*' || mon !== '*') return null

  const base = defaultSimpleSchedule()

  // */N * * * *
  const everyMin = min.match(/^\*\/(\d+)$/)
  if (everyMin && hour === '*' && dow === '*') {
    const n = Number(everyMin[1])
    if (n >= 1 && n <= 59) {
      return { ...base, frequency: 'everyMinutes', everyMinutes: n, minute: 0, hour: 0 }
    }
    return null
  }

  if (!/^\d+$/.test(min)) return null
  const minute = Number(min)
  if (minute < 0 || minute > 59) return null

  // M */N * * *
  const everyHour = hour.match(/^\*\/(\d+)$/)
  if (everyHour && dow === '*') {
    const n = Number(everyHour[1])
    if (n >= 1 && n <= 23) {
      return { ...base, frequency: 'hourly', everyHours: n, minute, hour: 0 }
    }
    return null
  }

  if (!/^\d+$/.test(hour)) return null
  const h = Number(hour)
  if (h < 0 || h > 23) return null

  if (dow === '*') {
    return { ...base, frequency: 'daily', hour: h, minute }
  }
  if (dow === '1-5') {
    return { ...base, frequency: 'weekdays', hour: h, minute }
  }
  if (/^[0-6]$/.test(dow)) {
    return { ...base, frequency: 'weekly', hour: h, minute, weekday: Number(dow) }
  }
  return null
}

/** 列表展示用：能解析则用人话，否则显示原 cron */
export function formatScheduleLabel(cron: string): string {
  const simple = parseCronToSimple(cron)
  if (simple) return describeSimpleSchedule(simple)
  const c = String(cron || '').trim()
  return c || '-'
}
