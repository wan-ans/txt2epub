/**
 * 工作区状态（单例 store）。
 * 所有与核心引擎的交互都经由 engine/core.ts，UI 组件只读这个 store 并调用 action。
 */

import { computed, reactive, ref } from "vue";
import {
  buildEpub,
  chapterWordCount,
  detectAndDecode,
  loadRules,
  mergeWithPrevious,
  parseChapters,
  preprocessLines,
  renameChapter,
  saveRules,
  suggestFileName,
  type BookMeta,
  type Chapter,
  type ChapterRule,
  type Cover,
  type EncodingChoice,
  type Language,
  type ReadResult,
  type TypesettingOptions,
} from "../engine/core";
import { desktop, downloadBytes } from "../../bridge";
import { useToast } from "./useToast";
import { t } from "./useUiLanguage";
import { chapterTitleFromFile, compareNaturally } from "./fileOrdering";

export type Phase = "empty" | "loading" | "ready" | "error";

export function encodingOptions(): { value: EncodingChoice; label: string }[] {
  return [
    { value: "auto", label: t("自动检测", "Auto detect") },
    { value: "utf-8", label: "UTF-8" },
    { value: "gb18030", label: "GB18030 / GBK" },
    { value: "big5", label: t("Big5 繁体", "Big5 (Traditional)") },
    { value: "shift_jis", label: t("Shift-JIS 日文", "Shift-JIS (Japanese)") },
    { value: "utf-16le", label: "UTF-16 LE" },
    { value: "utf-16be", label: "UTF-16 BE" },
  ];
}

export const LANGUAGE_OPTIONS: { value: Language; label: string }[] = [
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "en", label: "English" },
];

export const DEFAULT_TYPESETTING: TypesettingOptions = {
  indent: true,
  lineHeight: 1.8,
  fontSize: 1,
  paragraphSpacing: true,
};

const DEFAULT_META: BookMeta = {
  title: "",
  author: "",
  language: "zh-CN",
  description: "",
  tags: [],
};

export interface ImportRequest {
  name: string;
  path?: string;
  bytes: Uint8Array;
}

export interface WorkspaceState {
  phase: Phase;
  errorMessage: string;
  /** 正在进行的耗时操作描述（loading 态文案） */
  busyLabel: string;
  sourceName: string;
  sourcePath: string;
  sourceBytes: Uint8Array | null;
  read: ReadResult | null;
  encodingChoice: EncodingChoice;
  rawLines: string[];
  chapters: Chapter[];
  /** 追加进来的外部 TXT（不参与主文件重解析，单独保管原始字节） */
  appendSources: AppendFilePayload[];
  selectedChapterId: string | null;
  meta: BookMeta;
  cover: Cover | null;
  coverPreviewUrl: string | null;
  typesetting: TypesettingOptions;
  /** 解析耗时（ms），用于显示「解析 88 章 · 96ms」 */
  parseMs: number;
  exporting: boolean;
  lastExportPath: string | null;
}

const state = reactive<WorkspaceState>({
  phase: "empty",
  errorMessage: "",
  busyLabel: "",
  sourceName: "",
  sourcePath: "",
  sourceBytes: null,
  read: null,
  encodingChoice: "auto",
  rawLines: [],
  chapters: [],
  appendSources: [],
  selectedChapterId: null,
  meta: { ...DEFAULT_META, tags: [] },
  cover: null,
  coverPreviewUrl: null,
  typesetting: { ...DEFAULT_TYPESETTING },
  parseMs: 0,
  exporting: false,
  lastExportPath: null,
});

/** 自定义章节规则（持久化到 localStorage，由 core/customRules 负责读写）。 */
const rules = ref<ChapterRule[]>([]);

const toast = useToast();

/* ============================================================
   派生数据
   ============================================================ */

/**
 * 每章字数缓存：章节对象未变时复用，避免编辑单章时重算整本书。
 * 全书字数按章节正文累计，追加章节与合并/改标题后的结果都会如实反映。
 */
const wordCache = new WeakMap<Chapter, number>();

