import { SENSITIVE_WORDS } from './config'

export type ContentScoreResult = {
  score: number
  reasons: string[]
  hits: string[]
  hardStop: boolean
  needConsent: boolean
}

const EXTRA_HARD = ['裸聊', '儿童色情', '制毒', '洗钱教程', '爆炸物制作']

const MID_PATTERNS: Array<{ re: RegExp; reason: string; score: number }> = [
  { re: /(色情|黄片|约炮)/, reason: '疑似低俗内容', score: 70 },
  { re: /(政变|颠覆政权)/, reason: '疑似涉政敏感', score: 75 },
  { re: /(自杀|自残)(方法|教程)?/, reason: '疑似自伤相关', score: 72 }
]

export function scoreContent(text: string): ContentScoreResult {
  const raw = String(text || '')
  const hits: string[] = []
  const reasons: string[] = []
  let score = 0

  const dict = [...SENSITIVE_WORDS, ...EXTRA_HARD]
  for (const w of dict) {
    if (w && raw.includes(w)) hits.push(w)
  }
  if (hits.length) {
    score = Math.max(score, 92)
    reasons.push(`命中本地硬敏感词: ${hits.join(',')}`)
  }

  for (const p of MID_PATTERNS) {
    if (p.re.test(raw)) {
      score = Math.max(score, p.score)
      reasons.push(p.reason)
    }
  }

  return {
    score,
    reasons,
    hits: [...new Set(hits)],
    hardStop: score >= 80,
    needConsent: score >= 60 && score < 80
  }
}
