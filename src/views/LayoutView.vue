<template>
  <div class="shell">
    <div class="ambient" aria-hidden="true" />

    <aside class="sidebar">
      <div class="brand">
        <img class="brand-mark" src="/icon.png" width="28" height="28" alt="" />
        <div class="brand-text">
          <span class="brand-name">browser168</span>
          <span class="brand-meta">
            <span class="brand-tag">AI Browser</span>
            <button
              type="button"
              class="brand-version"
              :title="versionTitle"
              @click="onCheckUpdate"
            >
              v{{ appVersion }}
            </button>
          </span>
        </div>
      </div>

      <div class="nav-label">工作台</div>
      <nav class="menu">
        <router-link to="/profiles" class="menu-item" active-class="active">
          <el-icon class="menu-icon"><Monitor /></el-icon>
          <span>浏览器环境</span>
        </router-link>
        <router-link to="/schedules" class="menu-item" active-class="active">
          <el-icon class="menu-icon"><Timer /></el-icon>
          <span>定时任务</span>
        </router-link>
        <router-link to="/skills" class="menu-item" active-class="active">
          <el-icon class="menu-icon"><Collection /></el-icon>
          <span>技能</span>
        </router-link>
        <router-link to="/tools" class="menu-item" active-class="active">
          <el-icon class="menu-icon"><SetUp /></el-icon>
          <span>工具</span>
        </router-link>
      </nav>

      <div class="sidebar-foot">
        <div v-if="updateBannerVisible" class="update-banner">
          <div class="update-copy">
            <template v-if="updatePhase === 'available'">
              发现新版本 v{{ updateVersion }}
            </template>
            <template v-else-if="updatePhase === 'downloading'">
              正在下载 {{ updatePercent }}%
            </template>
            <template v-else-if="updatePhase === 'downloaded'">
              更新已就绪，重启后完成安装
            </template>
            <template v-else-if="updatePhase === 'checking'">
              正在检查更新…
            </template>
            <template v-else-if="updatePhase === 'error'">
              {{ updateError || '更新失败' }}
            </template>
          </div>
          <div class="update-actions">
            <button
              v-if="updatePhase === 'available'"
              type="button"
              class="update-btn"
              :disabled="updateBusy"
              @click="onDownloadUpdate"
            >
              立即更新
            </button>
            <button
              v-else-if="updatePhase === 'downloaded'"
              type="button"
              class="update-btn"
              @click="onInstallUpdate"
            >
              重启安装
            </button>
            <button
              v-if="updatePhase === 'error' || updatePhase === 'available'"
              type="button"
              class="update-dismiss"
              @click="dismissUpdate"
            >
              关闭
            </button>
          </div>
          <div
            v-if="updatePhase === 'downloading'"
            class="update-bar"
            :style="{ width: `${updatePercent}%` }"
          />
        </div>

        <div class="user-card">
          <div class="avatar" aria-hidden="true">{{ avatarLetter }}</div>
          <div class="user-meta">
            <div class="email" :title="auth.email">{{ auth.email }}</div>
            <button type="button" class="action-link" @click="onLogout">退出登录</button>
          </div>
          <button type="button" class="settings-icon" title="模型设置" @click="settingsOpen = true">
            <el-icon :size="16"><Setting /></el-icon>
          </button>
        </div>
      </div>
    </aside>

    <section class="center">
      <router-view v-slot="{ Component }">
        <component :is="Component" />
      </router-view>
    </section>

    <div
      class="splitter"
      title="拖动调整 Agent 宽度"
      @mousedown="startResize"
    />

    <aside class="agent-pane" :style="{ width: agentWidth + 'px' }">
      <div class="agent-body">
        <AgentPanel ref="agentPanelRef" />
      </div>
    </aside>

    <ModelSettingsDialog v-model="settingsOpen" @saved="onSettingsSaved" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Monitor, Timer, Setting, Collection, SetUp } from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import AgentPanel from '@/components/AgentPanel.vue'
import ModelSettingsDialog from '@/components/ModelSettingsDialog.vue'
import { connectDesktopSession, disconnectDesktopSession } from '@/utils/desktopSession'
import { getDesktopApi, type UpdateEventPayload } from '@/utils/desktopApi'
import type { LlmConfig } from '@/api'

const WIDTH_KEY = 'aiBrowser_agentWidth'
const MIN_W = 320
const MAX_W = 720
const DEFAULT_W = 400
const FALLBACK_VERSION = '0.1.0'

type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'

const auth = useAuthStore()
const router = useRouter()
const agentWidth = ref(DEFAULT_W)
const settingsOpen = ref(false)
const agentPanelRef = ref<{ refreshStatus?: () => void } | null>(null)

const appVersion = ref(FALLBACK_VERSION)
const packaged = ref(false)
const updatePhase = ref<UpdatePhase>('idle')
const updateVersion = ref('')
const updatePercent = ref(0)
const updateError = ref('')
const updateBusy = ref(false)
const updateDismissed = ref(false)
const manualCheck = ref(false)

let unsubUpdate: (() => void) | null = null

