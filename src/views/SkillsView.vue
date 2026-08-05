<template>
  <div class="yt-page skills-page">
    <div class="yt-page-head">
      <div>
        <p class="yt-eyebrow">Agent</p>
        <h2 class="yt-title page-title">技能</h2>
        <p class="yt-sub" style="margin-bottom: 0">
          系统默认技能人人均可用；编辑后仅保存为你的个人副本，不影响系统与其他用户。
        </p>
      </div>
      <div class="head-actions">
        <el-button @click="loadList" :loading="listLoading">
          <el-icon class="btn-ico"><Refresh /></el-icon>
          刷新
        </el-button>
        <el-button type="primary" @click="openCreate">
          <el-icon class="btn-ico"><Plus /></el-icon>
          新建技能
        </el-button>
      </div>
    </div>

    <div class="skills-grid" v-loading="listLoading">
      <button
        v-for="item in list"
        :key="item.name"
        type="button"
        class="skill-card"
        @click="openEdit(item.name)"
      >
        <div class="card-top">
          <span class="card-name">{{ item.name }}</span>
          <span class="skill-badge" :data-source="item.source">{{ sourceLabel(item.source) }}</span>
        </div>
        <p class="card-desc">{{ item.description || '暂无描述' }}</p>
        <div class="card-meta">
          <span>{{ layerLabel(item.layer) }}</span>
          <span v-if="item.tools?.length">{{ item.tools.length }} 个扩展工具</span>
        </div>
      </button>

      <p v-if="!listLoading && !list.length" class="empty-hint">暂无技能，点击右上角新建</p>
    </div>

    <el-dialog
      v-model="editVisible"
      :title="isCreate ? '新建技能' : `编辑 · ${form.name}`"
      width="920px"
      top="2vh"
      destroy-on-close
      class="skill-edit-dialog"
      @closed="onEditClosed"
    >
      <div v-loading="detailLoading" class="edit-dialog-body">
        <el-form label-position="top" class="edit-form" @submit.prevent>
          <div class="edit-fields">
            <el-form-item v-if="isCreate" label="技能标识" required>
              <el-input
                v-model="form.name"
                maxlength="64"
                placeholder="小写英文，例如 site-example"
                @input="onNameInput"
              />
              <p class="field-hint">保存后不可改名；Agent 通过 load_skill 使用此名称。</p>
            </el-form-item>

            <el-form-item v-else label="技能标识">
              <el-input :model-value="form.name" disabled />
            </el-form-item>

            <el-form-item label="简介" required>
              <el-input
                v-model="form.description"
                type="textarea"
                :autosize="{ minRows: 2, maxRows: 4 }"
                maxlength="500"
                show-word-limit
                placeholder="说明此技能适用场景、触发时机与注意事项"
              />
            </el-form-item>

            <div class="form-row">
              <el-form-item label="类型" class="half">
                <el-select v-model="form.layer" style="width: 100%">
                  <el-option label="普通技能" value="skill" />
                  <el-option label="子 Agent" value="subagent" />
                </el-select>
              </el-form-item>
              <el-form-item label="扩展工具" class="half">
                <el-input
                  v-model="form.toolsText"
                  placeholder="可选，逗号分隔，如 browser_wait_for, solve_captcha"
                />
              </el-form-item>
            </div>
          </div>

          <el-form-item label="操作说明" required class="body-item">
            <div v-show="!detailLoading" ref="editorHost" class="wysiwyg-host" />
          </el-form-item>
        </el-form>
      </div>

      <template #footer>
        <div class="dialog-foot">
          <div class="foot-left">
            <el-button v-if="detail?.canReset" :loading="saving" @click="onReset">
              恢复默认
            </el-button>
            <el-button
              v-if="detail?.canDelete"
              type="danger"
              plain
              :loading="saving"
              @click="onDelete"
            >
              删除
            </el-button>
          </div>
          <div class="foot-right">
            <el-button @click="editVisible = false">取消</el-button>
            <el-button type="primary" :loading="saving" @click="onSave">
              {{ isCreate ? '创建' : '保存' }}
            </el-button>
          </div>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh } from '@element-plus/icons-vue'
