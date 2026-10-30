<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import UiIcon from "../icons/UiIcon.vue";
import { useUiLanguage } from "../composables/useUiLanguage";
import type { EpubChapter } from "../engine/core";

/**
 * EPUB 章节列表：搜索 / 新增 / 删除 / 上移下移 / 原生 HTML5 拖拽排序。
 * 视觉与 ChapterList 保持一致：纸色底、朱砂指示条、细滚动条。
 */
const props = withDefaults(
  defineProps<{
    chapters: EpubChapter[];
    selectedId: string | null;
    /** 每章字数缓存（由 useEpubWorkspace 提供） */
    stats: Map<string, number>;
    collapsed: boolean;
    busy?: boolean;
  }>(),
  { collapsed: false, busy: false },
);

const emit = defineEmits<{
  select: [id: string];
  add: [];
  delete: [id: string];
  move: [payload: { id: string; toIndex: number }];
  collapse: [];
  appendFiles: [files: { name: string; bytes: Uint8Array }[]];
}>();

const { t } = useUiLanguage();

const query = ref("");
const scroller = ref<HTMLElement | null>(null);
const appendInput = ref<HTMLInputElement | null>(null);
const dropActive = ref(false);
let dropDepth = 0;

const dragId = ref<string | null>(null);
const dropIndex = ref<number | null>(null);

function hasFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function isImportFile(file: File): boolean {
  return /\.(txt|text|epub)$/i.test(file.name);
}

function onFileDragEnter(event: DragEvent): void {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  event.stopPropagation();
  dropDepth += 1;
  dropActive.value = true;
}

function onFileDragOver(event: DragEvent): void {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function onFileDragLeave(event: DragEvent): void {
  if (!hasFileDrag(event)) return;
  event.stopPropagation();
  dropDepth = Math.max(0, dropDepth - 1);
  if (dropDepth === 0) dropActive.value = false;
}

async function emitFiles(files: File[]): Promise<void> {
  const accepted = files.filter(isImportFile);
  if (!accepted.length) return;
  const payload = await Promise.all(
    accepted.map(async (file) => ({
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  );
  emit("appendFiles", payload);
}

async function onFileDrop(event: DragEvent): Promise<void> {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  event.stopPropagation();
  dropDepth = 0;
  dropActive.value = false;
  await emitFiles(Array.from(event.dataTransfer?.files ?? []));
}

async function onAppendPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  await emitFiles(files);
}

const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  const rows = props.chapters.map((chapter, index) => ({ chapter, index }));
  if (!keyword) return rows;
  return rows.filter(({ chapter }) => chapter.title.toLowerCase().includes(keyword));
});

function formatWords(value: number): string {
  if (value >= 10000) return t(`${(value / 10000).toFixed(1)} 万`, `${(value / 1000).toFixed(1)}k`);
  return value.toLocaleString(t("zh-CN", "en-US"));
}

function isSelected(chapter: EpubChapter): boolean {
  return chapter.id === props.selectedId;
}

function onDragStart(event: DragEvent, chapter: EpubChapter) {
  // 搜索时行号与真实顺序不一致，直接禁用拖拽，避免排错位置
  if (query.value.trim()) {
    event.preventDefault();
    return;
  }
  dragId.value = chapter.id;
  dropIndex.value = null;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", chapter.id);
  }
}

function onDragOver(event: DragEvent, index: number) {
  if (!dragId.value || query.value.trim()) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  dropIndex.value = event.clientY > rect.top + rect.height / 2 ? index + 1 : index;
}

function onDrop() {
  const id = dragId.value;
  const insert = dropIndex.value;
  dragId.value = null;
  dropIndex.value = null;
  if (!id || insert == null || query.value.trim()) return;

  const from = props.chapters.findIndex((chapter) => chapter.id === id);
  if (from < 0) return;
  let target = insert;
  if (from < target) target -= 1;
  if (target === from) return;
  emit("move", { id, toIndex: target });
}

function onDragEnd() {
  dragId.value = null;
  dropIndex.value = null;
}

