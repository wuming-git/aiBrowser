<template>
  <div class="yt-page edit">
    <div class="yt-page-head">
      <div>
        <p class="yt-eyebrow">Profile</p>
        <h2 class="yt-title page-title">{{ isNew ? '新建环境' : '编辑环境' }}</h2>
        <p class="yt-sub" style="margin-bottom: 0">配置指纹、代理与启动参数</p>
      </div>
      <el-button @click="$router.push('/profiles')">返回</el-button>
    </div>

    <el-form label-position="top" class="form yt-surface form-surface">
      <el-form-item label="名称">
        <el-input v-model="form.name" placeholder="例如：美区 Shopify-01" />
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="form.remark" placeholder="可选" />
      </el-form-item>

      <div class="section">
        <div class="section-head">
          <h3>指纹配置</h3>
          <div class="ai-row">
            <el-select v-model="ai.os" style="width: 120px">
              <el-option label="Windows" value="windows" />
              <el-option label="macOS" value="macos" />
              <el-option label="Linux" value="linux" />
              <el-option label="Android" value="android" />
              <el-option label="iOS" value="ios" />
            </el-select>
            <el-select v-model="ai.region" style="width: 110px">
              <el-option label="US" value="us" />
              <el-option label="CN" value="cn" />
              <el-option label="RU" value="ru" />
              <el-option label="JP" value="jp" />
              <el-option label="EU" value="eu" />
            </el-select>
            <el-button type="primary" :loading="generating" @click="generate">AI 生成</el-button>
          </div>
        </div>
        <el-input v-model="fpText" type="textarea" :rows="14" placeholder="指纹 JSON" class="fp-input" />
      </div>

      <div class="section">
        <h3>代理（可选）</h3>
        <el-form-item label="启用代理">
          <el-switch v-model="proxy.enabled" />
        </el-form-item>
        <div class="grid" v-if="proxy.enabled">
          <el-form-item label="类型">
            <el-select v-model="proxy.type">
              <el-option label="HTTP" value="http" />
              <el-option label="HTTPS" value="https" />
              <el-option label="SOCKS5" value="socks5" />
            </el-select>
          </el-form-item>
          <el-form-item label="主机">
            <el-input v-model="proxy.host" />
          </el-form-item>
          <el-form-item label="端口">
            <el-input-number v-model="proxy.port" :min="1" :max="65535" />
          </el-form-item>
          <el-form-item label="用户名">
            <el-input v-model="proxy.username" />
          </el-form-item>
          <el-form-item label="密码">
            <el-input v-model="proxy.password" type="password" show-password />
          </el-form-item>
        </div>
      </div>

      <div class="actions">
        <el-button type="primary" :loading="saving" @click="() => save(false)">保存</el-button>
        <el-button v-if="!isNew" @click="openEnv">保存并打开</el-button>
      </div>
    </el-form>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { profileApi } from '@/api'
import { getDesktopApi, toIpcPayload } from '@/utils/desktopApi'

const route = useRoute()
const router = useRouter()
const isNew = computed(() => route.path.endsWith('/new'))
const saving = ref(false)
const generating = ref(false)
const fpText = ref('')

const form = reactive({ name: '', remark: '' })
const ai = reactive({ os: 'windows', region: 'us' })
const proxy = reactive({
  enabled: false,
  type: 'http' as 'http' | 'https' | 'socks5',
  host: '',
  port: 8080,
  username: '',
  password: ''
})

async function load() {
  if (isNew.value) return
  const id = Number(route.params.id)
  const res = await profileApi.get(id)
  const p = res.data
  form.name = p.name
  form.remark = p.remark || ''
  fpText.value = JSON.stringify(p.fingerprint || {}, null, 2)
  if (p.proxy) {
    proxy.enabled = !!p.proxy.enabled
    proxy.type = p.proxy.type || 'http'
    proxy.host = p.proxy.host || ''
    proxy.port = p.proxy.port || 8080
    proxy.username = p.proxy.username || ''
    proxy.password = p.proxy.password || ''
  }
}

async function generate() {
  generating.value = true
  try {
    const res = await profileApi.generateFp({ os: ai.os, region: ai.region })
    fpText.value = JSON.stringify(res.data, null, 2)
    ElMessage.success('已生成')
  } catch (e: any) {
    ElMessage.error(e.message || '生成失败')
  } finally {
    generating.value = false
  }
}

function parseFp() {
  try {
    return JSON.parse(fpText.value || '{}')
  } catch {
    throw new Error('指纹 JSON 格式不正确')
  }
}

async function save(andOpen: boolean) {
  if (!form.name.trim()) {
    ElMessage.warning('请填写名称')
    return
  }
  saving.value = true
  try {
    const fingerprint = parseFp()
    const proxyCfg = proxy.enabled
      ? {
          enabled: true,
          type: proxy.type,
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
          password: proxy.password
        }
      : { enabled: false }

    if (isNew.value) {
      const res = await profileApi.create({
        name: form.name,
        remark: form.remark,
        fingerprint,
        proxy: proxyCfg
      })
      ElMessage.success('已创建')
      if (andOpen) await launch(res.data.id, fingerprint, proxyCfg)
      else router.push('/profiles')
    } else {
      const id = Number(route.params.id)
      await profileApi.update(id, {
        name: form.name,
        remark: form.remark,
        fingerprint,
        proxy: proxyCfg
      })
      ElMessage.success('已保存')
      if (andOpen) await launch(id, fingerprint, proxyCfg)
      else router.push('/profiles')
    }
  } catch (e: any) {
    ElMessage.error(e.message || '保存失败')
  } finally {
    saving.value = false
  }
}

async function openEnv() {
  await save(true)
}

async function launch(id: number, fingerprint: unknown, proxyCfg: unknown) {
  const api = getDesktopApi()
  if (!api?.launchBrowser) {
    ElMessage.error('桌面桥接未就绪，请完全退出后重新执行 npm run dev')
    return
  }
  try {
    const res = await api.launchBrowser(
      toIpcPayload({
        profileId: id,
        fingerprint,
        proxy: proxyCfg
      })
    )
    if (res.ok) ElMessage.success(`已启动 (pid=${res.pid})`)
    else ElMessage.error(res.message || '启动失败')
  } catch (e: any) {
    ElMessage.error(e?.message || '启动失败')
  }
}

onMounted(() => {
  load().catch((e) => ElMessage.error(e.message || '加载失败'))
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
.form-surface {
  padding: 24px 28px 28px;
  max-width: 880px;
}
.form {
  max-width: 880px;
}
.section {
  margin: 28px 0;
  padding-top: 20px;
  border-top: 1px solid var(--yt-border);
}
.section h3 {
  margin: 0 0 16px;
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--yt-muted);
}
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.section-head h3 {
  margin: 0;
}
.ai-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px 16px;
}
.fp-input :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.55;
}
.actions {
  display: flex;
  gap: 10px;
  margin-top: 8px;
  padding-top: 20px;
  border-top: 1px solid var(--yt-border);
}
</style>
