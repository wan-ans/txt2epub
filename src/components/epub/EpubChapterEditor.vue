<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Quill from "quill";
import "quill/dist/quill.snow.css";
import UiButton from "../ui/UiButton.vue";
import UiIcon from "../icons/UiIcon.vue";
import UiModal from "../ui/UiModal.vue";
import UiField from "../ui/UiField.vue";
import UiInput from "../ui/UiInput.vue";
import { useUiLanguage } from "../composables/useUiLanguage";
import type { EpubChapter } from "../engine/core";
import { setEditorFlushHook } from "../composables/useEpubWorkspace";

/**
 * EPUB 单章编辑器：Quill 2 富文本 + 墨匣化 toolbar。
 *
 * - 正文改动防抖 500ms 后通过 getSemanticHTML() 写回 store；
 * - 切换章节时用 clipboard.convert 把 html 转成 Delta 再 setContents，
 *   避免 Quill 直接 innerHTML 注入导致的不安全标记；
 * - 章节标题可内联重命名（回车保存 / Esc 取消）。
 */
const props = defineProps<{
  chapter: EpubChapter | null;
  /** 本章字数 */
  wordCount: number;
  index: number;
  total: number;
}>();

const emit = defineEmits<{
  rename: [payload: { id: string; title: string }];
  updateHtml: [payload: { id: string; html: string }];
  selectPrev: [];
  selectNext: [];
}>();

const { t, language } = useUiLanguage();

/** Quill 的占位文案在初始化时写入 data-placeholder，切换语言时需要同步刷新。 */
function editorPlaceholder(): string {
  return t("本章暂无正文，点击这里开始写作…", "No text in this chapter yet. Click here to start writing…");
}

const editorRef = ref<HTMLElement | null>(null);
const toolbarRef = ref<HTMLElement | null>(null);
const titleInput = ref<HTMLInputElement | null>(null);

let quill: Quill | null = null;
let currentEditorChapterId: string | null = null;
let lastEmittedHtml = "";
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let savedTimer: ReturnType<typeof setTimeout> | null = null;
let suppressChange = false;

const bodyDirty = ref(false);
const savedFlash = ref(false);
const editing = ref(false);
const draft = ref("");
let skipBlurCommit = false;

/* —— 编辑排版（字号 / 行距，仅影响界面预览，不写入导出 EPUB） —— */
const FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 26, 28, 30, 32];
const LINE_HEIGHT_OPTIONS = [1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.1, 2.2, 2.4];
const FONT_SIZE_STORAGE_KEY = "inkbox:epub-editor-font-size-px";
const LINE_HEIGHT_STORAGE_KEY = "inkbox:epub-editor-line-height";

function readStoredNumber(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    if (Number.isFinite(value)) return value;
  } catch {
    /* localStorage 不可用时使用默认值 */
  }
  return fallback;
}

function nearestIndex(options: number[], value: number): number {
  let best = 0;
  for (let index = 1; index < options.length; index += 1) {
    if (Math.abs(options[index] - value) < Math.abs(options[best] - value)) best = index;
  }
  return best;
}

const fontSizePx = ref<number>(FONT_SIZE_OPTIONS[nearestIndex(FONT_SIZE_OPTIONS, readStoredNumber(FONT_SIZE_STORAGE_KEY, 17))]);
const lineHeight = ref<number>(LINE_HEIGHT_OPTIONS[nearestIndex(LINE_HEIGHT_OPTIONS, readStoredNumber(LINE_HEIGHT_STORAGE_KEY, 1.85))]);
const fontSizeLabel = computed(() => `${fontSizePx.value}px`);
const lineHeightLabel = computed(() => lineHeight.value.toFixed(1));

/** 直接写到 Quill 的 .ql-editor 上，避免 Quill 自带 CSS 的 font-size / line-height 规则压过组件样式。 */
function applyEditorTypography(): void {
  const root = editorRef.value?.querySelector<HTMLElement>(".ql-editor");
  if (!root) return;
  root.style.fontSize = `${fontSizePx.value}px`;
  root.style.lineHeight = String(lineHeight.value);
}

watch([fontSizePx, lineHeight], () => {
  void nextTick(applyEditorTypography);
});

function stepNumber(options: number[], current: number, delta: number): number {
  const index = nearestIndex(options, current);
  return options[Math.max(0, Math.min(options.length - 1, index + delta))];
}

