import { SENSITIVE_WORDS } from './config'

export function filterSensitive(text: string) {
  const hits = SENSITIVE_WORDS.filter((w) => text.includes(w))
  return { blocked: hits.length > 0, sensitiveHits: hits }
}