const chapterStats = computed(() => {
  const map = new Map<string, number>();
  for (const chapter of state.chapters) {
    let words = wordCache.get(chapter);
    if (words === undefined) {
      words = chapterWordCount(chapter);
      wordCache.set(chapter, words);
    }
    map.set(chapter.id, words);
  }
  return map;
});

const totalWords = computed(() => {
  let total = 0;
  for (const words of chapterStats.value.values()) total += words;
  return total;
});

const selectedChapter = computed(
  () => state.chapters.find((chapter) => chapter.id === state.selectedChapterId) ?? null,
);

const selectedIndex = computed(() =>
  state.chapters.findIndex((chapter) => chapter.id === state.selectedChapterId),
);

const bookTitle = computed(
  () => state.meta.title.trim() || state.sourceName.replace(/\.txt$/i, "") || t("未命名", "Untitled"),
);

/** 所有来源（主文件 + 追加）的总字节数，用于状态栏「原文件」显示。 */
const totalSourceBytes = computed(() => {
  const main = state.sourceBytes?.byteLength ?? 0;
  const extra = state.appendSources.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  return main + extra;
});

/** 追加进来的来源文件数（0 表示单文件模式）。 */
const appendSourceCount = computed(() => state.appendSources.length);

/* ============================================================
   内部工具
   ============================================================ */

function setError(message: string) {
  state.phase = "error";
  state.errorMessage = message;
  state.busyLabel = "";
}

/**
 * 让浏览器有机会先画出 loading 态，再跑同步解析。
 *
 * 必须带超时兜底：窗口被最小化 / 被遮挡 / 处于后台标签时，浏览器不会触发
 * requestAnimationFrame，只等 rAF 会让导入永远卡在「正在读取并解析文件…」。
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(finish, 120);
    try {
      requestAnimationFrame(() => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

function revokeCoverUrl() {
  if (state.coverPreviewUrl) {
    URL.revokeObjectURL(state.coverPreviewUrl);
    state.coverPreviewUrl = null;
  }
}

function normalizeName(name: string): string {
  return name.replace(/\.(txt|text)$/i, "").trim() || name;
}

/**
 * 从正文开头若干行猜测书名与作者（《书名》 / 书名：xx / 作者：xx）。
 * 只用于填充空字段，用户可以随时改。
 */
function guessMeta(lines: string[]): { title?: string; author?: string } {
  const head = lines.slice(0, 40);
  let title: string | undefined;
  let author: string | undefined;

  for (const raw of head) {
    const line = raw.trim();
    if (!line) continue;
    if (!title) {
      const bracket = line.match(/^《(.{1,40})》$/);
      if (bracket) title = bracket[1].trim();
    }
    if (!title) {
      const named = line.match(/^(?:书\s*名|作品名|title)\s*[:：]\s*(.{1,40})$/i);
      if (named) title = named[1].trim();
    }
    if (!author) {
      const named = line.match(/^(?:作\s*者|著\s*者|author)\s*[:：]\s*(.{1,40})$/i);
      if (named) author = named[1].trim();
    }
    if (title && author) break;
  }

  return { title, author };
}

