<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import UiIcon from "../icons/UiIcon.vue";
import UiButton from "../ui/UiButton.vue";
import type { Chapter, TypesettingOptions } from "../engine/core";
import { useUiLanguage } from "../composables/useUiLanguage";

/**
 * 章节正文预览 + 重命名 + 合并。
 * 正文用衬线字体、保留空行；切换章节时滚动回顶部。
 */
const props = defineProps<{
  chapter: Chapter | null;
  /** 本章字数 */
  wordCount: number;
  /** 是否可合并到上一章（第一章不可） */
  canMerge: boolean;
  /** 当前章节序号（0 起；-1 表示未选中） */
  index: number;
  total: number;
  /** 排版设置：字号 / 行高同时用于正文预览与导出样式 */
  typesetting: TypesettingOptions;
}>();

const emit = defineEmits<{
  selectPrev: [];
  selectNext: [];
  rename: [payload: { id: string; title: string }];
  /** 保存正文改动（已按行切分） */
  updateBody: [payload: { id: string; lines: string[] }];
  updateTypesetting: [patch: Partial<TypesettingOptions>];
  mergePrev: [];
}>();

const bodyRef = ref<HTMLElement | null>(null);
const editing = ref(false);
const draft = ref("");
const inputRef = ref<HTMLInputElement | null>(null);
const { t } = useUiLanguage();
/** Esc 取消后，输入框卸载引发的 blur 不应再提交草稿。 */
let skipBlurCommit = false;

/* —— 正文内联编辑 ——
   不使用 textarea：正文本身就是编辑区（contenteditable），
   点哪儿光标落哪儿，像在阅读时直接改字。
*/
const bodyEditableRef = ref<HTMLElement | null>(null);
/** 本章是否有未落盘的改动 */
const bodyDirty = ref(false);
/** 正在自动保存（给用户一个「已存」的确认） */
const bodySavedFlash = ref(false);
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let savedFlashTimer: ReturnType<typeof setTimeout> | null = null;
/** 输入法组合中：不打断中文输入 */
let composing = false;

const title = computed(() => props.chapter?.title ?? "");
const lines = computed(() => props.chapter?.lines ?? []);

const fontLabel = computed(() => `${props.typesetting.fontSize.toFixed(2)}em`);
const lineHeightLabel = computed(() => props.typesetting.lineHeight.toFixed(2));

function stepFontSize(delta: number): void {
  const next = Math.min(1.6, Math.max(0.8, Math.round((props.typesetting.fontSize + delta) * 100) / 100));
  if (next !== props.typesetting.fontSize) emit("updateTypesetting", { fontSize: next });
}

function stepLineHeight(delta: number): void {
  const next = Math.min(2.4, Math.max(1.2, Math.round((props.typesetting.lineHeight + delta) * 100) / 100));
  if (next !== props.typesetting.lineHeight) emit("updateTypesetting", { lineHeight: next });
}

/** 超过这个行数就不做内联编辑，避免单次渲染几万个节点卡死 */
const MAX_EDIT_LINES = 5000;
const canEditBody = computed(() => lines.value.length <= MAX_EDIT_LINES);

/**
 * 把当前章节正文写进编辑区。
 * 只在「不是在输入」的时候刷新 DOM，否则会把光标顶掉。
 *
 * 用「一行一个 <div>」而不是单一文本节点：这样每段能保留首行缩进（2 字），
 * 阅读观感和原来一致；读取时仍走 innerText，块之间天然带 \n。
 */
function syncBodyDom(force = false) {
  const el = bodyEditableRef.value;
  if (!el) return;
  if (!force && document.activeElement === el) return;
  const nextLines = props.chapter?.lines ?? [];
  const currentLines = readBodyLines(el);
  const same =
    currentLines.length === nextLines.length &&
    currentLines.every((line, i) => line === nextLines[i]);
  if (same) return;

  el.replaceChildren(
    ...nextLines.map((line) => {
      const block = document.createElement("div");
      if (line.length) {
        block.textContent = line;
      } else {
        // 空行必须有 <br>，否则高度塌陷、光标点不进去
        block.appendChild(document.createElement("br"));
      }
      return block;
    }),
  );
}

/**
 * 从编辑区读回正文。
 *
 * 不能直接用 innerText：块级元素之间会被它算成额外换行，导致每保存一次
 * 空白行就翻倍。这里按子块逐个取，一个 <div> 对应一行，块内若还有换行
 * （Shift+Enter 产生的 <br>）再拆开。
 */
