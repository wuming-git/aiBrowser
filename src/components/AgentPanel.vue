<template>
  <div class="panel">
    <div class="tab-bar">
      <el-tabs
        v-model="activeChatId"
        type="card"
        class="chat-tabs"
        @tab-remove="removeChat"
      >
        <el-tab-pane
          v-for="c in chats"
          :key="c.id"
          :name="c.id"
          :label="c.name"
          :closable="chats.length > 1"
        />
      </el-tabs>
      <button class="tab-add" type="button" title="新建对话" @click="createChat()">+</button>
      <button class="link-btn" type="button" title="清空当前对话" :disabled="!activeChat" @click="clearChat">
        清空
      </button>
    </div>

    <div ref="listRef" class="msg-list">
      <div v-if="!activeChat || activeChat.turns.length === 0" class="empty">
        <div class="empty-title">开始一次浏览器任务</div>
        <div class="empty-hint">用自然语言描述目标，Agent 会驱动浏览器完成。</div>
      </div>

      <div v-for="turn in activeChat?.turns || []" :key="turn.id" class="turn">
        <div class="msg user">
          <div class="bubble">{{ turn.user }}</div>
        </div>

        <!-- 执行过程：思考+工具合并，一键折叠 -->
        <div v-if="hasProcess(turn) || turn.streaming" class="process">
          <button class="process-bar" type="button" @click="toggleProcess(turn.id)">
            <span class="process-left">
              <span class="process-dot" :class="{ live: turn.streaming }" />
              <span class="process-title">{{ turn.streaming ? '执行中' : '执行过程' }}</span>
              <span class="process-summary">{{ processSummary(turn) }}</span>
            </span>
            <span class="process-right">
              <span class="process-action">{{ isProcessOpen(turn) ? '收起' : '展开' }}</span>
              <span class="chevron" :class="{ open: isProcessOpen(turn) }">▾</span>
            </span>
          </button>

          <div v-show="isProcessOpen(turn)" class="process-body">
            <ol v-if="processItems(turn).length" class="story">
              <li
                v-for="item in processItems(turn)"
                :key="item.id"
                class="story-item"
                :class="[item.kind, item.phase || 'end']"
              >
                <span class="story-rail">
                  <i class="story-dot" />
                </span>
                <div class="story-main">
                  <p class="story-text">{{ item.text }}</p>
                  <span class="story-meta">{{ item.meta }}</span>
                </div>
              </li>
            </ol>

            <div
              v-else-if="turn.streaming"
              class="think-note muted"
            >
              等待模型回报进展…
            </div>
          </div>
        </div>

        <!-- 工具/进展已结束，模型还在写最终回复 -->
        <div v-if="isComposingReply(turn)" class="reply-composing">
          <span class="composing-pulse" />
          <span class="composing-text">正在生成回复</span>
          <span class="composing-dots" aria-hidden="true">
            <i /><i /><i />
          </span>
        </div>

        <!-- AI 回复：主展示 -->
        <div
          v-for="(step, rIdx) in turnReplies(turn)"
          :key="step.id"
          class="reply-block"
          :class="{
            'is-error': (step.content || '').includes('⚠️'),
            'is-streaming': turn.streaming && rIdx === turnReplies(turn).length - 1
          }"
        >
          <div class="reply-head">
            <span class="reply-label">回复</span>
            <span class="reply-time">{{ formatTime(step.at) }}</span>
          </div>
          <div class="reply-body">
            <MarkdownView :content="displayReply(step.content)" />
            <span
              v-if="turn.streaming && rIdx === turnReplies(turn).length - 1"
              class="reply-caret"
            />
          </div>
        </div>
      </div>
    </div>

    <footer class="composer">
      <div
        v-if="!activeChat || activeChat.turns.length === 0"
        class="suggest-row"
      >
        <span class="suggest-label">试试</span>
        <button
          v-for="chip in suggestions"
          :key="chip"
          type="button"
          class="suggest-item"
          @click="useSuggestion(chip)"
        >
          {{ chip }}
        </button>
      </div>
      <div class="composer-box">
        <textarea
          v-model="input"
          rows="3"
          placeholder="输入任务，Enter 发送 · Shift+Enter 换行"
          @keydown="onKeydown"
        />
        <div class="composer-bar">
          <span class="model">{{ status?.model || 'Agent' }}</span>
          <el-button
            type="primary"
            size="small"
            :loading="!!activeChat?.sending"
            :disabled="!input.trim() || !activeChat"
            @click="send"
          >
            发送
          </el-button>
        </div>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { agentApi, type AgentStatus, type AgentChatResult } from '@/api'