/** 纯解析：把当前 rawLines 按当前语言 / 规则切成章节（含追加进来的外部 TXT）。 */
function runParse(options: { keepSelection?: boolean } = {}) {
  rebuildChapters(options);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/* ============================================================
   Actions
   ============================================================ */

function initRules() {
  rules.value = loadRules();
}

function persistRules(next: ChapterRule[]) {
  rules.value = next;
  saveRules(next);
}

async function importBytes(request: ImportRequest, options: { encoding?: EncodingChoice } = {}) {
  state.phase = "loading";
  state.busyLabel = t("正在读取并解析文件…", "Reading and parsing file…");
  state.errorMessage = "";
  state.lastExportPath = null;

  await nextFrame();

  try {
    if (!request.bytes || request.bytes.byteLength === 0) {
      throw new Error(t("文件是空的，读不到任何内容", "The file is empty; no content could be read"));
    }
    const choice = options.encoding ?? state.encodingChoice;
    const read = detectAndDecode(request.bytes, choice === "auto" ? undefined : choice);

    const lines = preprocessLines(read.text);
    if (!lines.length) throw new Error(t("文件里没有可用的文本（可能是二进制文件或已损坏）", "No usable text found (the file may be binary or corrupted)"));

    state.sourceBytes = request.bytes;
    state.sourceName = request.name;
    state.sourcePath = request.path ?? "";
    state.read = read;
    state.rawLines = lines;
    // 换主文件 = 开新书，之前追加进来的章节属于旧书，必须清掉
    state.appendSources = [];

    const baseName = normalizeName(request.name);
    state.meta.title = baseName;
    const guessed = guessMeta(lines);
    state.meta.author = guessed.author ?? "";
    if (!state.meta.title && guessed.title) state.meta.title = guessed.title;

    runParse();
    state.phase = "ready";
    state.busyLabel = "";

    toast.success(t(`已解析 ${state.chapters.length} 个章节`, `Parsed ${state.chapters.length} chapters`), {
      detail: `${state.sourceName} · ${formatBytes(request.bytes.byteLength)} · ${read.usedEncoding.toUpperCase()}`,
    });
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
    toast.error(t("导入失败", "Import failed"), { detail: state.errorMessage });
  }
}

/** 切换编码：从原始字节重新解码并解析。 */
async function reimportWithEncoding(choice: EncodingChoice) {
  if (!state.sourceBytes) {
    state.encodingChoice = choice;
    return;
  }
  state.encodingChoice = choice;
  await importBytes(
    { name: state.sourceName, path: state.sourcePath, bytes: state.sourceBytes },
    { encoding: choice },
  );
}

async function setLanguage(language: Language) {
  if (state.meta.language === language) return;
  state.meta.language = language;
  if (state.phase === "ready") {
    runParse({ keepSelection: true });
    toast.info(t(`已按「${LANGUAGE_OPTIONS.find((o) => o.value === language)?.label}」重新分章`, `Re-split chapters using "${LANGUAGE_OPTIONS.find((o) => o.value === language)?.label}"`));
  }
}

function reparse() {
  if (state.phase !== "ready") return;
  runParse({ keepSelection: true });
  toast.success(t(`已重新解析，共 ${state.chapters.length} 章`, `Reparsed into ${state.chapters.length} chapters`));
}

function selectChapter(id: string) {
  state.selectedChapterId = id;
}

function renameChapterTitle(id: string, title: string) {
  const next = renameChapter(state.chapters, id, title);
  if (next === state.chapters) {
    toast.warning(t("章节标题不能为空", "Chapter title cannot be empty"));
    return;
  }
  state.chapters = next;
}

/**
 * 修改章节正文（删减文字）。
 *
 * 只改 state.chapters 里的这一章，不重新解析整个文件 —— 重新解析会把用户的
 * 删改全部冲掉。改动会在下次导出 EPUB 时生效。
 *
 * 不弹 toast：正文是「边打字边自动保存」的，每次都弹会非常吵；
 * 保存反馈由正文上方的「已自动保存」小标签承担。
 */
function updateChapterBody(id: string, lines: string[]) {
  const index = state.chapters.findIndex((chapter) => chapter.id === id);
  if (index < 0) return;
  const chapter = state.chapters[index];
  const next = [...state.chapters];
  next[index] = { ...chapter, lines, bodyEdited: true };
  state.chapters = next;
}

/** 是否有任何手动改动（标题或正文），用于重新解析前的提示 */
const dirtyChapterEdits = computed(
  () =>
    state.chapters.some(
      (chapter) =>
        chapter.bodyEdited ||
        (chapter.originalTitle !== undefined && chapter.title !== chapter.originalTitle),
    ),
);

function mergeChapterWithPrevious(id: string) {
  const index = state.chapters.findIndex((chapter) => chapter.id === id);
  if (index <= 0) {
    toast.warning(t("第一章没有可合并的目标", "The first chapter has nothing to merge into"));
    return;
  }
  const targetTitle = state.chapters[index - 1].title;
  state.chapters = mergeWithPrevious(state.chapters, id);
  state.selectedChapterId = state.chapters[index - 1]?.id ?? null;
  toast.success(t(`已并入「${targetTitle}」`, `Merged into "${targetTitle}"`), { detail: t("正文追加到上一章末尾", "Body text appended to the end of the previous chapter") });
}

/* ------------------------------------------------------------
   追加章节：把额外的 TXT 作为新章节并入当前书
   ------------------------------------------------------------ */

export interface AppendFilePayload {
  name: string;
  bytes: Uint8Array;
}

let appendSeed = 0;
function createChapterId(prefix: string): string {
  appendSeed += 1;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${appendSeed}`;
}

/**
 * 把一个追加的 TXT 解析成章节。
 * 内部能按规则切出多章就尊重它自己的分章；切不开就当成一整章，标题取文件名，
 * 避免「拖进来三个文件，结果三章都叫正文」。
 */
function parseAppendedSource(source: AppendFilePayload, language: Language): Chapter[] {
  const read = detectAndDecode(
    source.bytes,
    state.encodingChoice === "auto" ? undefined : state.encodingChoice,
  );
  const lines = preprocessLines(read.text);
  if (!lines.length) throw new Error(t("没有可读文本", "No readable text"));

  const parsed = parseChapters(lines, language, rules.value);
  const fallbackTitles = new Set(["正文", "Content"]);
  if (parsed.length === 1 && fallbackTitles.has(parsed[0].title)) {
    parsed[0] = { ...parsed[0], title: chapterTitleFromFile(source.name) };
  }
  return parsed.map((chapter) => ({
    ...chapter,
    id: createChapterId("append"),
    // 追加章节不进 rawLines，重新解析时要能原样恢复，所以用 originalTitle 记住
    originalTitle: chapter.title,
  }));
}

/**
 * 主文件章节 + 所有追加来源的章节。
 *
 * 顺序规则（重要）：
 * - **主文件的章节顺序原样保留**，不参与重排 —— 用户可能已经手动改过标题，
 *   按章号重排会把两本书的「第1章」穿插在一起，反而毁掉结构。
 * - 追加内容按「加入批次」的先后接在主文件后面；同一批内按文件名自然序。
 * - 每本书自己的分章顺序由它自己的规则决定，这里不越权干预。
 */
function rebuildChapters(options: { keepSelection?: boolean } = {}): void {
  const started = performance.now();

  const main = parseChapters(state.rawLines, state.meta.language, rules.value);
  const appended: Chapter[] = [];
  for (const source of state.appendSources) {
    try {
      appended.push(...parseAppendedSource(source, state.meta.language));
    } catch {
      // 单个来源失效不影响其它内容
    }
  }

  state.chapters = appended.length ? [...main, ...appended] : main;
  state.parseMs = Math.round(performance.now() - started);

  const stillThere = state.chapters.some((chapter) => chapter.id === state.selectedChapterId);
  if (!options.keepSelection || !stillThere) {
    state.selectedChapterId = state.chapters[0]?.id ?? null;
  }
}

/**
 * 追加一个或多个 TXT 为新章节。
 * 支持「杂乱的多 TXT 合并」：文件先按文件名自然序排好，再逐个解析并入。
 */
async function appendFiles(files: AppendFilePayload[]): Promise<void> {
  if (!files.length) return;
  if (state.phase !== "ready") {
    toast.warning(t("请先打开一本主文件，再往里追加章节", "Open a main file before appending chapters"));
    return;
  }

  state.busyLabel = t("正在读取并切分新增文件…", "Reading and splitting added files…");
  await nextFrame();

  const ordered = [...files].sort((a, b) => compareNaturally(a.name, b.name));
  const accepted: AppendFilePayload[] = [];
  const failures: string[] = [];
  let addedChapters = 0;

  for (const file of ordered) {
    try {
      if (!file.bytes || file.bytes.byteLength === 0) {
        failures.push(t(`${file.name}（空文件）`, `${file.name} (empty file)`));
        continue;
      }
      const count = parseAppendedSource(file, state.meta.language).length;
      accepted.push(file);
      addedChapters += count;
    } catch (error) {
      failures.push(`${file.name}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }

  if (!accepted.length) {
    state.busyLabel = "";
    toast.error(t("没有可以追加的内容", "Nothing to append"), { detail: failures.join(t("；", "; ")) || undefined });
    return;
  }

  const previousSelection = state.selectedChapterId;
  state.appendSources = [...state.appendSources, ...accepted];
  rebuildChapters({ keepSelection: true });

  // 追加后定位到新内容的第一个章节，方便立刻检查
  const appendedOnly = state.chapters.filter((chapter) =>
    chapter.id.startsWith("append-"),
  );
  state.selectedChapterId = appendedOnly[0]?.id ?? previousSelection ?? state.selectedChapterId;

  state.busyLabel = "";
  toast.success(t(`已并入 ${addedChapters} 个章节`, `Appended ${addedChapters} chapters`), {
    detail: t(`${accepted.length} 个文件`, `${accepted.length} files`) + (failures.length ? t(`，${failures.length} 个读取失败`, `, ${failures.length} failed`) : ""),
  });
  if (failures.length) {
    toast.warning(t("部分文件没能读进来", "Some files could not be read"), { detail: failures.join(t("；", "; ")), timeout: 8000 });
  }
}

