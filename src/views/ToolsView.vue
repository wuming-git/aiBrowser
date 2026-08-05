<template>
  <div class="yt-page tools-page">
    <div class="yt-page-head">
      <div>
        <p class="yt-eyebrow">Agent</p>
        <h2 class="yt-title page-title">工具</h2>
        <p class="yt-sub" style="margin-bottom: 0">
          项目内置工具清单，只读展示，不可修改。Agent 通过名称调用这些能力。
        </p>
      </div>
      <div class="head-actions">
        <el-button @click="loadList" :loading="listLoading">
          <el-icon class="btn-ico"><Refresh /></el-icon>
          刷新
        </el-button>
      </div>
    </div>

    <div class="filter-bar">
      <button
        type="button"
        class="filter-chip"
        :class="{ active: locationFilter === 'all' }"
        @click="locationFilter = 'all'"
      >
        全部 {{ list.length }}
      </button>
      <button
        type="button"
        class="filter-chip"
        :class="{ active: locationFilter === 'desktop' }"
        @click="locationFilter = 'desktop'"
      >
        桌面端 {{ desktopCount }}
      </button>
      <button
        type="button"
        class="filter-chip"
        :class="{ active: locationFilter === 'server' }"
        @click="locationFilter = 'server'"
      >
        服务端 {{ serverCount }}
      </button>
      <el-input
        v-model="keyword"
        clearable
        class="search-input"
        placeholder="搜索名称或描述"
      />
    </div>

    <div class="tools-grid" v-loading="listLoading">
      <article v-for="item in filteredList" :key="item.name" class="tool-card">
        <div class="card-top">
          <span class="card-name">{{ item.name }}</span>
          <span class="tool-badge" :data-location="item.location">
            {{ locationLabel(item.location) }}
          </span>
        </div>
        <p class="card-desc">{{ item.description || '暂无描述' }}</p>
      </article>

      <p v-if="!listLoading && !filteredList.length" class="empty-hint">
        {{ list.length ? '没有匹配的工具' : '暂无工具清单' }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { agentApi, type ToolManifestItem } from '@/api'

const list = ref<ToolManifestItem[]>([])
const listLoading = ref(false)
const keyword = ref('')
const locationFilter = ref<'all' | 'desktop' | 'server'>('all')

const desktopCount = computed(() => list.value.filter((t) => t.location === 'desktop').length)
const serverCount = computed(() => list.value.filter((t) => t.location === 'server').length)

const filteredList = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  return list.value.filter((item) => {
    if (locationFilter.value !== 'all' && item.location !== locationFilter.value) return false
    if (!q) return true
    return (
      item.name.toLowerCase().includes(q) ||
      (item.description || '').toLowerCase().includes(q)
    )
  })
})

function locationLabel(location: string) {
  if (location === 'desktop') return '桌面端'
  if (location === 'server') return '服务端'
  return location || '未知'
}

function normalizeManifest(raw: unknown): ToolManifestItem[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((row) => {
      const r = (row || {}) as Record<string, unknown>
      const name = String(r.name || '').trim()
      if (!name) return null
      const location = String(r.location || '').trim() || 'server'
      return {
        name,
        description: String(r.description || '').trim(),
        location: location === 'desktop' ? 'desktop' : 'server'
      } satisfies ToolManifestItem
    })
    .filter((x): x is ToolManifestItem => !!x)
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function loadList() {
  listLoading.value = true
  try {
    const res = await agentApi.manifest()
    list.value = normalizeManifest(res.data)
  } catch (e: any) {
    ElMessage.error(e.message || '加载工具清单失败')
  } finally {
    listLoading.value = false
  }
}

onMounted(() => {
  void loadList()
})
</script>

<style scoped>
.tools-page {
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
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}
.filter-chip {
  border: 1px solid var(--yt-border);
  background: #fff;
  color: var(--yt-muted);
  font: inherit;
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 9999px;
  cursor: pointer;
  transition:
    border-color 160ms var(--yt-ease),
    background 160ms var(--yt-ease),
    color 160ms var(--yt-ease);
}
.filter-chip:hover {
  border-color: var(--yt-border-strong);
  color: var(--yt-text);
}
.filter-chip.active {
  border-color: var(--yt-text);
  color: var(--yt-text);
  background: #f5f4f1;
}
.search-input {
  width: 220px;
  margin-left: auto;
}
.tools-grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
  align-content: start;
  padding-bottom: 8px;
}
.tool-card {
  text-align: left;
  border: 1px solid var(--yt-border);
  border-radius: 12px;
  background: #fff;
  padding: 18px 18px 16px;
  font: inherit;
  color: inherit;
}
.card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.card-name {
  font-size: 14px;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: var(--yt-text);
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.card-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--yt-muted);
}
.tool-badge {
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
.tool-badge[data-location='desktop'] {
  background: #e1f3fe;
  color: #1f6c9f;
}
.tool-badge[data-location='server'] {
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
@media (max-width: 640px) {
  .search-input {
    width: 100%;
    margin-left: 0;
  }
}
</style>
