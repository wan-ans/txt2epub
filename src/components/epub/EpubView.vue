<script setup lang="ts">
import { computed, ref } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiIcon from "../icons/UiIcon.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import UiModal from "../ui/UiModal.vue";
import CoverPanel from "../panels/CoverPanel.vue";
import EpubChapterList from "./EpubChapterList.vue";
import EpubChapterEditor from "./EpubChapterEditor.vue";
import EpubMetaForm from "./EpubMetaForm.vue";
import EpubExportBar from "./EpubExportBar.vue";
import EpubDropZone from "./EpubDropZone.vue";
import { useEpubWorkspace } from "../composables/useEpubWorkspace";
import { useUiLanguage } from "../composables/useUiLanguage";
import { desktop } from "../../bridge";
import type { IconName } from "../icons";

/**
 * EPUB 编辑视图：空 / 加载 / 错误 / 就绪四态。
 * 就绪布局沿用 ConvertView：左侧章节列表 + 中间富文本编辑器 + 右侧设置抽屉 + 底部导出条。
 * 只在空状态与错误态发 pick-files，由 App.vue 打开系统文件对话框。
 */
const fileInput = ref<HTMLInputElement | null>(null);
const emit = defineEmits<{ opened: [] }>();
const { t } = useUiLanguage();

const {
  state,
  selectedChapter,
  selectedIndex,
  chapterStats,
  totalWords,
  selectChapter,
  renameChapter,
  updateChapterHtml,
  addChapter,
  appendFiles,
  deleteChapter,
  moveChapter,
  updateMeta,
  setCover,
  clearCover,
  createBlank,
  reset,
  exportEpub,
  importBytes,
} = useEpubWorkspace();

type TabKey = "meta" | "cover";

const tabs = computed<{ key: TabKey; label: string; icon: IconName }[]>(() => [
  { key: "meta", label: t("书籍信息", "Book info"), icon: "book-open" },
  { key: "cover", label: t("封面", "Cover"), icon: "photo" },
]);

const tab = ref<TabKey>("meta");
const chapterListCollapsed = ref(false);
const asideCollapsed = ref(true);
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

const deleteOpen = ref(false);
const deleteId = ref<string | null>(null);

function pickFile(): void {
  fileInput.value?.click();
}

async function createBlankAndOpen(): Promise<void> {
  await createBlank();
  if (state.phase === "ready") {
    asideCollapsed.value = true;
    emit("opened");
  }
}

async function onFilePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await importBytes({ name: file.name, bytes });
    asideCollapsed.value = true;
    emit("opened");
  } catch (error) {
    console.error(t("[epub] 读取文件失败", "[epub] Failed to read file"), error);
  }
}

const pendingTitle = computed(
  () => state.chapters.find((chapter) => chapter.id === deleteId.value)?.title ?? "",
);

function requestDelete(id: string): void {
  if (state.chapters.length <= 1) return;
  deleteId.value = id;
  deleteOpen.value = true;
}

function confirmDelete(): void {
  if (deleteId.value) deleteChapter(deleteId.value);
  deleteId.value = null;
  deleteOpen.value = false;
}

function openAsideTab(key: TabKey): void {
  tab.value = key;
  asideCollapsed.value = false;
}

function goPrev(): void {
  const index = selectedIndex.value;
  if (index > 0) selectChapter(state.chapters[index - 1].id);
}

function goNext(): void {
  const index = selectedIndex.value;
  if (index >= 0 && index < state.chapters.length - 1) {
    selectChapter(state.chapters[index + 1].id);
  }
}

async function revealExport(): Promise<void> {
  const bridge = desktop();
  if (bridge && state.lastExportPath) {
    await bridge.revealInExplorer(state.lastExportPath);
  }
}
</script>