import MarkdownView from '@/components/MarkdownView.vue'
import { getDesktopApi } from '@/utils/desktopApi'
import { getPersistedDeviceId } from '@/utils/desktopSession'
import { toolLabel } from '@/utils/toolLabels'
import { narrativeOnEnd, narrativeOnStart, narrativePreview, resetNarrativeContext } from '@/utils/toolNarrative'
import { humanizeAgentText, humanizeSummary, displayAgentReply } from '@/utils/agentDisplay'

type StepKind = 'thinking' | 'tool' | 'reply' | 'progress'

type TimelineStep = {
  id: string
  kind: StepKind
  at: number
  content?: string
  name?: string
  phase?: 'start' | 'end'
  /** 工具入参 JSON 字符串 */
  args?: string
  /** 工具结果 JSON / 文本 */
  result?: string
  /** 面向用户的自然语言叙述 */
  narrative?: string
}

type ChatTurn = {
  id: string
  user: string
  steps: TimelineStep[]
  toolTags: string[]
  reply: string
  streaming: boolean
}

type ChatSession = {
  id: string
  name: string
  sessionId: string
  turns: ChatTurn[]
  named: boolean
  sending: boolean
}

const chats = ref<ChatSession[]>([])
const activeChatId = ref('')
const input = ref('')
const status = ref<AgentStatus | null>(null)
const deviceId = ref('')
const desktopOnline = ref(false)
const listRef = ref<HTMLElement | null>(null)
/** turnId -> 执行过程是否展开；流式中默认展开，结束后默认收起 */
const processOpen = reactive<Record<string, boolean>>({})
let statusTimer: ReturnType<typeof setInterval> | null = null
let stepSeq = 0
let streamTurnId = ''
let streamChatId = ''

const activeChat = computed(() => chats.value.find((c) => c.id === activeChatId.value) || null)

const suggestions = [
  '登录百度，账号：xxxxx，密码：yyyyyy',
  '你会什么技能',
  '每天早上，收集五条最新的新闻给我'
]

function useSuggestion(text: string) {
  input.value = text
}

function uid(prefix: string) {
  stepSeq += 1
  return `${prefix}_${Date.now().toString(36)}_${stepSeq}`
}

