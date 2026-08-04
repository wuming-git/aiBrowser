<template>
  <el-dialog
    v-model="visible"
    title="模型设置"
    width="520px"
    destroy-on-close
    class="settings-dialog"
    @open="load"
  >
    <div v-loading="loading" class="body">
      <el-form label-position="top" class="form">
        <el-form-item label="使用自定义模型">
          <el-switch v-model="form.useCustom" />
          <p class="hint">
            平台免费提供一套模型密钥供试用；您也可以开启此项，填写自己的接口地址与密钥。
            免费额度仅在使用平台密钥时扣减。
          </p>
        </el-form-item>

        <template v-if="form.useCustom">
          <el-form-item label="模型接口地址" required>
            <el-input
              v-model="form.baseUrl"
              placeholder="例如 https://api.deepseek.com/v1"
            />
          </el-form-item>
          <el-form-item label="模型密钥" required>
            <el-input
              v-model="form.apiKey"
              type="password"
              show-password
              :placeholder="keyPlaceholder"
              autocomplete="off"
            />
            <p v-if="hasStoredKey && !form.apiKey" class="hint">已保存密钥，留空则保持不变</p>
          </el-form-item>
          <el-form-item label="模型名称" required>
            <el-input v-model="form.model" placeholder="例如 deepseek-v4-flash" />
          </el-form-item>
        </template>

        <div v-else class="env-preview">
          <div class="preview-title">当前使用平台免费模型</div>
          <div class="row"><span>当前模型</span><code>{{ effective.model || '—' }}</code></div>
          <div class="row"><span>接口地址</span><code>{{ effective.baseUrl || '—' }}</code></div>
          <div class="row"><span>密钥</span><code>{{ effective.hasApiKey ? '平台已提供' : '未配置' }}</code></div>
        </div>
      </el-form>

      <section class="quota">
        <div class="quota-head">
          <h3>Token 使用记录</h3>
          <span class="quota-tag" :class="{ danger: usage.exhausted }">
            {{ usage.exhausted ? '额度已用尽' : '免费额度' }}
          </span>
        </div>
        <p class="hint quota-note">{{ usage.note }}</p>
        <div class="quota-bar">
          <div class="quota-fill" :style="{ width: usage.percent + '%' }" />
        </div>
        <div class="quota-stats">
          <span>已用 {{ formatNum(usage.freeUsed) }}</span>
          <span>剩余 {{ formatNum(usage.freeRemaining) }}</span>
          <span>上限 {{ formatNum(usage.freeQuota) }}</span>
        </div>

        <div v-if="!usage.records.length" class="empty-records">暂无使用记录</div>
        <ul v-else class="records">
          <li v-for="r in usage.records" :key="r.id">
            <div class="rec-top">
              <span class="rec-source" :class="r.source">{{
                r.source === 'custom' ? '自定义' : '免费'
              }}</span>
              <span class="rec-model">{{ r.model || '—' }}</span>
              <span class="rec-time">{{ formatTime(r.createdAt) }}</span>
            </div>
            <div class="rec-tokens">
              输入 {{ formatNum(r.inputTokens) }} · 输出 {{ formatNum(r.outputTokens) }} · 合计
              {{ formatNum(r.totalTokens) }}
            </div>
          </li>
        </ul>
      </section>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { agentApi, type LlmConfig, type TokenUsagePayload } from '@/api'

const visible = defineModel<boolean>({ default: false })
const emit = defineEmits<{ saved: [cfg: LlmConfig] }>()

const loading = ref(false)
const saving = ref(false)
const hasStoredKey = ref(false)
const form = reactive({
  useCustom: false,
  baseUrl: '',
  apiKey: '',
  model: ''
})
const effective = reactive({
  model: '',
  baseUrl: '',
  hasApiKey: false
})
const usage = reactive<TokenUsagePayload>({
  freeQuota: 1_000_000,
  freeUsed: 0,
  freeRemaining: 1_000_000,
  exhausted: false,
  percent: 0,
  records: [],
  note: ''
})

const keyPlaceholder = computed(() =>
  hasStoredKey.value ? '已保存，留空不修改' : 'sk-…'
)

function formatNum(n?: number) {
  return Number(n || 0).toLocaleString('zh-CN')
}