const avatarLetter = computed(() => {
  const e = auth.email || '?'
  return e.charAt(0).toUpperCase()
})

const versionTitle = computed(() =>
  packaged.value ? '点击检查更新' : '开发版 · 点击检查更新'
)

const updateBannerVisible = computed(() => {
  if (updateDismissed.value && updatePhase.value !== 'downloading' && updatePhase.value !== 'downloaded') {
    return false
  }
  if (updatePhase.value === 'checking') return manualCheck.value
  return (
    updatePhase.value === 'available' ||
    updatePhase.value === 'downloading' ||
    updatePhase.value === 'downloaded' ||
    updatePhase.value === 'error'
  )
})

let resizing = false

function onSettingsSaved(_cfg: LlmConfig) {
  agentPanelRef.value?.refreshStatus?.()
}
function onLogout() {
  void disconnectDesktopSession()
  auth.logout()
  router.push('/login')
}

function clamp(w: number) {
  const max = Math.min(MAX_W, Math.floor(window.innerWidth * 0.55))
  return Math.max(MIN_W, Math.min(max, w))
}

function startResize(e: MouseEvent) {
  e.preventDefault()
  resizing = true
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onMove(e: MouseEvent) {
  if (!resizing) return
  agentWidth.value = clamp(window.innerWidth - e.clientX)
}

function onUp() {
  if (!resizing) return
  resizing = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  localStorage.setItem(WIDTH_KEY, String(agentWidth.value))
}

function onUpdateEvent(payload: UpdateEventPayload) {
  if (payload.type === 'checking') {
    updatePhase.value = 'checking'
    updateDismissed.value = false
    return
  }
  if (payload.type === 'available') {
    updatePhase.value = 'available'
    updateVersion.value = payload.version
    updateDismissed.value = false
    return
  }
  if (payload.type === 'not-available') {
    const wasManual = manualCheck.value
    manualCheck.value = false
    updatePhase.value = 'idle'
    if (wasManual) {
      ElMessage.success(`已是最新版本 v${payload.version || appVersion.value}`)
    }
    return
  }
  if (payload.type === 'progress') {
    updatePhase.value = 'downloading'
    updatePercent.value = Math.max(0, Math.min(100, Math.round(payload.percent || 0)))
    return
  }
  if (payload.type === 'downloaded') {
    updatePhase.value = 'downloaded'
    updateVersion.value = payload.version || updateVersion.value
    updateBusy.value = false
    return
  }
  if (payload.type === 'error') {
    // 启动自动检查失败时不弹大段堆栈；仅手动检查时提示
    if (!manualCheck.value) {
      updatePhase.value = 'idle'
      return
    }
    updatePhase.value = 'error'
    updateError.value = payload.message || '更新失败'
    updateBusy.value = false
    manualCheck.value = false
    return
  }
  if (payload.type === 'dev-skip') {
    updatePhase.value = 'idle'
    ElMessage.info(payload.message || '开发模式不检查更新')
  }
}

async function loadVersion() {
  const api = getDesktopApi()
  if (!api?.getAppVersion) {
    appVersion.value = FALLBACK_VERSION
    return
  }
  try {
    const info = await api.getAppVersion()
    appVersion.value = info.version || FALLBACK_VERSION
    packaged.value = !!info.packaged
  } catch {
    appVersion.value = FALLBACK_VERSION
  }
}

async function onCheckUpdate() {
  const api = getDesktopApi()
  if (!api?.checkForUpdates) {
    ElMessage.info(`当前版本 v${appVersion.value}`)
    return
  }
  updateDismissed.value = false
  manualCheck.value = true
  updatePhase.value = 'checking'
  try {
    const res = await api.checkForUpdates()
    if (res?.skipped && res.message) {
      ElMessage.info(res.message)
      manualCheck.value = false
      if (!packaged.value) updatePhase.value = 'idle'
    }
  } catch (e: any) {
    manualCheck.value = false
    updatePhase.value = 'error'
    updateError.value = e?.message || '检查更新失败'
  }
}

async function onDownloadUpdate() {
  const api = getDesktopApi()
  if (!api?.downloadUpdate) return
  updateBusy.value = true
  updatePhase.value = 'downloading'
  updatePercent.value = 0
  try {
    const res = await api.downloadUpdate()
    if (!res?.ok && res?.message) {
      updatePhase.value = 'error'
      updateError.value = res.message
      updateBusy.value = false
    }
  } catch (e: any) {
    updatePhase.value = 'error'
    updateError.value = e?.message || '下载失败'
    updateBusy.value = false
  }
}

async function onInstallUpdate() {
  const api = getDesktopApi()
  if (!api?.installUpdate) return
  try {
    const res = await api.installUpdate()
    if (!res?.ok && res?.message) ElMessage.warning(res.message)
  } catch (e: any) {
    ElMessage.error(e?.message || '安装失败')
  }
}

function dismissUpdate() {
  updateDismissed.value = true
  if (updatePhase.value === 'error' || updatePhase.value === 'available') {
    updatePhase.value = 'idle'
  }
}

onMounted(() => {
  const saved = Number(localStorage.getItem(WIDTH_KEY))
  if (!Number.isNaN(saved) && saved > 0) {
    agentWidth.value = clamp(saved)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  if (auth.token) {
    void connectDesktopSession(auth.token)
  }
  void loadVersion()
  const api = getDesktopApi()
  if (api?.onUpdateEvent) {
    unsubUpdate = api.onUpdateEvent(onUpdateEvent)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', onUp)
  unsubUpdate?.()
  unsubUpdate = null
})
</script>

<style scoped>
.shell {
  height: 100vh;
  display: flex;
  overflow: hidden;
  background: var(--yt-bg);
  position: relative;
  animation: yt-in 0.5s var(--yt-ease) both;
}

.ambient {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background:
    radial-gradient(ellipse 50% 40% at 8% 100%, rgba(225, 243, 254, 0.4), transparent 70%),
    radial-gradient(ellipse 45% 35% at 92% 88%, rgba(237, 243, 236, 0.5), transparent 68%);
  opacity: 0.85;
}

.sidebar,
.center,
.agent-pane {
  position: relative;
}

.sidebar {
  width: 228px;
  flex: 0 0 228px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--yt-border);
  background: transparent;
  padding: 28px 16px 18px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 6px 36px;
}

.brand-mark {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
  display: block;
}

.brand-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.brand-name {
  font-family: var(--yt-font);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--yt-text);
  line-height: 1.1;
}

.brand-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.brand-tag {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--yt-muted);
}

