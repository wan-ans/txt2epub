<script setup lang="ts">
import { computed, ref } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiIcon from "../icons/UiIcon.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import DropZone from "./DropZone.vue";
import EncodingBar from "./EncodingBar.vue";
import ChapterList from "./ChapterList.vue";
import ChapterViewer from "./ChapterViewer.vue";
import MetaForm from "./MetaForm.vue";
import CoverPanel from "./CoverPanel.vue";
import TypesettingPanel from "./TypesettingPanel.vue";
import ExportBar from "./ExportBar.vue";
import { useUiLanguage } from "../composables/useUiLanguage";
import type {
  BookMeta,
  Chapter,
  Cover,
  EncodingChoice,
  Language,
  ReadResult,
  TypesettingOptions,
} from "../engine/core";

const { t } = useUiLanguage();

/**
 * 单本转换视图：左侧章节树 + 右侧「元信息 / 排版 / 预览」分段卡片。
 * 空状态与加载态也在这里切换，保证 App.vue 只负责外壳。
 */
const props = defineProps<{
  phase: "empty" | "loading" | "ready" | "error";
  busyLabel: string;
  errorMessage: string;
  dragging: boolean;

  sourceName: string;
  chapters: Chapter[];
  selectedChapterId: string | null;
  selectedChapter: Chapter | null;
  selectedIndex: number;
  chapterStats: Map<string, number>;
  totalWords: number;
  parseMs: number;
  sourceBytes: number;

  read: ReadResult | null;
  encodingChoice: EncodingChoice;

  meta: BookMeta;
  cover: Cover | null;
  coverPreviewUrl: string | null;
  typesetting: TypesettingOptions;

  exporting: boolean;
  lastExportPath: string | null;
  /** 章节列表是否收起（与主导航独立） */
  chapterListCollapsed: boolean;
  /** 右侧设置面板是否收起 */
  asideCollapsed: boolean;
  /** 追加的来源文件数 */
  appendCount: number;
}>();

const emit = defineEmits<{
  pickFiles: [];
  pickFolder: [];
  changeEncoding: [value: EncodingChoice];
  selectChapter: [id: string];
  renameChapter: [payload: { id: string; title: string }];
  mergeChapter: [id: string];
  /** 编辑章节正文（删减文字） */
  updateChapterBody: [payload: { id: string; lines: string[] }];
  reparse: [];
  updateMeta: [patch: Partial<BookMeta>];
  setLanguage: [value: Language];
  selectCover: [payload: { cover: Cover; previewUrl: string }];
  clearCover: [];
  updateTypesetting: [patch: Partial<TypesettingOptions>];
  resetTypesetting: [];
  export: [];
  reveal: [];
  reset: [];
  toggleChapterList: [];
  toggleAside: [];
  /** 追加 TXT 为新章节 */
  appendFiles: [files: { name: string; bytes: Uint8Array }[]];
  /** 章节区开始/结束接拖拽 */
  chapterDrag: [active: boolean];
}>();

type TabKey = "meta" | "typeset" | "cover";

const tab = ref<TabKey>("meta");
const rootRef = ref<HTMLElement | null>(null);
const saveFabActive = ref(false);

function onPointerMove(event: PointerEvent): void {
  const root = rootRef.value;
  if (!root) return;
  const rect = root.getBoundingClientRect();
  saveFabActive.value = rect.right - event.clientX < 220 && rect.bottom - event.clientY < 150;
}

function onPointerLeave(): void {
  saveFabActive.value = false;
}

const tabs = computed<{ key: TabKey; label: string; icon: "book-open" | "type-t" | "photo" }[]>(() => [
  { key: "meta", label: t("书籍信息", "Book info"), icon: "book-open" },
  { key: "typeset", label: t("排版", "Typesetting"), icon: "type-t" },
  { key: "cover", label: t("封面", "Cover"), icon: "photo" },
]);

const sourceBytes = computed(() => props.sourceBytes);

/** 从工具栏的点按入口打开某个设置分区（必要时同时展开面板） */
function openAsideTab(key: TabKey) {
  tab.value = key;
  if (props.asideCollapsed) emit("toggleAside");
}