function formatTime(iso?: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function load() {
  loading.value = true
  try {
    const [cfgRes, usageRes] = await Promise.all([
      agentApi.getLlmConfig(),
      agentApi.getTokenUsage()
    ])
    const data = cfgRes.data
    form.useCustom = !!data.useCustom
    form.baseUrl = data.baseUrl || ''
    form.model = data.model || ''
    form.apiKey = ''
    hasStoredKey.value = !!data.hasApiKey
    effective.model = data.effective?.model || data.model || ''
    effective.baseUrl = data.effective?.baseUrl || data.baseUrl || ''
    effective.hasApiKey = !!data.effective?.hasApiKey

    Object.assign(usage, usageRes.data)
  } catch (e: any) {
    ElMessage.error(e?.message || '加载设置失败')
  } finally {
    loading.value = false
  }
}

async function save() {
  if (form.useCustom) {
    if (!form.baseUrl.trim()) {
      ElMessage.warning('请填写模型接口地址')
      return
    }
    if (!form.model.trim()) {
      ElMessage.warning('请填写模型名称')
      return
    }
    if (!form.apiKey.trim() && !hasStoredKey.value) {
      ElMessage.warning('请填写模型密钥')
      return
    }
  }
  saving.value = true
  try {
    const payload: {
      useCustom: boolean
      baseUrl: string
      model: string
      apiKey?: string
    } = {
      useCustom: form.useCustom,
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim()
    }
    if (form.useCustom) {
      payload.apiKey = form.apiKey.trim() ? form.apiKey.trim() : undefined
    }
    const res = await agentApi.putLlmConfig(payload)
    ElMessage.success('已保存')
    emit('saved', res.data)
    visible.value = false
  } catch (e: any) {
    ElMessage.error(e?.message || '保存失败')
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 22px;
}
.hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--yt-muted);
  line-height: 1.55;
}
.env-preview {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--yt-border);
  border-radius: 10px;
  background: var(--yt-bg);
}
.preview-title {
  font-size: 12px;
  font-weight: 650;
  color: var(--yt-muted);
  letter-spacing: 0.04em;
}
.row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  color: var(--yt-muted);
}
.row code {
  font-family: var(--yt-font-mono);
  font-size: 12px;
  color: var(--yt-text);
  max-width: 62%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quota {
  border-top: 1px solid var(--yt-border);
  padding-top: 18px;
}
.quota-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 6px;
}
.quota-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  color: var(--yt-text);
}
.quota-tag {
  font-size: 11px;
  font-weight: 650;
  padding: 3px 8px;
  border-radius: 9999px;
  background: var(--yt-success-bg);
  color: var(--yt-success);
}
.quota-tag.danger {
  background: var(--yt-danger-bg);
  color: var(--yt-danger);
}
.quota-note {
  margin-bottom: 12px;
}
.quota-bar {
  height: 8px;
  border-radius: 9999px;
  background: #ebeae6;
  overflow: hidden;
}
.quota-fill {
  height: 100%;
  background: #111111;
  border-radius: 9999px;
  transition: width 0.25s var(--yt-ease);
}
.quota-stats {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 12px;
  color: var(--yt-muted);
  font-variant-numeric: tabular-nums;
}
.empty-records {
  margin-top: 14px;
  font-size: 12px;
  color: var(--yt-muted);
  text-align: center;
  padding: 16px 0;
}
.records {
  list-style: none;
  margin: 14px 0 0;
  padding: 0;
  max-height: 200px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.records li {
  padding: 10px 12px;
  border: 1px solid var(--yt-border);
  border-radius: 8px;
  background: var(--yt-panel);
}
.rec-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.rec-source {
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 9999px;
  background: #efeeea;
  color: var(--yt-muted);
}
.rec-source.custom {
  background: var(--yt-info-bg, #e1f3fe);
  color: var(--yt-info, #1f6c9f);
}
.rec-model {
  font-size: 12px;
  color: var(--yt-text);
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rec-time {
  margin-left: auto;
  font-size: 11px;
  color: var(--yt-muted);
  font-variant-numeric: tabular-nums;
}
.rec-tokens {
  font-size: 12px;
  color: var(--yt-muted);
  font-variant-numeric: tabular-nums;
}
</style>