function updateMeta(patch: Partial<BookMeta>) {
  Object.assign(state.meta, patch);
}

function setCover(cover: Cover | null, previewUrl: string | null) {
  revokeCoverUrl();
  state.cover = cover;
  state.coverPreviewUrl = previewUrl;
}

function clearCover() {
  revokeCoverUrl();
  state.cover = null;
}

function updateTypesetting(patch: Partial<TypesettingOptions>) {
  Object.assign(state.typesetting, patch);
}

function resetTypesetting() {
  Object.assign(state.typesetting, DEFAULT_TYPESETTING);
}

/** 清空工作区，回到空状态。 */
function reset() {
  revokeCoverUrl();
  Object.assign(state, {
    phase: "empty",
    errorMessage: "",
    busyLabel: "",
    sourceName: "",
    sourcePath: "",
    sourceBytes: null,
    read: null,
    encodingChoice: "auto",
    rawLines: [],
    chapters: [],
    appendSources: [],
    selectedChapterId: null,
    meta: { ...DEFAULT_META, tags: [] },
    cover: null,
    coverPreviewUrl: null,
    typesetting: { ...DEFAULT_TYPESETTING },
    parseMs: 0,
    exporting: false,
    lastExportPath: null,
  });
}

/** 生成 EPUB。桌面端走保存对话框，浏览器端走下载。 */
async function exportEpub(): Promise<void> {
  if (!state.chapters.length) {
    toast.warning(t("还没有章节可以导出", "There are no chapters to export yet"));
    return;
  }
  state.exporting = true;
  try {
    const meta: BookMeta = {
      ...state.meta,
      title: bookTitle.value,
      tags: state.meta.tags?.length ? state.meta.tags : undefined,
    };
    const bytes = await buildEpub(meta, state.chapters, {
      cover: state.cover,
      typesetting: state.typesetting,
      includeNcx: true,
    });

    const suggestedName = suggestFileName(meta);
    const bridge = desktop();

    if (bridge) {
      const result = await bridge.saveEpub({ bytes, suggestedName });
      if (!result) return; // 用户取消
      state.lastExportPath = result.path;
      toast.success(t("EPUB 已保存", "EPUB saved"), {
        detail: result.path,
        timeout: 9000,
        action: {
          label: t("打开所在位置", "Show in folder"),
          handler: () => {
            void bridge.revealInExplorer(result.path);
          },
        },
      });
    } else {
      downloadBytes(bytes, suggestedName);
      toast.success(t("EPUB 已开始下载", "EPUB download started"), { detail: suggestedName });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toast.error(t("生成 EPUB 失败", "Failed to generate EPUB"), { detail: message });
  } finally {
    state.exporting = false;
  }
}

/* ============================================================
   对外导出
   ============================================================ */

export function useWorkspace() {
  return {
    state,
    rules,
    totalWords,
    chapterStats,
    selectedChapter,
    selectedIndex,
    dirtyChapterEdits,
    totalSourceBytes,
    appendSourceCount,

    initRules,
    persistRules,
    importBytes,
    reimportWithEncoding,
    setLanguage,
    reparse,
    selectChapter,
    renameChapterTitle,
    updateChapterBody,
    mergeChapterWithPrevious,
    appendFiles,
    updateMeta,
    setCover,
    clearCover,
    updateTypesetting,
    resetTypesetting,
    reset,
    exportEpub,
  };
}
