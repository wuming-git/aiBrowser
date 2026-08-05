import { defineStore } from 'pinia'
import { ref } from 'vue'

const TOKEN_KEY = 'browser168_token'
const EMAIL_KEY = 'browser168_email'
const USER_ID_KEY = 'browser168_userId'
const LEGACY_TOKEN_KEY = 'yuntuo_token'
const LEGACY_EMAIL_KEY = 'yuntuo_email'

function readMigrated(key: string, legacyKey: string) {
  const cur = localStorage.getItem(key)
  if (cur) return cur
  const legacy = localStorage.getItem(legacyKey)
  if (legacy) {
    localStorage.setItem(key, legacy)
    localStorage.removeItem(legacyKey)
    return legacy
  }
  return ''
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref(readMigrated(TOKEN_KEY, LEGACY_TOKEN_KEY))
  const email = ref(readMigrated(EMAIL_KEY, LEGACY_EMAIL_KEY))
  const userId = ref<number | null>(
    (() => {
      const raw = localStorage.getItem(USER_ID_KEY)
      const n = raw ? Number(raw) : NaN
      return Number.isFinite(n) && n > 0 ? n : null
    })()
  )

  function setSession(t: string, e: string, uid?: number | null) {
    token.value = t
    email.value = e
    localStorage.setItem(TOKEN_KEY, t)
    localStorage.setItem(EMAIL_KEY, e)
    localStorage.removeItem(LEGACY_TOKEN_KEY)
    localStorage.removeItem(LEGACY_EMAIL_KEY)
    if (uid != null && Number.isFinite(Number(uid))) {
      userId.value = Number(uid)
      localStorage.setItem(USER_ID_KEY, String(uid))
    }
  }

  function logout() {
    token.value = ''
    email.value = ''
    userId.value = null
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(EMAIL_KEY)
    localStorage.removeItem(USER_ID_KEY)
    localStorage.removeItem(LEGACY_TOKEN_KEY)
    localStorage.removeItem(LEGACY_EMAIL_KEY)
  }

  return { token, email, userId, setSession, logout }
})