function formatBytes(bytes: number): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 预览样张：优先取当前章节前几行，否则第一章 */
const sampleLines = computed(() => {
  const chapter = props.selectedChapter ?? props.chapters[0];
  return chapter ? chapter.lines.slice(0, 20) : [];
});

const sampleTitle = computed(() => props.selectedChapter?.title ?? props.chapters[0]?.title ?? "");

function goPrev() {
  const index = props.selectedIndex;
  if (index > 0) emit("selectChapter", props.chapters[index - 1].id);
}

function goNext() {
  const index = props.selectedIndex;
  if (index >= 0 && index < props.chapters.length - 1) {
    emit("selectChapter", props.chapters[index + 1].id);
  }
}
</script>

<template>
  <!-- 空状态：整窗拖拽引导 -->
  <DropZone
    v-if="phase === 'empty'"
    :dragging="dragging"
    @pick-files="emit('pickFiles')"
    @pick-folder="emit('pickFolder')"
  />

  <!-- 加载态 -->
  <div v-else-if="phase === 'loading'" class="loading">
    <div class="loading__card">
      <span class="loading__spinner" aria-hidden="true" />
      <p class="loading__title serif">{{ busyLabel || t("正在准备…", "Preparing…") }}</p>
      <p class="loading__desc">{{ t("大文件需要几秒，编码检测与分章都在本地完成", "Large files may take a few seconds; encoding detection and chapter splitting are done locally.") }}</p>
    </div>
    <div class="loading__skeleton card">
      <UiSkeleton :lines="2" :height="14" last-width="40%" />
      <hr class="divider" />
      <UiSkeleton :lines="6" :height="10" last-width="70%" />
    </div>
  </div>

  <!-- 错误态 -->
  <div v-else-if="phase === 'error'" class="errorstate">
    <span class="errorstate__icon">
      <UiIcon name="exclamation-triangle" :size="26" />
    </span>
    <h2 class="errorstate__title serif">{{ t("这本没读进来", "Couldn't read this book") }}</h2>
    <p class="errorstate__message">{{ errorMessage }}</p>
    <div class="errorstate__actions">
      <UiButton variant="primary" icon="arrow-up-tray" @click="emit('pickFiles')">{{ t("换个文件", "Choose another file") }}</UiButton>
      <UiButton variant="ghost" icon="arrow-path" @click="emit('reset')">{{ t("回到开始", "Back to start") }}</UiButton>
    </div>
  </div>

  <!-- 就绪态 -->
  <div v-else ref="rootRef" class="convert" @pointermove="onPointerMove" @pointerleave="onPointerLeave">
    <ChapterList
      :chapters="chapters"
      :selected-id="selectedChapterId"
      :stats="chapterStats"
      :collapsed="chapterListCollapsed"
      :busy="exporting"
      @select="(id) => emit('selectChapter', id)"
      @reparse="emit('reparse')"
      @collapse="emit('toggleChapterList')"
      @append-files="(files) => emit('appendFiles', files)"
      @dragging-change="(active) => emit('chapterDrag', active)"
    >
      <template #footer>
        <div class="convert__side-foot">
          <span class="tnum">{{ chapters.length }} {{ t("章", "chapters") }}</span>
          <span class="convert__dot" aria-hidden="true">·</span>
          <span class="tnum">{{ formatBytes(sourceBytes) }}</span>
          <span class="spacer" />
          <span class="muted tnum">{{ t("解析", "Parsed in") }} {{ parseMs }}ms</span>
        </div>
      </template>
    </ChapterList>

    <!-- 章节列表收起后的窄条：点它可以重新展开 -->
    <button
      v-if="chapterListCollapsed"
      type="button"
      class="convert__reopen"
      :aria-label="t('展开章节列表', 'Expand chapter list')"
      :title="t('展开章节列表（Ctrl+Shift+B）', 'Expand chapter list (Ctrl+Shift+B)')"
      @click="emit('toggleChapterList')"
    >
      <UiIcon name="chevron-double-right" :size="15" />
      <span class="convert__reopen-text">{{ t("章节", "Chapters") }} {{ chapters.length }}</span>
    </button>

    <div class="convert__main">
      <EncodingBar
        :read="read"
        :choice="encodingChoice"
        :busy="exporting"
        :file-name="sourceName"
        :file-size="formatBytes(sourceBytes)"
        @change="(value) => emit('changeEncoding', value)"
      />

      <div class="convert__body">
        <div class="convert__split" :class="{ 'convert__split--aside-off': asideCollapsed }">
          <ChapterViewer
            :chapter="selectedChapter"
            :word-count="selectedChapter ? (chapterStats.get(selectedChapter.id) ?? 0) : 0"
            :can-merge="selectedIndex > 0"
            :index="selectedIndex"
            :total="chapters.length"
            :typesetting="typesetting"
            @select-prev="goPrev"
            @select-next="goNext"
            @rename="(payload) => emit('renameChapter', payload)"
            @update-body="(payload) => emit('updateChapterBody', payload)"
            @update-typesetting="(patch) => emit('updateTypesetting', patch)"
            @merge-prev="selectedChapter && emit('mergeChapter', selectedChapter.id)"
          >
            <!--
              设置面板收起后，恢复入口放在工具栏最右侧（并入上一章 / 上下章箭头的后面），
              横向排列，不再占正文下方一条竖栏。
            -->
            <template #actions-extra>
              <div v-if="asideCollapsed" class="aside-restore" role="group" :aria-label="t('设置面板已收起', 'Settings panel collapsed')">
                <button
                  type="button"
                  class="aside-restore__toggle"
                  :aria-label="t('展开设置面板', 'Expand settings panel')"
                  :title="t('展开设置面板', 'Expand settings panel')"
                  @click="emit('toggleAside')"
                >
                  <UiIcon name="chevron-double-left" :size="14" />
                  <span class="aside-restore__label">{{ t("设置", "Settings") }}</span>
                </button>
                <span class="aside-restore__sep" aria-hidden="true" />
                <button
                  v-for="item in tabs"
                  :key="`restore-${item.key}`"
                  type="button"
                  class="aside-restore__tab"
                  :class="{ 'aside-restore__tab--on': tab === item.key }"
                  :aria-label="t(`展开并打开「${item.label}」`, `Expand and open “${item.label}”`)"
                  :title="item.label"
                  @click="openAsideTab(item.key)"
                >
                  <UiIcon :name="item.icon" :size="14" />
                </button>
              </div>
            </template>
          </ChapterViewer>

          <aside v-show="!asideCollapsed" class="convert__aside" :aria-label="t('导出设置', 'Export settings')">
            <div class="tabs" role="tablist" :aria-label="t('设置分区', 'Settings sections')">
              <button
                v-for="item in tabs"
                :key="item.key"
                type="button"
                role="tab"
                class="tab"
                :class="{ 'tab--on': tab === item.key }"
                :aria-selected="tab === item.key"
                :id="`tab-${item.key}`"
                :aria-controls="`panel-${item.key}`"
                @click="tab = item.key"
              >
                <UiIcon :name="item.icon" :size="14" />
                {{ item.label }}
              </button>
              <button
                type="button"
                class="tabs__collapse"
                :aria-label="t('收起设置面板', 'Collapse settings panel')"
                :title="t('收起设置面板', 'Collapse settings panel')"
                @click="emit('toggleAside')"
              >
                <UiIcon name="chevron-double-right" :size="14" />
              </button>
            </div>

            <div
              v-show="tab === 'meta'"
              :id="'panel-meta'"
              class="tabpanel"
              role="tabpanel"
              aria-labelledby="tab-meta"
              tabindex="0"
            >
              <MetaForm
                :meta="meta"
                @update="(patch) => emit('updateMeta', patch)"
                @set-language="(value) => emit('setLanguage', value)"
              />
            </div>

            <div
              v-show="tab === 'typeset'"
              :id="'panel-typeset'"
              class="tabpanel"
              role="tabpanel"
              aria-labelledby="tab-typeset"
              tabindex="0"
            >
              <TypesettingPanel
                :options="typesetting"
                :sample-lines="sampleLines"
                :sample-title="sampleTitle"
                @update="(patch) => emit('updateTypesetting', patch)"
                @reset="emit('resetTypesetting')"
              />
            </div>

            <div
              v-show="tab === 'cover'"
              :id="'panel-cover'"
              class="tabpanel"
              role="tabpanel"
              aria-labelledby="tab-cover"
              tabindex="0"
            >
              <CoverPanel
                :cover="cover"
                :preview-url="coverPreviewUrl"
                @select="(payload) => emit('selectCover', payload)"
                @clear="emit('clearCover')"
              />
            </div>
          </aside>
        </div>
      </div>

      <ExportBar
        :chapter-count="chapters.length"
        :word-count="totalWords"
        :source-bytes="sourceBytes"
        :has-cover="Boolean(cover)"
        :last-export-path="lastExportPath"
        :append-count="appendCount"
        @reveal="emit('reveal')"
      />

      <button
        type="button"
        class="convert-fab"
        :class="{ 'convert-fab--on': saveFabActive || exporting }"
        :disabled="exporting || !chapters.length"
        :aria-label="exporting ? t('正在生成 EPUB', 'Generating EPUB') : t('生成 EPUB', 'Generate EPUB')"
        :title="exporting ? t('正在生成 EPUB', 'Generating EPUB') : t('生成 EPUB', 'Generate EPUB')"
        @click="emit('export')"
        @mouseenter="saveFabActive = true"
        @mouseleave="saveFabActive = false"
        @focus="saveFabActive = true"
        @blur="saveFabActive = false"
      >
        <UiIcon :name="exporting ? 'spinner' : 'archive'" :size="18" />
        <span class="convert-fab__label">{{ exporting ? t("正在生成…", "Generating…") : t("生成 EPUB", "Generate EPUB") }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* —— 加载态 —— */
.loading {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  width: min(100%, 720px);
  margin: 0 auto;
  padding: var(--space-16) var(--space-6);
}

.loading__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-8);
  text-align: center;
}