/** 选中项不在可视区时滚到中间，和 ChapterList 的体验一致。 */
watch(
  () => props.selectedId,
  async (id) => {
    if (!id) return;
    await nextTick();
    const row = scroller.value?.querySelector<HTMLElement>(`[data-chapter-id="${id}"]`);
    // jsdom / 老式内嵌浏览器没有 scrollIntoView，有则平滑滚动，无则静默跳过
    if (typeof row?.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  },
);

watch(query, () => {
  if (scroller.value) scroller.value.scrollTop = 0;
});
</script>

<template>
  <aside
    class="chapters epub-chapters"
    :class="{ 'chapters--collapsed': collapsed }"
    aria-labelledby="epub-chapters-heading"
  >
    <header class="chapters__head">
      <h2 id="epub-chapters-heading" class="chapters__title">
        {{ t("章节", "Chapters") }}
        <span class="chapters__count tnum">{{ filtered.length }}</span>
        <span v-if="query" class="chapters__of tnum">/ {{ chapters.length }}</span>
      </h2>
      <div class="chapters__head-actions">
        <button
          type="button"
          class="chapters__icon-btn"
          :aria-label="t('新增章节', 'Add chapter')"
          :title="t('新增章节', 'Add chapter')"
          :disabled="busy"
          @click="emit('add')"
        >
          <UiIcon name="plus" :size="15" />
        </button>
        <button
          type="button"
          class="chapters__icon-btn"
          :aria-label="t('收起章节侧栏', 'Collapse chapter sidebar')"
          :title="t('收起侧栏', 'Collapse sidebar')"
          @click="emit('collapse')"
        >
          <UiIcon name="chevron-double-left" :size="15" />
        </button>
      </div>
    </header>

    <div class="chapters__search">
      <UiIcon name="magnifying-glass" :size="15" class="chapters__search-icon" />
      <input
        v-model="query"
        class="ctl chapters__search-input"
        type="search"
        :placeholder="t('搜索章节标题', 'Search chapter titles')"
        :aria-label="t('搜索章节标题', 'Search chapter titles')"
        spellcheck="false"
      />
      <button
        v-if="query"
        type="button"
        class="chapters__search-clear"
        :aria-label="t('清除搜索', 'Clear search')"
        @click="query = ''"
      >
        <UiIcon name="x-mark" :size="13" />
      </button>
    </div>

    <p v-if="query" class="chapters__filter-note tnum">{{ t(`匹配 ${filtered.length} 章`, `${filtered.length} matching ${filtered.length === 1 ? "chapter" : "chapters"}`) }}</p>

    <div
      ref="scroller"
      class="chapters__scroll"
      role="listbox"
      :aria-label="t('章节列表', 'Chapter list')"
      tabindex="0"
      @dragend="onDragEnd"
      @dragenter="onFileDragEnter"
      @dragover="onFileDragOver"
      @dragleave="onFileDragLeave"
      @drop="onFileDrop"
    >
      <div
        v-for="row in filtered"
        :key="row.chapter.id"
        role="option"
        :aria-selected="isSelected(row.chapter)"
        :data-chapter-id="row.chapter.id"
        tabindex="-1"
        class="chapter-row"
        :class="{
          'chapter-row--on': isSelected(row.chapter),
          'chapter-row--dragging': dragId === row.chapter.id,
        }"
        :draggable="!query.trim()"
        @click="emit('select', row.chapter.id)"
        @keydown.enter.prevent="emit('select', row.chapter.id)"
        @keydown.space.prevent="emit('select', row.chapter.id)"
        @dragstart="onDragStart($event, row.chapter)"
        @dragover="onDragOver($event, row.index)"
        @drop.prevent.stop="onDrop"
      >
        <span v-if="dropIndex === row.index" class="chapter-row__insert" aria-hidden="true" />

        <span class="chapter-row__index mono tnum">{{ String(row.index + 1).padStart(2, "0") }}</span>
        <span class="chapter-row__rail" aria-hidden="true" />

        <span class="chapter-row__body">
          <span class="chapter-row__title">
            <UiIcon v-if="row.chapter.isNew" name="document-plus" :size="12" class="chapter-row__mark" />
            {{ row.chapter.title || t("未命名章节", "Untitled chapter") }}
          </span>
          <span class="chapter-row__meta tnum">
            {{ formatWords(stats.get(row.chapter.id) ?? 0) }} {{ t("字", "words") }}
            <template v-if="row.chapter.isNew"> · {{ t("新章节", "New chapter") }}</template>
          </span>
        </span>

        <span class="chapter-row__actions" @click.stop @keydown.stop>
          <button
            type="button"
            class="chapter-row__act"
            :title="t('上移', 'Move up')"
            :aria-label="t('上移本章', 'Move chapter up')"
            :disabled="row.index === 0"
            @click="emit('move', { id: row.chapter.id, toIndex: row.index - 1 })"
          >
            <UiIcon name="chevron-up" :size="13" />
          </button>
          <button
            type="button"
            class="chapter-row__act"
            :title="t('下移', 'Move down')"
            :aria-label="t('下移本章', 'Move chapter down')"
            :disabled="row.index >= chapters.length - 1"
            @click="emit('move', { id: row.chapter.id, toIndex: row.index + 1 })"
          >
            <UiIcon name="chevron-down" :size="13" />
          </button>
          <button
            type="button"
            class="chapter-row__act chapter-row__act--danger"
            :title="t('删除', 'Delete')"
            :aria-label="t('删除本章', 'Delete chapter')"
            :disabled="chapters.length <= 1"
            @click="emit('delete', row.chapter.id)"
          >
            <UiIcon name="trash" :size="13" />
          </button>
        </span>
      </div>

      <span
        v-if="dropIndex === filtered.length && filtered.length"
        class="chapter-row__insert chapter-row__insert--end"
        aria-hidden="true"
      />

      <p v-if="!filtered.length" class="chapters__empty">
        <UiIcon name="magnifying-glass" :size="18" />
        <template v-if="query">{{ t(`没有标题包含「${query}」的章节`, `No chapters with titles containing "${query}"`) }}</template>
        <template v-else>{{ t("还没有章节", "No chapters yet") }}</template>
      </p>
    </div>

    <div
      class="chapters__append"
      :class="{ 'chapters__append--active': dropActive }"
      @dragenter="onFileDragEnter"
      @dragover="onFileDragOver"
      @dragleave="onFileDragLeave"
      @drop="onFileDrop"
    >
      <UiIcon name="document-plus" :size="14" class="chapters__append-icon" />
      <span class="chapters__append-text">{{ dropActive ? t("松手追加章节", "Release to append chapters") : t("拖入 TXT / EPUB 追加章节", "Drop a TXT / EPUB file to append chapters") }}</span>
      <button type="button" class="chapters__append-btn" :disabled="busy" @click="appendInput?.click()">
        {{ t("打开文件", "Open file") }}
      </button>
      <input
        ref="appendInput"
        class="sr-only"
        type="file"
        accept=".txt,.text,.epub,text/plain,application/epub+zip"
        multiple
        tabindex="-1"
        aria-hidden="true"
        @change="onAppendPicked"
      />
    </div>

    <footer class="chapters__foot">
      <button type="button" class="chapters__add" :disabled="busy" @click="emit('add')">
        <UiIcon name="plus" :size="14" />
        {{ t("新增章节", "Add chapter") }}
      </button>
      <slot name="footer" />
    </footer>
  </aside>
