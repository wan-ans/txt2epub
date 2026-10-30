<script setup lang="ts">
/**
 * 墨匣 · 应用外壳。
 * 职责：视图路由（转换 / 批量 / 规则 / 设置）、全局拖拽导入、主题初始化、
 * 键盘快捷键、Toast 容器与确认对话框。业务状态全部在 useWorkspace 里。
 */
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from "vue";
import AppTitleBar from "./components/layout/AppTitleBar.vue";
import AppNav from "./components/layout/AppNav.vue";
import type { ViewKey } from "./components/layout/AppNav.vue";
import ConvertView from "./components/panels/ConvertView.vue";
import UiToast from "./components/ui/UiToast.vue";
import UiModal from "./components/ui/UiModal.vue";
import UiButton from "./components/ui/UiButton.vue";
import { initTheme } from "./components/composables/useTheme";
import { useToast } from "./components/composables/useToast";
import { useWorkspace } from "./components/composables/useWorkspace";
import { useEpubWorkspace } from "./components/composables/useEpubWorkspace";
import { useUiLanguage } from "./components/composables/useUiLanguage";
import { desktop } from "./bridge";
import type { BookMeta, Cover, EncodingChoice, Language, TypesettingOptions } from "./components/engine/core";

/** 非首屏视图按需加载：EPUB 编辑器带着 Quill（约 200KB+），批量/规则/设置也只有切过去才需要。 */
const EpubView = defineAsyncComponent(() => import("./components/epub/EpubView.vue"));
const BatchPanel = defineAsyncComponent(() => import("./components/panels/BatchPanel.vue"));
const RulePanel = defineAsyncComponent(() => import("./components/panels/RulePanel.vue"));
const SettingsPanel = defineAsyncComponent(() => import("./components/panels/SettingsPanel.vue"));

const ws = useWorkspace();
const epubWs = useEpubWorkspace();
const toast = useToast();
const { t } = useUiLanguage();
const { state } = ws;
const epubState = epubWs.state;

/* ============================================================
   视图
   ============================================================ */

const view = ref<ViewKey>("convert");
/**
 * 三处「收起」互相独立，各自有按钮，互不联动：
 *   navCollapsed       左侧主导航（单本转换/批量/规则/设置）
 *   chapterListCollapsed 单本转换里的章节列表
 *   asideCollapsed     单本转换右侧的设置面板（书籍信息/排版/封面）
 */
const navCollapsed = ref(false);
const chapterListCollapsed = ref(false);
const asideCollapsed = ref(false);
const dragging = ref(false);
/** 鼠标正把文件拖到章节区上方：此时全局「换一本」遮罩要让位给局部「追加章节」提示 */
const chapterDropActive = ref(false);

const fileInput = ref<HTMLInputElement | null>(null);
const resetOpen = ref(false);
const reparseOpen = ref(false);
const epubResetOpen = ref(false);

/** 有文件时批量/规则视图才有意义，导航徽标用得上 */
const chapterCount = computed(() => state.chapters.length);
const epubChapterCount = computed(() => epubState.chapters.length);

/** 标题栏显示当前视图对应的文件与章节数 */
const activeFileName = computed(() => (view.value === "epub" ? epubState.sourceName : state.sourceName));
const activeChapterCount = computed(() => (view.value === "epub" ? epubChapterCount.value : chapterCount.value));
const activeHasFile = computed(() => Boolean(activeFileName.value));

/* ============================================================
   导入
   ============================================================ */

function pickFiles() {
  fileInput.value?.click();
}

