<template>
  <div class="yt-page">
    <div class="yt-page-head">
      <div>
        <p class="yt-eyebrow">Workspace</p>
        <h2 class="yt-title page-title">浏览器环境</h2>
        <p class="yt-sub" style="margin-bottom: 0">管理指纹配置并启动独立 Chrome 环境</p>
      </div>
      <el-button type="primary" @click="$router.push('/profiles/new')">
        <el-icon class="btn-ico"><Plus /></el-icon>
        新建环境
      </el-button>
    </div>

    <div class="yt-surface">
      <el-table :data="list" v-loading="loading" class="yt-table" empty-text="暂无环境">
        <el-table-column prop="name" label="名称" min-width="160" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="isRunning(row.id) ? 'success' : 'info'">
              {{ isRunning(row.id) ? '运行中' : '未打开' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="系统" width="120">
          <template #default="{ row }">{{ row.fingerprint?.os || '-' }}</template>
        </el-table-column>
        <el-table-column label="地区" width="100">
          <template #default="{ row }">{{ row.fingerprint?.region || '-' }}</template>
        </el-table-column>
        <el-table-column label="代理" width="120">
          <template #default="{ row }">{{ row.proxy?.enabled ? `${row.proxy.host}:${row.proxy.port}` : '直连' }}</template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="140" />
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="isRunning(row.id)"
              size="small"
              type="danger"
              :loading="busyId === row.id"
              @click="closeEnv(row)"
            >
              关闭
            </el-button>
            <el-button
              v-else
              size="small"
              type="primary"
              :loading="busyId === row.id"
              @click="openEnv(row)"
            >
              打开
            </el-button>
            <el-button size="small" @click="$router.push(`/profiles/${row.id}`)">编辑</el-button>
            <el-button size="small" type="danger" plain @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { profileApi, type Profile } from '@/api'
import { getDesktopApi, toIpcPayload } from '@/utils/desktopApi'

const list = ref<Profile[]>([])
const loading = ref(false)
const busyId = ref<number | null>(null)
const runningMap = ref<Record<string, number>>({})

let offBrowserStatus: (() => void) | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

function isRunning(id: number | string) {
  return runningMap.value[String(id)] != null
}

function applyBrowsers(browsers: Array<{ profileId: string; pid: number }>) {
  const next: Record<string, number> = {}
  for (const b of browsers || []) {
    next[String(b.profileId)] = b.pid
  }
  runningMap.value = next
}

async function refreshRunning() {
  const api = getDesktopApi()
  if (!api?.listBrowsers) return
  try {
    const browsers = await api.listBrowsers()
    applyBrowsers(browsers)
  } catch (_) {}
}

async function load() {
  loading.value = true
  try {
    const res = await profileApi.list()
    list.value = res.data || []
    await refreshRunning()
  } catch (e: any) {
    ElMessage.error(e.message || '加载失败')
  } finally {
    loading.value = false
  }
}

async function openEnv(row: Profile) {
  const api = getDesktopApi()
  if (!api?.launchBrowser) {
    ElMessage.error('桌面桥接未就绪，请完全退出后重新执行 npm run dev')
    return
  }
  busyId.value = row.id
  try {
    const res = await api.launchBrowser(
      toIpcPayload({
        profileId: row.id,
        name: row.name,
        fingerprint: row.fingerprint,
        proxy: row.proxy
      })
    )
    if (res.ok) {
      if (res.pid) {
        runningMap.value = { ...runningMap.value, [String(row.id)]: res.pid }
      }
      ElMessage.success(res.message || `已启动 (pid=${res.pid})`)
    } else {
      ElMessage.error(res.message || '启动失败')
    }
    await refreshRunning()
  } catch (e: any) {
    ElMessage.error(e?.message || '启动失败')
  } finally {
    busyId.value = null
  }
}

async function closeEnv(row: Profile) {
  const api = getDesktopApi()
  if (!api?.closeBrowser) {
    ElMessage.error('桌面桥接未就绪')
    return
  }
  busyId.value = row.id
  try {
    const res = await api.closeBrowser(row.id)
    if (res.ok) {
      const next = { ...runningMap.value }
      delete next[String(row.id)]
      runningMap.value = next
      ElMessage.success('已关闭')
    } else {
      ElMessage.error('关闭失败')
    }
    await refreshRunning()
  } catch (e: any) {
    ElMessage.error(e?.message || '关闭失败')
  } finally {
    busyId.value = null
  }
}

async function remove(row: Profile) {
  if (isRunning(row.id)) {
    await ElMessageBox.confirm(`环境「${row.name}」正在运行，删除前将先关闭浏览器。继续？`, '提示')
    await closeEnv(row)
  } else {
    await ElMessageBox.confirm(`确认删除环境「${row.name}」？`, '提示')
  }
  await profileApi.remove(row.id)
  ElMessage.success('已删除')
  load()
}

onMounted(() => {
  load()
  const api = getDesktopApi()
  if (api?.onBrowserStatus) {
    offBrowserStatus = api.onBrowserStatus((ev) => {
      if (Array.isArray(ev.browsers)) {
        applyBrowsers(ev.browsers)
      } else if (!ev.running) {
        const next = { ...runningMap.value }
        delete next[String(ev.profileId)]
        runningMap.value = next
      } else if (ev.pid) {
        runningMap.value = { ...runningMap.value, [String(ev.profileId)]: ev.pid }
      }
    })
  }
  pollTimer = setInterval(() => {
    void refreshRunning()
  }, 2000)
})

onBeforeUnmount(() => {
  offBrowserStatus?.()
  offBrowserStatus = null
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
})
</script>

<style scoped>
.page-title {
  font-family: var(--yt-font);
  font-size: 24px;
  font-weight: 650;
  margin-bottom: 6px;
  letter-spacing: -0.025em;
}
.btn-ico {
  margin-right: 4px;
}
.yt-table :deep(.el-button + .el-button) {
  margin-left: 6px;
}
.yt-surface {
  padding: 4px 0;
}
.yt-surface :deep(.el-table) {
  --el-table-header-bg-color: #fbfbfa;
}
.yt-surface :deep(.el-table__header th) {
  background: #fbfbfa !important;
}
</style>