</template>

<style scoped>
.chapters {
  display: flex;
  flex-direction: column;
  flex: none;
  width: var(--sidebar-width);
  height: 100%;
  background-color: var(--color-bg-elevated);
  border-right: 1px solid var(--color-border);
}

.chapters--collapsed {
  display: none;
}

.chapters__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-2) var(--space-2) var(--space-4);
}

.chapters__title {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  font-family: var(--font-serif);
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.08em;
  color: var(--color-text);
}

.chapters__count {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: var(--weight-regular);
  letter-spacing: 0;
  color: var(--color-text-muted);
}

.chapters__of {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--color-text-muted);
}

.chapters__head-actions {
  display: flex;
  gap: 2px;
}

.chapters__icon-btn {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  transition:
    color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.chapters__icon-btn:hover:not(:disabled) {
  color: var(--color-text);
  background-color: var(--color-surface-active);
}

.chapters__icon-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.chapters__search {
  position: relative;
  display: flex;
  align-items: center;
  margin: 0 var(--space-4) var(--space-2);
}

.chapters__search-icon {
  position: absolute;
  left: var(--space-3);
  color: var(--color-text-muted);
  pointer-events: none;
}

.chapters__search-input {
  min-height: 32px;
  padding-left: 34px;
  padding-right: 30px;
  font-size: var(--text-xs);
  background-color: var(--color-bg-sunken);
  border-color: var(--color-border);
}

.chapters__search-input::-webkit-search-cancel-button {
  display: none;
}

.chapters__search-clear {
  position: absolute;
  right: 6px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  color: var(--color-text-muted);
  border-radius: 4px;
}

.chapters__search-clear:hover {
  color: var(--color-text);
  background-color: var(--color-surface-active);
}

.chapters__filter-note {
  padding: 0 var(--space-4) var(--space-2);
  font-size: var(--text-2xs);
  color: var(--color-text-muted);
}

.chapters__scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 var(--space-2);
  scrollbar-gutter: stable;
}

