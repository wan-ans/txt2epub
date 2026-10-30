/**
 * 章节解析：把「行数组」切成章节。
 *
 * 匹配优先级：预置规则（内置、按顺序） > 用户自定义规则（按顺序）。
 * 任一行只要被某条规则命中，它就（且仅）作为一个章节标题。
 *
 * 设计要点（相对参考实现的增强）：
 * - 标题长度上限，避免正文里恰好以「第X章」开头的长段落被误切成标题。
 * - 预置规则覆盖 章/节/回/卷 + Chapter N + 序章/楔子/引子/前言/后记/尾声/番外 等。
 * - 支持 "1.Chapter0---1序" 这类「序号 + Chapter」混排标题。
 * - 章节 id 确定性生成，重新解析（比如切换编码）后 UI 选中项不会错乱。
 * - 0 章节时返回单章「正文」，永不返回空数组。
 */

import type { Chapter, Language } from "../types";
import { fallbackChapterTitle, introChapterTitle } from "./i18n";
import { hasMeaningfulContent } from "./preprocess";
import { compileRule, type ChapterRule, type CompiledRule } from "./customRules";

/** 判定标题行时允许的最大字符数；超过则视为正文。 */
const MAX_TITLE_LENGTH = 120;

/**
 * 正文句子守卫（内嵌进每条预置规则，而不是放在匹配流程里）。
 *
 * 规则：整行「句末标点之前」至少还有 SENTENCE_GUARD_LENGTH 个字符时，不认为它是标题。
 * 即：长度 ≥ N+1 且以句末标点收尾 → 判为正文。
 *
 * 为什么取 8：
 * - 能挡住「第1章的第0段正文内容。」（11 个字符在 。之前）这类以章节标记开头的正文。
 * - 又不会误伤「第1章 你好！」（6 个字符在 ！之前）这类带感叹号的短标题。
 *
 * 之所以内嵌进 pattern：presetRules() 是公开 API，UI 的「命中行数」统计直接用编译后的
 * 正则，守卫必须和解析行为保持一致，否则面板显示 1 行命中、实际却切出 0 章。
 */
const SENTENCE_GUARD_LENGTH = 8;
const SENTENCE_GUARD = `(?!.{${SENTENCE_GUARD_LENGTH},}[。！？；….!?;]$)`;

/** 中文数字字符集（含全角数字、异体字）。 */
const CN_NUM = "0-9０-９零〇○一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾";

/** 标题标记之后允许的标题正文长度上限（不含标记本身），进一步压误判率。 */
const TAIL_LIMIT = 50;

/** 标记与标题之间的合法分隔符（含全角空格与常见括号）。 */
const SEP = "\\s·、，,：:.．\\-—（(\\[【";

/**
 * 预置规则定义。
 * 注意：`pattern` 里用 `^` 锚定行首（preprocessLines 已裁掉行首缩进），
 * 并在其后紧跟 SENTENCE_GUARD 以排除正文句子。
 */
const PRESET_DEFINITIONS: Array<Omit<ChapterRule, "builtin" | "enabled">> = [
  {
    id: "preset-zhang",
    name: "第 N 章",
    mode: "regex",
    // 第1章 / 第一百零三章 风起 / 第１２章：xxx
    pattern: `^${SENTENCE_GUARD}第\\s*[${CN_NUM}]+\\s*章[${SEP}]{0,2}[^\\n]{0,${TAIL_LIMIT}}$`,
  },
  {
    id: "preset-jie",
    name: "第 N 节",
    mode: "regex",
    pattern: `^${SENTENCE_GUARD}第\\s*[${CN_NUM}]+\\s*节[${SEP}]{0,2}[^\\n]{0,${TAIL_LIMIT}}$`,
  },
  {
    id: "preset-hui",
    name: "第 N 回",
    mode: "regex",
    pattern: `^${SENTENCE_GUARD}第\\s*[${CN_NUM}]+\\s*回[${SEP}]{0,2}[^\\n]{0,${TAIL_LIMIT}}$`,
  },
  {
    id: "preset-juan",
    name: "第 N 卷 / 部 / 篇",
    mode: "regex",
    pattern: `^${SENTENCE_GUARD}第\\s*[${CN_NUM}]+\\s*[卷部篇][${SEP}]{0,2}[^\\n]{0,${TAIL_LIMIT}}$`,
  },
  {
    id: "preset-chapter-en",
    name: "Chapter N（含 1.Chapter0---1 混排）",
    mode: "regex",
    // 可选前置序号 "12." / "12、" / "12："，Chapter 后必须紧跟数字
    pattern: `^${SENTENCE_GUARD}(?:\\d{1,6}\\s*[.、．:：]\\s*)?chapter\\s*\\d+[^\\n]{0,${TAIL_LIMIT}}$`,
    flags: "i",
  },
  {
    id: "preset-special-exact",
    name: "序章 / 楔子 / 引子 / 前言 / 后记 / 尾声 / 番外（独占一行）",
    mode: "regex",
    // 只有关键词本身的标题行，这是中文 TXT 里最常见的形式
    pattern:
      "^(?:序章|序言|楔子|引子|序幕|前言|序|后记|後記|尾声|尾聲|终章|終章|番外篇|番外|外传|外傳|附录|附錄|作者的话|作者的話|完本感言)$",
  },
  {
    id: "preset-special-prefixed",
    name: "序章 / 楔子 / 尾声 …（带标题）",
    mode: "regex",
    // 关键词后必须跟分隔符再跟短标题，像「尾声渐渐远去。」这种正文不会被命中
    pattern: `^(?:序章|序言|楔子|引子|序幕|前言|后记|後記|尾声|尾聲|终章|終章|番外篇|番外|外传|外傳|附录|附錄)[${SEP}]+[^\\n]{1,${TAIL_LIMIT}}$`,
  },
  {
    id: "preset-special-numbered",
    name: "番外一 / 外传 2（带编号）",
    mode: "regex",
    pattern: `^(?:番外|外传|外傳|附录|附錄)\\s*[${CN_NUM}]+[${SEP}]{0,2}[^\\n]{0,${TAIL_LIMIT}}$`,
  },
];

