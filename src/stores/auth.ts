import { defineStore } from 'pinia'
import { ref } from 'vue'

const TOKEN_KEY = 'browser168_token'
const EMAIL_KEY = 'browser168_email'
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

  function setSession(t: string, e: string) {
    token.value = t
    email.value = e
    localStorage.setItem(TOKEN_KEY, t)
    localStorage.setItem(EMAIL_KEY, e)
    localStorage.removeItem(LEGACY_TOKEN_KEY)
    localStorage.removeItem(LEGACY_EMAIL_KEY)
  }

  function logout() {
    token.value = ''
    email.value = ''
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(EMAIL_KEY)
    localStorage.removeItem(LEGACY_TOKEN_KEY)
    localStorage.removeItem(LEGACY_EMAIL_KEY)
  }

  return { token, email, setSession, logout }
})