function readBodyLines(el: HTMLElement): string[] {
  const rows = Array.from(el.children) as HTMLElement[];
  if (!rows.length) {
    const text = el.innerText.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    return text.length ? text.split("\n") : [""];
  }
  const out: string[] = [];
  for (const row of rows) {
    const raw = (row.innerText ?? "").replace(/\r\n?/g, "\n");
    const cleaned = raw.replace(/\n+$/, "");
    if (cleaned.length === 0) {
      out.push("");
    } else {
      out.push(...cleaned.split("\n"));
    }
  }
  return out.length ? out : [""];
}

function flashSaved() {
  bodySavedFlash.value = true;
  if (savedFlashTimer) clearTimeout(savedFlashTimer);
  savedFlashTimer = setTimeout(() => {
    bodySavedFlash.value = false;
  }, 1400);
}

/** 真正提交到 store */
function flushBodyEdits() {
  const el = bodyEditableRef.value;
  const chapter = props.chapter;
  if (!el || !chapter) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const nextLines = readBodyLines(el);
  const changed =
    nextLines.length !== chapter.lines.length ||
    nextLines.some((line, i) => line !== chapter.lines[i]);
  bodyDirty.value = changed;
  if (changed) {
    emit("updateBody", { id: chapter.id, lines: nextLines });
    flashSaved();
  }
}

/** 输入时防抖自动保存（约 600ms 无输入即落盘） */
function scheduleBodySave() {
  if (composing) return;
  bodyDirty.value = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushBodyEdits();
  }, 600);
}

function onBodyInput() {
  scheduleBodySave();
}

function onBodyCompositionStart() {
  composing = true;
}

function onBodyCompositionEnd() {
  composing = false;
  scheduleBodySave();
}

function onBodyBlur() {
  flushBodyEdits();
  // 失焦后把 DOM 归一回纯文本结构（Enter 键会产生 <div>/<br>，
  // 归一后下次进入时光标位置与行号能对上）
  nextTick(() => syncBodyDom(true));
}

/** 粘贴时只取纯文本，避免把外部样式带进正文 */
async function onBodyPaste(event: ClipboardEvent) {
  event.preventDefault();
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (!text) return;
  // execCommand 在 Electron/Chromium 里对 contenteditable 仍然是最可靠的光标处插入方式
  document.execCommand("insertText", false, text.replace(/\r\n?/g, "\n"));
}

watch(
  () => props.chapter?.id,
  () => {
    editing.value = false;
    bodyDirty.value = false;
    nextTick(() => {
      syncBodyDom(true);
      if (bodyRef.value) bodyRef.value.scrollTop = 0;
    });
  },
  { immediate: true },
);

/** 章节内容被外部改动（合并、重新解析等）时同步 DOM */
watch(
  () => props.chapter?.lines,
  () => {
    bodyDirty.value = false;
    nextTick(() => syncBodyDom());
  },
);

onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer);
  if (savedFlashTimer) clearTimeout(savedFlashTimer);
});

/** 超长章节的只读预览：只渲染前 N 行，避免一次性创建上万节点。 */
const MAX_RENDER_LINES = 1200;
const shownLines = computed(() => lines.value.slice(0, MAX_RENDER_LINES));

async function startEdit() {
  if (!props.chapter) return;
  draft.value = props.chapter.title;
  editing.value = true;
  await nextTick();
  inputRef.value?.focus();
  inputRef.value?.select();
}

function commit() {
  if (!props.chapter) return;
  // Esc 取消或已退出编辑态时，blur 不能再把草稿提交上去
  if (skipBlurCommit) {
    skipBlurCommit = false;
    return;
  }
  if (!editing.value) return;
  const next = draft.value.trim();
  if (next && next !== props.chapter.title) {
    emit("rename", { id: props.chapter.id, title: next });
  }
  editing.value = false;
}

function cancel() {
  // 先置标记：取消会让输入框卸载并触发 blur，必须拦掉那次 commit
  skipBlurCommit = true;
  draft.value = "";
  editing.value = false;
}

function formatWords(value: number): string {
  if (value >= 10000) return t(`${(value / 10000).toFixed(2)} 万字`, `${(value / 1000).toFixed(1)}k characters`);
  return t(`${value} 字`, `${value} characters`);
}

</script>