<template>
  <!-- 文件输入常驻：空状态与错误态都能直接选书 -->
  <input
    ref="fileInput"
    class="sr-only"
    type="file"
    accept=".epub,application/epub+zip"
    tabindex="-1"
    aria-hidden="true"
    @change="onFilePicked"
  />

  <!-- 空状态：打开 EPUB / 新建空白书 -->
  <EpubDropZone
    v-if="state.phase === 'empty'"
    @open="pickFile"
    @create="() => void createBlankAndOpen()"
  />

  <!-- 加载态 -->
  <div v-else-if="state.phase === 'loading'" class="loading">
    <div class="loading__card">
      <span class="loading__spinner" aria-hidden="true" />
      <p class="loading__title serif">{{ state.busyLabel || t("正在准备…", "Preparing…") }}</p>
      <p class="loading__desc">{{ t("大文件需要几秒，解压与解析都在本地完成", "Large files may take a few seconds; unpacking and parsing happen locally.") }}</p>
    </div>
    <div class="loading__skeleton card">
      <UiSkeleton :lines="2" :height="14" last-width="40%" />
      <hr class="divider" />
      <UiSkeleton :lines="6" :height="10" last-width="70%" />
    </div>
  </div>

  <!-- 错误态 -->
  <div v-else-if="state.phase === 'error'" class="errorstate">
    <span class="errorstate__icon">
      <UiIcon name="exclamation-triangle" :size="26" />
    </span>
    <h2 class="errorstate__title serif">{{ t("这本 EPUB 没读进来", "This EPUB could not be opened") }}</h2>
    <p class="errorstate__message">{{ state.errorMessage }}</p>
    <div class="errorstate__actions">
      <UiButton variant="primary" icon="arrow-up-tray" @click="pickFile">{{ t("换个文件", "Choose another file") }}</UiButton>
      <UiButton variant="ghost" icon="arrow-path" @click="reset">{{ t("回到开始", "Back to start") }}</UiButton>
    </div>
  </div>

  <!-- 就绪态 -->
  <div v-else ref="rootRef" class="epub" @pointermove="onPointerMove" @pointerleave="onPointerLeave">
    <EpubChapterList
      :chapters="state.chapters"
      :selected-id="state.selectedChapterId"
      :stats="chapterStats"
      :collapsed="chapterListCollapsed"
      :busy="state.exporting"
      @select="selectChapter"
      @add="addChapter"
      @delete="requestDelete"
      @move="(payload) => moveChapter(payload.id, payload.toIndex)"
      @append-files="(files) => void appendFiles(files)"
      @collapse="chapterListCollapsed = true"
    >
      <template #footer>
        <div class="epub__side-foot">
          <span class="tnum">{{ state.chapters.length }} {{ t("章", "chapters") }}</span>
          <span class="epub__dot" aria-hidden="true">·</span>
          <span class="tnum">{{ state.resourceCount }} {{ t("个资源", "resources") }}</span>
          <span class="spacer" />
          <span class="muted tnum">{{ t(`解析 ${state.parseMs}ms`, `Parsed in ${state.parseMs}ms`) }}</span>
        </div>
      </template>
    </EpubChapterList>

    <!-- 章节列表收起后的窄条：点它重新展开 -->
    <button
      v-if="chapterListCollapsed"
      type="button"
      class="epub__reopen"
      :aria-label="t('展开章节列表', 'Expand chapter list')"
      :title="t('展开章节列表', 'Expand chapter list')"
      @click="chapterListCollapsed = false"
    >
      <UiIcon name="chevron-double-right" :size="15" />
      <span class="epub__reopen-text">{{ t("章节", "Chapters") }} {{ state.chapters.length }}</span>
    </button>

    <div class="epub__main">
      <div class="epub__body">
        <div class="epub__split" :class="{ 'epub__split--aside-off': asideCollapsed }">
          <EpubChapterEditor
            :chapter="selectedChapter"
            :word-count="selectedChapter ? (chapterStats.get(selectedChapter.id) ?? 0) : 0"
            :index="selectedIndex"
            :total="state.chapters.length"
            @rename="(payload) => renameChapter(payload.id, payload.title)"
            @update-html="(payload) => updateChapterHtml(payload.id, payload.html)"
            @select-prev="goPrev"
            @select-next="goNext"
          >
            <template #actions-extra>
              <div v-if="asideCollapsed" class="aside-restore" role="group" :aria-label="t('设置面板已收起', 'Settings panel collapsed')">
                <button
                  type="button"
                  class="aside-restore__toggle"
                  :aria-label="t('展开设置面板', 'Expand settings panel')"
                  :title="t('展开设置面板', 'Expand settings panel')"
                  @click="asideCollapsed = false"
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
          </EpubChapterEditor>

          <aside v-show="!asideCollapsed" class="epub__aside" :aria-label="t('书籍设置', 'Book settings')">
            <div class="tabs" role="tablist" :aria-label="t('设置分区', 'Settings sections')">
              <button
                v-for="item in tabs"
                :key="item.key"
                type="button"
                role="tab"
                class="tab"
                :class="{ 'tab--on': tab === item.key }"
                :aria-selected="tab === item.key"
                :id="`epub-tab-${item.key}`"
                :aria-controls="`epub-panel-${item.key}`"
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
                @click="asideCollapsed = true"
              >
                <UiIcon name="chevron-double-right" :size="14" />
              </button>
            </div>

            <div
              v-show="tab === 'meta'"
              id="epub-panel-meta"
              class="tabpanel"
              role="tabpanel"
              aria-labelledby="epub-tab-meta"
              tabindex="0"
            >
              <EpubMetaForm
                :meta="state.meta"
                @update="updateMeta"
                @set-language="(value) => updateMeta({ language: value })"
              />
            </div>

            <div
              v-show="tab === 'cover'"
              id="epub-panel-cover"
              class="tabpanel"
              role="tabpanel"
              aria-labelledby="epub-tab-cover"
              tabindex="0"
            >
              <CoverPanel
                :cover="state.cover"
                :preview-url="state.coverPreviewUrl"
                @select="(payload) => setCover(payload.cover, payload.previewUrl)"
                @clear="clearCover"
              />
            </div>
          </aside>
        </div>
      </div>

      <EpubExportBar
        :chapter-count="state.chapters.length"
        :word-count="totalWords"
        :source-bytes="state.byteLength"
        :has-cover="Boolean(state.cover)"
        :resource-count="state.resourceCount"
        :last-export-path="state.lastExportPath"
        @reveal="() => void revealExport()"
      />

      <button
        type="button"
        class="epub-fab"
        :class="{ 'epub-fab--on': saveFabActive || state.exporting }"
        :disabled="state.exporting"
        :aria-label="state.exporting ? t('正在保存 EPUB', 'Saving EPUB') : t('保存 EPUB', 'Save EPUB')"
        :title="state.exporting ? t('正在保存 EPUB', 'Saving EPUB') : t('保存 EPUB', 'Save EPUB')"
        @click="() => void exportEpub()"
        @mouseenter="saveFabActive = true"
        @mouseleave="saveFabActive = false"
        @focus="saveFabActive = true"
        @blur="saveFabActive = false"
      >
        <UiIcon :name="state.exporting ? 'spinner' : 'archive'" :size="18" />
        <span class="epub-fab__label">{{ state.exporting ? t("正在写入…", "Writing…") : t("保存 EPUB", "Save EPUB") }}</span>
      </button>
    </div>

    <!-- 删除章节确认 -->
    <UiModal
      :open="deleteOpen"
      :title="t('删除这一章？', 'Delete this chapter?')"
      :description="t(`「${pendingTitle}」删除后不可撤销，保存时会从 EPUB 中移除该章及其正文。`, `“${pendingTitle}” will be permanently removed; saving will delete this chapter and its text from the EPUB.`)"
      icon="exclamation-triangle"
      size="sm"
      @close="deleteOpen = false"
    >
      <template #footer>
        <UiButton variant="ghost" @click="deleteOpen = false">{{ t("取消", "Cancel") }}</UiButton>
        <UiButton variant="danger" data-autofocus @click="confirmDelete">{{ t("删除章节", "Delete chapter") }}</UiButton>
      </template>
    </UiModal>
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
.epub {
  position: relative;
  display: flex;
  height: 100%;
  min-height: 0;
}