/** 预置规则（只读副本，每次调用返回新数组，防止 UI 侧误改内部状态）。 */
export function presetRules(): ChapterRule[] {
  return PRESET_DEFINITIONS.map((definition) => ({
    ...definition,
    enabled: true,
    builtin: true,
  }));
}

/** 编译内置预置规则（模块级缓存，避免每次解析都重新 new RegExp）。 */
let presetCompiled: CompiledRule[] | null = null;

function compiledPresets(): CompiledRule[] {
  if (!presetCompiled) {
    presetCompiled = [];
    for (const definition of PRESET_DEFINITIONS) {
      try {
        presetCompiled.push(compileRule({ ...definition, enabled: true, builtin: true }));
      } catch {
        // 预置规则写错属于开发期错误；跳过以保证解析不崩
      }
    }
  }
  return presetCompiled;
}

/** 编译用户规则，忽略停用与语法错误的条目。 */
function compileUserRules(rules: ChapterRule[]): CompiledRule[] {
  if (!rules || rules.length === 0) return [];
  const out: CompiledRule[] = [];
  const presetIds = new Set(PRESET_DEFINITIONS.map((definition) => definition.id));
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    // 调用方可能把 presetRules() 一并传进来，跳过以免重复编译/重复匹配
    if (rule.builtin && presetIds.has(rule.id)) continue;
    try {
      out.push(compileRule(rule));
    } catch {
      // 单条坏规则不能拖垮整篇解析
    }
  }
  return out;
}

/**
 * 用一组已编译规则判定某行是否是标题，返回标题文本（整行，含已裁剪的首尾空白）。
 * 命中第一条规则即返回；捕获组为空时退回整行匹配。
 */
function matchTitle(line: string, rules: CompiledRule[]): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_TITLE_LENGTH) return null;

  for (const rule of rules) {
    let matched: RegExpMatchArray | null = null;
    try {
      matched = trimmed.match(rule.regex);
    } catch {
      continue;
    }
    if (!matched) continue;

    const capture = rule.capture;
    const picked =
      capture !== undefined && capture > 0 && matched[capture] !== undefined
        ? matched[capture]
        : matched[0];
    const title = String(picked ?? "").trim();
    // 捕获组为空（例如可选分组未参与匹配）时用整行兜底
    return title.length > 0 ? title : trimmed;
  }
  return null;
}

/**
 * 把行数组切成章节。
 *
 * @param lines    预处理后的行（见 preprocessLines）
 * @param language 影响兜底标题与简介标题的语言
 * @param rules    用户自定义规则；预置规则始终生效且优先级更高
 */
export function parseChapters(lines: string[], language: Language, rules?: ChapterRule[]): Chapter[] {
  const safeLines = Array.isArray(lines) ? lines : [];
  const compiled = [...compiledPresets(), ...compileUserRules(rules ?? [])];

  /** 记录每个标题行的位置与标题文本。 */
  const marks: Array<{ index: number; title: string }> = [];
  for (let index = 0; index < safeLines.length; index += 1) {
    const title = matchTitle(safeLines[index], compiled);
    if (title !== null) marks.push({ index, title });
  }

  // 没有任何标题：整篇作为单章，保证 UI 永远有内容可展示
  if (marks.length === 0) {
    const title = fallbackChapterTitle(language);
    return [
      {
        id: "chapter-1",
        title,
        originalTitle: title,
        lines: safeLines.slice(),
      },
    ];
  }

  const chapters: Chapter[] = [];

  // 首个标题之前的内容作为「简介」章节（全空行则忽略）
  const introLines = safeLines.slice(0, marks[0].index);
  if (hasMeaningfulContent(introLines)) {
    const title = introChapterTitle(language);
    chapters.push({
      id: "intro",
      title,
      originalTitle: title,
      lines: introLines,
      isIntro: true,
    });
  }

  for (let order = 0; order < marks.length; order += 1) {
    const start = marks[order];
    const end = order + 1 < marks.length ? marks[order + 1].index : safeLines.length;
    chapters.push({
      // 用「第几个标题」编号而不是数组下标，简介章节就不会挤占正文编号
      id: `chapter-${order + 1}`,
      title: start.title,
      originalTitle: start.title,
      lines: safeLines.slice(start.index + 1, end),
    });
  }

  return chapters;
}

/**
 * 统计规则命中行数（UI 的「测命中」用）。
 * 只统计会被采纳为标题的行（即受标题长度上限约束）。
 */
export function countRuleMatches(lines: string[], rule: ChapterRule): number {
  let compiled: CompiledRule;
  try {
    compiled = compileRule(rule);
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of lines ?? []) {
    if (matchTitle(line, [compiled]) !== null) count += 1;
  }
  return count;
}
