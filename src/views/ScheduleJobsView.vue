<template>
  <div class="yt-page">
    <div class="yt-page-head">
      <div>
        <p class="yt-eyebrow">Automation</p>
        <h2 class="yt-title page-title">定时任务</h2>
        <p class="yt-sub" style="margin-bottom: 0">查看、编辑本机调度任务与执行日志</p>
      </div>
      <el-button @click="load" :loading="loading">
        <el-icon class="btn-ico"><Refresh /></el-icon>
        刷新
      </el-button>
    </div>

    <div class="yt-surface">
    <el-table :data="list" v-loading="loading" class="yt-table table" empty-text="暂无定时任务">
      <el-table-column prop="name" label="任务名称" min-width="140" />
      <el-table-column label="任务状态" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="displayStatusType(row)">
            {{ displayStatusLabel(row) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="执行时间" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">{{ formatScheduleLabel(row.cron) }}</template>
      </el-table-column>
      <el-table-column label="操作" min-width="380" fixed="right">
        <template #default="{ row }">
          <el-button size="small" type="primary" plain @click="openEdit(row)">编辑</el-button>
          <el-button size="small" text type="primary" @click="openLogs(row)">执行日志</el-button>
          <el-button size="small" :disabled="!!row.executing" @click="runNow(row)">
            立即执行
          </el-button>
          <el-button
            v-if="row.status !== 'paused'"
            size="small"
            @click="setStatus(row, 'paused')"
          >
            暂停
          </el-button>
          <el-button v-else size="small" type="primary" @click="setStatus(row, 'running')">
            恢复
          </el-button>
          <el-button size="small" type="danger" :disabled="!!row.executing" @click="remove(row)">
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>
    </div>

    <el-dialog
      v-model="editVisible"
      title="编辑定时任务"
      width="580px"
      destroy-on-close
      class="edit-dialog"
      @closed="onEditClosed"
    >
      <el-form label-position="top" class="edit-form" @submit.prevent>
        <el-form-item label="任务名称" required>
          <el-input v-model="form.name" maxlength="80" show-word-limit placeholder="例如：每日新闻早报" />
        </el-form-item>

        <el-form-item label="什么时候执行" required>
          <div class="schedule-simple" :class="{ dimmed: useCustomCron }">
            <el-radio-group
              v-model="simple.frequency"
              class="freq-group"
              :disabled="useCustomCron"
              @change="onSimpleChange"
            >
              <el-radio-button value="daily">每天</el-radio-button>
              <el-radio-button value="weekdays">工作日</el-radio-button>
              <el-radio-button value="weekly">每周</el-radio-button>
              <el-radio-button value="hourly">每隔几小时</el-radio-button>
              <el-radio-button value="everyMinutes">每隔几分钟</el-radio-button>
            </el-radio-group>

            <div v-if="needsClock" class="schedule-row">
              <span class="schedule-label">时间</span>
              <el-select
                v-model="simple.hour"
                :disabled="useCustomCron"
                style="width: 100px"
                @change="onSimpleChange"
              >
                <el-option v-for="h in hourOptions" :key="h" :label="pad2(h) + ' 时'" :value="h" />
              </el-select>
              <el-select
                v-model="simple.minute"
                :disabled="useCustomCron"
                style="width: 100px"
                @change="onSimpleChange"
              >
                <el-option v-for="m in minuteOptions" :key="m" :label="pad2(m) + ' 分'" :value="m" />
              </el-select>
            </div>

            <div v-if="simple.frequency === 'weekly'" class="schedule-row">
              <span class="schedule-label">星期</span>
              <el-select
                v-model="simple.weekday"
                :disabled="useCustomCron"
                style="width: 140px"
                @change="onSimpleChange"
              >
                <el-option
                  v-for="w in WEEKDAY_OPTIONS"
                  :key="w.value"
                  :label="w.label"
                  :value="w.value"
                />
              </el-select>
            </div>

            <div v-if="simple.frequency === 'hourly'" class="schedule-row">
              <span class="schedule-label">间隔</span>
              <el-select
                v-model="simple.everyHours"
                :disabled="useCustomCron"
                style="width: 140px"
                @change="onSimpleChange"
              >
                <el-option
                  v-for="n in EVERY_HOURS_OPTIONS"
                  :key="n"
                  :label="`每 ${n} 小时`"
                  :value="n"
                />
              </el-select>
              <el-select
                v-model="simple.minute"
                :disabled="useCustomCron"
                style="width: 120px"
                @change="onSimpleChange"
              >
                <el-option v-for="m in minuteOptions" :key="m" :label="`第 ${pad2(m)} 分`" :value="m" />
              </el-select>
            </div>

            <div v-if="simple.frequency === 'everyMinutes'" class="schedule-row">
              <span class="schedule-label">间隔</span>
              <el-select
                v-model="simple.everyMinutes"
                :disabled="useCustomCron"
                style="width: 160px"
                @change="onSimpleChange"
              >
                <el-option
                  v-for="n in EVERY_MINUTES_OPTIONS"
                  :key="n"
                  :label="`每 ${n} 分钟`"
                  :value="n"
                />
              </el-select>
            </div>

            <p class="schedule-preview">
              {{
                useCustomCron
                  ? '已启用高级 Cron，上方简易时间不会生效'
                  : `将按：${describeSimpleSchedule(simple)} 执行`
              }}
            </p>
          </div>
        </el-form-item>

        <el-form-item label="浏览器环境">
          <el-select
            v-model="form.profileId"
            filterable
            clearable
            placeholder="选择指纹环境"
            style="width: 100%"
          >
            <el-option
              v-for="p in profiles"
              :key="p.id"
              :label="`${p.name} (#${p.id})`"
              :value="p.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="任务提示词（给大模型）">
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="4"
            maxlength="2000"
            show-word-limit
            placeholder="到点执行时交给 Agent 的任务说明；留空则只打开 URL"
          />
        </el-form-item>
        <el-form-item label="备注（仅展示）">
          <el-input v-model="form.remark" maxlength="200" show-word-limit placeholder="给自己看的备注" />
        </el-form-item>
        <el-form-item label="任务状态">
          <el-radio-group v-model="form.status">
            <el-radio-button value="running">空闲（启用调度）</el-radio-button>
            <el-radio-button value="paused">暂停</el-radio-button>
          </el-radio-group>
          <p class="field-hint">启用后平时显示「空闲」，到点执行时显示「执行中」</p>
        </el-form-item>

        <div class="advanced-toggle">
          <el-button text type="primary" @click="advancedOpen = !advancedOpen">
            {{ advancedOpen ? '收起高级选项' : '高级选项' }}
            <span class="advanced-caret">{{ advancedOpen ? '▴' : '▾' }}</span>
          </el-button>
        </div>

        <div v-show="advancedOpen" class="advanced-panel">
          <el-form-item label="打开 URL">
            <el-input v-model="form.url" placeholder="https://…（到点先打开此页面）" />
            <p class="field-hint">一般由任务提示词决定打开哪里；仅在需要固定入口页时填写</p>
          </el-form-item>
          <el-form-item label="使用 Cron 表达式">
            <el-switch
              v-model="useCustomCron"
              active-text="用 Cron 控制时间"
              inactive-text="用上方简易时间"
            />
            <p class="field-hint">开启后以 Cron 为准，忽略上方「每天 / 工作日…」设置</p>
          </el-form-item>
          <el-form-item v-if="useCustomCron" label="Cron 表达式" required>
            <el-input
              v-model="form.cron"
              placeholder="例如每天 9 点：0 9 * * *"
              @input="onCronManualInput"
            />
            <p class="field-hint">标准 5 段：分 时 日 月 周（0=周日）</p>
          </el-form-item>
          <el-form-item v-else label="当前对应 Cron（只读）">
            <el-input :model-value="buildCronFromSimple(simple)" readonly />
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="logVisible" :title="logTitle" size="480px">
      <p class="log-hint">
        此处为桌面调度摘要（打开 URL / 是否调 Agent / 结果摘要）。完整主 Agent 提示词与各轮
        LLM 输入输出在后端
        <code>browser-agent/logs/&lt;sessionId&gt;/chat.log</code>。
      </p>
      <div v-if="logLoading" class="log-empty">加载中…</div>
      <div v-else-if="logs.length === 0" class="log-empty">暂无执行日志</div>
      <div v-else class="log-list">
        <div v-for="item in logs" :key="item.id" class="log-item" :class="{ fail: !item.ok }">
          <div class="log-top">
            <el-tag size="small" :type="item.ok ? 'success' : 'danger'" effect="plain">
              {{ item.ok ? '成功' : '失败' }}
            </el-tag>
            <span class="log-time">{{ formatTime(item.at) }}</span>
            <span v-if="item.durationMs != null" class="log-ms">{{ item.durationMs }}ms</span>
          </div>
          <div class="log-msg">{{ item.message }}</div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { profileApi, type Profile } from '@/api'
import {
  getDesktopApi,
  toIpcPayload,
  type ScheduleJob,
  type ScheduleLog
} from '@/utils/desktopApi'
import {
  EVERY_HOURS_OPTIONS,
  EVERY_MINUTES_OPTIONS,
  WEEKDAY_OPTIONS,
  buildCronFromSimple,
  defaultSimpleSchedule,
  describeSimpleSchedule,
  formatScheduleLabel,
  parseCronToSimple,
  type SimpleSchedule
} from '@/utils/scheduleUi'

const list = ref<ScheduleJob[]>([])
const profiles = ref<Profile[]>([])
const loading = ref(false)
const logs = ref<ScheduleLog[]>([])
const logVisible = ref(false)
const logLoading = ref(false)
const logTitle = ref('执行日志')
const editVisible = ref(false)
const saving = ref(false)
const editingJobId = ref('')
const advancedOpen = ref(false)
const useCustomCron = ref(false)
const simple = reactive<SimpleSchedule>(defaultSimpleSchedule())
const form = reactive({
  name: '',
  cron: '',
  url: '',
  profileId: undefined as number | string | undefined,
  description: '',
  remark: '',
  status: 'running' as 'running' | 'paused'
})
let timer: ReturnType<typeof setInterval> | null = null

const hourOptions = Array.from({ length: 24 }, (_, i) => i)
const minuteOptions = Array.from({ length: 60 }, (_, i) => i)
const needsClock = computed(
  () => simple.frequency === 'daily' || simple.frequency === 'weekdays' || simple.frequency === 'weekly'
)

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

/** 列表展示态：空闲 / 暂停 / 执行中 */
function displayStatusLabel(row: ScheduleJob) {
  if (row.status === 'paused') return '暂停'
  if (row.executing) return '执行中'
  return '空闲'
}

function displayStatusType(row: ScheduleJob) {
  if (row.status === 'paused') return 'info'
  if (row.executing) return 'warning'
  return 'success'
}

function formatTime(v?: string) {
  if (!v) return '-'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function onSimpleChange() {
  if (!useCustomCron.value) {
    form.cron = buildCronFromSimple(simple)
  }
}

function onCronManualInput() {
  useCustomCron.value = true
}

function onEditClosed() {
  editingJobId.value = ''
  advancedOpen.value = false
  useCustomCron.value = false
}

async function loadProfiles() {
  try {
    const res = await profileApi.list()
    profiles.value = res.data || []
  } catch {
    profiles.value = []
  }
}

async function load() {
  const api = getDesktopApi()
  if (!api?.schedulerList) {
    ElMessage.warning('请在 Electron 客户端中查看定时任务')
    list.value = []
    return
  }
  loading.value = true
  try {
    list.value = (await api.schedulerList()) || []
  } catch (e: any) {
    ElMessage.error(e?.message || '加载失败')
  } finally {
    loading.value = false
  }
}

async function openLogs(row: ScheduleJob) {
  const api = getDesktopApi()
  if (!api?.schedulerLogs) return
  logTitle.value = `执行日志 · ${row.name}`
  logVisible.value = true
  logLoading.value = true
  try {
    logs.value = (await api.schedulerLogs(row.jobId, 100)) || []
  } catch (e: any) {
    ElMessage.error(e?.message || '日志加载失败')
    logs.value = []
  } finally {
    logLoading.value = false
  }
}

async function openEdit(row: ScheduleJob) {
  if (!profiles.value.length) await loadProfiles()
  editingJobId.value = row.jobId
  form.name = row.name || ''
  form.cron = row.cron || ''
  form.url = row.url || ''
  form.profileId = row.profileId
  form.description = row.description || ''
  form.remark = row.remark || ''
  form.status = row.status === 'paused' ? 'paused' : 'running'

  const parsed = parseCronToSimple(row.cron || '')
  if (parsed) {
    Object.assign(simple, parsed)
    useCustomCron.value = false
    advancedOpen.value = false
    form.cron = buildCronFromSimple(simple)
  } else {
    Object.assign(simple, defaultSimpleSchedule())
    useCustomCron.value = true
    advancedOpen.value = true
  }
  editVisible.value = true
}

async function saveEdit() {
  const api = getDesktopApi()
  if (!api?.schedulerUpdate || !editingJobId.value) return
  const name = form.name.trim()
  if (!name) {
    ElMessage.warning('请填写任务名称')
    return
  }

  let cron = ''
  if (useCustomCron.value) {
    cron = form.cron.trim()
    if (!cron) {
      ElMessage.warning('请填写 Cron 表达式，或关闭高级里的 Cron 开关改用简易时间')
      advancedOpen.value = true
      return
    }
  } else {
    cron = buildCronFromSimple(simple)
    form.cron = cron
  }

  let url = form.url.trim()
  if (!url) {
    // 简易模式下 URL 在高级区，允许空则给占位；后端要求 http(s)
    url = 'https://browser168.com'
    form.url = url
  }
  if (!/^https?:\/\//i.test(url)) {
    ElMessage.warning('URL 必须以 http(s):// 开头')
    advancedOpen.value = true
    return
  }

  saving.value = true
  try {
    await api.schedulerUpdate(
      editingJobId.value,
      toIpcPayload({
        name,
        cron,
        url,
        profileId: form.profileId,
        description: form.description,
        remark: form.remark,
        status: form.status
      })
    )
    ElMessage.success('已保存')
    editVisible.value = false
    await load()
  } catch (e: any) {
    ElMessage.error(e?.message || '保存失败')
  } finally {
    saving.value = false
  }
}

async function setStatus(row: ScheduleJob, status: 'running' | 'paused') {
  const api = getDesktopApi()
  if (!api?.schedulerSetStatus) return
  try {
    const wasExecuting = !!row.executing
    await api.schedulerSetStatus(row.jobId, status)
    if (status === 'paused') {
      ElMessage.success(wasExecuting ? '已暂停：已停止调度并中止当前执行' : '已暂停调度')
    } else {
      ElMessage.success('已恢复调度')
    }
    await load()
  } catch (e: any) {
    ElMessage.error(e?.message || '操作失败')
  }
}

async function runNow(row: ScheduleJob) {
  const api = getDesktopApi()
  if (!api?.schedulerRunNow) return
  try {
    const res = await api.schedulerRunNow(row.jobId)
    if (res?.ok) ElMessage.success('已触发执行')
    else ElMessage.warning('触发失败')
    setTimeout(() => void load(), 800)
  } catch (e: any) {
    ElMessage.error(e?.message || '执行失败')
  }
}

async function remove(row: ScheduleJob) {
  await ElMessageBox.confirm(`确认删除任务「${row.name}」？`, '提示')
  const api = getDesktopApi()
  if (!api?.schedulerCancel) return
  await api.schedulerCancel(row.jobId)
  ElMessage.success('已删除')
  await load()
}

function refreshIntervalMs() {
  return list.value.some((j) => j.executing) ? 2000 : 8000
}

function armRefreshTimer() {
  if (timer) clearInterval(timer)
  timer = setInterval(() => {
    void load().then(() => armRefreshTimer())
  }, refreshIntervalMs())
}

onMounted(() => {
  void loadProfiles()
  void load().then(() => armRefreshTimer())
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
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
.yt-surface {
  padding: 4px 0;
}
.yt-surface :deep(.el-table) {
  --el-table-header-bg-color: #fbfbfa;
}
.yt-surface :deep(.el-table__header th) {
  background: #fbfbfa !important;
}
.table :deep(.el-button + .el-button) {
  margin-left: 6px;
}
.field-hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--yt-muted);
}
.edit-form :deep(.el-form-item__label) {
  color: var(--yt-muted);
}
.schedule-simple {
  width: 100%;
  padding: 14px 16px;
  border-radius: 10px;
  border: 1px solid var(--yt-border);
  background: var(--yt-panel);
  box-shadow: var(--yt-shadow);
  transition: opacity 0.2s ease;
}
.schedule-simple.dimmed {
  opacity: 0.45;
}
.freq-group {
  display: flex;
  flex-wrap: wrap;
  gap: 0;
  margin-bottom: 12px;
}
.schedule-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 10px;
}
.schedule-label {
  width: 36px;
  font-size: 13px;
  color: var(--yt-muted);
}
.schedule-preview {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--yt-text);
}
.advanced-toggle {
  margin: 4px 0 8px;
}
.advanced-caret {
  margin-left: 4px;
  opacity: 0.8;
}
.advanced-panel {
  margin-top: 4px;
  padding: 14px 14px 4px;
  border-radius: 8px;
  border: 1px solid #bdbcb7;
  background: var(--yt-panel);
}
.log-hint {
  margin: 0 0 14px;
  padding: 12px 14px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--yt-muted);
  border-radius: 8px;
  border: 1px solid #bdbcb7;
  background: var(--yt-panel);
}
.log-hint code {
  font-size: 11px;
  color: var(--yt-text);
}
.log-empty {
  color: var(--yt-muted);
  padding: 24px 8px;
  font-size: 13px;
}
.log-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.log-item {
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid #bdbcb7;
  background: var(--yt-panel);
}
.log-item.fail {
  border-color: color-mix(in srgb, var(--yt-danger) 35%, var(--yt-border));
}
.log-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.log-time {
  color: var(--yt-muted);
  font-size: 12px;
}
.log-ms {
  margin-left: auto;
  color: var(--yt-muted);
  font-size: 12px;
}
.log-msg {
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
  white-space: pre-wrap;
}
</style>
