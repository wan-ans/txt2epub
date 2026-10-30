<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import UiIcon from "../icons/UiIcon.vue";
import UiButton from "../ui/UiButton.vue";
import UiField from "../ui/UiField.vue";
import UiSelect from "../ui/UiSelect.vue";
import UiSwitch from "../ui/UiSwitch.vue";
import { desktop, isDesktop } from "../../bridge";
import {
  buildEpub,
  convertTxt,
  countWords,
  detectAndDecode,
  parseChapters,
  preprocessLines,
  suggestFileName,
  type BookMeta,
  type Chapter,
  type ChapterRule,
  type EncodingChoice,
  type Language,
} from "../engine/core";
import { encodingOptions, formatBytes } from "../composables/useWorkspace";
import {
  moveItem,
  sortFilesByNaturalName,
  stripExtension,
} from "../composables/fileOrdering";
import { useToast } from "../composables/useToast";
import { useUiLanguage } from "../composables/useUiLanguage";

/**
 * 批量转换：仅在桌面端可用（需要桥接的文件对话框与目录写入）。
 * 每个文件独立显示状态，失败不影响其它文件。
 */

type JobStatus = "pending" | "running" | "success" | "failed";

interface BatchJob {
  id: number;
  name: string;
  path: string;
  bytes: Uint8Array;
  status: JobStatus;
  chapterCount: number;
  wordCount: number;
  outputName: string;
  error: string;
  /**
   * 合并模式下用户改过的章节标题（undefined = 还没改过，跟随文件名）。
   * 单独存一个字段而不是直接改 name：name 是磁盘上的真实文件名，
   * 改它会让「这个文件到底叫什么」失真的同时，也让「恢复默认」无从下手。
   */
  customTitle?: string;
  /**
   * 该文件按当前规则会切成几章（合并模式下预计算）。
   * 0 = 还没算；1 = 整篇当一章（改名直接生效）；>1 = 会拆成多章（改名成为章节前缀）。
   */
  previewChapters: number;
}

const props = defineProps<{
  rules: ChapterRule[];
  language: Language;
  defaultEncoding: EncodingChoice;
  typesettingIndent: boolean;
}>();

const toast = useToast();
const { t } = useUiLanguage();
const bridge = desktop();
const desktopMode = isDesktop();

const jobs = ref<BatchJob[]>([]);
const running = ref(false);
const dir = ref("");
const encoding = ref<EncodingChoice>(props.defaultEncoding);
const author = ref("");
const useTitleFromFile = ref(true);
/** 合并模式：所有文件合成一本书，队列变成排序列表 */
const mergeMode = ref(false);
const importInput = ref<HTMLInputElement | null>(null);

let seed = 0;

/* ------------------------------------------------------------
   合并模式：拖拽排序
   ------------------------------------------------------------ */

/** 正在拖拽的 job id */
const draggingId = ref<number | null>(null);
/** 拖过的目标位置（插入到该 job 之前） */
const dropTargetId = ref<number | null>(null);

function onDragStart(job: BatchJob, event: DragEvent) {
  if (running.value) {
    event.preventDefault();
    return;
  }
  draggingId.value = job.id;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    // Firefox 需要 setData 才会真正开始拖拽
    event.dataTransfer.setData("text/plain", String(job.id));
  }
}

function onDragOver(job: BatchJob, event: DragEvent) {
  if (draggingId.value === null || job.id === draggingId.value) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dropTargetId.value = job.id;
}

function onDragEnd() {
  draggingId.value = null;
  dropTargetId.value = null;
}

function onDrop(job: BatchJob, event: DragEvent) {
  event.preventDefault();
  const fromId = draggingId.value;
  const toId = job.id;
  onDragEnd();
  if (fromId === null || fromId === toId) return;

  const list = [...jobs.value];
  const fromIndex = list.findIndex((item) => item.id === fromId);
  const toIndex = list.findIndex((item) => item.id === toId);
  if (fromIndex < 0 || toIndex < 0) return;

  jobs.value = moveItem(list, fromIndex, toIndex);
}

function moveBy(id: number, delta: number) {
  const list = [...jobs.value];
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) return;
  jobs.value = moveItem(list, index, index + delta);
}

/**
 * 按文件名自然排序（数字感知）。
 * 「第1话」「第2话」…「第10话」会排成 1,2,…,10 而不是 1,10,2。
 * 顺序已经正确时返回 false，便于提示「无需调整」。
 */
function sortByFileName(): boolean {
  const before = jobs.value.map((job) => job.id).join(",");
  jobs.value = sortFilesByNaturalName(jobs.value);
  return jobs.value.map((job) => job.id).join(",") !== before;
}

/** 切到合并模式时自动排一次序，符合「按文件名自动排」的预期 */
function setMergeMode(value: boolean) {
  mergeMode.value = value;
  if (value && jobs.value.length > 1) {
    sortByFileName();
  }
}