function changeFontSize(delta: number): void {
  const next = stepNumber(FONT_SIZE_OPTIONS, fontSizePx.value, delta);
  if (next === fontSizePx.value) return;
  fontSizePx.value = next;
  applyEditorTypography();
  try {
    localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(next));
  } catch {
    /* 忽略写入失败 */
  }
}

function changeLineHeight(delta: number): void {
  const next = stepNumber(LINE_HEIGHT_OPTIONS, lineHeight.value, delta);
  if (next === lineHeight.value) return;
  lineHeight.value = next;
  applyEditorTypography();
  try {
    localStorage.setItem(LINE_HEIGHT_STORAGE_KEY, String(next));
  } catch {
    /* 忽略写入失败 */
  }
}

/* —— 格式工具栏收起 —— */
const toolbarCollapsed = ref(false);

/* —— 链接 / 图片插入对话框 ——
   不用 window.prompt：Electron 默认禁用 prompt，点击会毫无反应。
   选中范围在打开对话框时先存下来，确认后按 Quill API 写回。 */
const linkOpen = ref(false);
const linkUrl = ref("");
const linkError = ref("");
const imageOpen = ref(false);
const imageUrl = ref("");
const imageError = ref("");
const imageInput = ref<HTMLInputElement | null>(null);
const savedRange = ref<{ index: number; length: number } | null>(null);

function captureRange(): { index: number; length: number } | null {
  if (!quill) return null;
  const range = quill.getSelection();
  if (range) return { index: range.index, length: range.length };
  return { index: quill.getLength(), length: 0 };
}

function normalizeLink(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  if (/^(https?:|mailto:|tel:)/i.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return ""; // javascript: / data: 等一律拒绝
  if (raw.startsWith("#") || raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../")) return raw;
  if (/\.x?html?(#|$)/i.test(raw)) return raw;
  return "https://" + raw;
}

function openLink(): void {
  if (!quill) return;
  const range = captureRange();
  savedRange.value = range;
  linkUrl.value = "";
  linkError.value = "";
  if (range && range.length > 0) {
    const existing = quill.getFormat(range).link;
    if (typeof existing === "string") linkUrl.value = existing;
  }
  linkOpen.value = true;
}

function setLinkUrl(value: string): void {
  linkUrl.value = value;
}

function applyLink(): void {
  if (!quill) return;
  const url = normalizeLink(linkUrl.value);
  if (!url) {
    linkError.value = t("请输入有效的链接地址（http / https / mailto 或 EPUB 内相对路径）", "Enter a valid link URL (http / https / mailto, or a relative path inside the EPUB)");
    return;
  }
  const range = savedRange.value ?? captureRange();
  if (!range) return;
  quill.focus();
  if (range.length > 0) {
    quill.formatText(range.index, range.length, "link", url, "user");
  } else {
    quill.insertText(range.index, url, "user", "user");
    quill.formatText(range.index, url.length, "link", url, "user");
    quill.setSelection(range.index + url.length, 0, "silent");
  }
  linkOpen.value = false;
}

function removeLink(): void {
  if (!quill) return;
  const range = savedRange.value ?? captureRange();
  if (!range || range.length === 0) return;
  quill.focus();
  quill.formatText(range.index, range.length, "link", false, "user");
  linkOpen.value = false;
}

function openImage(): void {
  if (!quill) return;
  savedRange.value = captureRange();
  imageUrl.value = "";
  imageError.value = "";
  imageOpen.value = true;
}

function setImageUrl(value: string): void {
  imageUrl.value = value;
}

function applyImage(): void {
  if (!quill) return;
  const url = imageUrl.value.trim();
  if (!url) {
    imageError.value = t("请输入图片地址，或选择本地图片", "Enter an image URL or choose a local image");
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^(https?:|data:image\/)/i.test(url)) {
    imageError.value = t("只支持 http / https、data:image 或 EPUB 内相对路径", "Only http / https, data:image, or relative paths inside the EPUB are supported");
    return;
  }
  const range = savedRange.value ?? captureRange();
  if (!range) return;
  quill.focus();
  quill.insertEmbed(range.index, "image", url, "user");
  quill.setSelection(range.index + 1, 0, "silent");
  imageOpen.value = false;
}

function onImageFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    imageError.value = t("请选择图片文件", "Please choose an image file");
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    imageError.value = t("图片不能超过 5 MB", "Images must be 5 MB or smaller");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    imageUrl.value = typeof reader.result === "string" ? reader.result : "";
    imageError.value = "";
  };
  reader.onerror = () => {
    imageError.value = t("读取图片失败", "Failed to read the image");
  };
  reader.readAsDataURL(file);
}

/** 空章节占位与编辑区首行缩进都靠这里统一控制 */
function formatWords(value: number): string {
  if (value >= 10000) return t(`${(value / 10000).toFixed(2)} 万`, `${(value / 1000).toFixed(2)}k`);
  return value.toLocaleString(t("zh-CN", "en-US"));
}

function flashSaved(): void {
  savedFlash.value = true;
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    savedFlash.value = false;
  }, 1600);
}