.loading__spinner {
  width: 22px;
  height: 22px;
  margin-bottom: var(--space-2);
  border: 2px solid var(--color-border-strong);
  border-top-color: var(--color-primary);
  border-radius: var(--radius-full);
  animation: ink-spin 720ms linear infinite;
}

.loading__title {
  font-size: var(--text-lg);
  letter-spacing: 0.06em;
  color: var(--color-text);
}

.loading__desc {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.loading__skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
}

/* —— 错误态 —— */
.errorstate {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  height: 100%;
  padding: var(--space-10) var(--space-6);
  text-align: center;
}

.errorstate__icon {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  color: var(--color-danger);
  background-color: var(--color-danger-soft);
  border-radius: var(--radius-md);
}

.errorstate__title {
  font-size: var(--text-lg);
  letter-spacing: 0.06em;
  color: var(--color-text);
}

.errorstate__message {
  max-width: 46ch;
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  color: var(--color-text-secondary);
}

.errorstate__actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

/* —— 就绪态 —— */
.convert {
  position: relative;
  display: flex;
  height: 100%;
  min-height: 0;
}

.convert__main {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

.convert__body {
  flex: 1 1 auto;
  min-height: 0;
  /* 桌面应用观感：外层不滚，滚动交给左右两块面板自己，
     避免出现「整页滚动条 + 面板滚动条」双重滚动。 */
  overflow: hidden;
  padding: var(--space-4) var(--space-5);
}

.convert__split {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(340px, 0.85fr);
  gap: var(--space-4);
  height: 100%;
  min-height: 0;
}

/* 右侧面板收起时，正文占满整行。
   用双类选择器提高优先级，避免被下面的 1280px 媒体查询覆盖。 */
.convert__split.convert__split--aside-off {
  grid-template-columns: minmax(0, 1fr);
}

/* —— 章节列表收起后的窄条 —— */
.convert__reopen {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  width: 34px;
  padding: var(--space-3) 0;
  color: var(--color-text-muted);
  background-color: var(--color-bg-elevated);
  border-right: 1px solid var(--color-border);
  transition:
    color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.convert__reopen:hover {
  color: var(--color-primary-text);
  background-color: var(--color-primary-soft);
}

.convert__reopen-text {
  writing-mode: vertical-rl;
  font-size: var(--text-2xs);
  letter-spacing: 0.12em;
}

/* —— 右下角悬浮生成按钮：与 EPUB 编辑视图一致 —— */
.convert-fab {
  position: absolute;
  right: var(--space-5);
  bottom: calc(28px + var(--space-4));
  z-index: var(--z-sticky);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  width: 42px;
  height: 42px;
  padding: 0;
  overflow: hidden;
  color: var(--color-primary-contrast);
  background-color: var(--color-primary);
  border-radius: var(--radius-full);
  box-shadow: var(--shadow-md);
  opacity: 0.42;
  transform: translateY(2px);
  transition:
    opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}

.convert-fab:hover,
.convert-fab:focus-visible {
  opacity: 1;
}

.convert-fab--on {
  gap: var(--space-2);
  width: 132px;
  padding: 0 var(--space-4);
  opacity: 1;
  transform: none;
}

.convert-fab__label {
  max-width: 0;
  overflow: hidden;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  white-space: nowrap;
  opacity: 0;
  transition:
    max-width var(--duration-base) var(--ease-out),
    opacity var(--duration-fast) var(--ease-out);
}

.convert-fab--on .convert-fab__label {
  max-width: 100px;
  opacity: 1;
}

.convert-fab:disabled {
  cursor: wait;
}

.convert-fab:disabled :deep(.icon) {
  animation: ink-spin 720ms linear infinite;
}

/* —— 设置面板收起后：工具栏最右侧的横向入口 —— */
.aside-restore {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
  margin-left: var(--space-1);
  padding: 2px;
  background-color: var(--color-bg-sunken);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.aside-restore__toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 var(--space-2);
  font-size: var(--text-2xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-secondary);
  border-radius: 4px;
  transition:
    color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.aside-restore__toggle:hover {
  color: var(--color-primary-text);
  background-color: var(--color-primary-soft);
}

.aside-restore__sep {
  flex: none;
  width: 1px;
  height: 14px;
  margin: 0 2px;
  background-color: var(--color-border);
}

.aside-restore__tab {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  color: var(--color-text-muted);
  border-radius: 4px;
  transition:
    color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.aside-restore__tab:hover {
  color: var(--color-text);
  background-color: var(--color-surface-active);
}

.aside-restore__tab--on {
  color: var(--color-primary-text);
  background-color: var(--color-primary-soft);
}

@media (max-width: 1180px) {
  /* 窄窗口里工具栏会换行，收起入口仍跟在操作按钮后面，不再掉到正文下方 */
  .aside-restore__label {
    display: none;
  }
}

/* 设置面板标题行右侧的收起按钮 */
.tabs__collapse {
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 28px;
  margin-left: auto;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  transition:
    color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.tabs__collapse:hover {
  color: var(--color-text);
  background-color: var(--color-surface-active);
}

.convert__aside {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background-color: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.tabs {
  display: flex;
  flex: none;
  gap: 2px;
  padding: var(--space-2) var(--space-2) 0;
  border-bottom: 1px solid var(--color-border);
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 34px;
  padding: 0 var(--space-3);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
  border-bottom: 2px solid transparent;
  transition:
    color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}

.tab:hover {
  color: var(--color-text);
}

.tab--on {
  color: var(--color-primary-text);
  border-bottom-color: var(--color-primary);
}

.tabpanel {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-5);
}

.tabpanel:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: -2px;
}

.convert__side-foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-2xs);
  color: var(--color-text-secondary);
}

.convert__dot {
  opacity: 0.5;
}

.convert__side-foot .muted {
  color: var(--color-text-muted);
}

@media (max-width: 1280px) {
  .convert__split {
    grid-template-columns: minmax(0, 1fr) minmax(320px, 0.8fr);
  }
}

/* 窄窗口下改成上下堆叠，此时外层允许滚动，两块面板各自回到自然高度 */
@media (max-width: 1180px) {
  .convert__body {
    overflow-y: auto;
  }

  .convert__split {
    grid-template-columns: 1fr;
    height: auto;
    gap: var(--space-3);
  }

  .convert__split > :first-child {
    min-height: 420px;
  }

  .convert__aside {
    min-height: 460px;
  }
}

@media (max-width: 1000px) {
  .convert__body {
    padding: var(--space-3);
  }
}
</style>