function formatTime(ts: number) {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function turnTools(turn: ChatTurn) {
  return turn.steps.filter((s) => s.kind === 'tool')
}

function turnReplies(turn: ChatTurn) {
  return turn.steps.filter((s) => s.kind === 'reply')
}

function hasProcess(turn: ChatTurn) {
  return turn.steps.some(
    (s) => s.kind === 'tool' || s.kind === 'thinking' || s.kind === 'progress'
  )
}

/** 执行过程：只展示普通人能看懂的进展与操作结果（同文去重） */
function processItems(turn: ChatTurn) {
  const items: Array<{
    id: string
    kind: 'progress' | 'tool'
    phase?: 'start' | 'end'
    text: string
    meta: string
  }> = []
  const seenProgress = new Set<string>()
  for (const s of turn.steps) {
    if (s.kind === 'progress') {
      const text = humanizeAgentText(s.content || s.narrative)
      if (!text) continue
      const key = text.replace(/\s+/g, '')
      if (seenProgress.has(key)) continue
      seenProgress.add(key)
      items.push({
        id: s.id,
        kind: 'progress',
        phase: 'end',
        text,
        meta: formatTime(s.at)
      })
    } else if (s.kind === 'thinking' && (s.content || '').trim()) {
      // thinking 常与 progress 同源；已有 progress 展示时跳过，避免双份
      const text = humanizeAgentText(s.content)
      if (!text) continue
      const key = text.replace(/\s+/g, '')
      if (seenProgress.has(key)) continue
      seenProgress.add(key)
      items.push({
        id: s.id,
        kind: 'progress',
        phase: 'end',
        text,
        meta: formatTime(s.at)
      })
    } else if (s.kind === 'tool') {
      const raw =
        (s.narrative || '').trim() ||
        (s.phase === 'start'
          ? `正在${toolLabel(s.name)}…`
          : `${toolLabel(s.name)}已完成`)
      const shown = humanizeAgentText(raw) || raw
      // 仍含技术工具名的句子不展示给用户
      if (!shown || /\b[a-z]+(?:_[a-z0-9]+)+\b/i.test(shown)) continue
      items.push({
        id: s.id,
        kind: 'tool',
        phase: s.phase,
        text: shown,
        meta: `${s.phase === 'start' ? '进行中' : '已完成'} · ${formatTime(s.at)}`
      })
    }
  }
  return items.filter((i) => i.text)
}

/** 执行过程已告一段落，正在等待/接收最终回复 */
function isComposingReply(turn: ChatTurn) {
  if (!turn.streaming) return false
  if (turnReplies(turn).some((s) => (s.content || '').trim())) return false
  const tools = turnTools(turn)
  if (tools.some((t) => t.phase === 'start')) return false
  return hasProcess(turn) || tools.length > 0
}

function processSummary(turn: ChatTurn) {
  const thoughts = turn.steps
    .filter((s) => s.kind === 'progress' || s.kind === 'thinking')
    .map((s) => humanizeAgentText(s.content || s.narrative))
    .filter(Boolean)
  const tools = turnTools(turn)
  const done = tools.filter((t) => t.phase === 'end').length
  const toolBit = tools.length ? `已完成 ${done}/${tools.length} 步` : ''
  if (thoughts.length) {
    return humanizeSummary(thoughts[thoughts.length - 1], toolBit)
  }
  if (!tools.length) return turn.streaming ? '正在处理…' : '暂无进展'
  return (
    narrativePreview(
      tools.map((t) => humanizeAgentText(t.narrative) || t.narrative || toolLabel(t.name)),
      2
    ) || toolBit
  )
}

function displayReply(content?: string) {
  return displayAgentReply(content)
}

function isProcessOpen(turn: ChatTurn) {
  if (processOpen[turn.id] === true) return true
  if (processOpen[turn.id] === false) return false
  // 默认：执行中展开，结束后收起，突出最终回复
  return !!turn.streaming
}

function toggleProcess(turnId: string) {
  const turn = activeChat.value?.turns.find((t) => t.id === turnId)
  const open = turn ? isProcessOpen(turn) : false
  processOpen[turnId] = !open
}

function createChat(name = '待命名') {
  const chat: ChatSession = {
    id: uid('chat'),
    name,
    sessionId: `web-${Date.now().toString(36)}`,
    turns: [],
    named: false,
    sending: false
  }
  chats.value.push(chat)
  activeChatId.value = chat.id
  return chat
}

function removeChat(id: string | number) {
  const chatId = String(id)
  const idx = chats.value.findIndex((c) => c.id === chatId)
  if (idx < 0) return
  if (chats.value.length <= 1) {
    ElMessage.warning('至少保留一个对话框')
    return
  }
  const removing = chats.value[idx]
  if (removing.sending) {
    ElMessage.warning('该对话正在执行，请稍后再关闭')
    return
  }
  chats.value.splice(idx, 1)
  if (activeChatId.value === chatId) {
    activeChatId.value = chats.value[Math.max(0, idx - 1)].id
  }
}

function findChat(chatId: string) {
  return chats.value.find((c) => c.id === chatId) || null
}

function findTurn(chatId: string, turnId: string) {
  const chat = findChat(chatId)
  return chat?.turns.find((t) => t.id === turnId) || null
}

function streamTargets() {
  const chat = findChat(streamChatId)
  const turn = streamChatId && streamTurnId ? findTurn(streamChatId, streamTurnId) : null
  return { chat, turn }
}

function rememberToolTag(turn: ChatTurn, name?: string) {
  const n = String(name || '').trim()
  if (!n) return
  if (!turn.toolTags.includes(n)) turn.toolTags.push(n)
}

function openStep(turn: ChatTurn, kind: StepKind, extra?: Partial<TimelineStep>) {
  const step: TimelineStep = {
    id: uid('step'),
    kind,
    at: Date.now(),
    content: '',
    ...extra
  }
  turn.steps.push(step)
  return step
}

function lastStep(turn: ChatTurn, kind?: StepKind) {
  for (let i = turn.steps.length - 1; i >= 0; i--) {
    if (!kind || turn.steps[i].kind === kind) return turn.steps[i]
  }
  return null
}

function appendThinking(chunk: string) {
  const { turn } = streamTargets()
  if (!turn) return
  let step = lastStep(turn)
  if (!step || step.kind !== 'thinking') step = openStep(turn, 'thinking')
  if (step.content && chunk.startsWith(step.content)) step.content = chunk
  else step.content = (step.content || '') + chunk
}

/** 模型同轮思考文本：每条独立展示 */
function appendProgress(text: string) {
  const { turn } = streamTargets()
  if (!turn) return
  const t = String(text || '').trim()
  if (!t) return
  const norm = humanizeAgentText(t).replace(/\s+/g, '')
  // 与最近一条进展相同则跳过（避免 progress 事件与 thinking/误入回复 重复）
  for (let i = turn.steps.length - 1; i >= 0; i--) {
    const s = turn.steps[i]
    if (s.kind !== 'progress' && s.kind !== 'thinking') continue
    const prev = humanizeAgentText(s.content || s.narrative).replace(/\s+/g, '')
    if (prev && prev === norm) return
    break
  }
  openStep(turn, 'progress', {
    content: t,
    narrative: t,
    phase: 'end'
  })
}

function appendReply(chunk: string) {
  const { turn } = streamTargets()
  if (!turn) return
  let step = lastStep(turn)
  if (!step || step.kind !== 'reply') step = openStep(turn, 'reply')
  step.content = (step.content || '') + chunk
  turn.reply = (turn.reply || '') + chunk
}

function safeNarrativeStart(name?: string | null, detail?: string | null) {
  try {
    return narrativeOnStart(name, detail)
  } catch {
    return `正在执行 ${toolLabel(name)}…`
  }
}

function safeNarrativeEnd(name?: string | null, args?: string | null, result?: string | null) {
  try {
    return narrativeOnEnd(name, args, result)
  } catch {
    return `${toolLabel(name)}已完成`
  }
}

function pushTool(payload: { phase: 'start' | 'end'; name?: string; detail?: string }) {
  const { turn } = streamTargets()
  if (!turn) return
  // 模型先吐了回复文本、随后又调工具：把误入回复区的内容挪到执行过程
  if (payload.phase === 'start') {
    const premature = turn.steps.filter((s) => s.kind === 'reply' && (s.content || '').trim())
    if (premature.length) {
      for (const r of premature) {
        const t = String(r.content || '').trim()
        const norm = humanizeAgentText(t).replace(/\s+/g, '')
        const dup = turn.steps.some((s) => {
          if (s.kind !== 'progress' && s.kind !== 'thinking') return false
          return humanizeAgentText(s.content || s.narrative).replace(/\s+/g, '') === norm
        })
        if (!dup) {
          openStep(turn, 'progress', { content: t, narrative: t, phase: 'end' })
        }
      }
      turn.steps = turn.steps.filter((s) => s.kind !== 'reply')
      turn.reply = ''
    }
  }
  rememberToolTag(turn, payload.name)
  if (payload.phase === 'end' && payload.name) {
    for (let i = turn.steps.length - 1; i >= 0; i--) {
      const s = turn.steps[i]
      if (s.kind === 'tool' && s.name === payload.name && s.phase === 'start') {
        s.phase = 'end'
        s.at = Date.now()
        s.result = payload.detail || ''
        s.narrative = safeNarrativeEnd(s.name, s.args, s.result)
        return
      }
    }
  }
  const args = payload.detail || ''
  openStep(turn, 'tool', {
    name: payload.name,
    phase: payload.phase,
    content: '',
    args,
    narrative:
      payload.phase === 'end'
        ? safeNarrativeEnd(payload.name, args, args)
        : safeNarrativeStart(payload.name, args)
  })
}

async function suggestTitleForChat(chat: ChatSession, message: string) {
  if (chat.named) return
  chat.named = true
  try {
    const res = await agentApi.suggestTitle(message)
    const title = String(res.data?.title || '').trim()
    if (title) chat.name = title.slice(0, 10)
  } catch {
    const fallback = message.replace(/\s+/g, '').slice(0, 10)
    if (fallback) chat.name = fallback
  }
}

async function loadMeta() {
  try {
    if (!deviceId.value) deviceId.value = await getPersistedDeviceId()
    const s = await agentApi.status()
    status.value = s.data
    desktopOnline.value = !!s.data.desktopOnline
  } catch (e: any) {
    ElMessage.error(e.message || 'Agent 状态加载失败')
  }
  await refreshDesktopBridge()
}

async function refreshDesktopBridge() {
  const api = getDesktopApi()
  if (!api?.desktopStatus) return
  try {
    const st = await api.desktopStatus()
    if (st.deviceId) deviceId.value = st.deviceId
    if (st.connected) desktopOnline.value = true
  } catch (_) {}
}

async function scrollBottom() {
  await nextTick()
  if (listRef.value) listRef.value.scrollTop = listRef.value.scrollHeight
}

function clearChat() {
  const chat = activeChat.value
  if (!chat) return
  if (chat.sending) {
    ElMessage.warning('对话进行中，无法清空')
    return
  }
  chat.turns = []
  chat.sessionId = `web-${Date.now().toString(36)}`
  chat.named = false
  chat.name = '待命名'
}

function finalizeTurn(chat: ChatSession, turn: ChatTurn, data?: AgentChatResult, errorText?: string) {
  if (data?.sessionId) chat.sessionId = data.sessionId

  if (errorText) {
    const prev = (turn.reply || '').trim()
    const content = prev ? `${prev}\n\n⚠️ ${errorText}` : `⚠️ ${errorText}`
    const last = lastStep(turn, 'reply')
    if (last && last.kind === 'reply') last.content = content
    else openStep(turn, 'reply', { content })
    turn.reply = content
  } else {
    const finalReply = (data?.reply || turn.reply || '').trim()
    if (finalReply) {
      const last = lastStep(turn, 'reply')
      if (last && last.kind === 'reply') last.content = finalReply
      else openStep(turn, 'reply', { content: finalReply })
      turn.reply = finalReply
    }
  }

  turn.streaming = false
  if (data) {
    status.value = {
      ...(status.value || { enabled: true, ready: false }),
      ready: data.ready,
      model: data.model,
      desktopOnline: data.desktopOnline
    }
    desktopOnline.value = !!data.desktopOnline
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

const HISTORY_LIMIT = 10

function buildHistoryPayload(chat: ChatSession): { role: 'user' | 'assistant'; content: string }[] {
  const pairs: { role: 'user' | 'assistant'; content: string }[] = []
  for (const t of chat.turns) {
    if (t.streaming) continue
    pairs.push({ role: 'user', content: t.user })
    if (t.reply.trim()) pairs.push({ role: 'assistant', content: t.reply })
  }
  return pairs.slice(-HISTORY_LIMIT)
}

function formatAgentError(err: unknown): string {
  const raw = String((err as any)?.message || err || '').trim()
  if (!raw) return '模型调用失败，请稍后再试'

  // 业务 API 的 HTTP 状态（须优先于「401=模型密钥」误判）
  const httpMatch = raw.match(/流式请求失败\s*HTTP\s*(\d+)/i) || raw.match(/\bHTTP\s*(\d+)\b/i)
  if (httpMatch) {
    const code = Number(httpMatch[1])
    if (code === 401) return '登录已过期或未登录，请重新登录后再试'
    if (code === 403) return '当前账号无权限访问该服务'
    if (code === 429) return '请求过于频繁，请稍后再试'
    if ([502, 503, 504].includes(code)) return '服务暂时不可用，请稍后再试'
    return `服务请求失败（HTTP ${code}），请稍后重试`
  }

  if (/429|too many requests|1305|访问量过大|rate limit/i.test(raw)) {
    return '模型当前访问量过大，请稍后再试'
  }
  if (/invalid api key|incorrect api key|authentication.*api.?key/i.test(raw)) {
    return '模型密钥无效或未授权，请检查 LLM 配置'
  }
  // 仅在明确是模型侧 unauthorized 时提示密钥；避免把业务 401 文案误伤
  if (/\b401\b/.test(raw) && /api.?key|llm|openai|deepseek|模型/i.test(raw)) {
    return '模型密钥无效或未授权，请检查 LLM 配置'
  }
  if (/403|quota|余额/i.test(raw)) {
    return '模型服务拒绝访问，请检查账号权限或额度'
  }
  if (/timeout|timed out/i.test(raw)) {
    return '模型响应超时，请稍后再试'
  }
  if (/502|503|504|bad gateway/i.test(raw)) {
    return '模型服务暂时不可用，请稍后再试'
  }
  if (/模型|请稍|失败|超时|不可用|密钥|额度|登录/.test(raw) && raw.length < 120) return raw
  return raw.length > 160 ? `模型调用失败：${raw.slice(0, 160)}…` : `模型调用失败：${raw}`
}

async function send() {
  const chat = activeChat.value
  const text = input.value.trim()
  if (!chat || !text || chat.sending) return
  const history = buildHistoryPayload(chat)
  const needTitle = !chat.named

  const turn: ChatTurn = {
    id: uid('turn'),
    user: text,
    steps: [],
    toolTags: [],
    reply: '',
    streaming: true
  }
  chat.turns.push(turn)
  streamChatId = chat.id
  streamTurnId = turn.id
  processOpen[turn.id] = true
  resetNarrativeContext()
  input.value = ''
  chat.sending = true
  await scrollBottom()

  if (needTitle) void suggestTitleForChat(chat, text)

  try {
    const api = getDesktopApi()
    if (api?.contentScore) {
      const cs = await api.contentScore(text)
      if (cs.hardStop) {
        finalizeTurn(
          chat,
          turn,
          undefined,
          `本地内容安全分 ${cs.score}≥80，已中断。\n命中：${(cs.hits || []).join('、') || '敏感内容'}`
        )
        return
      }
    }
    if (api?.filterSensitive) {
      const sens = await api.filterSensitive(text)
      if (sens.blocked) {
        finalizeTurn(
          chat,
          turn,
          undefined,
          `请求已被本地敏感词过滤拦截。\n命中：${sens.sensitiveHits.join('、') || '敏感内容'}`
        )
        return
      }
    }

    const data = await agentApi.chatStream(
      {
        message: text,
        history,
        sessionId: chat.sessionId,
        profileId: null,
        deviceId: deviceId.value || null
      },
      {
        onThinking: (chunk) => {
          appendThinking(chunk)
          if (activeChatId.value === chat.id) void scrollBottom()
        },
        onProgress: (text) => {
          appendProgress(text)
          if (activeChatId.value === chat.id) void scrollBottom()
        },
        onToken: (chunk) => {
          appendReply(chunk)
          if (activeChatId.value === chat.id) void scrollBottom()
        },
        onTool: (payload) => {
          // 进展已由 progress 事件处理（同轮文本）
          if (String(payload.name || '').includes('report_progress') || payload.name === 'model_thought') return
          pushTool(payload)
          if (activeChatId.value === chat.id) void scrollBottom()
        }
      }
    )
    finalizeTurn(chat, turn, data)
  } catch (e: any) {
    const msg = formatAgentError(e)
    ElMessage.error({ message: msg, duration: 5000, showClose: true })
    finalizeTurn(chat, turn, undefined, msg)
  } finally {
    turn.streaming = false
    chat.sending = false
    // 结束后默认收起执行过程，突出回复
    processOpen[turn.id] = false
    if (streamTurnId === turn.id) {
      streamTurnId = ''
      streamChatId = ''
    }
    if (activeChatId.value === chat.id) await scrollBottom()
  }
}

onMounted(() => {
  createChat()
  loadMeta()
  statusTimer = setInterval(() => {
    void agentApi
      .status()
      .then((s) => {
        status.value = s.data
        desktopOnline.value = !!s.data.desktopOnline
      })
      .catch(() => undefined)
    void refreshDesktopBridge()
  }, 8000)
})

onBeforeUnmount(() => {
  if (statusTimer) clearInterval(statusTimer)
})

defineExpose({
  refreshStatus: loadMeta
})
</script>

<style scoped>
.panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: transparent;
}

.link-btn {
  border: none;
  background: transparent;
  color: var(--yt-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  flex-shrink: 0;
  margin-bottom: 2px;
}
.link-btn:hover:not(:disabled) {
  color: var(--yt-text);
  background: rgba(17, 17, 17, 0.04);
}
.link-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.tab-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px 0;
  border-bottom: 1px solid var(--yt-border);
  min-height: 42px;
  background: transparent;
}
.chat-tabs {
  flex: 1;
  min-width: 0;
}
.chat-tabs :deep(.el-tabs__header) {
  margin: 0;
  border-bottom: none;
}
.chat-tabs :deep(.el-tabs__nav) {
  border: none;
}
.chat-tabs :deep(.el-tabs__item) {
  height: 30px;
  line-height: 30px;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 550;
  color: var(--yt-muted);
  border: none !important;
  border-radius: 0;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  background: transparent;
}
.chat-tabs :deep(.el-tabs__item.is-active) {
  color: var(--yt-text);
  font-weight: 650;
  background: transparent;
  box-shadow: inset 0 -1.5px 0 #111111;
}
.chat-tabs :deep(.el-tabs__content) {
  display: none;
}
.tab-add {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  margin-bottom: 2px;
  border-radius: 6px;
  border: 1px solid var(--yt-border-strong);
  background: var(--yt-panel);
  color: var(--yt-muted);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  font-family: inherit;
  font-weight: 600;
  box-shadow: var(--yt-shadow);
}
.tab-add:hover {
  color: var(--yt-text);
  border-color: #8f8e89;
  background: #ffffff;
}

.msg-list {
  flex: 1;
  overflow: auto;
  padding: 20px 16px 24px;
  min-height: 0;
  background: transparent;
}
.empty {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  min-height: 100%;
  padding: 8px 4px 20px;
  text-align: left;
  color: var(--yt-muted);
  border: none;
  background: transparent;
  box-shadow: none;
}
.empty-title {
  font-family: var(--yt-font);
  font-size: 16px;
  font-weight: 650;
  color: var(--yt-text);
  margin-bottom: 6px;
  letter-spacing: -0.02em;
}
.empty-hint {
  font-size: 13px;
  color: var(--yt-muted);
  line-height: 1.55;
  max-width: 32ch;
}

.turn {
  margin-bottom: 22px;
}
.turn + .turn {
  padding-top: 18px;
  border-top: 1px solid var(--yt-border);
}

.msg {
  display: flex;
  margin-bottom: 12px;
}
.msg.user {
  justify-content: flex-end;
}
.bubble {
  max-width: 92%;
  padding: 10px 14px;
  border-radius: 10px 10px 2px 10px;
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.55;
  background: #111111;
  color: #ffffff;
}

.process {
  margin-bottom: 10px;
  border: 1px solid var(--yt-border);
  border-radius: 10px;
  background: var(--yt-panel);
  box-shadow: var(--yt-shadow);
  overflow: hidden;
}
.process-bar {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}
.process-bar:hover {
  background: rgba(17, 17, 17, 0.025);
}
.process-left,
.process-right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.process-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--yt-faint);
  flex-shrink: 0;
}
.process-dot.live {
  background: var(--yt-success);
  animation: live-pulse 1.4s ease-in-out infinite;
}
.process-title {
  font-size: 13px;
  font-weight: 650;
  font-family: var(--yt-font);
  color: var(--yt-text);
  flex-shrink: 0;
}
.process-summary {
  font-size: 12px;
  font-family: var(--yt-font);
  color: var(--yt-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.process-action {
  font-size: 12px;
  font-family: var(--yt-font);
  color: var(--yt-muted);
  flex-shrink: 0;
}
.chevron {
  font-size: 11px;
  color: var(--yt-faint);
  transition: transform 0.2s var(--yt-ease);
  display: inline-block;
  transform: rotate(-90deg);
}
.chevron.open {
  transform: rotate(0deg);
}
.process-body {
  padding: 0 12px 12px;
  border-top: 1px solid var(--yt-border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.story {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}
.story-item {
  display: grid;
  grid-template-columns: 14px 1fr;
  gap: 8px;
  min-height: 34px;
}
.story-rail {
  position: relative;
  display: flex;
  justify-content: center;
}
.story-rail::after {
  content: '';
  position: absolute;
  top: 12px;
  bottom: -2px;
  width: 1px;
  background: var(--yt-border);
}
.story-item:last-child .story-rail::after {
  display: none;
}
.story-dot {
  width: 6px;
  height: 6px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--yt-faint);
  z-index: 1;
}
.story-main {
  padding-bottom: 10px;
  min-width: 0;
}
.story-text {
  margin: 0;
  font-family: var(--yt-font);
  font-size: 13.5px;
  font-weight: 500;
  line-height: 1.65;
  letter-spacing: -0.01em;
  color: #1c1c1a;
}
.story-item.progress .story-dot {
  background: #111111;
}
.story-item.progress .story-text {
  color: var(--yt-text);
}
.story-item.tool .story-text {
  color: var(--yt-muted);
  font-size: 13px;
  font-weight: 500;
}
.story-item.start .story-dot {
  background: var(--yt-warning);
  animation: live-pulse 1.4s ease-in-out infinite;
}
.story-item.end.tool .story-dot {
  background: var(--yt-success);
}
.story-item.start .story-text {
  color: var(--yt-text);
}
.story-meta {
  display: inline-block;
  margin-top: 3px;
  font-size: 11px;
  font-family: var(--yt-font);
  font-weight: 500;
  color: var(--yt-muted);
  letter-spacing: 0.01em;
}

.think-note {
  border-radius: 6px;
  background: transparent;
  border: 1px dashed var(--yt-border);
  padding: 8px 10px;
}
.think-note.muted {
  color: var(--yt-muted);
  font-size: 12px;
}
.think-note-label {
  font-size: 10px;
  color: var(--yt-muted);
  margin-bottom: 4px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.think-note pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--yt-font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: #2f3437;
  max-height: 140px;
  overflow: auto;
}

.reply-block {
  border: 1px solid var(--yt-border);
  border-radius: 10px;
  background: var(--yt-panel);
  box-shadow: var(--yt-shadow);
  padding: 12px 14px;
  animation: reply-in 0.38s ease both;
}
.reply-block.is-streaming {
  animation: none;
}
@keyframes reply-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.reply-block.is-error {
  border-color: color-mix(in srgb, var(--yt-danger) 28%, var(--yt-border));
  background: var(--yt-danger-bg);
}
.reply-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.reply-label {
  font-size: 12px;
  font-weight: 650;
  font-family: var(--yt-font);
  color: var(--yt-muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.reply-time {
  font-size: 11px;
  font-family: var(--yt-font);
  font-weight: 500;
  color: var(--yt-muted);
  font-variant-numeric: tabular-nums;
}
.reply-body {
  font-family: var(--yt-font);
  font-size: 14px;
  font-weight: 500;
  line-height: 1.65;
  letter-spacing: -0.01em;
  color: var(--yt-text);
}
.reply-block.is-error .reply-body {
  color: var(--yt-danger);
}
.reply-caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: -0.12em;
  background: var(--yt-text);
  animation: caret-blink 1s steps(1) infinite;
}
@keyframes caret-blink {
  0%,
  45% {
    opacity: 1;
  }
  50%,
  100% {
    opacity: 0;
  }
}

.reply-composing {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border: 1px dashed color-mix(in srgb, var(--yt-border) 80%, #111 8%);
  border-radius: 10px;
  background: color-mix(in srgb, var(--yt-panel) 88%, #111 2%);
  color: var(--yt-muted);
  font-size: 13px;
  font-weight: 550;
  animation: reply-in 0.3s ease both;
}
.composing-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #2f3437;
  animation: composing-pulse 1.2s ease-in-out infinite;
}
@keyframes composing-pulse {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.85);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}
.composing-text {
  letter-spacing: 0.02em;
}
.composing-dots {
  display: inline-flex;
  gap: 3px;
  margin-left: 2px;
}
.composing-dots i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.35;
  animation: composing-dot 1.2s ease-in-out infinite;
}
.composing-dots i:nth-child(2) {
  animation-delay: 0.15s;
}
.composing-dots i:nth-child(3) {
  animation-delay: 0.3s;
}
@keyframes composing-dot {
  0%,
  80%,
  100% {
    opacity: 0.25;
    transform: translateY(0);
  }
  40% {
    opacity: 1;
    transform: translateY(-2px);
  }
}

.composer {
  padding: 12px 14px 16px;
  border-top: 1px solid var(--yt-border);
  background: transparent;
}
.suggest-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  margin-bottom: 10px;
}
.suggest-label {
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--yt-muted);
  flex-shrink: 0;
}
.suggest-item {
  border: none;
  background: transparent;
  color: var(--yt-text);
  font-size: 12px;
  font-weight: 550;
  font-family: inherit;
  padding: 0;
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: rgba(17, 17, 17, 0.22);
  text-underline-offset: 3px;
  transition: text-decoration-color 0.15s ease, opacity 0.15s ease;
}
.suggest-item:hover {
  text-decoration-color: var(--yt-text);
}
.composer-box {
  border: 1px solid var(--yt-border-strong);
  border-radius: 12px;
  background: var(--yt-panel);
  box-shadow: var(--yt-shadow);
  overflow: hidden;
  transition: border-color 0.2s var(--yt-ease);
}
.composer-box:focus-within {
  border-color: #111111;
}
.composer-box textarea {
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--yt-text);
  font-size: 13px;
  line-height: 1.55;
  padding: 12px 12px 4px;
  font-family: inherit;
  box-sizing: border-box;
}
.composer-box textarea::placeholder {
  color: var(--yt-muted);
  opacity: 1;
}
.composer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px 10px;
}
.model {
  font-size: 11px;
  color: var(--yt-muted);
  letter-spacing: 0.02em;
  font-family: var(--yt-font-mono);
  font-weight: 500;
}

@keyframes live-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

@media (prefers-reduced-motion: reduce) {
  .process-dot.live,
  .story-item.start .story-dot {
    animation: none !important;
  }
}
</style>
