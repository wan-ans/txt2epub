/**
 * EPUB 编辑工作区（模块单例 store）。
 *
 * 与 useWorkspace 同风格：组件只读 state，所有核心读写都经由
 * src/core/epubPackage.ts。内部持有一份非响应式的 project，
 * 导出时以原始 EPUB 为底做增量写回，未编辑的图片 / 字体 / CSS 原样保留。
 */

import { computed, reactive, ref } from "vue";
import {
  countHtmlWords,
  createBlankEpub,
  detectAndDecode,
  loadRules,
  parseChapters,
  preprocessLines,
  readEpub,
  suggestFileName,
  writeEpub,
  type Chapter,
  type Cover,
  type EpubBookMeta,
  type EpubChapter,
  type EpubProject,
} from "../engine/core";
import { desktop, downloadBytes } from "../../bridge";
import { useToast } from "./useToast";
import { t } from "./useUiLanguage";
import { chapterTitleFromFile, compareNaturally } from "./fileOrdering";

export type EpubPhase = "empty" | "loading" | "ready" | "error";

export interface EpubImportRequest {
  name: string;
  bytes: Uint8Array;
}

export interface EpubAppendFile {
  name: string;
  bytes: Uint8Array;
}

export interface EpubWorkspaceState {
  phase: EpubPhase;
  /** 正在进行的耗时操作描述（loading 态文案） */
  busyLabel: string;
  errorMessage: string;
  sourceName: string;
  meta: EpubBookMeta;
  chapters: EpubChapter[];
  selectedChapterId: string | null;
  cover: Cover | null;
  coverPreviewUrl: string | null;
  exporting: boolean;
  lastExportPath: string | null;
  /** 正文之外的资源数量（图片 / 字体 / CSS 等） */
  resourceCount: number;
  /** 原始 EPUB 字节数 */
  byteLength: number;
  /** 解析耗时（ms） */
  parseMs: number;
}

const DEFAULT_META: EpubBookMeta = {
  title: "",
  author: "",
  language: "zh-CN",
  description: "",
  tags: [],
};

const state = reactive<EpubWorkspaceState>({
  phase: "empty",
  busyLabel: "",
  errorMessage: "",
  sourceName: "",
  meta: { ...DEFAULT_META, tags: [] },
  chapters: [],
  selectedChapterId: null,
  cover: null,
  coverPreviewUrl: null,
  exporting: false,
  lastExportPath: null,
  resourceCount: 0,
  byteLength: 0,
  parseMs: 0,
});

/**
 * 非响应式工程快照：导出时以它为底增量写回。
 * 新建空白书时是 buildEpub 生成的初始包。
 */
let project: EpubProject | null = null;

/** 编辑器注册的「立即落盘」钩子：导出前先把防抖中的正文刷进 store，避免刚打字就点保存丢字。 */
let flushEditorHook: (() => void) | null = null;

export function setEditorFlushHook(hook: (() => void) | null): void {
  flushEditorHook = hook;
}

type ChapterSnapshot = { id: string; title: string; html: string; isNew: boolean };

/**
 * 保存基线：导入 / 新建时取自 project，每次成功导出后推进到当前内容，
 * 这样「已保存」之后 dirty 会回到 false，退出时不会误报未导出改动。
 */
let baselineMeta = "";
let baselineChapters: ChapterSnapshot[] = [];
let baselineCover = "";
const baselineVersion = ref(0);

const toast = useToast();

/* ============================================================
   派生数据
   ============================================================ */

const selectedChapter = computed(
  () => state.chapters.find((chapter) => chapter.id === state.selectedChapterId) ?? null,
);

const selectedIndex = computed(() =>
  state.chapters.findIndex((chapter) => chapter.id === state.selectedChapterId),
);

/** 每章字数缓存：章节对象未变时复用，避免编辑时反复解析整本书。 */
const wordCache = new WeakMap<EpubChapter, number>();

