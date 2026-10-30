/**
 * 核心逻辑内部用的多语言文案。
 * 只服务于「生成物」（章节兜底标题、目录标题等），与 UI 文案互不影响。
 */

import type { Language } from "../types";

/** 解析不到任何章节时使用的兜底章节名。 */
export function fallbackChapterTitle(language: Language): string {
  return language === "en" ? "Content" : "正文";
}

/** 首个章节标记之前的「简介」章节名。 */
export function introChapterTitle(language: Language): string {
  if (language === "en") return "Introduction";
  if (language === "zh-TW") return "簡介";
  return "简介";
}

/** EPUB nav.xhtml 的目录标题。 */
export function tocTitle(language: Language): string {
  return language === "en" ? "Contents" : "目录";
}

/** 封面页的替代文本用词。 */
export function coverLabel(language: Language): string {
  if (language === "en") return "Cover";
  if (language === "zh-TW") return "封面";
  return "封面";
}

/** 没有书名时的占位书名。 */
export function untitledBook(language: Language): string {
  return language === "en" ? "Untitled" : "未命名";
}