.brand-version {
  border: none;
  background: transparent;
  padding: 0;
  margin: 0;
  font-size: 10px;
  font-weight: 600;
  font-family: inherit;
  letter-spacing: 0.04em;
  color: var(--yt-muted);
  cursor: pointer;
  font-variant-numeric: tabular-nums;
}
.brand-version:hover {
  color: var(--yt-text);
}

.nav-label {
  margin: 0 12px 8px;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--yt-muted);
}

.menu {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  color: var(--yt-muted);
  font-size: 13.5px;
  font-weight: 550;
  letter-spacing: -0.01em;
  text-decoration: none;
  border: 1px solid transparent;
  transition: color 0.2s ease, background 0.2s ease, border-color 0.2s ease;
}

.menu-icon {
  font-size: 16px;
  color: inherit;
}

.menu-item:hover {
  color: var(--yt-text);
  background: rgba(255, 255, 255, 0.55);
  text-decoration: none;
}

.menu-item.active {
  color: var(--yt-text);
  background: var(--yt-panel);
  border-color: var(--yt-border);
  box-shadow: var(--yt-shadow);
  font-weight: 600;
}

.sidebar-foot {
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.update-banner {
  position: relative;
  overflow: hidden;
  border-radius: 10px;
  border: 1px solid var(--yt-border);
  background: var(--yt-panel);
  box-shadow: var(--yt-shadow);
  padding: 10px 10px 12px;
}

.update-copy {
  font-size: 11.5px;
  font-weight: 550;
  color: var(--yt-text);
  line-height: 1.4;
  margin-bottom: 8px;
}

.update-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.update-btn {
  border: none;
  border-radius: 6px;
  background: #111111;
  color: #ffffff;
  font-size: 11px;
  font-weight: 600;
  font-family: inherit;
  padding: 5px 10px;
  cursor: pointer;
}
.update-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.update-dismiss {
  border: none;
  background: transparent;
  color: var(--yt-muted);
  font-size: 11px;
  font-weight: 550;
  font-family: inherit;
  cursor: pointer;
  padding: 0;
}
.update-dismiss:hover {
  color: var(--yt-text);
}

.update-bar {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  background: #111111;
  transition: width 0.2s ease;
}

.user-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid var(--yt-border);
  background: var(--yt-panel);
  box-shadow: var(--yt-shadow);
}

.avatar {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: #111111;
  color: #ffffff;
  display: grid;
  place-items: center;
  font-size: 13px;
  font-weight: 650;
  flex-shrink: 0;
}

.user-meta {
  min-width: 0;
  flex: 1;
}

.email {
  color: var(--yt-text);
  font-size: 12px;
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.action-link {
  border: none;
  background: transparent;
  color: var(--yt-muted);
  font-size: 11px;
  font-weight: 550;
  font-family: inherit;
  cursor: pointer;
  padding: 2px 0 0;
  text-align: left;
}
.action-link:hover {
  color: var(--yt-text);
}

.settings-icon {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--yt-muted);
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}
.settings-icon:hover {
  color: var(--yt-text);
  background: rgba(17, 17, 17, 0.05);
}

.center {
  flex: 1;
  min-width: 360px;
  overflow: auto;
  padding: 32px 36px;
  background: transparent;
}

.splitter {
  width: 1px;
  flex: 0 0 1px;
  cursor: col-resize;
  background: var(--yt-border);
  position: relative;
}
.splitter::before {
  content: '';
  position: absolute;
  inset: 0 -4px;
}
.splitter:hover {
  background: #111111;
}

.agent-pane {
  flex: 0 0 auto;
  min-width: 320px;
  max-width: 55vw;
  background: transparent;
  border-left: 1px solid var(--yt-border);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.agent-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