/** 把章节 html 灌进 Quill；程序化写入不触发自动保存。 */
function loadChapter(chapter: EpubChapter | null): void {
  if (!quill) return;
  suppressChange = true;
  const html = chapter?.html ?? "";
  quill.setContents(quill.clipboard.convert({ html }), "silent");
  quill.history.clear();
  lastEmittedHtml = html;
  currentEditorChapterId = chapter?.id ?? null;
  bodyDirty.value = false;
  savedFlash.value = false;
  suppressChange = false;
  if (quill.root) quill.root.scrollTop = 0;
}

/**
 * 提交当前编辑中的正文。
 * 只在确实有用户输入（存在防抖计时器）时提交，避免切换章节时
 * 把 Quill 规范化后的 HTML 误标成「已修改」。
 */
function flushPending(chapterId: string | null): void {
  const hadPending = saveTimer !== null;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!quill || !chapterId || !hadPending) return;
  const html = quill.getSemanticHTML();
  if (html !== lastEmittedHtml) {
    lastEmittedHtml = html;
    emit("updateHtml", { id: chapterId, html });
  }
  bodyDirty.value = false;
}

function scheduleSave(): void {
  bodyDirty.value = true;
  savedFlash.value = false;
  if (saveTimer) clearTimeout(saveTimer);
  const chapterId = currentEditorChapterId;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!quill || !chapterId || currentEditorChapterId !== chapterId) return;
    const html = quill.getSemanticHTML();
    if (html !== lastEmittedHtml) {
      lastEmittedHtml = html;
      emit("updateHtml", { id: chapterId, html });
    }
    bodyDirty.value = false;
    flashSaved();
  }, 500);
}

function initQuill(): void {
  if (quill || !editorRef.value || !toolbarRef.value) return;
  quill = new Quill(editorRef.value, {
    theme: "snow",
    placeholder: editorPlaceholder(),
    modules: {
      toolbar: {
        container: toolbarRef.value,
      },
    },
  });
  quill.on("text-change", (_delta, _oldDelta, source) => {
    if (suppressChange || source !== "user") return;
    scheduleSave();
  });
  applyEditorTypography();
  loadChapter(props.chapter);
}

watch(language, () => {
  if (quill) quill.root.setAttribute("data-placeholder", editorPlaceholder());
});

watch(
  () => props.chapter?.id,
  async (id, oldId) => {
    if (oldId) flushPending(oldId);
    editing.value = false;
    bodyDirty.value = false;
    await nextTick();
    initQuill();
    if (quill) loadChapter(props.chapter);
    if (id === null) currentEditorChapterId = null;
  },
);

/** 外部改动（目前只有切换章节）同步；用户输入期间不覆盖编辑器内容。 */
watch(
  () => props.chapter?.html,
  (html) => {
    if (!quill || !props.chapter) return;
    if (props.chapter.id !== currentEditorChapterId) return;
    if (html === lastEmittedHtml) return;
    if (saveTimer) return;
    loadChapter(props.chapter);
  },
);

onMounted(() => {
  initQuill();
  // 导出 / Ctrl+S 之前由 store 调用，把 500ms 防抖里的正文立即提交
  setEditorFlushHook(() => flushPending(currentEditorChapterId));
});

onBeforeUnmount(() => {
  setEditorFlushHook(null);
  flushPending(currentEditorChapterId);
  if (saveTimer) clearTimeout(saveTimer);
  if (savedTimer) clearTimeout(savedTimer);
  quill = null;
});

async function startRename(): Promise<void> {
  if (!props.chapter) return;
  draft.value = props.chapter.title;
  editing.value = true;
  await nextTick();
  titleInput.value?.focus();
  titleInput.value?.select();
}

