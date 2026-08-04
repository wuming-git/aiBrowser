<template>
  <div class="md" v-html="html" />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const props = defineProps<{ content: string }>()

marked.setOptions({
  gfm: true,
  breaks: true
})

const html = computed(() => {
  const raw = marked.parse(props.content || '', { async: false }) as string
  const withTables = raw
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>')
  return DOMPurify.sanitize(withTables, {
    USE_PROFILES: { html: true }
  })
})
</script>

<style scoped>
.md {
  font-family: var(--yt-font);
  font-size: 14px;
  font-weight: 500;
  line-height: 1.65;
  letter-spacing: -0.01em;
  color: var(--yt-text);
  word-break: break-word;
}
.md :deep(p) {
  margin: 0 0 0.65em;
}
.md :deep(p:last-child) {
  margin-bottom: 0;
}
.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4) {
  margin: 0.85em 0 0.45em;
  font-weight: 600;
  line-height: 1.35;
  color: var(--yt-text);
  letter-spacing: -0.02em;
}
.md :deep(h1) { font-size: 1.2em; }
.md :deep(h2) { font-size: 1.1em; }
.md :deep(h3) { font-size: 1.05em; }
.md :deep(ul),
.md :deep(ol) {
  margin: 0.4em 0 0.7em;
  padding-left: 1.3em;
}
.md :deep(li) {
  margin: 0.2em 0;
}
.md :deep(strong) {
  color: var(--yt-text);
  font-weight: 650;
}
.md :deep(a) {
  color: var(--yt-text);
  text-decoration-color: rgba(17, 17, 17, 0.28);
}
.md :deep(code) {
  font-family: var(--yt-font-mono);
  font-size: 0.92em;
  background: #f0efec;
  border: 1px solid var(--yt-border);
  border-radius: 4px;
  padding: 0.08em 0.35em;
  color: #2f3437;
}
.md :deep(pre) {
  margin: 0.55em 0 0.75em;
  padding: 10px 12px;
  overflow: auto;
  background: #f7f6f3;
  border: 1px solid var(--yt-border);
  border-radius: 6px;
}
.md :deep(pre code) {
  background: transparent;
  border: none;
  padding: 0;
  color: #2f3437;
  font-size: 12px;
  line-height: 1.5;
}
.md :deep(blockquote) {
  margin: 0.55em 0;
  padding: 6px 10px;
  border-left: 2px solid #111111;
  background: #f0efec;
  color: var(--yt-muted);
}
.md :deep(hr) {
  border: none;
  border-top: 1px solid var(--yt-border);
  margin: 0.9em 0;
}
.md :deep(.table-wrap) {
  width: 100%;
  overflow-x: auto;
  margin: 0.6em 0 0.8em;
  border: 1px solid var(--yt-border);
  border-radius: 6px;
}
.md :deep(.table-wrap table) {
  display: table;
  width: 100%;
  margin: 0;
  border: none;
  border-radius: 0;
}
.md :deep(table) {
  border-collapse: collapse;
  font-size: 12px;
}
.md :deep(th),
.md :deep(td) {
  border: 1px solid var(--yt-border);
  padding: 7px 10px;
  text-align: left;
  vertical-align: top;
}
.md :deep(th) {
  background: var(--yt-panel);
  color: var(--yt-muted);
  font-weight: 600;
  white-space: nowrap;
}
.md :deep(tr:nth-child(even) td) {
  background: rgba(17, 17, 17, 0.02);
}
.md :deep(tr:hover td) {
  background: rgba(17, 17, 17, 0.035);
}
</style>
