/**
 * 引擎适配层（Engine Adapter）
 *
 * 唯一允许触碰 src/core 的地方，全部按 docs/CONTRACT.md 第 1 节的签名调用。
 * 另外承担两件纯 UI 侧的事情（契约没有覆盖，也不该塞进 core）：
 *  1. 章节编辑操作：改名 / 合并 —— 用纯函数在 UI 层组合。
 *  2. 统一 re-export，让组件只依赖这一个模块，避免到处散落 ../../core/xxx。
 */

import { convertTxt, type ConvertInput, type ConvertOptions } from "../../core/convert";
import {
  compileRule,
  createRuleId,
  loadRules,
  parseImportedRules,
  saveRules,
  serializeRules,
  validateRule,
  type ChapterRule,
  type ChapterRuleMode,
  type KeywordTemplate,
} from "../../core/customRules";
import { countRuleMatches, parseChapters, presetRules } from "../../core/chapterParser";
import { buildEpub, suggestFileName, toEpubBlob } from "../../core/epubBuilder";
import {
  countHtmlWords,
  createBlankEpub,
  isEpubFileName,
  readEpub,
  writeEpub,
} from "../../core/epubPackage";
import { detectAndDecode, normalizeEncoding } from "../../core/textReader";
import { countWords, hasMeaningfulContent, preprocessLines } from "../../core/preprocess";
import type {
  BookMeta,
  BuildEpubOptions,
  Chapter,
  ConvertResult,
  Cover,
  EncodingChoice,
  EpubBookMeta,
  EpubChapter,
  EpubProject,
  Language,
  ReadResult,
  TypesettingOptions,
  WriteEpubOptions,
} from "../../types";

export type {
  BookMeta,
  BuildEpubOptions,
  Chapter,
  ChapterRule,
  ChapterRuleMode,
  ConvertInput,
  ConvertOptions,
  ConvertResult,
  Cover,
  EncodingChoice,
  EpubBookMeta,
  EpubChapter,
  EpubProject,
  KeywordTemplate,
  Language,
  ReadResult,
  TypesettingOptions,
  WriteEpubOptions,
};

export {
  buildEpub,
  compileRule,
  convertTxt,
  countHtmlWords,
  countRuleMatches,
  countWords,
  createBlankEpub,
  createRuleId,
  detectAndDecode,
  hasMeaningfulContent,
  isEpubFileName,
  loadRules,
  normalizeEncoding,
  parseChapters,
  parseImportedRules,
  preprocessLines,
  presetRules,
  readEpub,
  saveRules,
  serializeRules,
  suggestFileName,
  toEpubBlob,
  validateRule,
  writeEpub,
};

/* ============================================================
   章节编辑操作（UI 层纯函数）
   ============================================================ */

export function renameChapter(chapters: Chapter[], id: string, title: string): Chapter[] {
  const clean = title.trim();
  if (!clean) return chapters;
  return chapters.map((chapter) => (chapter.id === id ? { ...chapter, title: clean } : chapter));
}

/**
 * 与上一章合并：把当前章并入上一章，标题保留上一章的。
 * 中间补一个空行，避免阅读器里两段黏在一起。
 */
export function mergeWithPrevious(chapters: Chapter[], id: string): Chapter[] {
  const index = chapters.findIndex((chapter) => chapter.id === id);
  if (index <= 0) return chapters;
  const prev = chapters[index - 1];
  const current = chapters[index];
  const separator = prev.lines.length && current.lines.length ? [""] : [];
  const merged: Chapter = {
    ...prev,
    lines: [...prev.lines, ...separator, ...current.lines],
    isIntro: prev.isIntro || current.isIntro,
  };
  return [...chapters.slice(0, index - 1), merged, ...chapters.slice(index + 1)];
}

/** 统计章节字数（与核心 countWords 同口径：去掉空白后的字符数）。 */
export function chapterWordCount(chapter: Chapter): number {
  return countWords(chapter.lines);
}