import Editor from '@toast-ui/editor'
import '@toast-ui/editor/dist/toastui-editor.css'
import '@toast-ui/editor/dist/i18n/zh-cn'
import { skillsApi, type UserSkillDetail, type UserSkillSummary } from '@/api'

type SkillForm = {
  name: string
  description: string
  layer: string
  toolsText: string
  body: string
}

const list = ref<UserSkillSummary[]>([])
const listLoading = ref(false)
const editVisible = ref(false)
const isCreate = ref(false)
const detail = ref<UserSkillDetail | null>(null)
const detailLoading = ref(false)
const saving = ref(false)
const editorHost = ref<HTMLElement | null>(null)
let bodyEditor: Editor | null = null
let editorResizeObserver: ResizeObserver | null = null

const form = reactive<SkillForm>({
  name: '',
  description: '',
  layer: 'skill',
  toolsText: '',
  body: ''
})

function syncEditorHeight() {
  const el = editorHost.value
  if (!el || !bodyEditor) return
  const h = Math.max(el.clientHeight, 160)
  bodyEditor.setHeight(`${h}px`)
}

function stopEditorResizeWatch() {
  if (editorResizeObserver) {
    editorResizeObserver.disconnect()
    editorResizeObserver = null
  }
}

function startEditorResizeWatch(el: HTMLElement) {
  stopEditorResizeWatch()
  editorResizeObserver = new ResizeObserver(() => {
    syncEditorHeight()
  })
  editorResizeObserver.observe(el)
}

function destroyBodyEditor() {
  stopEditorResizeWatch()
  if (bodyEditor) {
    try {
      bodyEditor.destroy()
    } catch {
      /* ignore */
    }
    bodyEditor = null
  }
}

function syncBodyFromEditor() {
  if (bodyEditor) {
    form.body = bodyEditor.getMarkdown() || ''
  }
}

async function mountBodyEditor(markdown: string) {
  destroyBodyEditor()
  await nextTick()
  // 等待 dialog 内容挂载完成
  await new Promise((r) => requestAnimationFrame(() => r(null)))
  const el = editorHost.value
  if (!el) return
  el.innerHTML = ''
  const initialHeight = Math.max(el.clientHeight, 240)
  bodyEditor = new Editor({
    el,
    height: `${initialHeight}px`,
    initialEditType: 'wysiwyg',
    hideModeSwitch: true,
    usageStatistics: false,
    language: 'zh-CN',
    placeholder: '在美化文档中直接编写步骤与规则…',
    toolbarItems: [
      ['heading', 'bold', 'italic', 'strike'],
      ['hr', 'quote'],
      ['ul', 'ol', 'task', 'indent', 'outdent'],
      ['table', 'code', 'codeblock']
    ],
    initialValue: markdown || ''
  })
  startEditorResizeWatch(el)
  await nextTick()
  syncEditorHeight()
}

function sourceLabel(source: string) {
  if (source === 'system') return '系统默认'
  if (source === 'override') return '已个性化'
  return '我的技能'
}

function layerLabel(layer: string) {
  if (layer === 'subagent') return '子 Agent'
  return '普通技能'
}

function onNameInput(v: string) {
  form.name = String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
}