async function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await ws.importBytes({ name: file.name, bytes });
    view.value = "convert";
    navCollapsed.value = true;
    asideCollapsed.value = true;
  } catch (error) {
    toast.error(t("读取文件失败", "Failed to read file"), {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function pickFolder() {
  const bridge = desktop();
  if (!bridge) {
    pickFiles();
    return;
  }
  try {
    const files = await bridge.openTxtFolder();
    if (!files.length) {
      toast.warning(t("这个文件夹里没有 TXT 文件", "No TXT files in this folder"));
      return;
    }
    if (files.length === 1) {
      await ws.importBytes(files[0]);
      view.value = "convert";
      navCollapsed.value = true;
      asideCollapsed.value = true;
      return;
    }
    // 多个文件：导入第一个，其余提示去批量
    await ws.importBytes(files[0]);
    view.value = "convert";
    navCollapsed.value = true;
    asideCollapsed.value = true;
    toast.info(t(`文件夹里有 ${files.length} 个 TXT，先打开了第一个`, `Found ${files.length} TXT files; opened the first one`), {
      detail: t("要一次全转换，请到「批量转换」", 'To convert them all, use "Batch convert"'),
      timeout: 6000,
    });
  } catch (error) {
    toast.error(t("打开文件夹失败", "Failed to open folder"), {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/* ============================================================
   全局拖拽：整个窗口任意位置都能放
   ============================================================ */

let dragDepth = 0;

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/** 事件是否源自章节区的「追加章节」拖放区（那里自己处理，不该触发整窗换书） */
function fromChapterZone(event: Event): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (view.value === "convert") return Boolean(target.closest(".append, .chapters__scroll"));
  if (view.value === "epub") return Boolean(target.closest(".epub-chapters"));
  return false;
}

function onDragEnter(event: DragEvent) {
  if (!hasFiles(event)) return;
  // 章节区内部追加章节的拖拽由 ChapterList 自己处理，不显示「换一本」遮罩
  if (fromChapterZone(event)) return;
  dragDepth += 1;
  dragging.value = true;
}

function onDragOver(event: DragEvent) {
  if (!hasFiles(event)) return;
  // 必须阻止默认行为，否则浏览器会直接打开文件
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function onDragLeave(event: DragEvent) {
  if (!hasFiles(event)) return;
  if (fromChapterZone(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragging.value = false;
}

async function onDrop(event: DragEvent) {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  dragging.value = false;

  // 章节区自己已处理并阻止冒泡；兜底再挡一次，避免同一个文件既被追加又被当成新书
  if (fromChapterZone(event)) return;

  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  if (!/\.(txt|text)$/i.test(file.name) && file.type !== "text/plain") {
    toast.warning(t("只能导入 TXT 文件", "Only TXT files can be imported"), { detail: file.name });
    return;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await ws.importBytes({ name: file.name, bytes });
    view.value = "convert";
    navCollapsed.value = true;
    asideCollapsed.value = true;
  } catch (error) {
    toast.error(t("读取文件失败", "Failed to read file"), {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/* ============================================================
   事件桥接
   ============================================================ */

function onToggleNav() {
  navCollapsed.value = !navCollapsed.value;
}

function onToggleChapterList() {
  chapterListCollapsed.value = !chapterListCollapsed.value;
}

function onToggleAside() {
  asideCollapsed.value = !asideCollapsed.value;
}

/**
 * 退出当前这本书的转换界面，回到空状态以便换一本。
 * 有未导出的改动时先确认，避免误触丢失整理结果。
 */
function onExitBook() {
  if (view.value === "epub") {
    if (!epubState.chapters.length) {
      epubWs.reset();
      return;
    }
    if (epubWs.dirty.value) {
      epubResetOpen.value = true;
      return;
    }
    epubWs.reset();
    return;
  }
  if (!state.chapters.length) {
    ws.reset();
    view.value = "convert";
    return;
  }
  resetOpen.value = true;
}

function onEpubOpened() {
  // 打开 EPUB 后默认收起主导航，把画面留给章节与正文
  navCollapsed.value = true;
}

async function onChangeEncoding(value: EncodingChoice) {
  await ws.reimportWithEncoding(value);
}

function onReparse() {
  // 重新解析会按原文重切章节，手动改过的标题与正文都会丢失 —— 先确认
  if (ws.dirtyChapterEdits.value) {
    reparseOpen.value = true;
    return;
  }
  ws.reparse();
}

function onRenameChapter(payload: { id: string; title: string }) {
  ws.renameChapterTitle(payload.id, payload.title);
}

function onUpdateChapterBody(payload: { id: string; lines: string[] }) {
  ws.updateChapterBody(payload.id, payload.lines);
}

function onMergeChapter(id: string) {
  ws.mergeChapterWithPrevious(id);
}

/** 追加 TXT 为新章节（章节区拖入或点「打开文件」触发） */
async function onAppendFiles(files: { name: string; bytes: Uint8Array }[]) {
  if (!files.length) return;
  await ws.appendFiles(files);
}

function onUpdateMeta(patch: Partial<BookMeta>) {
  ws.updateMeta(patch);
}

async function onSetLanguage(value: Language) {
  await ws.setLanguage(value);
}

function onSelectCover(payload: { cover: Cover; previewUrl: string }) {
  ws.setCover(payload.cover, payload.previewUrl);
}

function onClearCover() {
  ws.clearCover();
}

function onUpdateTypesetting(patch: Partial<TypesettingOptions>) {
  ws.updateTypesetting(patch);
}

function onResetTypesetting() {
  ws.resetTypesetting();
}

function onExport() {
  void ws.exportEpub();
}

async function onReveal() {
  const bridge = desktop();
  if (bridge && state.lastExportPath) {
    await bridge.revealInExplorer(state.lastExportPath);
  }
}

function requestReset() {
  if (!state.chapters.length) {
    ws.reset();
    return;
  }
  resetOpen.value = true;
}

function confirmReset() {
  resetOpen.value = false;
  ws.reset();
  view.value = "convert";
  toast.info(t("工作区已清空", "Workspace cleared"));
}

function confirmEpubReset() {
  epubResetOpen.value = false;
  epubWs.reset();
  view.value = "epub";
  toast.info(t("已退出这本 EPUB", "Left this EPUB"));
}

function confirmReparse() {
  reparseOpen.value = false;
  ws.reparse();
}

/* ============================================================
   键盘快捷键
   ============================================================ */

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function onKeydown(event: KeyboardEvent) {
  const mod = event.ctrlKey || event.metaKey;

  // Ctrl/Cmd + O：打开 TXT 文件
  if (mod && event.key.toLowerCase() === "o") {
    event.preventDefault();
    pickFiles();
    return;
  }

  // Ctrl/Cmd + S：按当前视图导出（阻止浏览器另存网页）
  if (mod && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (view.value === "epub") {
      if (epubState.chapters.length && !epubState.exporting) void epubWs.exportEpub();
    } else if (state.chapters.length && !state.exporting) {
      onExport();
    }
    return;
  }

  // Ctrl/Cmd + Shift + B：折叠章节列表（放在 Ctrl+B 之前，否则会被前者吞掉）
  if (mod && event.shiftKey && event.key.toLowerCase() === "b") {
    event.preventDefault();
    onToggleChapterList();
    return;
  }

  // Ctrl/Cmd + B：折叠左侧主导航
  if (mod && event.key.toLowerCase() === "b") {
    event.preventDefault();
    onToggleNav();
    return;
  }

  if (isTypingTarget(event.target)) return;

  // [ / ]：上一章 / 下一章
  if (event.key === "[" || event.key === "]") {
    const index = state.chapters.findIndex((chapter) => chapter.id === state.selectedChapterId);
    if (index < 0) return;
    const next = event.key === "[" ? index - 1 : index + 1;
    if (next >= 0 && next < state.chapters.length) {
      event.preventDefault();
      ws.selectChapter(state.chapters[next].id);
    }
  }
}

/* ============================================================
   生命周期
   ============================================================ */

onMounted(() => {
  initTheme();
  ws.initRules();
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
});

/** 切到批量视图时，把当前规则带过去由 BatchPanel 自行读取 */
const rules = computed(() => ws.rules.value);
const defaultEncoding = computed<EncodingChoice>(() => state.encodingChoice);
</script>

<template>
  <div
    class="app"
    :class="{ 'app--dragging': dragging }"
    @dragenter.prevent="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <AppTitleBar
      :file-name="activeFileName"
      :chapter-count="activeChapterCount"
      :has-file="activeHasFile"
      :nav-collapsed="navCollapsed"
      :show-chapter-count="view === 'convert' || view === 'epub'"
      @toggle-nav="onToggleNav"
      @exit-book="onExitBook"
    />

    <div class="app__body">
      <AppNav
        :model-value="view"
        :collapsed="navCollapsed"
        :chapter-count="chapterCount"
        @update:model-value="(next) => (view = next)"
        @expand="navCollapsed = false"
      />

      <main class="app__view" :class="`app__view--${view}`">
        <ConvertView
          v-if="view === 'convert'"
          :phase="state.phase"
          :busy-label="state.busyLabel"
          :error-message="state.errorMessage"
          :dragging="dragging"
          :source-name="state.sourceName"
          :chapters="state.chapters"
          :selected-chapter-id="state.selectedChapterId"
          :selected-chapter="ws.selectedChapter.value"
          :selected-index="ws.selectedIndex.value"
          :chapter-stats="ws.chapterStats.value"
          :total-words="ws.totalWords.value"
          :parse-ms="state.parseMs"
          :source-bytes="ws.totalSourceBytes.value"
          :read="state.read"
          :encoding-choice="state.encodingChoice"
          :meta="state.meta"
          :cover="state.cover"
          :cover-preview-url="state.coverPreviewUrl"
          :typesetting="state.typesetting"
          :exporting="state.exporting"
          :last-export-path="state.lastExportPath"
          :chapter-list-collapsed="chapterListCollapsed"
          :aside-collapsed="asideCollapsed"
          :append-count="ws.appendSourceCount.value"
          @pick-files="pickFiles"
          @pick-folder="pickFolder"
          @change-encoding="onChangeEncoding"
          @select-chapter="(id) => ws.selectChapter(id)"
          @rename-chapter="onRenameChapter"
          @merge-chapter="onMergeChapter"
          @update-chapter-body="onUpdateChapterBody"
          @reparse="onReparse"
          @update-meta="onUpdateMeta"
          @set-language="onSetLanguage"
          @select-cover="onSelectCover"
          @clear-cover="onClearCover"
          @update-typesetting="onUpdateTypesetting"
          @reset-typesetting="onResetTypesetting"
          @export="onExport"
          @reveal="onReveal"
          @reset="requestReset"
          @toggle-chapter-list="onToggleChapterList"
          @toggle-aside="onToggleAside"
          @append-files="onAppendFiles"
          @chapter-drag="(active) => (chapterDropActive = active)"
        />

        <EpubView v-else-if="view === 'epub'" @opened="onEpubOpened" />

        <BatchPanel
          v-else-if="view === 'batch'"
          :rules="rules"
          :language="state.meta.language"
          :default-encoding="defaultEncoding"
          :typesetting-indent="state.typesetting.indent"
        />

        <SettingsPanel v-else-if="view === 'settings'" />

        <RulePanel
          v-else-if="view === 'rules'"
          :rules="rules"
          :raw-lines="state.rawLines"
          :has-source="state.rawLines.length > 0"
          @update:rules="(next) => ws.persistRules(next)"
          @reparse="onReparse"
        />

      </main>
    </div>

    <!-- 整窗拖拽遮罩 -->
    <Transition name="fade">
      <div v-if="dragging && !chapterDropActive && state.phase !== 'empty'" class="dropveil" aria-hidden="true">
        <div class="dropveil__card">
          <span class="dropveil__glyph">匣</span>
          <p class="dropveil__title serif">{{ t("松手，换一本", "Drop to open another book") }}</p>
          <p class="dropveil__desc">{{ t("会把当前工作区替换成新文件", "Replaces the current workspace with the new file") }}</p>
        </div>
      </div>
    </Transition>

    <input
      ref="fileInput"
      class="sr-only"
      type="file"
      accept=".txt,text/plain"
      tabindex="-1"
      aria-hidden="true"
      @change="onFilePicked"
    />

    <UiModal
      :open="resetOpen"
      :title="t('清空当前工作区？', 'Clear the current workspace?')"
      :description="t('已解析的章节、改过的标题、封面与排版设置都会丢失，原始 TXT 文件不受影响。', 'Parsed chapters, edited titles, cover and typesetting settings will be lost. The original TXT file is unaffected.')"
      icon="exclamation-triangle"
      size="sm"
      @close="resetOpen = false"
    >
      <template #footer>
        <UiButton variant="ghost" @click="resetOpen = false">{{ t("取消", "Cancel") }}</UiButton>
        <UiButton variant="danger" data-autofocus @click="confirmReset">{{ t("清空工作区", "Clear workspace") }}</UiButton>
      </template>
    </UiModal>

    <UiModal
      :open="reparseOpen"
      :title="t('重新解析会丢掉正文修改', 'Reparsing will discard body edits')"
      :description="t('你改过章节标题或正文。重新解析会按原始 TXT 重新切分，这些修改都会丢失，且无法撤销。', 'You have edited chapter titles or body text. Reparsing will split the original TXT again; those edits will be lost and cannot be undone.')"
      icon="exclamation-triangle"
      size="sm"
      @close="reparseOpen = false"
    >
      <template #footer>
        <UiButton variant="ghost" @click="reparseOpen = false">{{ t("取消", "Cancel") }}</UiButton>
        <UiButton variant="danger" data-autofocus @click="confirmReparse">{{ t("仍然重新解析", "Reparse anyway") }}</UiButton>
      </template>
    </UiModal>

    <UiModal
      :open="epubResetOpen"
      :title="t('退出这本 EPUB？', 'Leave this EPUB?')"
      :description="t('章节标题、正文修改、书籍信息与封面改动都还没有导出，退出后会丢失。原 EPUB 文件不受影响。', 'Chapter titles, body edits, book info and cover changes have not been exported and will be lost. The original EPUB file is unaffected.')"
      icon="exclamation-triangle"
      size="sm"
      @close="epubResetOpen = false"
    >
      <template #footer>
        <UiButton variant="ghost" @click="epubResetOpen = false">{{ t("继续编辑", "Keep editing") }}</UiButton>
        <UiButton variant="danger" data-autofocus @click="confirmEpubReset">{{ t("放弃修改并退出", "Discard changes and leave") }}</UiButton>
      </template>
    </UiModal>

    <UiToast
      :items="[...toast.items.value]"
      :raised="(view === 'convert' && state.phase === 'ready') || (view === 'epub' && epubState.phase === 'ready')"
      @dismiss="toast.dismiss"
    />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background-color: var(--color-bg);
}

.app__body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}

.app__view {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/* 只有转换视图做内部滚动，其它视图整页滚 */
.app__view--batch,
.app__view--rules,
.app__view--settings {
  overflow-y: auto;
}

/* 整窗拖拽遮罩 */
.dropveil {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  display: grid;
  place-items: center;
  background-color: var(--color-overlay);
  pointer-events: none;
}

.dropveil__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-8) var(--space-12);
  text-align: center;
  background-color: var(--color-bg-elevated);
  border: 1px dashed var(--color-primary);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}

.dropveil__glyph {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin-bottom: var(--space-2);
  font-family: var(--font-serif);
  font-size: 24px;
  font-weight: var(--weight-bold);
  color: var(--color-primary-contrast);
  background-color: var(--color-primary);
  border-radius: var(--radius-sm);
}

.dropveil__title {
  font-size: var(--text-lg);
  letter-spacing: 0.08em;
  color: var(--color-text);
}

.dropveil__desc {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
</style>