<template>
  <section class="viewer" aria-labelledby="viewer-title">
    <header class="viewer__head">
      <div class="viewer__heading">
        <span class="viewer__index mono tnum">
          {{ index >= 0 ? String(index + 1).padStart(2, "0") : "—" }}
          <span class="viewer__index-sep">/</span>
          {{ total }}
        </span>

        <div class="viewer__title-wrap">
          <template v-if="editing">
            <input
              ref="inputRef"
              v-model="draft"
              class="ctl viewer__title-input serif"
              type="text"
              :aria-label="t('章节标题', 'Chapter title')"
              @keydown.enter.prevent.stop="commit"
              @keydown.esc.prevent.stop="cancel"
              @blur="commit"
            />
          </template>
          <template v-else>
            <h2 id="viewer-title" class="viewer__title serif">
              <UiIcon v-if="chapter?.isIntro" name="bookmark" :size="14" class="viewer__intro-mark" />
              {{ title || t("未选择章节", "No chapter selected") }}
            </h2>
          </template>
        </div>
      </div>

      <div class="viewer__actions">
        <UiButton
          v-if="!editing && chapter"
          size="sm"
          variant="ghost"
          icon="pencil"
          @click="startEdit"
        >
          {{ t("重命名", "Rename") }}
        </UiButton>
        <template v-else-if="editing">
          <UiButton size="sm" variant="ghost" @click="cancel">{{ t("取消", "Cancel") }}</UiButton>
          <UiButton size="sm" variant="primary" @click="commit">{{ t("保存", "Save") }}</UiButton>
        </template>

        <UiButton
          v-if="!editing && chapter"
          size="sm"
          variant="ghost"
          icon="arrow-uturn-left"
          :disabled="!canMerge"
          @click="emit('mergePrev')"
        >
          {{ t("并入上一章", "Merge into previous") }}
        </UiButton>

        <div class="viewer__nav">
          <button
            type="button"
            class="viewer__nav-btn"
            :aria-label="t('上一章', 'Previous chapter')"
            :disabled="index <= 0"
            @click="emit('selectPrev')"
          >
            <UiIcon name="chevron-up" :size="16" />
          </button>
          <button
            type="button"
            class="viewer__nav-btn"
            :aria-label="t('下一章', 'Next chapter')"
            :disabled="index < 0 || index >= total - 1"
            @click="emit('selectNext')"
          >
            <UiIcon name="chevron-down" :size="16" />
          </button>
        </div>

        <!-- 工具栏最右侧的扩展位：右侧设置面板收起后，恢复入口就放在这里 -->
        <slot name="actions-extra" />
      </div>
    </header>

    <div v-if="chapter" class="viewer__strip">
      <span class="badge">{{ chapter.isIntro ? t("简介", "Introduction") : t(`第 ${index + 1} 章`, `Chapter ${index + 1}`) }}</span>
      <span class="viewer__strip-meta tnum">{{ formatWords(wordCount) }}</span>
      <span class="viewer__strip-sep" aria-hidden="true">·</span>
      <span class="viewer__strip-meta tnum">{{ lines.length }} {{ t("行", "lines") }}</span>
      <span v-if="chapter.bodyEdited || bodyDirty" class="viewer__strip-edited">
        <UiIcon name="pencil" :size="11" />
        {{ t("正文已修改", "Body edited") }}
      </span>
      <span v-if="bodySavedFlash" class="viewer__strip-saved">
        <UiIcon name="check" :size="11" />
        {{ t("已自动保存", "Auto-saved") }}
      </span>
      <span class="spacer" />
      <span class="viewer__setting" role="group" :aria-label="t('预览字号', 'Preview font size')">
        <span class="viewer__setting-label">{{ t("字号", "Size") }}</span>
        <button
          type="button"
          class="viewer__setting-btn"
          :aria-label="t('减小预览字号', 'Decrease preview font size')"
          :title="t('减小预览字号', 'Decrease preview font size')"
          :disabled="typesetting.fontSize <= 0.8"
          @click="stepFontSize(-0.05)"
        >
          A−
        </button>
        <span class="viewer__setting-value tnum">{{ fontLabel }}</span>
        <button
          type="button"
          class="viewer__setting-btn"
          :aria-label="t('增大预览字号', 'Increase preview font size')"
          :title="t('增大预览字号', 'Increase preview font size')"
          :disabled="typesetting.fontSize >= 1.6"
          @click="stepFontSize(0.05)"
        >
          A+
        </button>
      </span>

      <span class="viewer__setting" role="group" :aria-label="t('预览行距', 'Preview line height')">
        <span class="viewer__setting-label">{{ t("行距", "Spacing") }}</span>
        <button
          type="button"
          class="viewer__setting-btn"
          :aria-label="t('减小预览行距', 'Decrease preview line height')"
          :title="t('减小预览行距', 'Decrease preview line height')"
          :disabled="typesetting.lineHeight <= 1.2"
          @click="stepLineHeight(-0.05)"
        >
          −
        </button>
        <span class="viewer__setting-value tnum">{{ lineHeightLabel }}</span>
        <button
          type="button"
          class="viewer__setting-btn"
          :aria-label="t('增大预览行距', 'Increase preview line height')"
          :title="t('增大预览行距', 'Increase preview line height')"
          :disabled="typesetting.lineHeight >= 2.4"
          @click="stepLineHeight(0.05)"
        >
          +
        </button>
      </span>
    </div>

    <div
      ref="bodyRef"
      class="viewer__body"
      :style="{ '--viewer-font-size': `calc(var(--text-md) * ${typesetting.fontSize})`, '--viewer-line-height': String(typesetting.lineHeight) }"
      tabindex="0"
      role="region"
      :aria-label="t('章节正文', 'Chapter body')"
    >
      <!--
        正文即编辑区：contenteditable 让光标直接落在点击位置，
        没有额外的输入框和「进入编辑」步骤。行由 JS 写进 DOM，
        避免 Vue 在用户打字时重渲染把光标顶掉。
      -->
      <div
        v-if="chapter && canEditBody"
        ref="bodyEditableRef"
        class="prose prose--editable serif"
        contenteditable="true"
        role="textbox"
        aria-multiline="true"
        :aria-label="t('章节正文，可直接编辑', 'Chapter body, editable')"
        :data-placeholder="t('（本章无正文，点击这里开始输入）', '(No body text in this chapter; click here to start typing)')"
        spellcheck="false"
        @input="onBodyInput"
        @blur="onBodyBlur"
        @paste="onBodyPaste"
        @compositionstart="onBodyCompositionStart"
        @compositionend="onBodyCompositionEnd"
      />
      <div v-else-if="chapter" class="prose serif">
        <p
          v-for="(line, lineIndex) in shownLines"
          :key="lineIndex"
          class="prose__line"
          :class="{ 'prose__line--blank': !line.trim() }"
        >{{ line || "\u00A0" }}</p>
        <p class="prose__more">
          {{ t(`本章有 ${lines.length} 行，超过内联编辑上限（${MAX_EDIT_LINES} 行），这里仅预览。导出不受影响。`, `This chapter has ${lines.length} lines, exceeding the inline editing limit (${MAX_EDIT_LINES} lines). Showing a preview only; export is unaffected.`) }}
        </p>
      </div>
      <div v-else class="viewer__empty">
        <UiIcon name="book-open" :size="28" />
        <p>{{ t("从左侧选择一章查看正文", "Select a chapter on the left to read its text") }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.viewer {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  /* 关键：grid 子项默认 min-height:auto，内容一长就会把整块撑高，
     导致内部 .viewer__body 没有可滚动空间（滚轮失效）。必须显式允许收缩。 */
  min-height: 0;
  height: 100%;
  background-color: var(--color-surface);
}

.viewer__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
  padding: var(--space-4) var(--space-6) var(--space-3);
  border-bottom: 1px solid var(--color-border-subtle);
}