function parseSkillContent(raw: string): Omit<SkillForm, 'name'> & { name?: string } {
  const text = (raw || '').trim()
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!m) {
    return { description: '', layer: 'skill', toolsText: '', body: text }
  }
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#') || !s.includes(':')) continue
    const i = s.indexOf(':')
    meta[s.slice(0, i).trim().toLowerCase()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  let tools = meta.tools || ''
  if (tools.startsWith('[') && tools.endsWith(']')) {
    tools = tools
      .slice(1, -1)
      .split(/[,，]/)
      .map((x) => x.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
      .join(', ')
  }
  return {
    name: meta.name,
    description: meta.description || '',
    layer: meta.layer || 'skill',
    toolsText: tools,
    body: (m[2] || '').trim()
  }
}

function yamlScalar(value: string): string {
  // frontmatter 单行字段：折叠空白并 JSON 转义，避免冒号/引号破坏 YAML
  return JSON.stringify(String(value || '').trim().replace(/\s+/g, ' '))
}

function buildSkillContent(f: SkillForm): string {
  const tools = f.toolsText
    .split(/[,，]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(', ')
  const body = (f.body || '').trim() || `# ${f.name}\n`
  return (
    `---\n` +
    `name: ${f.name}\n` +
    `description: ${yamlScalar(f.description)}\n` +
    `layer: ${f.layer || 'skill'}\n` +
    `tools: ${tools}\n` +
    `---\n\n` +
    `${body}\n`
  )
}

function fillForm(partial: Partial<SkillForm>) {
  form.name = partial.name || ''
  form.description = partial.description || ''
  form.layer = partial.layer || 'skill'
  form.toolsText = partial.toolsText || ''
  form.body = partial.body || ''
}

async function loadList() {
  listLoading.value = true
  try {
    const res = await skillsApi.list()
    list.value = res.data || []
  } catch (e: any) {
    ElMessage.error(e.message || '加载技能列表失败')
  } finally {
    listLoading.value = false
  }
}

async function openEdit(name: string) {
  isCreate.value = false
  editVisible.value = true
  detailLoading.value = true
  detail.value = null
  destroyBodyEditor()
  try {
    const res = await skillsApi.get(name)
    detail.value = res.data
    const parsed = parseSkillContent(res.data.content || '')
    fillForm({
      name: res.data.name,
      description: parsed.description || res.data.description || '',
      layer: parsed.layer || res.data.layer || 'skill',
      toolsText: parsed.toolsText || (res.data.tools || []).join(', '),
      body: parsed.body
    })
    detailLoading.value = false
    await mountBodyEditor(form.body)
  } catch (e: any) {
    ElMessage.error(e.message || '加载技能失败')
    editVisible.value = false
    detailLoading.value = false
  }
}

async function openCreate() {
  isCreate.value = true
  detail.value = null
  fillForm({
    name: 'my-skill',
    description: '',
    layer: 'skill',
    toolsText: '',
    body: '在此编写对本任务的操作说明。'
  })
  editVisible.value = true
  detailLoading.value = false
  destroyBodyEditor()
  await mountBodyEditor(form.body)
}

function onEditClosed() {
  destroyBodyEditor()
  detail.value = null
  isCreate.value = false
}

async function onSave() {
  syncBodyFromEditor()
  const name = form.name.trim()
  if (!name) {
    ElMessage.warning('请填写技能标识')
    return
  }
  if (!form.description.trim()) {
    ElMessage.warning('请填写简介')
    return
  }
  if (!form.body.trim()) {
    ElMessage.warning('请填写操作说明')
    return
  }
  const content = buildSkillContent(form)
  saving.value = true
  try {
    if (isCreate.value) {
      await skillsApi.create({ name, content })
      ElMessage.success('已创建')
      editVisible.value = false
      await loadList()
    } else {
      const res = await skillsApi.save(name, content)
      detail.value = res.data
      ElMessage.success(res.data.source === 'override' ? '已保存为你的个人副本' : '已保存')
      editVisible.value = false
      await loadList()
    }
  } catch (e: any) {
    ElMessage.error(e.message || '保存失败')
  } finally {
    saving.value = false
  }
}

async function onReset() {
  if (!detail.value?.canReset) return
  try {
    await ElMessageBox.confirm('将删除你的个人副本并恢复系统默认内容。继续？', '恢复默认', {
      type: 'warning'
    })
  } catch {
    return
  }
  saving.value = true
  try {
    const name = detail.value.name
    await skillsApi.remove(name)
    ElMessage.success('已恢复系统默认')
    await openEdit(name)
    await loadList()
  } catch (e: any) {
    ElMessage.error(e.message || '恢复失败')
  } finally {
    saving.value = false
  }
}

async function onDelete() {
  if (!detail.value?.canDelete) return
  try {
    await ElMessageBox.confirm(`确定删除技能「${detail.value.name}」？此操作不可恢复。`, '删除', {
      type: 'warning',
      confirmButtonText: '删除'
    })
  } catch {
    return
  }
  saving.value = true
  try {
    await skillsApi.remove(detail.value.name)
    ElMessage.success('已删除')
    editVisible.value = false
    await loadList()
  } catch (e: any) {
    ElMessage.error(e.message || '删除失败')
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void loadList()
})

onBeforeUnmount(() => {
  destroyBodyEditor()
})
</script>

<style scoped>
.skills-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.head-actions {
  display: flex;
  gap: 10px;
  align-items: center;
}
.btn-ico {
  margin-right: 4px;
}
.skills-grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
  align-content: start;
  padding-bottom: 8px;
}
.skill-card {
  text-align: left;
  border: 1px solid var(--yt-border);
  border-radius: 12px;
  background: #fff;
  padding: 18px 18px 16px;
  cursor: pointer;
  transition:
    border-color 160ms var(--yt-ease),
    transform 160ms var(--yt-ease),
    background 160ms var(--yt-ease);
  font: inherit;
  color: inherit;
}
.skill-card:hover {
  border-color: var(--yt-border-strong);
  background: #fbfbfa;
}
.skill-card:active {
  transform: scale(0.98);
}
.card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.card-name {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: var(--yt-text);
  word-break: break-all;
}
.card-desc {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--yt-muted);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 3.9em;
}
.card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  color: var(--yt-faint);
}
.skill-badge {
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 9999px;
  background: #efeeea;
  color: var(--yt-muted);
  flex-shrink: 0;
  white-space: nowrap;
}
.skill-badge[data-source='system'] {
  background: #e1f3fe;
  color: #1f6c9f;
}
.skill-badge[data-source='override'] {
  background: #fbf3db;
  color: #956400;
}
.skill-badge[data-source='custom'] {
  background: #edf3ec;
  color: #346538;
}
.empty-hint {
  grid-column: 1 / -1;
  padding: 48px 24px;
  color: var(--yt-muted);
  font-size: 13px;
  text-align: center;
}
.edit-dialog-body {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.edit-form {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.edit-fields {
  flex-shrink: 0;
}
.edit-form :deep(.el-form-item) {
  margin-bottom: 14px;
}
.body-item {
  flex: 1;
  min-height: 0;
  margin-bottom: 0 !important;
  display: flex;
  flex-direction: column;
}
.body-item :deep(.el-form-item__label) {
  flex-shrink: 0;
}
.body-item :deep(.el-form-item__content) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  line-height: normal;
}
.wysiwyg-host {
  width: 100%;
  flex: 1;
  min-height: 160px;
  height: 100%;
  border: 1px solid var(--yt-border);
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
}
.wysiwyg-host :deep(.toastui-editor-defaultUI) {
  border: none;
  height: 100% !important;
}
.wysiwyg-host :deep(.toastui-editor-toolbar) {
  background: #fbfbfa;
  border-bottom: 1px solid var(--yt-border);
}
.wysiwyg-host :deep(.toastui-editor-ww-container),
.wysiwyg-host :deep(.toastui-editor-contents) {
  font-family: var(--yt-font);
  font-size: 14px;
  color: var(--yt-text);
  line-height: 1.65;
}
.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.form-row .half {
  margin-bottom: 14px;
}
.field-hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--yt-faint);
  line-height: 1.4;
}
.dialog-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}
.foot-left,
.foot-right {
  display: flex;
  gap: 8px;
  align-items: center;
}
@media (max-width: 640px) {
  .form-row {
    grid-template-columns: 1fr;
  }
  .dialog-foot {
    flex-direction: column;
    align-items: stretch;
  }
  .foot-left,
  .foot-right {
    justify-content: flex-end;
  }
}
</style>

<!-- dialog 挂到 body，需非 scoped -->
<style>
.skill-edit-dialog.el-dialog {
  height: 96vh;
  max-height: 96vh;
  margin-top: 2vh !important;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.skill-edit-dialog .el-dialog__header {
  flex-shrink: 0;
  padding-bottom: 10px;
}
.skill-edit-dialog .el-dialog__body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding-top: 8px;
  padding-bottom: 8px;
}
.skill-edit-dialog .el-dialog__footer {
  flex-shrink: 0;
  padding-top: 10px;
}
</style>