.chapters__scroll:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: -2px;
}

.chapter-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 54px;
  padding: var(--space-1) var(--space-2) var(--space-1) var(--space-3);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition:
    background-color var(--duration-fast) var(--ease-out),
    opacity var(--duration-fast) var(--ease-out);
}

.chapter-row:hover {
  background-color: var(--color-surface-active);
}

.chapter-row--on {
  background-color: var(--color-primary-soft);
}

.chapter-row--dragging {
  opacity: 0.45;
}

.chapter-row__index {
  flex: none;
  width: 2.2ch;
  font-size: var(--text-2xs);
  color: var(--color-text-muted);
}

.chapter-row__rail {
  flex: none;
  width: 2px;
  height: 0;
  background-color: var(--color-primary);
  border-radius: var(--radius-full);
  transition: height var(--duration-fast) var(--ease-out);
}

.chapter-row--on .chapter-row__rail {
  height: 24px;
}

.chapter-row__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
}

.chapter-row__title {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-sm);
  line-height: 1.4;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chapter-row--on .chapter-row__title {
  font-weight: var(--weight-medium);
}

.chapter-row__mark {
  flex: none;
  color: var(--color-primary-text);
}

.chapter-row__meta {
  font-size: var(--text-2xs);
  line-height: 1.2;
  color: var(--color-text-muted);
}

.chapter-row__actions {
  display: flex;
  gap: 1px;
  flex: none;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}

.chapter-row:hover .chapter-row__actions,
.chapter-row--on .chapter-row__actions,
.chapter-row:focus-within .chapter-row__actions {
  opacity: 1;
}

.chapter-row__act {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  color: var(--color-text-muted);
  border-radius: 4px;
  transition:
    color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.chapter-row__act:hover:not(:disabled) {
  color: var(--color-text);
  background-color: var(--color-surface);
}

.chapter-row__act--danger:hover:not(:disabled) {
  color: var(--color-danger);
  background-color: var(--color-danger-soft);
}

.chapter-row__act:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

/* 拖拽插入线：贴着目标行上沿 / 末尾下沿 */
.chapter-row__insert {
  position: absolute;
  left: var(--space-2);
  right: var(--space-2);
  top: -1px;
  height: 2px;
  background-color: var(--color-primary);
  border-radius: var(--radius-full);
  pointer-events: none;
}

.chapter-row__insert--end {
  position: relative;
  display: block;
  top: auto;
  left: auto;
  right: auto;
  margin: 0 var(--space-2);
}

.chapters__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-10) var(--space-4);
  font-size: var(--text-xs);
  text-align: center;
  color: var(--color-text-muted);
}

.chapters__append {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  margin: 0 var(--space-2) var(--space-2);
  padding: var(--space-2) var(--space-3);
  background-color: var(--color-bg-sunken);
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
  transition:
    background-color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}

.chapters__append--active {
  background-color: var(--color-primary-soft);
  border-color: var(--color-primary);
}

.chapters__append-icon {
  flex: none;
  color: var(--color-text-muted);
}

.chapters__append--active .chapters__append-icon {
  color: var(--color-primary-text);
}

.chapters__append-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: var(--text-2xs);
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
}

.chapters__append--active .chapters__append-text {
  color: var(--color-primary-text);
}

.chapters__append-btn {
  flex: none;
  min-height: 26px;
  padding: 0 var(--space-2);
  font-size: var(--text-2xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-secondary);
  background-color: var(--color-surface);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
}

.chapters__append-btn:hover:not(:disabled) {
  color: var(--color-text);
  background-color: var(--color-surface-hover);
  border-color: var(--color-text-muted);
}

.chapters__append-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.chapters__foot {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex: none;
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--color-border-subtle);
}

.chapters__add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 32px;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--color-primary-text);
  background-color: var(--color-primary-soft);
  border: 1px dashed color-mix(in srgb, var(--color-primary) 34%, transparent);
  border-radius: var(--radius-sm);
  transition:
    background-color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}

.chapters__add:hover:not(:disabled) {
  background-color: color-mix(in srgb, var(--color-primary-soft) 72%, var(--color-surface));
  border-color: var(--color-primary);
}

.chapters__add:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

@media (max-width: 1280px) {
  .chapters {
    width: 292px;
  }
}

@media (max-width: 1080px) {
  .chapters {
    width: 256px;
  }
}

@media (hover: none) {
  .chapter-row__actions {
    opacity: 1;
  }
}
</style>