/* ------------------------------------------------------------
   合并模式：编辑章节标题
   ------------------------------------------------------------ */

/** 正在编辑标题的 job id（一次只编辑一个，避免多个输入框抢焦点） */
const editingTitleId = ref<number | null>(null);
const titleDraft = ref("");
const titleInputRef = ref<HTMLInputElement | null>(null);

/** 该 job 在合并后实际使用的章节标题：改过就用改的，没改就用文件名。 */
function effectiveTitle(job: BatchJob): string {
  const custom = (job.customTitle ?? "").trim();
  return custom || stripExtension(job.name);
}

/** 该 job 是否被改过标题 */
function isRenamed(job: BatchJob): boolean {
  return Boolean((job.customTitle ?? "").trim());
}

async function startTitleEdit(job: BatchJob) {
  if (running.value) return;
  editingTitleId.value = job.id;
  titleDraft.value = effectiveTitle(job);
  await nextTick();
  titleInputRef.value?.focus();
  titleInputRef.value?.select();
}

function commitTitleEdit(job: BatchJob) {
  if (editingTitleId.value !== job.id) return;
  const next = titleDraft.value.trim();
  if (next && next !== stripExtension(job.name)) {
    job.customTitle = next;
  } else {
    // 改回和文件名一致，等于恢复默认
    job.customTitle = undefined;
  }
  editingTitleId.value = null;
}

function cancelTitleEdit() {
  editingTitleId.value = null;
  titleDraft.value = "";
}

/** 恢复某个任务的标题为文件名 */
function resetTitle(job: BatchJob) {
  job.customTitle = undefined;
  if (editingTitleId.value === job.id) cancelTitleEdit();
}

/** 一键把全部标题恢复成文件名 */
function resetAllTitles() {
  let count = 0;
  for (const job of jobs.value) {
    if (isRenamed(job)) {
      job.customTitle = undefined;
      count += 1;
    }
  }
  cancelTitleEdit();
  if (count) toast.info(t(`已把 ${count} 个章节标题恢复为文件名`, `Restored ${count} chapter titles to file names`));
}

/** 改过标题的数量 */
const renamedCount = computed(() => jobs.value.filter(isRenamed).length);

/**
 * 预计算每个文件会切成几章（只在合并模式下、文件变动时算一次）。
 * 用来在改名输入框旁提示「这一格改的是整章名 / 还是章节前缀」，
 * 避免用户以为改了文件名就等于改了所有章节名。
 */
function refreshChapterPreview() {
  for (const job of jobs.value) {
    if (job.previewChapters > 0) continue;
    try {
      const read = detectAndDecode(
        job.bytes,
        encoding.value === "auto" ? undefined : encoding.value,
      );
      const lines = preprocessLines(read.text);
      job.previewChapters = lines.length
        ? parseChapters(lines, props.language, props.rules).length
        : 0;
    } catch {
      job.previewChapters = 0;
    }
  }
}

watch(mergeMode, (on) => {
  if (on) refreshChapterPreview();
});

/** 编码/规则变了，预计算结果就失效，需要重算 */
watch([encoding, () => props.language, () => props.rules], () => {
  for (const job of jobs.value) job.previewChapters = 0;
  if (mergeMode.value) refreshChapterPreview();
});

/** 合并模式下的预计章节数（粗估，实际以转换结果为准） */
const mergeEstimate = computed(() => {
  if (!mergeMode.value) return "";
  const total = jobs.value.reduce((sum, job) => sum + job.bytes.byteLength, 0);
  return t(`${jobs.value.length} 个文件 · ${formatBytes(total)}`, `${jobs.value.length} files · ${formatBytes(total)}`);
});

const counts = computed(() => {
  let success = 0;
  let failed = 0;
  for (const job of jobs.value) {
    if (job.status === "success") success += 1;
    else if (job.status === "failed") failed += 1;
  }
  return { success, failed };
});

const totalBytes = computed(() => jobs.value.reduce((sum, job) => sum + job.bytes.byteLength, 0));

const canRun = computed(() => desktopMode && jobs.value.length > 0 && !running.value);

function addFiles(files: { name: string; path: string; bytes: Uint8Array }[]) {
  if (!files.length) return;
  const existing = new Set(jobs.value.map((job) => job.path || job.name));
  const fresh = files
    .filter((file) => !existing.has(file.path || file.name))
    .map<BatchJob>((file) => ({
      id: ++seed,
      name: file.name,
      path: file.path,
      bytes: file.bytes,
      status: "pending",
      chapterCount: 0,
      wordCount: 0,
      outputName: "",
      error: "",
      previewChapters: 0,
    }));
  jobs.value = [...jobs.value, ...fresh];
  if (files.length !== fresh.length) {
    toast.info(t(`已跳过 ${files.length - fresh.length} 个重复文件`, `Skipped ${files.length - fresh.length} duplicate files`));
  }
  // 合并模式下新加进来的文件也要按文件名插到正确位置，
  // 否则「后拖进来的第 2 话」会排到队尾，合并出来顺序就是错的。
  if (mergeMode.value && fresh.length) sortByFileName();
}