.viewer__heading {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  flex: 1 1 240px;
}

.viewer__index {
  flex: none;
  font-size: var(--text-2xs);
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.viewer__index-sep {
  opacity: 0.6;
}

.viewer__title-wrap {
  min-width: 0;
  flex: 1 1 auto;
}

.viewer__title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
  letter-spacing: 0.03em;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.viewer__intro-mark {
  flex: none;
  color: var(--color-primary-text);
}

.viewer__title-input {
  height: 34px;
  font-size: var(--text-md);
  font-weight: var(--weight-medium);
}

.viewer__actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: wrap;
}

.viewer__nav {
  display: flex;
  gap: 2px;
  margin-left: var(--space-1);
  padding-left: var(--space-2);
  border-left: 1px solid var(--color-border);
}

.viewer__nav-btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  color: var(--color-text-secondary);
  border-radius: var(--radius-sm);
  transition:
    color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.viewer__nav-btn:hover:not(:disabled) {
  color: var(--color-text);
  background-color: var(--color-surface-active);
}

.viewer__nav-btn:disabled {
  color: var(--color-text-muted);
  opacity: 0.45;
  cursor: not-allowed;
}

.viewer__strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
  padding: var(--space-2) var(--space-6);
  font-size: var(--text-2xs);
  color: var(--color-text-muted);
  background-color: var(--color-bg-sunken);
  border-bottom: 1px solid var(--color-border-subtle);
}

.viewer__strip > * {
  flex: none;
}

.viewer__strip .spacer {
  flex: 1 1 auto;
  min-width: var(--space-2);
}

/* 各项都是 nowrap，避免「3603 字 / 123 行」被挤成两行 */
.viewer__strip-meta,
.viewer__strip-sep,
.viewer__strip-edited {
  white-space: nowrap;
}