function commitRename(): void {
  if (!props.chapter) return;
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

function cancelRename(): void {
  skipBlurCommit = true;
  draft.value = "";
  editing.value = false;
}

const title = computed(() => props.chapter?.title ?? "");
</script>

<template>
  <section class="editor" :style="{ '--epub-editor-font-size': fontSizePx + 'px' }" aria-labelledby="epub-editor-title">
    <header class="editor__head">
      <div class="editor__heading">
        <span class="editor__index mono tnum">
          {{ index >= 0 ? String(index + 1).padStart(2, "0") : "—" }}
          <span class="editor__index-sep">/</span>
          {{ total }}
        </span>

        <div class="editor__title-wrap">
          <template v-if="editing">
            <input
              ref="titleInput"
              v-model="draft"
              class="ctl editor__title-input serif"
              type="text"
              :aria-label="t('章节标题', 'Chapter title')"
              @keydown.enter.prevent.stop="commitRename"
              @keydown.esc.prevent.stop="cancelRename"
              @blur="commitRename"
            />
          </template>
          <template v-else>
            <h2
              id="epub-editor-title"
              class="editor__title serif"
              :title="t('双击重命名', 'Double-click to rename')"
              @dblclick="startRename"
            >
              {{ title || t("未选择章节", "No chapter selected") }}
            </h2>
          </template>
        </div>
      </div>

      <div class="editor__actions">
        <template v-if="editing">
          <UiButton size="sm" variant="ghost" @click="cancelRename">{{ t("取消", "Cancel") }}</UiButton>
          <UiButton size="sm" variant="primary" @click="commitRename">{{ t("保存", "Save") }}</UiButton>
        </template>
        <UiButton
          v-else-if="chapter"
          size="sm"
          variant="ghost"
          icon="pencil"
          @click="startRename"
        >
          {{ t("重命名", "Rename") }}
        </UiButton>

        <div class="editor__nav">
          <button
            type="button"
            class="editor__nav-btn"
            :aria-label="t('上一章', 'Previous chapter')"
            :title="t('上一章', 'Previous chapter')"
            :disabled="index <= 0"
            @click="emit('selectPrev')"
          >
            <UiIcon name="chevron-up" :size="16" />
          </button>
          <button
            type="button"
            class="editor__nav-btn"
            :aria-label="t('下一章', 'Next chapter')"
            :title="t('下一章', 'Next chapter')"
            :disabled="index < 0 || index >= total - 1"
            @click="emit('selectNext')"
          >
            <UiIcon name="chevron-down" :size="16" />
          </button>
        </div>

        <slot name="actions-extra" />
      </div>
    </header>

    <div v-if="chapter" class="editor__strip">
      <span class="badge">{{ chapter.isNew ? t("新章节", "New chapter") : t(`第 ${index + 1} 章`, `Chapter ${index + 1}`) }}</span>
      <span class="editor__strip-meta tnum">{{ formatWords(wordCount) }} {{ t("字", "words") }}</span>
      <span class="editor__strip-sep" aria-hidden="true">·</span>
      <span class="editor__strip-meta">{{ chapter.epubType || "XHTML" }}</span>
      <span v-if="bodyDirty" class="editor__strip-edited">
        <UiIcon name="pencil" :size="11" />
        {{ t("正文已修改", "Text modified") }}
      </span>
      <span v-else-if="savedFlash" class="editor__strip-saved">
        <UiIcon name="check" :size="11" />
        {{ t("已自动保存", "Autosaved") }}
      </span>
      <span class="spacer" />
      <span class="editor__controls">
        <span class="editor__fontsize" role="group" :aria-label="t('编辑字号', 'Editor font size')">
        <span class="editor__fontsize-label">{{ t("字号", "Font size") }}</span>
        <button
          type="button"
          class="editor__fontsize-btn"
          :aria-label="t('减小编辑字号', 'Decrease editor font size')"
          :title="t('减小编辑字号', 'Decrease editor font size')"
          :disabled="fontSizePx <= FONT_SIZE_OPTIONS[0]"
          @click="changeFontSize(-1)"
        >
          A−
        </button>
        <span class="editor__fontsize-value tnum">{{ fontSizeLabel }}</span>
        <button
          type="button"
          class="editor__fontsize-btn"
          :aria-label="t('增大编辑字号', 'Increase editor font size')"
          :title="t('增大编辑字号', 'Increase editor font size')"
          :disabled="fontSizePx >= FONT_SIZE_OPTIONS[FONT_SIZE_OPTIONS.length - 1]"
          @click="changeFontSize(1)"
        >
          A+
        </button>
      </span>

      <span class="editor__fontsize" role="group" :aria-label="t('编辑行距', 'Editor line height')">
        <span class="editor__fontsize-label">{{ t("行距", "Line height") }}</span>
        <button
          type="button"
          class="editor__fontsize-btn"
          :aria-label="t('减小编辑行距', 'Decrease editor line height')"
          :title="t('减小编辑行距', 'Decrease editor line height')"
          :disabled="lineHeight <= LINE_HEIGHT_OPTIONS[0]"
          @click="changeLineHeight(-1)"
        >
          −
        </button>
        <span class="editor__fontsize-value tnum">{{ lineHeightLabel }}</span>
        <button
          type="button"
          class="editor__fontsize-btn"
          :aria-label="t('增大编辑行距', 'Increase editor line height')"
          :title="t('增大编辑行距', 'Increase editor line height')"
          :disabled="lineHeight >= LINE_HEIGHT_OPTIONS[LINE_HEIGHT_OPTIONS.length - 1]"
          @click="changeLineHeight(1)"
        >
          +
        </button>
      </span>

      <button
        type="button"
        class="editor__toolbar-toggle"
        :aria-expanded="!toolbarCollapsed"
        :aria-label="toolbarCollapsed ? t('展开编辑格式工具栏', 'Show formatting toolbar') : t('收起编辑格式工具栏', 'Hide formatting toolbar')"
        :title="toolbarCollapsed ? t('展开编辑格式工具栏', 'Show formatting toolbar') : t('收起编辑格式工具栏', 'Hide formatting toolbar')"
        @click="toolbarCollapsed = !toolbarCollapsed"
      >
          <UiIcon :name="toolbarCollapsed ? 'chevron-down' : 'chevron-up'" :size="14" />
        </button>
      </span>
    </div>

    <div v-if="chapter" class="editor__workspace">
      <div v-show="!toolbarCollapsed" ref="toolbarRef" class="editor__toolbar" role="toolbar" :aria-label="t('正文格式', 'Text formatting')">
        <span class="editor__group">
          <button type="button" class="ql-bold editor__tool" :aria-label="t('加粗', 'Bold')" :title="t('加粗（Ctrl+B）', 'Bold (Ctrl+B)')"></button>
          <button type="button" class="ql-italic editor__tool" :aria-label="t('斜体', 'Italic')" :title="t('斜体（Ctrl+I）', 'Italic (Ctrl+I)')"></button>
          <button type="button" class="ql-underline editor__tool" :aria-label="t('下划线', 'Underline')" :title="t('下划线（Ctrl+U）', 'Underline (Ctrl+U)')"></button>
          <button type="button" class="ql-strike editor__tool" :aria-label="t('删除线', 'Strikethrough')" :title="t('删除线', 'Strikethrough')"></button>
        </span>

        <span class="editor__tool-sep" aria-hidden="true"></span>

        <span class="editor__group">
          <button type="button" class="ql-header editor__tool" value="1" :aria-label="t('一级标题', 'Heading 1')" :title="t('一级标题', 'Heading 1')"></button>
          <button type="button" class="ql-header editor__tool" value="2" :aria-label="t('二级标题', 'Heading 2')" :title="t('二级标题', 'Heading 2')"></button>
          <button type="button" class="ql-header editor__tool" value="3" :aria-label="t('三级标题', 'Heading 3')" :title="t('三级标题', 'Heading 3')"></button>
        </span>

        <span class="editor__tool-sep" aria-hidden="true"></span>

        <span class="editor__group">
          <button type="button" class="ql-blockquote editor__tool" :aria-label="t('引用', 'Blockquote')" :title="t('引用', 'Blockquote')"></button>
          <button type="button" class="ql-list editor__tool" value="ordered" :aria-label="t('有序列表', 'Ordered list')" :title="t('有序列表', 'Ordered list')"></button>
          <button type="button" class="ql-list editor__tool" value="bullet" :aria-label="t('无序列表', 'Bullet list')" :title="t('无序列表', 'Bullet list')"></button>
        </span>

        <span class="editor__tool-sep" aria-hidden="true"></span>

        <span class="editor__group">
          <button
            type="button"
            class="editor__tool"
            :aria-label="t('插入链接', 'Insert link')"
            :title="t('插入链接', 'Insert link')"
            @mousedown.prevent
            @click="openLink"
          >
            <UiIcon name="link" :size="16" />
          </button>
          <button
            type="button"
            class="editor__tool"
            :aria-label="t('插入图片', 'Insert image')"
            :title="t('插入图片', 'Insert image')"
            @mousedown.prevent
            @click="openImage"
          >
            <UiIcon name="photo" :size="16" />
          </button>
        </span>

        <span class="spacer" />

        <span class="editor__group">
          <button type="button" class="ql-clean editor__tool" :aria-label="t('清除格式', 'Clear formatting')" :title="t('清除格式', 'Clear formatting')"></button>
        </span>
      </div>

      <div class="editor__body">
        <div ref="editorRef" class="editor__quill" />
      </div>
    </div>

    <div v-else class="editor__empty">
      <UiIcon name="book-open" :size="28" />
      <p>{{ t("从左侧选择一章开始编辑", "Select a chapter on the left to start editing") }}</p>
    </div>

    <UiModal
      :open="linkOpen"
      :title="t('插入链接', 'Insert link')"
      :description="t('可以填网址、mailto，或 EPUB 内的相对路径；纯文本会自动补 https://。', 'Enter a URL, a mailto address, or a relative path inside the EPUB; plain text gets https:// added automatically.')"
      size="sm"
      @close="linkOpen = false"
    >
      <div class="dialog-form">
        <UiField :label="t('链接地址', 'Link URL')" input-id="epub-link-url" :error="linkError">
          <UiInput
            id="epub-link-url"
            :model-value="linkUrl"
            :placeholder="t('https://example.com 或 Text/chapter2.xhtml', 'https://example.com or Text/chapter2.xhtml')"
            autofocus
            @update:model-value="setLinkUrl"
            @keydown.enter.prevent="applyLink"
          />
        </UiField>
      </div>
      <template #footer>
        <UiButton
          v-if="savedRange && savedRange.length > 0"
          variant="ghost"
          @click="removeLink"
        >
          {{ t("移除链接", "Remove link") }}
        </UiButton>
        <UiButton variant="ghost" @click="linkOpen = false">{{ t("取消", "Cancel") }}</UiButton>
        <UiButton variant="primary" @click="applyLink">{{ t("插入", "Insert") }}</UiButton>
      </template>
    </UiModal>

    <UiModal
      :open="imageOpen"
      :title="t('插入图片', 'Insert image')"
      :description="t('可填图片网址、EPUB 内相对路径，或从本地选择图片（会以 data:image 形式嵌入）。', 'Enter an image URL, a relative path inside the EPUB, or choose a local image (embedded as data:image).')"
      size="sm"
      @close="imageOpen = false"
    >
      <div class="dialog-form">
        <UiField :label="t('图片地址', 'Image URL')" input-id="epub-image-url" :error="imageError">
          <UiInput
            id="epub-image-url"
            :model-value="imageUrl"
            :placeholder="t('https://… 或 images/cover.jpg', 'https://… or images/cover.jpg')"
            autofocus
            @update:model-value="setImageUrl"
            @keydown.enter.prevent="applyImage"
          />
        </UiField>
        <div class="dialog-form__row">
          <UiButton variant="secondary" size="sm" icon="photo-add" @click="imageInput?.click()">
            {{ t("选择本地图片", "Choose local image") }}
          </UiButton>
          <span class="hint">≤ 5 MB</span>
        </div>
        <input
          ref="imageInput"
          class="sr-only"
          type="file"
          accept="image/*"
          tabindex="-1"
          aria-hidden="true"
          @change="onImageFile"
        />
      </div>
      <template #footer>
        <UiButton variant="ghost" @click="imageOpen = false">{{ t("取消", "Cancel") }}</UiButton>
        <UiButton variant="primary" @click="applyImage">{{ t("插入", "Insert") }}</UiButton>
      </template>
    </UiModal>
  </section>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background-color: var(--color-surface);
}

