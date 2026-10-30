<script setup lang="ts">
import { computed, ref, watch } from "vue";
import UiIcon from "../icons/UiIcon.vue";
import type { Chapter } from "../engine/core";
import { useUiLanguage } from "../composables/useUiLanguage";

/**
 * 章节列表（虚拟滚动）。
 * 固定行高 + overscan，600~5000 章时 DOM 节点稳定在 ~20 个，
 * 滚动位置与选中项由父级持有，组件本身无状态泄漏。
 */
const props = withDefaults(
  defineProps<{
    chapters: Chapter[];
    selectedId: string | null;
    /** 每章字数缓存 Map，避免逐项统计 */
    stats: Map<string, number>;
    collapsed: boolean;
    /** 追加章节时禁用按钮 */
    busy?: boolean;
  }>(),
  { collapsed: false, busy: false },
);

const emit = defineEmits<{
  select: [id: string];
  reparse: [];
  collapse: [];
  /** 追加 TXT 为新章节 */
  appendFiles: [files: { name: string; bytes: Uint8Array }[]];
  /** 章节区正在接拖拽：父级据此隐藏「换一本」整窗遮罩 */
  draggingChange: [active: boolean];
}>();

const ITEM_HEIGHT = 46;
const OVERSCAN = 8;

const { t } = useUiLanguage();

const query = ref("");
const scroller = ref<HTMLElement | null>(null);

/** 拖拽进入章节区时的高亮状态（仅统计本区域的 dragenter/leave 配对） */
const dropActive = ref(false);
let dropDepth = 0;
const appendInput = ref<HTMLInputElement | null>(null);

function isTxtFile(file: File): boolean {
  return /\.(txt|text)$/i.test(file.name) || file.type === "text/plain";
}

function hasFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function onZoneDragEnter(event: DragEvent) {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  event.stopPropagation();
  dropDepth += 1;
  dropActive.value = true;
  emit("draggingChange", true);
}