.viewer__strip-edited {
  flex: none;
}

.viewer__strip-meta {
  color: var(--color-text-secondary);
}

.viewer__strip-sep {
  opacity: 0.6;
}

.viewer__setting {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
  padding: 1px 2px;
  background-color: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.viewer__setting-label {
  padding: 0 4px;
  font-size: var(--text-2xs);
  color: var(--color-text-muted);
}

.viewer__setting-btn {
  display: grid;
  place-items: center;
  min-width: 26px;
  height: 22px;
  padding: 0 4px;
  font-size: var(--text-2xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-secondary);
  border-radius: 3px;
}

.viewer__setting-btn:hover:not(:disabled) {
  color: var(--color-text);
  background-color: var(--color-surface-active);
}

.viewer__setting-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.viewer__setting-value {
  min-width: 34px;
  text-align: center;
  font-size: var(--text-2xs);
  color: var(--color-text-secondary);
}

.viewer__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  /* 自适应宽度：两侧栏收起后正文随可用宽度伸展 */
  padding: var(--space-6) clamp(var(--space-5), 5vw, var(--space-12)) var(--space-12);
}

/* —— 内联编辑：正文本身就是输入区，没有任何边框 —— */
.prose--editable {
  outline: none;
  caret-color: var(--color-primary);
  /* 块级 <div> 之间靠行高分隔，保留空行高度 */
  min-height: 40vh;
  cursor: text;
  /* 明确不做任何 focus 描边：编辑态与阅读态看起来应当一致 */
}

/* 每段首行缩进两字，编辑态与阅读态一致。
   段落是 JS 动态创建的，不带 scoped 属性，必须用 :deep() 才能命中。 */
.prose--editable :deep(> div) {
  min-height: 1em;
  text-indent: 2em;
}

/* 空行不缩进、占 0.6em 高度（与只读态的 .prose__line--blank 对齐） */
.prose--editable :deep(> div:empty),
.prose--editable :deep(> div:has(> br:only-child)) {
  min-height: 0.6em;
  text-indent: 0;
}

/* 鼠标点进来时不画框；只有键盘 Tab 聚焦（focus-visible）才给可见轮廓，
   兼顾「不要框住正文」和无障碍要求 */
.prose--editable:focus,
.prose--editable:focus-visible {
  outline: none;
  box-shadow: none;
}

/* 空章节时给个可点击的落点 */
.prose--editable:empty::before {
  content: attr(data-placeholder);
  color: var(--color-text-muted);
}

.viewer__strip-saved {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  font-size: var(--text-2xs);
  color: var(--color-success);
  background-color: var(--color-success-soft);
  border-radius: var(--radius-full);
}

.viewer__strip-edited {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  font-size: var(--text-2xs);
  color: var(--color-warning);
  background-color: var(--color-warning-soft);
  border-radius: var(--radius-full);
}

.viewer__body:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: -2px;
}

/* 正文：衬线、宽松行高、首行缩进两字 */
.prose {
  width: 100%;
  max-width: none;
  margin: 0;
  font-size: var(--viewer-font-size, var(--text-md));
  line-height: var(--viewer-line-height, var(--leading-relaxed));
  color: var(--color-text);
  text-align: justify;
  word-break: break-word;
  hyphens: auto;
}

.prose__line {
  min-height: 1em;
  text-indent: 2em;
}

.prose__line--blank {
  min-height: 0.6em;
  text-indent: 0;
}

.prose__more {
  margin-top: var(--space-6);
  padding-top: var(--space-4);
  font-family: var(--font-sans);
  font-size: var(--text-xs);
  text-indent: 0;
  text-align: center;
  color: var(--color-text-muted);
  border-top: 1px dashed var(--color-border);
}

.viewer__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  height: 100%;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

@media (max-width: 1100px) {
  .viewer__head {
    padding: var(--space-3) var(--space-5) var(--space-2);
  }

  .viewer__body {
    padding: var(--space-5) var(--space-5) var(--space-10);
  }

  .viewer__strip {
    padding: var(--space-2) var(--space-5);
  }
}

/*
 * 窄窗口下 ConvertView 会把左右两栏改成上下堆叠（.convert__split 高度变 auto），
 * 此时滚动应由外层 .convert__body 统一负责。
 * 内层 .viewer__body 若继续持有 overscroll-behavior: contain，
 * 会把滚轮事件吃掉、不再向上传递，导致滚不动。
 */
@media (max-width: 1180px) {
  .viewer,
  .viewer__body {
    height: auto;
    min-height: 0;
    overflow: visible;
    overscroll-behavior: auto;
  }
}
</style>