.epub__main {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

.epub__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  padding: var(--space-4) var(--space-5);
}

.epub__split {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(340px, 0.75fr);
  gap: var(--space-4);
  height: 100%;
  min-height: 0;
}

/* 设置面板收起时，编辑器占满整行 */
.epub__split.epub__split--aside-off {
  grid-template-columns: minmax(0, 1fr);
}

/* —— 右下角悬浮保存按钮：平时收纳成小圆钮，鼠标靠近后自动展开 —— */
.epub-fab {
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

.epub-fab:hover,
.epub-fab:focus-visible {
  opacity: 1;
}

.epub-fab--on {
  gap: var(--space-2);
  width: 132px;
  padding: 0 var(--space-4);
  opacity: 1;
  transform: none;
}

.epub-fab__label {
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

.epub-fab--on .epub-fab__label {
  max-width: 100px;
  opacity: 1;
}

.epub-fab:disabled {
  cursor: wait;
}

.epub-fab:disabled :deep(.icon) {
  animation: ink-spin 720ms linear infinite;
}

/* —— 章节列表收起后的窄条 —— */
.epub__reopen {
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

.epub__reopen:hover {
  color: var(--color-primary-text);
  background-color: var(--color-primary-soft);
}

.epub__reopen-text {
  writing-mode: vertical-rl;
  font-size: var(--text-2xs);
  letter-spacing: 0.12em;
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

.epub__aside {
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

.epub__side-foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-2xs);
  color: var(--color-text-secondary);
}

.epub__dot {
  opacity: 0.5;
}

.epub__side-foot .muted {
  color: var(--color-text-muted);
}

@media (max-width: 1280px) {
  .epub__split {
    grid-template-columns: minmax(0, 1fr) minmax(320px, 0.8fr);
  }
}

/* 窄窗口改成上下堆叠，此时外层允许滚动，两块面板回到自然高度 */
@media (max-width: 1180px) {
  .epub__body {
    overflow-y: auto;
  }

  .epub__split {
    grid-template-columns: 1fr;
    height: auto;
    gap: var(--space-3);
  }

  .epub__split > :first-child {
    min-height: 480px;
  }

  .epub__aside {
    min-height: 460px;
  }
}

@media (max-width: 1000px) {
  .epub__body {
    padding: var(--space-3);
  }
}
</style>