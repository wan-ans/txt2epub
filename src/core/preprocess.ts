/**
 * 文本预处理：把任意 TXT 原文切成「干净的行数组」。
 *
 * 设计要点（与参考实现的差异）：
 * - 统一换行（CRLF / CR / LF / U+2028 / U+2029 → LF）。
 * - 去掉 BOM 与零宽字符，避免它们污染章节标题匹配。
 * - 保留中文全角空格在行内的位置（正文缩进靠 CSS 处理，不靠字符），
 *   但行首缩进会被裁掉，否则「　　第1章」匹配不上预置规则。
 * - 空行保留为 ""，因为空行是排版信息（段落分隔）的一部分。
 */

import type { Chapter } from "../types";

/** 需要从行首裁掉的空白：半角/全角/不间断空格/制表符。 */
const LEADING_BLANKS = /^[\s\u3000\u00a0\ufeff]+/u;
/** 需要从行尾裁掉的空白（不含全角空格：行尾全角空格常是排版残留，一并去掉）。 */
const TRAILING_BLANKS = /[\s\u3000\u00a0\ufeff]+$/u;
/** 零宽字符：BOM、ZWSP、ZWNJ、ZWJ、WJ。 */
const INVISIBLES = /[\ufeff\u200b\u200c\u200d\u2060]/gu;

/** 判断一行是否「有内容」（去空白后非空）。 */
export function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

/**
 * 归一换行符。导出便于测试单独验证。
 */
export function normalizeNewlines(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u2028/g, "\n")
    .replace(/\u2029/g, "\n");
}

/**
 * 把整篇文本切成行。
 *
 * @param text 解码后的原文
 * @returns 已去掉行首尾空白、去掉不可见字符的行数组；空行保留为 ""
 */
export function preprocessLines(text: string): string[] {
  if (!text) return [];
  const normalized = normalizeNewlines(text).replace(INVISIBLES, "");

  return normalized.split("\n").map((raw) => {
    // 行首全角空格是中文 TXT 的缩进习惯，裁掉以便标题正则匹配
    const line = raw.replace(LEADING_BLANKS, "");
    // 行尾空白不承载信息，裁掉可避免比对时的假差异
    return line.replace(TRAILING_BLANKS, "");
  });
}

/** 至少有一行含非空白字符时返回 true。 */
export function hasMeaningfulContent(lines: string[]): boolean {
  if (!lines || lines.length === 0) return false;
  for (const line of lines) {
    if (line && line.trim().length > 0) return true;
  }
  return false;
}

/** 统计非空白字符数（中文习惯的「字数」）。 */
export function countWords(lines: string[]): number {
  if (!lines || lines.length === 0) return 0;
  let total = 0;
  for (const line of lines) {
    if (!line) continue;
    // 只去掉空白字符；标点仍计入（与常见字数统计工具一致）
    total += line.replace(/\s+/gu, "").length;
  }
  return total;
}

/** 去掉行首尾的空白后返回新数组，不改动原数组。 */
export function trimLines(lines: string[]): string[] {
  return lines.map((line) => line.replace(LEADING_BLANKS, "").replace(TRAILING_BLANKS, ""));
}

/** 合并相邻的多个空行，最多保留 max 个（默认 1）。用于排版收敛。 */
export function collapseBlankLines(lines: string[], max = 1): string[] {
  const limit = Math.max(0, Math.floor(max));
  const out: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (isBlankLine(line)) {
      blankRun += 1;
      if (blankRun <= limit) out.push("");
    } else {
      blankRun = 0;
      out.push(line);
    }
  }
  return out;
}

/**
 * 计算整本书的字数（章节正文之和，不含章节标题）。
 * UI 用于「全书统计」，逐章累加时不会重复扫描。
 */
export function countBookWords(chapters: Chapter[]): number {
  let total = 0;
  for (const chapter of chapters) {
    total += countWords(chapter.lines);
  }
  return total;
}


