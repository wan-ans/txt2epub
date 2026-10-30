/**
 * 自定义章节规则：数据模型、编译、校验、序列化、导入与 localStorage 持久化。
 *
 * 全部实现为纯函数；唯一的外部依赖是全局 `localStorage`（不存在时安全降级），
 * 因此同一份代码在浏览器、Electron 渲染进程与 Node 测试环境下都能运行。
 */

/** localStorage 中保存自定义规则的键名。 */
export const STORAGE_KEY = "inkbox:customChapterRules";

export type ChapterRuleMode = "regex" | "keyword";
export type KeywordTemplate = "prefix" | "anywhere";

export interface ChapterRule {
  id: string;
  name: string;
  mode: ChapterRuleMode;
  pattern: string;
  flags?: string;
  capture?: number;
  keywordTemplate?: KeywordTemplate;
  enabled: boolean;
  /** true 表示预置规则，不可删除（UI 只读展示） */
  builtin?: boolean;
}

export interface CompiledRule {
  regex: RegExp;
  capture?: number;
}

/** RegExp 允许的标志位（u 与 v 互斥）。 */
const VALID_FLAGS = "dgimsuvy";
/** 章节匹配是「逐行单次匹配」，全局/粘滞标志会带来 lastIndex 状态，编译时剔除。 */
const STATEFUL_FLAGS = /[gy]/g;

/**
 * 生成规则 id。优先用 crypto.randomUUID，缺失时退回时间戳 + 随机串。
 */
export function createRuleId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 转义正则元字符。 */
export function escapeRegex(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * 关键词 → 正则源码。
 *
 * 关键词以 `|` 或换行分隔；空 token 与重复 token 会被丢弃。
 * - prefix:   `^(甲|乙).*$`  —— 行首命中（默认）
 * - anywhere: `^.*(甲|乙).*$` —— 行内任意位置命中
 *
 * 无有效关键词时抛出异常（由 validateRule 转为友好错误）。
 */
export function keywordToRegexSource(keywords: string, template: KeywordTemplate = "prefix"): string {
  const tokens = String(keywords ?? "")
    .split(/[|\n\r]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    throw new Error("关键词不能为空");
  }

  // 去重但保留首次出现的顺序，保证生成的正则稳定可测
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const escaped = escapeRegex(token);
    if (seen.has(escaped)) continue;
    seen.add(escaped);
    unique.push(escaped);
  }

  const alternation = unique.join("|");
  return template === "anywhere" ? `^.*(${alternation}).*$` : `^(${alternation}).*$`;
}

/** 整理标志位：去重、剔除非法字符与 g/y。非法标志由 validateRule 报告。 */
function sanitizeFlags(flags: string | undefined): string {
  if (!flags) return "";
  let out = "";
  for (const flag of flags) {
    if (!VALID_FLAGS.includes(flag)) continue;
    if (STATEFUL_FLAGS.test(flag)) continue;
    if (out.includes(flag)) continue;
    out += flag;
  }
  // u 与 v 不能共存，保留先出现的那个
  if (out.includes("u") && out.includes("v")) {
    out = out.replace("v", "");
  }
  return out;
}

/** 校验标志位是否合法（供 validateRule 使用，需在 sanitize 之前判断）。 */
function findInvalidFlag(flags: string | undefined): string | null {
  if (!flags) return null;
  const seen = new Set<string>();
  for (const flag of flags) {
    if (!VALID_FLAGS.includes(flag)) return flag;
    if (seen.has(flag)) return flag;
    seen.add(flag);
  }
  if (seen.has("u") && seen.has("v")) return "v";
  return null;
}

/**
 * 把规则编译成可用于逐行匹配的正则。
 * 正则模式直接 new RegExp；关键词模式先翻译成正则源码。
 * 语法错误会抛出异常（调用方决定是否吞掉）。
 */