function onZoneDragOver(event: DragEvent) {
  if (!hasFileDrag(event)) return;
  // 必须阻止默认行为，否则浏览器会直接把 txt 打开成新页面
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function onZoneDragLeave(event: DragEvent) {
  if (!hasFileDrag(event)) return;
  event.stopPropagation();
  dropDepth = Math.max(0, dropDepth - 1);
  if (dropDepth === 0) {
    dropActive.value = false;
    emit("draggingChange", false);
  }
}

async function onZoneDrop(event: DragEvent) {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  event.stopPropagation();
  dropDepth = 0;
  dropActive.value = false;
  emit("draggingChange", false);

  const all = Array.from(event.dataTransfer?.files ?? []);
  if (!all.length) return;
  const txtFiles = all.filter(isTxtFile);
  if (!txtFiles.length) return;

  const payload = await Promise.all(
    txtFiles.map(async (file) => ({
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  );
  emit("appendFiles", payload);
}

async function onAppendPicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (!files.length) return;
  const payload = await Promise.all(
    files.map(async (file) => ({
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  );
  emit("appendFiles", payload);
}

const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  if (!keyword) return props.chapters;
  return props.chapters.filter((chapter) => chapter.title.toLowerCase().includes(keyword));
});

const total = computed(() => filtered.value.length);

/* —— 虚拟滚动窗口 —— */
const scrollTop = ref(0);
const viewportHeight = ref(0);

function syncViewport() {
  viewportHeight.value = scroller.value?.clientHeight ?? 0;
}

watch(scroller, syncViewport, { immediate: true, flush: "post" });

const range = computed(() => {
  const height = viewportHeight.value || 640;
  const first = Math.max(0, Math.floor(scrollTop.value / ITEM_HEIGHT) - OVERSCAN);
  const visible = Math.ceil(height / ITEM_HEIGHT) + OVERSCAN * 2;
  return { start: first, end: Math.min(total.value, first + visible) };
});

const visibleChapters = computed(() => filtered.value.slice(range.value.start, range.value.end));
const padTop = computed(() => range.value.start * ITEM_HEIGHT);
const padBottom = computed(() => Math.max(0, (total.value - range.value.end) * ITEM_HEIGHT));

function onScroll(event: Event) {
  scrollTop.value = (event.target as HTMLElement).scrollTop;
}

/** 搜索后重置滚动位置，避免停在空白区 */
watch(query, () => {
  scrollTop.value = 0;
  if (scroller.value) scroller.value.scrollTop = 0;
});

function isSelected(chapter: Chapter): boolean {
  return chapter.id === props.selectedId;
}

/** 选中项不在可视区时（例如重新解析后）滚动到中间。 */
watch(
  () => props.selectedId,
  (id) => {
    if (!id || !scroller.value) return;
    const index = filtered.value.findIndex((chapter) => chapter.id === id);
    if (index < 0) return;
    const top = index * ITEM_HEIGHT;
    const viewport = scroller.value.clientHeight;
    const current = scroller.value.scrollTop;
    if (top < current || top + ITEM_HEIGHT > current + viewport) {
      scroller.value.scrollTo({
        top: Math.max(0, top - viewport / 2 + ITEM_HEIGHT / 2),
        behavior: "smooth",
      });
    }
  },
);

const matchedWords = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  if (!keyword) return 0;
  return filtered.value.reduce((sum, chapter) => sum + (props.stats.get(chapter.id) ?? 0), 0);
});

/** 当前滚到第几章（1 起），用于给「还能往下滚」一个明确的数字暗示。 */
const scrolledIndex = computed(() => {
  if (!total.value) return 0;
  const index = Math.floor((scrollTop.value + ITEM_HEIGHT / 2) / ITEM_HEIGHT);
  return Math.min(total.value, Math.max(1, index + 1));
});

/** 内容超出视口才提示可滚动 */
const scrollable = computed(() => total.value * ITEM_HEIGHT > viewportHeight.value + ITEM_HEIGHT);

function formatWords(value: number): string {
  if (value >= 10000) return t(`${(value / 10000).toFixed(1)} 万`, `${(value / 1000).toFixed(1)}k`);
  return String(value);
}
</script>

<template>
  <aside class="chapters" :class="{ 'chapters--collapsed': collapsed }" aria-labelledby="chapters-heading">
    <header class="chapters__head">
      <h2 id="chapters-heading" class="chapters__title">
        {{ t("章节", "Chapters") }}
        <span class="chapters__count tnum">{{ total }}</span>
        <span v-if="query" class="chapters__of tnum">/ {{ chapters.length }}</span>
      </h2>
      <div class="chapters__head-actions">
        <button
          type="button"
          class="chapters__icon-btn"
          :aria-label="t('按当前规则重新解析', 'Re-split with current rules')"
          :title="t('按当前规则重新解析', 'Re-split with current rules')"
          @click="emit('reparse')"
        >
          <UiIcon name="arrow-path" :size="15" />
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

    <p v-if="query" class="chapters__filter-note tnum">
      {{ t("匹配", "Matched") }} {{ total }} {{ t("章", "chapters") }} · {{ formatWords(matchedWords) }} {{ t("字", "chars") }}
    </p>

    <div
      ref="scroller"
      class="chapters__scroll"
      :class="{ 'chapters__scroll--drop': dropActive }"
      role="listbox"
      :aria-label="t('章节列表', 'Chapter list')"
      tabindex="0"
      @scroll.passive="onScroll"
      @dragenter="onZoneDragEnter"
      @dragover="onZoneDragOver"
      @dragleave="onZoneDragLeave"
      @drop="onZoneDrop"
    >
      <div :style="{ height: `${padTop}px` }" aria-hidden="true" />
      <div
        v-for="chapter in visibleChapters"
        :key="chapter.id"
        role="option"
        :aria-selected="isSelected(chapter)"
        tabindex="-1"
        class="chapter-row"
        :class="{ 'chapter-row--on': isSelected(chapter) }"
        @click="emit('select', chapter.id)"
        @keydown.enter.prevent="emit('select', chapter.id)"
        @keydown.space.prevent="emit('select', chapter.id)"
      >
        <span class="chapter-row__rail" aria-hidden="true" />
        <span class="chapter-row__body">
          <span class="chapter-row__title">
            <UiIcon v-if="chapter.isIntro" name="bookmark" :size="12" class="chapter-row__mark" />
            {{ chapter.title }}
          </span>
          <span class="chapter-row__meta tnum">
            {{ formatWords(stats.get(chapter.id) ?? 0) }} {{ t("字", "chars") }} · {{ chapter.lines.length }} {{ t("行", "lines") }}
          </span>
        </span>
      </div>
      <div :style="{ height: `${padBottom}px` }" aria-hidden="true" />

      <p v-if="!total" class="chapters__empty">
        <UiIcon name="magnifying-glass" :size="18" />
        {{ t(`没有标题包含「${query}」的章节`, `No chapters with “${query}” in the title`) }}
      </p>
    </div>

    <!-- 追加章节：把额外的 TXT 拖进来或点选，作为新章节并入当前书 -->
    <div
      class="append"
      :class="{ 'append--active': dropActive }"
      @dragenter="onZoneDragEnter"
      @dragover="onZoneDragOver"
      @dragleave="onZoneDragLeave"
      @drop="onZoneDrop"
    >
      <div class="append__text">
        <UiIcon name="document-plus" :size="15" class="append__icon" />
        <span class="append__label">
          {{ dropActive ? t("松手并入新章节", "Release to append as new chapters") : t("拖入 TXT 追加章节", "Drop TXT files to append chapters") }}
        </span>
      </div>
      <button
        type="button"
        class="append__btn"
        :disabled="busy"
        :title="t('选择 TXT 文件并作为新章节追加', 'Choose TXT files to append as new chapters')"
        @click="appendInput?.click()"
      >
        <UiIcon name="folder-plus" :size="13" />
        {{ t("打开文件", "Open file") }}
      </button>
      <input
        ref="appendInput"
        class="sr-only"
        type="file"
        accept=".txt,text/plain"
        multiple
        tabindex="-1"
        aria-hidden="true"
        @change="onAppendPicked"
      />
    </div>

    <footer class="chapters__foot">
      <div v-if="scrollable" class="chapters__scrollhint" aria-hidden="true">
        <span class="chapters__scrollhint-bar">
          <span
            class="chapters__scrollhint-thumb"
            :style="{
              height: `${Math.max(12, (viewportHeight / (total * ITEM_HEIGHT)) * 100)}%`,
              top: `${Math.min(88, (scrollTop / Math.max(1, total * ITEM_HEIGHT - viewportHeight)) * 100)}%`,
            }"
          />
        </span>
        <span class="chapters__scrollhint-text tnum">
          {{ scrolledIndex }} / {{ total }}
        </span>
      </div>
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

.chapters__icon-btn:hover {
  color: var(--color-text);
  background-color: var(--color-surface-active);
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
  /* 常驻细滚动槽，让「这里可以滚」在视觉上明确；
     滚动条本身用 --color-border-strong，浅深两套都有足够对比。 */
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border-strong) transparent;
}