.editor__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
  flex: none;
  padding: var(--space-4) var(--space-6) var(--space-3);
  border-bottom: 1px solid var(--color-border-subtle);
}

.editor__heading {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  flex: 1 1 240px;
}

.editor__index {
  flex: none;
  font-size: var(--text-2xs);
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.editor__index-sep {
  opacity: 0.6;
}

.editor__title-wrap {
  min-width: 0;
  flex: 1 1 auto;
}

.editor__title {
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

.editor__title-input {
  height: 34px;
  font-size: var(--text-md);
  font-weight: var(--weight-medium);
}

.editor__actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: wrap;
}

.editor__nav {
  display: flex;
  gap: 2px;
  margin-left: var(--space-1);
  padding-left: var(--space-2);
  border-left: 1px solid var(--color-border);
}

.editor__nav-btn {
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

.editor__nav-btn:hover:not(:disabled) {
  color: var(--color-text);
  background-color: var(--color-surface-active);
}

.editor__nav-btn:disabled {
  color: var(--color-text-muted);
  opacity: 0.45;
  cursor: not-allowed;
}

.editor__strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
  flex: none;
  padding: var(--space-2) var(--space-6);
  font-size: var(--text-2xs);
  color: var(--color-text-muted);
  background-color: var(--color-bg-sunken);
  border-bottom: 1px solid var(--color-border-subtle);
}

.editor__strip > * {
  flex: none;
}

.editor__strip .spacer {
  flex: 1 1 auto;
  min-width: var(--space-2);
}

.editor__strip-meta {
  color: var(--color-text-secondary);
}

.editor__strip-sep {
  opacity: 0.6;
}

.editor__controls {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-left: auto;
}

.editor__fontsize {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
  padding: 1px 2px;
  background-color: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.editor__fontsize-label {
  padding: 0 4px;
  font-size: var(--text-2xs);
  color: var(--color-text-muted);
}

.editor__fontsize-btn {
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

.editor__fontsize-btn:hover:not(:disabled) {
  color: var(--color-text);
  background-color: var(--color-surface-active);
}

.editor__fontsize-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.editor__fontsize-value {
  min-width: 28px;
  text-align: center;
  font-size: var(--text-2xs);
  color: var(--color-text-secondary);
}

.editor__toolbar-toggle {
  display: grid;
  place-items: center;
  flex: none;
  width: 26px;
  height: 22px;
  color: var(--color-text-muted);
  border-radius: 3px;
}

.editor__toolbar-toggle:hover {
  color: var(--color-text);
  background-color: var(--color-surface-active);
}

.editor__strip-edited,
.editor__strip-saved {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  font-size: var(--text-2xs);
  border-radius: var(--radius-full);
}

.editor__strip-edited {
  color: var(--color-warning);
  background-color: var(--color-warning-soft);
}

.editor__strip-saved {
  color: var(--color-success);
  background-color: var(--color-success-soft);
}

.editor__workspace {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

/* —— 工具栏：Quill 只负责注入图标，容器与间距由墨匣控制 —— */
.editor .editor__toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: wrap;
  flex: none;
  padding: var(--space-1) var(--space-2);
  background-color: var(--color-bg-sunken);
  border: 0;
  border-bottom: 1px solid var(--color-border-subtle);
}

.editor__group {
  display: inline-flex;
  align-items: center;
  gap: 1px;
}

.editor__tool-sep {
  width: 1px;
  height: 18px;
  margin: 0 var(--space-1);
  background-color: var(--color-border);
}

.editor__toolbar .editor__tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 4px;
  color: var(--color-text-secondary);
  border-radius: 4px;
  transition:
    color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.editor__toolbar .editor__tool:hover {
  color: var(--color-text);
  background-color: var(--color-surface);
}

.editor__toolbar .editor__tool.ql-active,
.editor__toolbar .editor__tool.ql-active:hover {
  color: var(--color-primary-text);
  background-color: var(--color-primary-soft);
}

/* Quill 注入的是无 scoped 属性的 SVG，需要 :deep 才能着色。
   额外加 .editor 前缀，确保压过 quill.snow.css 里的 hover / active 蓝色。 */
.editor .editor__toolbar :deep(.ql-stroke) {
  stroke: currentColor;
}

.editor .editor__toolbar :deep(.ql-fill) {
  fill: currentColor;
}

.editor .editor__toolbar :deep(button:hover .ql-stroke),
.editor .editor__toolbar :deep(button.ql-active .ql-stroke) {
  stroke: currentColor;
}

.editor .editor__toolbar :deep(button:hover .ql-fill),
.editor .editor__toolbar :deep(button.ql-active .ql-fill) {
  fill: currentColor;
}

/* —— 编辑区：纸面 + 衬线 + 与 ChapterViewer 一致的行高与首行缩进 —— */
.editor__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  background-color: var(--color-surface);
}

.editor__workspace .editor__quill {
  height: 100%;
  background-color: var(--color-surface);
}

.editor__workspace :deep(.ql-container.ql-snow) {
  height: 100%;
  font-family: var(--font-serif);
  font-size: var(--text-md);
  border: 0;
}

.editor__workspace :deep(.ql-editor) {
  height: 100%;
  overflow-y: auto;
  /* 自适应宽度：正文随编辑器可用宽度伸展，收起侧栏后不再只显示中间窄窄一列 */
  padding: var(--space-6) clamp(var(--space-5), 5vw, var(--space-12)) var(--space-12);
  color: var(--color-text);
  caret-color: var(--color-primary);
  font-family: var(--font-serif);
  font-size: var(--epub-editor-font-size, var(--text-md));
  line-height: var(--leading-relaxed);
  text-align: justify;
  word-break: break-word;
}

/* 编辑字号通过 .editor 上的 --epub-editor-font-size 控制，仅影响界面预览，不写入导出 EPUB。 */
.editor__workspace :deep(.ql-editor:focus) {
  outline: none;
}

.editor__workspace :deep(.ql-editor:focus-visible) {
  outline: 2px solid var(--color-focus);
  outline-offset: -2px;
}

.editor__workspace :deep(.ql-editor p) {
  min-height: 1em;
  text-indent: 2em;
}

.editor__workspace :deep(.ql-editor h1),
.editor__workspace :deep(.ql-editor h2),
.editor__workspace :deep(.ql-editor h3),
.editor__workspace :deep(.ql-editor blockquote),
.editor__workspace :deep(.ql-editor ol),
.editor__workspace :deep(.ql-editor ul),
.editor__workspace :deep(.ql-editor li) {
  text-indent: 0;
}

.editor__workspace :deep(.ql-editor h1) {
  margin: 0.8em 0 0.4em;
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
  letter-spacing: 0.04em;
}

.editor__workspace :deep(.ql-editor h2) {
  margin: 0.8em 0 0.4em;
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
  letter-spacing: 0.03em;
}

.editor__workspace :deep(.ql-editor h3) {
  margin: 0.8em 0 0.4em;
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
}

.editor__workspace :deep(.ql-editor blockquote) {
  margin: var(--space-3) 0;
  padding: var(--space-2) var(--space-4);
  color: var(--color-text-secondary);
  background-color: var(--color-bg-sunken);
  border-left: 3px solid var(--color-primary);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}

.editor__workspace :deep(.ql-editor ol) {
  padding-left: 1.8em;
  list-style: decimal;
}

.editor__workspace :deep(.ql-editor ul) {
  padding-left: 1.8em;
  list-style: disc;
}

.editor__workspace :deep(.ql-editor li) {
  padding-left: 0.2em;
}

.editor__workspace :deep(.ql-editor a) {
  color: var(--color-primary-text);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.editor__workspace :deep(.ql-editor img) {
  max-width: 100%;
  height: auto;
  border-radius: var(--radius-sm);
}

.editor__workspace :deep(.ql-editor.ql-blank::before) {
  left: clamp(var(--space-5), 5vw, var(--space-12));
  right: clamp(var(--space-5), 5vw, var(--space-12));
  color: var(--color-text-muted);
  font-style: normal;
}

/* 链接编辑浮层（Quill tooltip）也跟着墨匣配色 */
.editor__workspace :deep(.ql-tooltip) {
  color: var(--color-text);
  background-color: var(--color-bg-elevated);
  border-color: var(--color-border-strong);
  box-shadow: var(--shadow-md);
}

.editor__workspace :deep(.ql-tooltip input[type="text"]) {
  color: var(--color-text);
  background-color: var(--color-surface);
  border-color: var(--color-control-border);
}

.dialog-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.dialog-form__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.editor__empty {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

@media (max-width: 1100px) {
  .editor__head {
    padding: var(--space-3) var(--space-5) var(--space-2);
  }

  .editor__strip {
    padding: var(--space-2) var(--space-5);
  }

  .editor__workspace :deep(.ql-editor) {
    padding: var(--space-5) var(--space-5) var(--space-10);
  }

  .editor__workspace :deep(.ql-editor.ql-blank::before) {
    left: var(--space-5);
    right: var(--space-5);
  }
}

@media (max-width: 1180px) {
  .editor,
  .editor__body {
    height: auto;
    min-height: 0;
    overflow: visible;
  }

  .editor__workspace {
    min-height: 420px;
  }
}
</style>