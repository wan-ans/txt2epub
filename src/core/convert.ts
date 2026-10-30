/**
 * 一站式封装：TXT 字节流 → ConvertResult（含 EPUB 字节）。
 *
 * 单文件转换与批量转换共用同一入口，UI 只需 await 一次。
 * 本模块把所有步骤串起来：解码 → 预处理 → 解析章节 → 生成 EPUB。
 */

import type {
  BookMeta,
  Chapter,
  ConvertResult,
  Cover,
  EncodingChoice,
  Language,
  ReadResult,
  TypesettingOptions,
} from "../types";
import { buildEpub, suggestFileName } from "./epubBuilder";
import { countWords, preprocessLines } from "./preprocess";
import { parseChapters } from "./chapterParser";
import { detectAndDecode } from "./textReader";
import type { ChapterRule } from "./customRules";

export interface ConvertInput {
  sourceName: string;
  bytes: Uint8Array;
}

export interface ConvertOptions {
  meta?: Partial<BookMeta>;
  encoding?: EncodingChoice;
  rules?: ChapterRule[];
  cover?: Cover | null;
  typesetting?: Partial<TypesettingOptions>;
  language?: Language;
}

/**
 * convertTxt 的详细结果：除契约要求的 ConvertResult 之外，
 * 额外暴露中间产物（解码结果、章节列表、规范化后的书目元信息），
 * 让 UI 在「转换完成」之后还能展示编码信息、字数、章节预览，而无需重复解析。
 */
export interface ConvertDetail extends ConvertResult {
  read: ReadResult;
  chapters: Chapter[];
  meta: BookMeta;
  /** 实际使用的章节条数（= chapters.length，便于 UI 直接读取） */
  chapterCount: number;
  wordCount: number;
}

/** 文件名去扩展名，作为默认书名。 */
function stripExtension(fileName: string): string {
  const base = String(fileName ?? "").split(/[\\/]/).pop() ?? "";
  const withoutExt = base.replace(/\.[^./\\]+$/, "");
  const trimmed = withoutExt.trim();
  return trimmed.length > 0 ? trimmed : base.trim();
}

/** 把可选的 BookMeta 补全成完整对象。 */
export function resolveMeta(meta: Partial<BookMeta> | undefined, sourceName: string, language: Language): BookMeta {
  const title = meta?.title?.trim() || stripExtension(sourceName);
  return {
    title,
    author: meta?.author?.trim() ?? "",
    language: meta?.language ?? language,
    ...(meta?.publisher?.trim() ? { publisher: meta.publisher.trim() } : {}),
    ...(meta?.description?.trim() ? { description: meta.description.trim() } : {}),
    ...(meta?.tags && meta.tags.length > 0 ? { tags: meta.tags.map((tag) => String(tag)).filter((tag) => tag.trim().length > 0) } : {}),
  };
}

/**
 * 解析 TXT 字节流，不做 EPUB 生成。
 * UI 的「切换编码即时重解析」走这条路，可以只重算章节而不重新打包。
 */
export function parseTxt(
  input: ConvertInput,
  options?: Omit<ConvertOptions, "cover" | "typesetting">,
): { read: ReadResult; lines: string[]; chapters: Chapter[]; meta: BookMeta; wordCount: number } {
  const language = options?.language ?? options?.meta?.language ?? "zh-CN";
  const read = detectAndDecode(input?.bytes ?? new Uint8Array(0), options?.encoding ?? "auto");
  const lines = preprocessLines(read.text);
  const chapters = parseChapters(lines, language, options?.rules);
  const meta = resolveMeta(options?.meta, input?.sourceName ?? "", language);
  const wordCount = chapters.reduce((sum, chapter) => sum + countWords(chapter.lines), 0);
  return { read, lines, chapters, meta, wordCount };
}

/**
 * 解析 + 生成 EPUB，返回完整结果（不落盘、不触碰 DOM）。
 * 大批量转换时请逐个 await（或分批并发），避免同时压缩多本导致内存峰值。
 */
export async function convertTxt(input: ConvertInput, options?: ConvertOptions): Promise<ConvertDetail> {
  const language = options?.language ?? options?.meta?.language ?? "zh-CN";
  const sourceName = input?.sourceName ?? "untitled.txt";
  const parsed = parseTxt(input, { ...options, language });

  const meta: BookMeta = {
    ...parsed.meta,
    language: options?.meta?.language ?? language,
  };

  const bytes = await buildEpub(meta, parsed.chapters, {
    cover: options?.cover ?? null,
    typesetting: options?.typesetting,
  });

  return {
    sourceName,
    outputName: suggestFileName(meta),
    byteLength: bytes.byteLength,
    chapterCount: parsed.chapters.length,
    wordCount: parsed.wordCount,
    bytes,
    read: parsed.read,
    chapters: parsed.chapters,
    meta,
  };
}