.chapters__scroll:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: -2px;
}

/* 拖拽经过列表时整块染色，给出「放这里就并入」的明确信号 */
.chapters__scroll--drop {
  background-color: color-mix(in srgb, var(--color-primary-soft) 55%, transparent);
  box-shadow: inset 0 0 0 2px var(--color-primary);
  border-radius: var(--radius-sm);
}

/* —— 追加章节 —— */
.append {
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

.append--active {
  background-color: var(--color-primary-soft);
  border-color: var(--color-primary);
}

.append__text {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1 1 auto;
  min-width: 0;
}

.append__icon {
  flex: none;
  color: var(--color-text-muted);
}

.append--active .append__icon {
  color: var(--color-primary-text);
}

.append__label {
  font-size: var(--text-2xs);
  line-height: 1.3;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.append--active .append__label {
  color: var(--color-primary-text);
}

.append__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  min-height: 26px;
  padding: 0 var(--space-2);
  font-size: var(--text-2xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-secondary);
  background-color: var(--color-surface);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  transition:
    color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.append__btn:hover:not(:disabled) {
  color: var(--color-text);
  background-color: var(--color-surface-hover);
  border-color: var(--color-text-muted);
}

.append__btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.chapter-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 46px;
  padding: 0 var(--space-3);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background-color var(--duration-fast) var(--ease-out);
}

.chapter-row:hover {
  background-color: var(--color-surface-active);
}

.chapter-row--on {
  background-color: var(--color-primary-soft);
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
  height: 22px;
}

.chapter-row__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
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

.chapters__foot {
  flex: none;
  padding: var(--space-2) var(--space-4) var(--space-3);
  border-top: 1px solid var(--color-border-subtle);
}

/* 滚动位置条：一条 3px 的细轨 + 当前章序号，
   让「列表还能往下翻」在视觉上明确，无需依赖被隐藏的系统滚动条。 */
.chapters__scrollhint {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-1) var(--space-2);
}

.chapters__scrollhint-bar {
  position: relative;
  flex: 1 1 auto;
  height: 3px;
  overflow: hidden;
  background-color: var(--color-bg-sunken);
  border-radius: var(--radius-full);
}

.chapters__scrollhint-thumb {
  position: absolute;
  left: 0;
  width: 22%;
  min-height: 3px;
  background-color: var(--color-primary);
  border-radius: var(--radius-full);
  opacity: 0.55;
  transition:
    top var(--duration-fast) linear,
    height var(--duration-base) var(--ease-out);
}

.chapters__scrollhint-text {
  flex: none;
  font-size: var(--text-2xs);
  color: var(--color-text-muted);
}

/* 窗口变窄时只是收窄侧栏，始终保持「在流内」，
   不做遮挡主区的浮层 —— 否则 940px 最小尺寸下正文会被压住看不清。 */
@media (max-width: 1280px) {
  .chapters {
    width: 284px;
  }
}

@media (max-width: 1080px) {
  .chapters {
    width: 248px;
  }

  .chapters__head {
    padding-left: var(--space-3);
  }

  .chapters__search {
    margin-left: var(--space-3);
    margin-right: var(--space-3);
  }

  .chapters__foot {
    padding-left: var(--space-3);
    padding-right: var(--space-3);
  }
}
</style>