const chapterStats = computed(() => {
  const map = new Map<string, number>();
  for (const chapter of state.chapters) {
    let words = wordCache.get(chapter);
    if (words === undefined) {
      words = countHtmlWords(chapter.html);
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

function metaSignature(meta: EpubBookMeta): string {
  return JSON.stringify([
    meta.title,
    meta.subtitle ?? "",
    meta.author,
    meta.language,
    meta.publisher ?? "",
    meta.publishedAt ?? "",
    meta.description ?? "",
    meta.tags ?? [],
  ]);
}

function coverSignature(cover: Cover | null): string {
  if (!cover) return "";
  return [cover.fileName, cover.mimeType, cover.data.byteLength].join("\u0000");
}

function captureBaseline(): void {
  baselineMeta = metaSignature(state.meta);
  baselineChapters = state.chapters.map((chapter) => ({
    id: chapter.id,
    title: chapter.title,
    html: chapter.html,
    isNew: Boolean(chapter.isNew),
  }));
  baselineCover = coverSignature(state.cover);
  baselineVersion.value += 1;
}

/** 任一章节标题 / 正文改动、新增章节、封面或元信息改动都会置为 true。 */
const dirty = computed(() => {
  // 读取版本号，让保存成功后推进基线能触发重新计算
  void baselineVersion.value;
  if (!project) return false;
  if (metaSignature(state.meta) !== baselineMeta) return true;
  if (coverSignature(state.cover) !== baselineCover) return true;
  if (state.chapters.length !== baselineChapters.length) return true;
  for (let index = 0; index < state.chapters.length; index += 1) {
    const chapter = state.chapters[index];
    const saved = baselineChapters[index];
    if (
      !saved ||
      chapter.id !== saved.id ||
      chapter.title !== saved.title ||
      chapter.html !== saved.html ||
      Boolean(chapter.isNew) !== saved.isNew
    ) {
      return true;
    }
  }
  return false;
});

/* ============================================================
   内部工具
   ============================================================ */

/** core 抛出的 EPUB 错误是中文；英文界面下在显示层做一次映射。 */
function localizeCoreError(message: string): string {
  const exact: Record<string, [string, string]> = {
    "EPUB 内容为空，无法解析": ["EPUB 内容为空，无法解析", "EPUB content is empty and cannot be parsed"],
    "无法解压 EPUB 文件": ["无法解压 EPUB 文件", "Unable to unzip the EPUB file"],
    "EPUB 中找不到 OPF 包文档": ["EPUB 中找不到 OPF 包文档", "No OPF package document found in the EPUB"],
    "缺少 EPUB 工程数据": ["缺少 EPUB 工程数据", "Missing EPUB project data"],
    "找不到 OPF 包文档，无法写回": ["找不到 OPF 包文档，无法写回", "OPF package document not found; cannot write back"],
    "OPF 不是合法的 XML，无法写回": ["OPF 不是合法的 XML，无法写回", "OPF is not valid XML; cannot write back"],
  };
  if (exact[message]) return t(exact[message][0], exact[message][1]);
  const readOpf = message.match(/^无法读取 OPF：(.*)$/);
  if (readOpf) return t(message, `Unable to read OPF: ${readOpf[1]}`);
  const badXml = message.match(/^OPF 不是合法的 XML：(.*)$/);
  if (badXml) return t(message, `OPF is not valid XML: ${badXml[1]}`);
  return message;
}

function setError(message: string): void {
  state.phase = "error";
  state.errorMessage = localizeCoreError(message);
  state.busyLabel = "";
  state.exporting = false;
}

/** 让浏览器先画出 loading 态；后台标签页不触发 rAF 时用定时器兜底。 */
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

function revokeCoverUrl(): void {
  if (state.coverPreviewUrl) {
    URL.revokeObjectURL(state.coverPreviewUrl);
    state.coverPreviewUrl = null;
  }
}

function makeCoverPreview(cover: Cover | null): string | null {
  if (!cover || !cover.data || cover.data.byteLength === 0) return null;
  try {
    return URL.createObjectURL(new Blob([cover.data], { type: cover.mimeType || "image/jpeg" }));
  } catch {
    return null;
  }
}

function chooseChapterAfterRemoval(removedIndex: number, remaining: EpubChapter[]): string | null {
  if (!remaining.length) return null;
  const nextIndex = Math.min(removedIndex, remaining.length - 1);
  return remaining[nextIndex]?.id ?? remaining[0].id;
}

let chapterSeed = 0;

function createChapterId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `new-${crypto.randomUUID()}`;
  }
  chapterSeed += 1;
  return `new-${Date.now()}-${chapterSeed}`;
}

function escapeHtml(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** TXT 行 -> 语义段落 HTML（空行保留为可编辑的空白段）。 */
function linesToHtml(lines: string[]): string {
  return lines
    .map((line) => (line.trim() ? `<p>${escapeHtml(line)}</p>` : "<p><br></p>"))
    .join("");
}

/** 把导入的 TXT / EPUB 内容转成 EpubChapter 草稿，统一使用编辑器可接受的 HTML。 */
function toNewChapter(title: string, html: string, href: string): EpubChapter {
  const cleanTitle = title.trim() || t("新增章节", "New chapter");
  return {
    id: createChapterId(),
    href,
    title: cleanTitle,
    originalTitle: cleanTitle,
    html,
    originalHtml: "",
    linear: true,
    isNew: true,
  };
}

async function parseTxtFile(file: EpubAppendFile): Promise<EpubChapter[]> {
  const read = detectAndDecode(file.bytes);
  const lines = preprocessLines(read.text);
  if (!lines.length) throw new Error(t("没有可读文本", "No readable text"));
  const parsed: Chapter[] = parseChapters(lines, state.meta.language, loadRules());
  const fallbackTitle = chapterTitleFromFile(file.name);
  const list = parsed.length ? parsed : [{ id: "fallback", title: fallbackTitle, lines } as Chapter];
  return list.map((chapter, index) => {
    const title = list.length === 1 && /^(正文|Content)$/i.test(chapter.title) ? fallbackTitle : chapter.title;
    return toNewChapter(
      title,
      linesToHtml(chapter.lines),
      `Text/import-txt-${createChapterId()}-${index + 1}.xhtml`,
    );
  });
}

async function parseEpubFile(file: EpubAppendFile): Promise<EpubChapter[]> {
  const subProject = await readEpub(file.bytes, file.name);
  const base = file.name.replace(/\.epub$/i, "").trim();
  return subProject.chapters.map((chapter, index) => {
    const title = subProject.chapters.length > 1 ? `${base} · ${chapter.title}` : chapter.title || base;
    return toNewChapter(
      title,
      chapter.html,
      `Text/import-epub-${createChapterId()}-${index + 1}.xhtml`,
    );
  });
}

function applyProject(nextProject: EpubProject, request: { name: string }): void {
  project = nextProject;
  revokeCoverUrl();

  state.phase = "ready";
  state.busyLabel = "";
  state.errorMessage = "";
  state.sourceName = request.name;
  state.meta = {
    ...nextProject.meta,
    tags: nextProject.meta.tags ? [...nextProject.meta.tags] : [],
  };
  state.chapters = nextProject.chapters.map((chapter) => ({ ...chapter }));
  state.selectedChapterId = state.chapters[0]?.id ?? null;
  state.cover = nextProject.cover;
  state.coverPreviewUrl = makeCoverPreview(nextProject.cover);
  state.resourceCount = nextProject.resourceCount;
  state.byteLength = nextProject.byteLength;
  state.lastExportPath = null;
  state.exporting = false;
  captureBaseline();
}

function currentMeta(): EpubBookMeta {
  const meta = state.meta;
  return { ...meta, tags: meta.tags ? [...meta.tags] : undefined };
}

/* ============================================================
   Actions
   ============================================================ */

async function importBytes(request: EpubImportRequest): Promise<void> {
  state.phase = "loading";
  state.busyLabel = t("正在解析 EPUB…", "Parsing EPUB…");
  state.errorMessage = "";
  state.lastExportPath = null;
  await nextFrame();

  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  try {
    if (!request.bytes || request.bytes.byteLength === 0) {
      throw new Error(t("文件是空的，读不到任何内容", "The file is empty; no content could be read"));
    }
    const nextProject = await readEpub(request.bytes, request.name);
    const elapsed = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - started);
    applyProject(nextProject, request);
    state.parseMs = elapsed;
    toast.success(t(`已打开 ${request.name}`, `Opened ${request.name}`), {
      detail: t(
        `${state.chapters.length} 章 · ${state.resourceCount} 个原书资源 · ${formatBytes(state.byteLength)}`,
        `${state.chapters.length} chapters · ${state.resourceCount} original resources · ${formatBytes(state.byteLength)}`,
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setError(message);
    toast.error(t("这本 EPUB 没读进来", "This EPUB could not be opened"), { detail: localizeCoreError(message) });
  }
}

async function createBlank(): Promise<void> {
  state.phase = "loading";
  state.busyLabel = t("正在新建空白书…", "Creating a blank book…");
  state.errorMessage = "";
  state.lastExportPath = null;
  await nextFrame();

  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  try {
    const blankMeta: EpubBookMeta = {
      title: t("未命名", "Untitled"),
      author: "",
      language: "zh-CN",
      description: "",
      tags: [],
    };
    const nextProject = await createBlankEpub(blankMeta);
    const elapsed = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - started);
    applyProject(nextProject, { name: `${t("未命名", "Untitled")}.epub` });
    state.parseMs = elapsed;
    toast.success(t("已新建空白书", "Blank book created"), {
      detail: t("书名、作者可在右侧「书籍信息」里修改", "You can edit the title and author under “Book info” on the right"),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setError(message);
    toast.error(t("新建空白书失败", "Failed to create blank book"), { detail: localizeCoreError(message) });
  }
}

function selectChapter(id: string): void {
  if (!state.chapters.some((chapter) => chapter.id === id)) return;
  state.selectedChapterId = id;
}

function renameChapter(id: string, title: string): void {
  const clean = title.trim();
  if (!clean) {
    toast.warning(t("章节标题不能为空", "Chapter title cannot be empty"));
    return;
  }
  const index = state.chapters.findIndex((chapter) => chapter.id === id);
  if (index < 0) return;
  const chapter = state.chapters[index];
  if (chapter.title === clean) return;
  const next = [...state.chapters];
  next[index] = { ...chapter, title: clean };
  state.chapters = next;
}

function updateChapterHtml(id: string, html: string): void {
  const index = state.chapters.findIndex((chapter) => chapter.id === id);
  if (index < 0) return;
  const chapter = state.chapters[index];
  if (chapter.html === html) return;
  const next = [...state.chapters];
  next[index] = { ...chapter, html };
  state.chapters = next;
}

function addChapter(): void {
  if (state.phase !== "ready") return;
  const id = createChapterId();
  const chapter: EpubChapter = {
    id,
    href: `Text/chapter-${id}.xhtml`,
    title: t("新章节", "New chapter"),
    originalTitle: t("新章节", "New chapter"),
    html: "",
    originalHtml: "",
    linear: true,
    isNew: true,
  };
  state.chapters = [...state.chapters, chapter];
  state.selectedChapterId = id;
}

/** 拖入 TXT / EPUB：解析后作为新章节追加到当前书，不触碰原书其他章节。 */
async function appendFiles(files: EpubAppendFile[]): Promise<void> {
  if (!files.length) return;
  if (state.phase !== "ready") {
    toast.warning(t("请先打开一本 EPUB，再追加文件", "Open an EPUB before appending files"));
    return;
  }
  state.busyLabel = t("正在读取追加文件…", "Reading files to append…");
  await nextFrame();

  const ordered = [...files].sort((left, right) => compareNaturally(left.name, right.name));
  const added: EpubChapter[] = [];
  const failures: string[] = [];

  for (const file of ordered) {
    try {
      if (!file.bytes || file.bytes.byteLength === 0) {
        failures.push(t(`${file.name}（空文件）`, `${file.name} (empty file)`));
        continue;
      }
      if (/\.epub$/i.test(file.name)) {
        added.push(...(await parseEpubFile(file)));
      } else if (/\.(txt|text)$/i.test(file.name)) {
        added.push(...(await parseTxtFile(file)));
      } else {
        failures.push(t(`${file.name}（只支持 TXT / EPUB）`, `${file.name} (only TXT / EPUB is supported)`));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(t(`${file.name}（${message}）`, `${file.name} (${localizeCoreError(message)})`));
    }
  }

  state.busyLabel = "";
  if (!added.length) {
    toast.error(t("没有可以追加的内容", "Nothing to append"), { detail: failures.join(t("；", "; ")) || undefined });
    return;
  }

  state.chapters = [...state.chapters, ...added];
  state.selectedChapterId = added[0].id;
  toast.success(t(`已追加 ${added.length} 个章节`, `Appended ${added.length} chapters`), {
    detail: t(
      `${ordered.length} 个文件${failures.length ? `，${failures.length} 个读取失败` : ""}`,
      `${ordered.length} files${failures.length ? `, ${failures.length} failed to read` : ""}`,
    ),
  });
  if (failures.length) {
    toast.warning(t("部分文件没能追加", "Some files could not be appended"), { detail: failures.join(t("；", "; ")), timeout: 8000 });
  }
}

function deleteChapter(id: string): void {
  if (state.chapters.length <= 1) {
    toast.warning(t("至少保留一章", "At least one chapter must remain"));
    return;
  }
  const index = state.chapters.findIndex((chapter) => chapter.id === id);
  if (index < 0) return;

  const remaining = state.chapters.filter((chapter) => chapter.id !== id);
  if (state.selectedChapterId === id) {
    state.selectedChapterId = chooseChapterAfterRemoval(index, remaining);
  }
  state.chapters = remaining;
}

function moveChapter(id: string, toIndex: number): void {
  const from = state.chapters.findIndex((chapter) => chapter.id === id);
  if (from < 0) return;
  const target = Math.max(0, Math.min(state.chapters.length - 1, Math.trunc(toIndex)));
  if (target === from) return;
  const next = [...state.chapters];
  const [chapter] = next.splice(from, 1);
  next.splice(target, 0, chapter);
  state.chapters = next;
}

function updateMeta(patch: Partial<EpubBookMeta>): void {
  if (!patch || Object.keys(patch).length === 0) return;
  state.meta = { ...state.meta, ...patch };
}

function setCover(cover: Cover, previewUrl: string): void {
  revokeCoverUrl();
  state.cover = cover;
  state.coverPreviewUrl = previewUrl;
}

function clearCover(): void {
  revokeCoverUrl();
  state.cover = null;
}

function reset(): void {
  project = null;
  revokeCoverUrl();
  Object.assign(state, {
    phase: "empty",
    busyLabel: "",
    errorMessage: "",
    sourceName: "",
    meta: { ...DEFAULT_META, tags: [] },
    chapters: [],
    selectedChapterId: null,
    cover: null,
    coverPreviewUrl: null,
    exporting: false,
    lastExportPath: null,
    resourceCount: 0,
    byteLength: 0,
    parseMs: 0,
  });
  baselineMeta = "";
  baselineChapters = [];
  baselineCover = "";
  baselineVersion.value += 1;
}

/** 保存 EPUB：桌面端走保存对话框，浏览器端走下载。 */
async function exportEpub(): Promise<void> {
  if (!project) {
    toast.warning(t("还没有可保存的 EPUB", "There is no EPUB to save yet"));
    return;
  }
  if (!state.chapters.length) {
    toast.warning(t("还没有章节可以保存", "There are no chapters to save yet"));
    return;
  }
  if (state.exporting) return;

  state.exporting = true;
  try {
    // 先把编辑器里还在防抖等待的正文写回 state，再取快照。
    flushEditorHook?.();
    const meta = currentMeta();
    const chapters = state.chapters.map((chapter) => ({ ...chapter }));
    const bytes = await writeEpub(project, meta, chapters, { cover: state.cover });
    const suggestedName = suggestFileName(meta);
    const bridge = desktop();

    if (bridge) {
      const result = await bridge.saveEpub({ bytes, suggestedName });
      if (!result) return; // 用户取消
      state.lastExportPath = result.path;
      captureBaseline();
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
      state.lastExportPath = null;
      captureBaseline();
      toast.success(t("EPUB 已开始下载", "EPUB download started"), { detail: suggestedName });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toast.error(t("保存 EPUB 失败", "Failed to save EPUB"), { detail: localizeCoreError(message), timeout: 8000 });
  } finally {
    state.exporting = false;
  }
}

/* ============================================================
   对外导出
   ============================================================ */

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function useEpubWorkspace() {
  return {
    state,
    selectedChapter,
    selectedIndex,
    chapterStats,
    totalWords,
    dirty,

    importBytes,
    createBlank,
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
    reset,
    exportEpub,
    formatBytes,
  };
}