async function openFiles() {
  if (!bridge) return;
  try {
    addFiles(await bridge.openTxtFiles());
  } catch (error) {
    toast.error(t("打开文件失败", "Failed to open files"), { detail: error instanceof Error ? error.message : undefined });
  }
}

async function openFolder() {
  if (!bridge) return;
  try {
    const files = await bridge.openTxtFolder();
    if (!files.length) {
      toast.warning(t("这个文件夹里没有 TXT 文件", "No TXT files in this folder"));
      return;
    }
    addFiles(files);
    const firstDir = files[0].path.replace(/[\\/][^\\/]+$/, "");
    if (!dir.value) dir.value = firstDir;
  } catch (error) {
    toast.error(t("打开文件夹失败", "Failed to open folder"), { detail: error instanceof Error ? error.message : undefined });
  }
}

function onFallbackFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (!files.length) return;
  void Promise.all(
    files.map(async (file) => ({
      name: file.name,
      path: "",
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  ).then(addFiles);
}

function removeJob(id: number) {
  jobs.value = jobs.value.filter((job) => job.id !== id);
}

function clearFinished() {
  jobs.value = jobs.value.filter((job) => job.status === "pending" || job.status === "running");
}

function clearAll() {
  if (running.value) return;
  jobs.value = [];
}

async function chooseDir() {
  if (!bridge) return;
  const chosen = await bridge.chooseDirectory();
  if (chosen) dir.value = chosen;
}

/* ------------------------------------------------------------
   合并模式执行：多文件 → 一本书
   ------------------------------------------------------------ */

/**
 * 合并转换：把队列里所有文件按**当前顺序**（用户可拖拽调整）串成一本。
 *
 * 章节顺序严格跟随队列顺序；每个文件内部仍按当前章节规则切分，
 * 切不出章节时整篇作为一个章节，标题取文件名，保证「杂乱多 TXT」也能得到可读目录。
 */
async function runMerged() {
  const list = [...jobs.value];
  if (!list.length) return;

  for (const job of list) {
    job.status = "running";
    job.error = "";
  }
  await new Promise((resolve) => requestAnimationFrame(resolve));

  try {
    const chapters: Chapter[] = [];
    let totalWords = 0;
    let failedFiles = 0;

    for (const job of list) {
      try {
        if (!job.bytes || job.bytes.byteLength === 0) throw new Error(t("空文件", "Empty file"));
        const read = detectAndDecode(
          job.bytes,
          encoding.value === "auto" ? undefined : encoding.value,
        );
        const lines = preprocessLines(read.text);
        if (!lines.length) throw new Error(t("没有可读文本", "No readable text"));

        const parsed = parseChapters(lines, props.language, props.rules);
        const fallbackTitles = new Set(["正文", "Content"]);
        const baseTitle = stripExtension(job.name);
        const renamed = (job.customTitle ?? "").trim();

        const usable =
          parsed.length === 1 && fallbackTitles.has(parsed[0].title)
            ? [{ ...parsed[0], title: baseTitle }]
            : parsed;

        /*
         * 改名规则（与 UI 上给用户的说明一致）：
         * - 文件只切成 1 章：改的名字就是这一章的标题。
         * - 文件切成多章：改的名字作为「前缀」，各章保留自己的章名，
         *   形如「卷一 · 第1章」。这样既尊重用户改名，又不会让一章拆成多章后
         *   所有章节都叫同一个名字。
         */
        const titled = usable.map((chapter) => {
          if (!renamed) return chapter;
          if (usable.length === 1) return { ...chapter, title: renamed };
          return { ...chapter, title: `${renamed} · ${chapter.title}` };
        });

        for (const chapter of titled) {
          chapters.push({
            ...chapter,
            id: `merged-${job.id}-${chapters.length}`,
          });
        }

        job.chapterCount = titled.length;
        job.wordCount = titled.reduce((sum, chapter) => sum + countWords(chapter.lines), 0);
        totalWords += job.wordCount;
        job.status = "success";
      } catch (error) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        failedFiles += 1;
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    if (!chapters.length) {
      toast.error(t("没有可合并的内容", "Nothing to merge"), { detail: t("所有文件都读取失败", "All files failed to read") });
      return;
    }

    const first = list.find((job) => job.status === "success") ?? list[0];
    // 合并后的书名：默认取队列第一个文件的名字，用户可在此之后另行修改元信息
    const meta: BookMeta = {
      title: stripExtension(first.name),
      author: author.value.trim(),
      language: props.language,
    };

    const bytes = await buildEpub(meta, chapters, {
      typesetting: { indent: props.typesettingIndent },
    });
    const outputName = suggestFileName(meta);
    const saved = await bridge?.saveEpub({ bytes, suggestedName: outputName });

    if (saved) {
      dir.value = saved.path.replace(/[\\/][^\\/]+$/, "");
      toast.success(t(`已合并为 1 本 · ${chapters.length} 章`, `Merged into 1 book · ${chapters.length} chapters`), {
        detail: `${saved.path}${failedFiles ? t(`（${failedFiles} 个文件跳过）`, ` (${failedFiles} files skipped)`) : ""}`,
        timeout: 12000,
        action: {
          label: t("打开所在位置", "Show in folder"),
          handler: () => {
            void bridge?.revealInExplorer(saved.path);
          },
        },
      });
    }
  } catch (error) {
    toast.error(t("合并转换失败", "Merge conversion failed"), {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function run() {
  if (!bridge || !canRun.value) return;
  running.value = true;

  if (mergeMode.value) {
    await runMerged();
    running.value = false;
    return;
  }

  const pending = jobs.value.filter((job) => job.status === "pending" || job.status === "failed");
  const written: { job: BatchJob; outputName: string; bytes: Uint8Array }[] = [];

  // 串行执行：单线程解析，串行反而更稳定，也便于逐个反馈进度
  for (const job of pending) {
    job.status = "running";
    job.error = "";
    // 让出一帧，保证 UI 能画出 running 状态
    await new Promise((resolve) => requestAnimationFrame(resolve));

    try {
      const meta: BookMeta = {
        title: useTitleFromFile.value ? job.name.replace(/\.txt$/i, "") : job.name,
        // BookMeta.author 是必填字符串；留空由核心统一兜底成「佚名」
        author: author.value.trim(),
        language: props.language,
      };
      const result = await convertTxt(
        { sourceName: job.name, bytes: job.bytes },
        {
          meta,
          encoding: encoding.value === "auto" ? undefined : encoding.value,
          rules: props.rules,
          language: props.language,
          typesetting: { indent: props.typesettingIndent },
        },
      );
      job.chapterCount = result.chapterCount;
      job.wordCount = result.wordCount;
      job.outputName = result.outputName || suggestFileName(meta);
      written.push({ job, outputName: job.outputName, bytes: result.bytes });
      job.status = "success";
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    }
  }

  if (written.length) {
    try {
      const saved = await bridge.saveMany({
        items: written.map((item) => ({ bytes: item.bytes, outputName: item.outputName })),
        dir: dir.value || undefined,
      });
      if (saved) {
        dir.value = saved.dir;
        toast.success(t(`已写出 ${saved.written.length} 个 EPUB`, `Wrote ${saved.written.length} EPUB files`), {
          detail: saved.dir,
          timeout: 9000,
          action: {
            label: t("打开目录", "Open folder"),
            handler: () => {
              void bridge.revealInExplorer(saved.written[0] ?? saved.dir);
            },
          },
        });
      }
    } catch (error) {
      toast.error(t("写入文件失败", "Failed to write files"), { detail: error instanceof Error ? error.message : undefined });
    }
  }

  running.value = false;
  const failed = jobs.value.filter((job) => job.status === "failed").length;
  if (failed) {
    toast.warning(t(`${failed} 个文件转换失败`, `${failed} files failed to convert`), { detail: t("点击对应项可查看原因", "Click an item to see the reason") });
  }
}

const STATUS_META = computed<Record<JobStatus, { label: string; tone: string }>>(() => ({
  pending: { label: t("待处理", "Pending"), tone: "" },
  running: { label: t("转换中", "Converting"), tone: "badge--accent" },
  success: { label: t("成功", "Success"), tone: "badge--success" },
  failed: { label: t("失败", "Failed"), tone: "badge--danger" },
}));
</script>

<template>
  <section class="batch" aria-labelledby="batch-title">
    <header class="batch__head">
      <div>
        <h2 id="batch-title" class="batch__title serif">{{ t("批量转换", "Batch convert") }}</h2>
        <p class="batch__desc">
          {{ t("一次选中多个 TXT，或直接扫一个文件夹，全部按当前章节规则生成 EPUB。", "Select multiple TXT files at once, or scan a folder, and generate EPUBs with the current chapter rules.") }}
        </p>
      </div>
      <div class="batch__head-actions">
        <UiButton
          v-if="desktopMode"
          variant="secondary"
          icon="folder-plus"
          :disabled="running"
          @click="openFolder"
        >
          {{ t("添加文件夹", "Add folder") }}
        </UiButton>
        <UiButton
          variant="primary"
          icon="document-text"
          :disabled="running"
          @click="desktopMode ? openFiles() : importInput?.click()"
        >
          {{ t("添加文件", "Add files") }}
        </UiButton>
      </div>
    </header>

    <!-- 浏览器兜底提示 -->
    <div v-if="!desktopMode" class="batch__notice">
      <UiIcon name="information-circle" :size="16" />
      <div>
        <p class="batch__notice-title">{{ t("批量写出到文件夹需要桌面版", "Writing batches to a folder requires the desktop app") }}</p>
        <p class="batch__notice-desc">
          {{ t("当前在浏览器里运行，你可以先把文件加进列表做转换预览，但一次写出多个文件请用桌面端。", "You're running in a browser. You can add files to preview the conversion, but writing multiple files at once requires the desktop app.") }}
        </p>
      </div>
    </div>

    <!-- 参数行 -->
    <div class="batch__params">
      <UiField :label="t('输出目录', 'Output folder')" input-id="batch-dir" :hint="t('留空则在保存时询问', 'Leave empty to choose when saving')">
        <template #default="{ describedBy }">
          <div class="batch__dir">
            <input
              id="batch-dir"
              class="ctl mono batch__dir-input"
              type="text"
              :value="dir"
              :placeholder="t('尚未选择', 'Not selected')"
              :aria-describedby="describedBy"
              readonly
            />
            <UiButton size="sm" variant="secondary" icon="folder" :disabled="!desktopMode || running" @click="chooseDir">
              {{ t("选择", "Choose") }}
            </UiButton>
          </div>
        </template>
      </UiField>

      <UiField :label="t('编码', 'Encoding')" input-id="batch-encoding">
        <template #default="{ describedBy }">
          <UiSelect
            id="batch-encoding"
            :model-value="encoding"
            :options="encodingOptions()"
            :described-by="describedBy"
            :disabled="running"
            @update:model-value="(value) => (encoding = value as EncodingChoice)"
          />
        </template>
      </UiField>

      <UiField :label="t('统一作者', 'Unified author')" input-id="batch-author" :hint="t('留空则不写入作者', 'Leave empty to omit the author')">
        <template #default="{ describedBy }">
          <input
            id="batch-author"
            v-model="author"
            class="ctl"
            type="text"
            :placeholder="t('可选', 'Optional')"
            :aria-describedby="describedBy"
            :disabled="running"
          />
        </template>
      </UiField>

      <UiField :label="t('书名来源', 'Title source')" input-id="batch-title-source">
        <div class="batch__title-source">
          <UiSwitch
            id="batch-title-source"
            :model-value="useTitleFromFile"
            :label="t('用文件名作为书名', 'Use file name as title')"
            @update:model-value="(value) => (useTitleFromFile = value)"
          />
          <UiSwitch
            id="batch-merge"
            :model-value="mergeMode"
            :label="t('合并为一个文件', 'Merge into one file')"
            :disabled="running"
            @update:model-value="setMergeMode"
          />
        </div>
      </UiField>
    </div>

    <!-- 合并模式提示 -->
    <div v-if="mergeMode" class="batch__merge-note">
      <UiIcon name="squares-2x2" :size="16" />
      <div class="batch__merge-note-body">
        <p class="batch__merge-title">
          {{ t("合并模式", "Merge mode") }} · {{ mergeEstimate }}
          <span v-if="renamedCount" class="batch__merge-renamed tnum">
            · {{ t(`${renamedCount} 个已改名`, `${renamedCount} renamed`) }}
          </span>
        </p>
        <p class="batch__merge-desc">
          {{ t("下方列表变为", "The list below becomes ") }}<strong>{{ t("章节排序", "chapter order") }}</strong>{{ t("：拖动行或点 ↑↓ 调整顺序，最终按此顺序合并成一本书。", ": drag rows or click ↑↓ to reorder; files are merged into one book in this order.") }}
          {{ t("点击标题可直接改名 —— 只切出一章的文件用整名，会拆成多章的文件则作为章节前缀。", "Click a title to rename it — for files that produce one chapter the full name becomes the chapter title, while files split into multiple chapters use it as a chapter prefix.") }}
          {{ t("导入时已按文件名自动排过一次（带 1、2、10 的数字会按大小排，而不是按字符）。", "Files are sorted by file name on import (numbers such as 1, 2, 10 sort numerically, not by character).") }}
        </p>
      </div>
      <div class="batch__merge-actions">
        <button
          v-if="renamedCount"
          type="button"
          class="batch__link"
          :disabled="running"
          @click="resetAllTitles"
        >
          {{ t("全部恢复文件名", "Restore all file names") }}
        </button>
        <button
          type="button"
          class="batch__link"
          :disabled="running || jobs.length < 2"
          @click="sortByFileName() && toast.info(t('已按文件名重新排序', 'Re-sorted by file name'))"
        >
          {{ t("按文件名重排", "Sort by file name") }}
        </button>
      </div>
    </div>

    <!-- 队列 -->
    <div class="batch__queue">
      <header class="batch__queue-head">
        <div class="batch__queue-stats">
          <span class="tnum">{{ t(`共 ${jobs.length} 个`, `${jobs.length} total`) }}</span>
          <span v-if="counts.success" class="batch__ok tnum">{{ t(`${counts.success} 成功`, `${counts.success} succeeded`) }}</span>
          <span v-if="counts.failed" class="batch__fail tnum">{{ t(`${counts.failed} 失败`, `${counts.failed} failed`) }}</span>
          <span class="muted tnum">{{ formatBytes(totalBytes) }}</span>
        </div>
        <div class="row-wrap">
          <button
            v-if="counts.success || counts.failed"
            type="button"
            class="batch__link"
            :disabled="running"
            @click="clearFinished"
          >
            {{ t("清除已完成", "Clear completed") }}
          </button>
          <button
            v-if="jobs.length"
            type="button"
            class="batch__link batch__link--danger"
            :disabled="running"
            @click="clearAll"
          >
            {{ t("清空列表", "Clear list") }}
          </button>
        </div>
      </header>

      <ul v-if="jobs.length" class="jobs" :class="{ 'jobs--sortable': mergeMode }">
        <li
          v-for="(job, index) in jobs"
          :key="job.id"
          class="job"
          :class="[
            `job--${job.status}`,
            {
              'job--dragging': draggingId === job.id,
              'job--droptarget': dropTargetId === job.id && draggingId !== job.id,
              'job--sortable': mergeMode,
            },
          ]"
          :draggable="mergeMode && !running"
          @dragstart="onDragStart(job, $event)"
          @dragover="onDragOver(job, $event)"
          @drop="onDrop(job, $event)"
          @dragend="onDragEnd"
        >
          <!-- 合并模式的排序手柄与序号 -->
          <template v-if="mergeMode">
            <span class="job__grip" aria-hidden="true">
              <UiIcon name="squares-2x2" :size="13" />
            </span>
            <span class="job__order tnum">{{ index + 1 }}</span>
          </template>

          <span class="job__icon">
            <UiIcon
              :name="
                job.status === 'success'
                  ? 'check-circle'
                  : job.status === 'failed'
                    ? 'exclamation-circle'
                    : job.status === 'running'
                      ? 'spinner'
                      : 'document-text'
              "
              :size="16"
              :class="{ 'job__spin': job.status === 'running' }"
            />
          </span>

          <span class="job__body">
            <!-- 合并模式：章节标题可直接编辑 -->
            <span v-if="mergeMode" class="job__title-edit">
              <template v-if="editingTitleId === job.id">
                <input
                  ref="titleInputRef"
                  v-model="titleDraft"
                  class="ctl job__title-input"
                  type="text"
                  :aria-label="t(`编辑 ${job.name} 的章节标题`, `Edit chapter title for ${job.name}`)"
                  maxlength="120"
                  @keydown.enter.prevent.stop="commitTitleEdit(job)"
                  @keydown.esc.prevent.stop="cancelTitleEdit"
                  @blur="commitTitleEdit(job)"
                />
              </template>
              <template v-else>
                <button
                  type="button"
                  class="job__title-btn"
                  :class="{ 'job__title-btn--changed': isRenamed(job) }"
                  :disabled="running"
                  :title="t(`点击修改章节标题（当前：${effectiveTitle(job)}）`, `Click to edit the chapter title (current: ${effectiveTitle(job)})`)"
                  @click="startTitleEdit(job)"
                >
                  <span class="job__title-text">{{ effectiveTitle(job) }}</span>
                  <UiIcon name="pencil" :size="12" class="job__title-pen" />
                </button>
                <button
                  v-if="isRenamed(job)"
                  type="button"
                  class="job__title-reset"
                  :disabled="running"
                  :aria-label="t(`把 ${job.name} 的标题恢复为文件名`, `Restore the title of ${job.name} to its file name`)"
                  :title="t('恢复为文件名', 'Restore to file name')"
                  @click="resetTitle(job)"
                >
                  <UiIcon name="arrow-path" :size="11" />
                </button>
              </template>
            </span>

            <span v-else class="job__name" :title="job.path || job.name">{{ job.name }}</span>

            <span class="job__meta tnum">
              <template v-if="mergeMode">
                <span class="job__filename" :title="job.path || job.name">{{ job.name }}</span>
                <template v-if="job.previewChapters > 1">
                  · {{ t(`将拆为 ${job.previewChapters} 章（改名为章节前缀）`, `Will split into ${job.previewChapters} chapters (rename becomes chapter prefix)`) }}
                </template>
                <template v-else>· {{ formatBytes(job.bytes.byteLength) }}</template>
              </template>
              <template v-else-if="job.status === 'success'">
                {{ t(`${job.chapterCount} 章`, `${job.chapterCount} chapters`) }} · {{ job.wordCount.toLocaleString("zh-CN") }} {{ t("字", "characters") }} → {{ job.outputName }}
              </template>
              <template v-else-if="job.status === 'failed'">{{ job.error }}</template>
              <template v-else>{{ formatBytes(job.bytes.byteLength) }}</template>
            </span>
          </span>

          <span class="badge" :class="STATUS_META[job.status].tone">
            {{ STATUS_META[job.status].label }}
          </span>

          <!-- 合并模式：上下移动（拖拽的键盘可达替代） -->
          <span v-if="mergeMode" class="job__moves">
            <button
              type="button"
              class="job__move"
              :aria-label="t(`上移 ${job.name}`, `Move ${job.name} up`)"
              :disabled="running || index === 0"
              @click="moveBy(job.id, -1)"
            >
              <UiIcon name="chevron-up" :size="13" />
            </button>
            <button
              type="button"
              class="job__move"
              :aria-label="t(`下移 ${job.name}`, `Move ${job.name} down`)"
              :disabled="running || index === jobs.length - 1"
              @click="moveBy(job.id, 1)"
            >
              <UiIcon name="chevron-down" :size="13" />
            </button>
          </span>

          <button
            type="button"
            class="job__remove"
            :aria-label="t(`移除 ${job.name}`, `Remove ${job.name}`)"
            :disabled="job.status === 'running'"
            @click="removeJob(job.id)"
          >
            <UiIcon name="x-mark" :size="13" />
          </button>
        </li>
      </ul>

      <div v-else class="batch__blank">
        <UiIcon name="squares-2x2" :size="24" />
        <p class="batch__blank-title">{{ t("还没有待处理文件", "No files in the queue yet") }}</p>
        <p class="batch__blank-desc">{{ t("添加文件后，这里会显示每个文件的转换进度", "Add files to see each file's conversion progress here") }}</p>
      </div>
    </div>

    <footer class="batch__foot">
      <p class="hint">
        <UiIcon name="information-circle" :size="12" />
        <template v-if="mergeMode">
          {{ t(`合并模式会按上面的顺序把 ${jobs.length} 个文件串成一本，输出 1 个 EPUB。`, `Merge mode joins the ${jobs.length} files above in order into one book and outputs a single EPUB.`) }}
        </template>
        <template v-else>
          {{ t("已启用的自定义规则会应用到每个文件；单个文件失败不影响其余文件。", "Enabled custom rules apply to every file; one failure doesn't affect the others.") }}
        </template>
      </p>
      <UiButton
        variant="primary"
        :icon="mergeMode ? 'book-open' : 'archive'"
        :loading="running"
        :disabled="!canRun"
        @click="run"
      >
        <template v-if="running">{{ t("正在转换…", "Converting…") }}</template>
        <template v-else-if="mergeMode">{{ t("合并并导出", "Merge and export") }} {{ jobs.length ? t(`（${jobs.length} 个文件）`, `(${jobs.length} files)`) : "" }}</template>
        <template v-else>{{ t("开始转换", "Start conversion") }} {{ jobs.length || "" }}</template>
      </UiButton>
    </footer>

    <input
      ref="importInput"
      class="sr-only"
      type="file"
      accept=".txt,text/plain"
      multiple
      tabindex="-1"
      aria-hidden="true"
      @change="onFallbackFiles"
    />
  </section>
</template>

<style scoped>
.batch {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  height: 100%;
  padding: var(--space-6) var(--space-8);
  overflow-y: auto;
}

.batch__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.batch__title {
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.06em;
  color: var(--color-text);
}

.batch__desc {
  margin-top: var(--space-1);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.batch__head-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.batch__notice {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  color: var(--color-warning);
  background-color: var(--color-warning-soft);
  border: 1px solid color-mix(in srgb, var(--color-warning) 26%, transparent);
  border-radius: var(--radius-md);
}

.batch__notice-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.batch__notice-desc {
  margin-top: 2px;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-secondary);
}

.batch__params {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: var(--space-4);
  align-items: end;
  padding: var(--space-4);
  background-color: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.batch__dir {
  display: flex;
  gap: var(--space-2);
}

/* 书名来源一格塞了两个开关，竖排避免挤压 */
.batch__title-source {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

/* —— 合并模式说明 —— */
.batch__merge-note {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  color: var(--color-primary-text);
  background-color: var(--color-primary-soft);
  border: 1px solid color-mix(in srgb, var(--color-primary) 28%, transparent);
  border-radius: var(--radius-md);
}

.batch__merge-note-body {
  flex: 1 1 auto;
  min-width: 0;
}

.batch__merge-actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: none;
  align-items: flex-end;
}

.batch__merge-renamed {
  font-weight: var(--weight-regular);
  opacity: 0.85;
}

.batch__merge-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.batch__merge-desc {
  margin-top: 2px;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-secondary);
}

.batch__merge-note .batch__link {
  align-self: flex-start;
  flex: none;
  color: var(--color-primary-text);
}

.batch__dir-input {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--text-xs);
}

.batch__queue {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 260px;
  background-color: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.batch__queue-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--color-border-subtle);
}

.batch__queue-stats {
  display: flex;
  gap: var(--space-4);
  font-size: var(--text-2xs);
  color: var(--color-text-secondary);
}

.batch__ok {
  color: var(--color-success);
}

.batch__fail {
  color: var(--color-danger);
}

.batch__link {
  font-size: var(--text-2xs);
  color: var(--color-text-secondary);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.batch__link:hover:not(:disabled) {
  color: var(--color-text);
}

.batch__link--danger:hover:not(:disabled) {
  color: var(--color-danger);
}

.batch__link:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.jobs {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  overflow-y: auto;
}

.job {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  min-height: 46px;
  border-bottom: 1px solid var(--color-border-subtle);
}

/* —— 合并模式的排序态 —— */
.job--sortable {
  cursor: grab;
}

.job--sortable:active {
  cursor: grabbing;
}

.job--dragging {
  opacity: 0.42;
}

.job--droptarget {
  background-color: var(--color-primary-soft);
  box-shadow: inset 0 2px 0 0 var(--color-primary);
}

.job__grip {
  display: grid;
  place-items: center;
  flex: none;
  color: var(--color-text-muted);
  cursor: grab;
}

.job__order {
  display: grid;
  place-items: center;
  flex: none;
  width: 22px;
  height: 22px;
  font-size: var(--text-2xs);
  color: var(--color-text-secondary);
  background-color: var(--color-bg-sunken);
  border-radius: var(--radius-full);
}

.job__moves {
  display: flex;
  flex: none;
  gap: 2px;
}

/* —— 合并模式：可编辑的章节标题 —— */
.job__title-edit {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.job__title-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  max-width: 100%;
  padding: 2px var(--space-2) 2px 0;
  text-align: left;
  border-radius: var(--radius-sm);
  transition: background-color var(--duration-fast) var(--ease-out);
}

.job__title-btn:hover:not(:disabled) {
  background-color: var(--color-surface-active);
}

.job__title-btn:disabled {
  cursor: default;
}

.job__title-text {
  font-size: var(--text-sm);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 改过名的标题用朱砂色 + 下划线暗示「这是你改的，不是文件名」 */
.job__title-btn--changed .job__title-text {
  color: var(--color-primary-text);
  font-weight: var(--weight-medium);
}

.job__title-pen {
  flex: none;
  color: var(--color-text-muted);
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}

.job__title-btn:hover .job__title-pen,
.job__title-btn:focus-visible .job__title-pen {
  opacity: 1;
}

.job__title-input {
  width: 100%;
  min-height: 30px;
  padding: 4px var(--space-2);
  font-size: var(--text-sm);
  background-color: var(--color-surface);
}

.job__title-reset {
  display: grid;
  place-items: center;
  flex: none;
  width: 22px;
  height: 22px;
  color: var(--color-text-muted);
  border-radius: 4px;
  transition:
    color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.job__title-reset:hover:not(:disabled) {
  color: var(--color-primary-text);
  background-color: var(--color-surface-active);
}

.job__title-reset:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.job__filename {
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  opacity: 0.8;
}

.job__move {
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

.job__move:hover:not(:disabled) {
  color: var(--color-text);
  background-color: var(--color-surface-active);
}

.job__move:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.job:last-child {
  border-bottom: none;
}

.job--failed {
  background-color: color-mix(in srgb, var(--color-danger-soft) 45%, transparent);
}

.job__icon {
  display: grid;
  place-items: center;
  flex: none;
  color: var(--color-text-muted);
}

.job--success .job__icon {
  color: var(--color-success);
}

.job--failed .job__icon {
  color: var(--color-danger);
}

.job--running .job__icon {
  color: var(--color-accent);
}

.job__spin {
  animation: ink-spin 800ms linear infinite;
}

.job__body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1 1 auto;
  min-width: 0;
}

.job__name {
  font-size: var(--text-sm);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.job__meta {
  font-size: var(--text-2xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.job__remove {
  display: grid;
  place-items: center;
  flex: none;
  width: 24px;
  height: 24px;
  color: var(--color-text-muted);
  border-radius: 4px;
}

.job__remove:hover:not(:disabled) {
  color: var(--color-danger);
  background-color: var(--color-danger-soft);
}

.job__remove:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.batch__blank {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-12) var(--space-4);
  color: var(--color-text-muted);
}

.batch__blank-title {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}

.batch__blank-desc {
  font-size: var(--text-xs);
}

.batch__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.batch__foot .hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 56ch;
}

@media (max-width: 1200px) {
  .batch {
    padding: var(--space-5);
  }

  .batch__params {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 940px) {
  .batch__params {
    grid-template-columns: 1fr;
  }
}
</style>