export function compileRule(rule: ChapterRule): CompiledRule {
  if (!rule || (rule.mode !== "regex" && rule.mode !== "keyword")) {
    throw new Error("规则模式必须是 regex 或 keyword");
  }
  if (typeof rule.pattern !== "string" || rule.pattern.trim().length === 0) {
    throw new Error(rule.mode === "keyword" ? "关键词不能为空" : "正则不能为空");
  }

  if (rule.mode === "keyword") {
    const source = keywordToRegexSource(rule.pattern, rule.keywordTemplate ?? "prefix");
    return { regex: new RegExp(source), capture: rule.capture };
  }

  const regex = new RegExp(rule.pattern, sanitizeFlags(rule.flags));
  return { regex, capture: rule.capture };
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

/** 校验规则是否可编译。UI 在保存前调用，返回中文错误信息。 */
export function validateRule(rule: ChapterRule): ValidationResult {
  if (!rule || typeof rule !== "object") {
    return { ok: false, error: "规则格式不正确" };
  }
  if (rule.mode !== "regex" && rule.mode !== "keyword") {
    return { ok: false, error: "规则模式必须是 regex 或 keyword" };
  }
  if (typeof rule.name !== "string" || rule.name.trim().length === 0) {
    return { ok: false, error: "名称不能为空" };
  }
  if (typeof rule.pattern !== "string" || rule.pattern.trim().length === 0) {
    return { ok: false, error: rule.mode === "keyword" ? "关键词不能为空" : "正则不能为空" };
  }
  const invalidFlag = findInvalidFlag(rule.flags);
  if (invalidFlag) {
    return { ok: false, error: `不支持的标志位：${invalidFlag}` };
  }
  if (rule.mode === "keyword") {
    if (rule.keywordTemplate && rule.keywordTemplate !== "prefix" && rule.keywordTemplate !== "anywhere") {
      return { ok: false, error: "关键词模板不正确" };
    }
  }
  if (rule.capture !== undefined) {
    if (!Number.isInteger(rule.capture) || rule.capture < 0 || rule.capture > 99) {
      return { ok: false, error: "捕获组编号必须是 0-99 的整数" };
    }
  }
  try {
    compileRule(rule);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true };
}

/** 宽松地把未知 JSON 实体规整成 ChapterRule；非法条目返回 null。 */
function normalizeRule(raw: unknown, options: { keepId: boolean }): ChapterRule | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const mode = record.mode === "regex" || record.mode === "keyword" ? record.mode : null;
  if (!mode) return null;
  if (typeof record.name !== "string" || typeof record.pattern !== "string") return null;
  // 与 validateRule 保持一致：没有名称或没有 pattern 的规则无法使用
  if (record.name.trim().length === 0) return null;
  if (record.pattern.trim().length === 0) return null;

  const template =
    record.keywordTemplate === "prefix" || record.keywordTemplate === "anywhere"
      ? record.keywordTemplate
      : undefined;
  const capture =
    typeof record.capture === "number" && Number.isInteger(record.capture) && record.capture >= 0
      ? record.capture
      : undefined;

  return {
    id: options.keepId && typeof record.id === "string" && record.id ? record.id : createRuleId(),
    name: record.name,
    mode,
    pattern: record.pattern,
    flags: typeof record.flags === "string" && record.flags ? record.flags : undefined,
    capture,
    keywordTemplate: template,
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    // 导入/持久化的规则永远不是预置规则
    builtin: undefined,
  };
}

/** 序列化为带缩进的 JSON，方便用户手改与版本管理。 */
export function serializeRules(rules: ChapterRule[]): string {
  const plain = (rules ?? []).map((rule) => ({
    id: rule.id,
    name: rule.name,
    mode: rule.mode,
    pattern: rule.pattern,
    ...(rule.flags ? { flags: rule.flags } : {}),
    ...(rule.capture !== undefined ? { capture: rule.capture } : {}),
    ...(rule.keywordTemplate ? { keywordTemplate: rule.keywordTemplate } : {}),
    enabled: rule.enabled,
  }));
  return JSON.stringify(plain, null, 2);
}

/**
 * 导入规则 JSON。
 * 既接受根节点为数组，也接受 `{ rules: [...] }` 包装（方便用户手工整理）。
 * 所有导入规则的 id 会重新生成以避免冲突；非法条目被跳过。
 */
export function parseImportedRules(json: string): ChapterRule[] {
  const data: unknown = JSON.parse(json);
  const list: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).rules)
      ? ((data as Record<string, unknown>).rules as unknown[])
      : (() => {
          throw new Error("JSON 根节点必须是规则数组");
        })();

  const out: ChapterRule[] = [];
  for (const raw of list) {
    const rule = normalizeRule(raw, { keepId: false });
    if (rule) out.push(rule);
  }
  return out;
}

/** 读取 localStorage 里的自定义规则；环境没有 localStorage 或数据损坏时返回 []。 */
export function loadRules(): ChapterRule[] {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const out: ChapterRule[] = [];
    for (const item of data) {
      const rule = normalizeRule(item, { keepId: true });
      if (rule) out.push(rule);
    }
    return out;
  } catch {
    return [];
  }
}

/** 写入 localStorage；配额溢出或环境禁用时静默失败，不打断转换流程。 */
export function saveRules(rules: ChapterRule[]): void {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return;
    localStorage.setItem(STORAGE_KEY, serializeRules(rules ?? []));
  } catch {
    // 隐私模式 / 配额不足：规则不持久化，但本次会话仍可用
  }
}
