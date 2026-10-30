import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STORAGE_KEY,
  compileRule,
  createRuleId,
  escapeRegex,
  keywordToRegexSource,
  loadRules,
  parseImportedRules,
  saveRules,
  serializeRules,
  validateRule,
  type ChapterRule,
} from "./customRules";

const baseRule = (patch: Partial<ChapterRule> = {}): ChapterRule => ({
  id: "r1",
  name: "测试规则",
  mode: "regex",
  pattern: "^第\\d+章",
  enabled: true,
  ...patch,
});

describe("createRuleId", () => {
  it("生成的 id 非空且基本唯一", () => {
    const ids = new Set(Array.from({ length: 50 }, () => createRuleId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });
});

describe("escapeRegex", () => {
  it("转义全部正则元字符", () => {
    expect(escapeRegex(".*+?^${}()|[]\\/")).toBe("\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\\\/");
  });

  it("普通文字不变", () => {
    expect(escapeRegex("第一章")).toBe("第一章");
  });
});

describe("keywordToRegexSource", () => {
  it("按 | 分隔", () => {
    expect(keywordToRegexSource("序|楔子|后记")).toBe("^(序|楔子|后记).*$");
  });

  it("按换行分隔", () => {
    expect(keywordToRegexSource("序\n楔子\n后记")).toBe("^(序|楔子|后记).*$");
  });

  it("混合分隔符", () => {
    expect(keywordToRegexSource("序|楔子\n后记")).toBe("^(序|楔子|后记).*$");
  });

  it("裁剪空白并丢弃空 token", () => {
    expect(keywordToRegexSource("  序 | \n 楔子 |")).toBe("^(序|楔子).*$");
  });

  it("转义关键词里的正则元字符", () => {
    expect(keywordToRegexSource("(序)|.txt|\\路径")).toBe("^(\\(序\\)|\\.txt|\\\\路径).*$");
  });

  it("去重且保留首次出现顺序", () => {
    expect(keywordToRegexSource("序|序|楔子|序")).toBe("^(序|楔子).*$");
  });

  it("anywhere 模板", () => {
    expect(keywordToRegexSource("序", "anywhere")).toBe("^.*(序).*$");
  });

  it("没有有效关键词时抛错", () => {
    expect(() => keywordToRegexSource("")).toThrow();
    expect(() => keywordToRegexSource("|||")).toThrow();
    expect(() => keywordToRegexSource("  \n  ")).toThrow();
  });

  it("生成的正则能真正匹配", () => {
    const compiled = compileRule(baseRule({ mode: "keyword", pattern: "序|楔子" }));
    expect(compiled.regex.test("序章 开始")).toBe(true);
    expect(compiled.regex.test("楔子：雨夜")).toBe(true);
    expect(compiled.regex.test("第一章")).toBe(false);
    // 无 u 标志时 lastIndex 不受影响，重复 test 结果稳定
    expect(compiled.regex.test("序章 开始")).toBe(true);
  });
});

describe("compileRule", () => {
  it("编译正则模式并保留 flags", () => {
    const compiled = compileRule(baseRule({ pattern: "^chapter\\s+\\d+", flags: "i" }));
    expect(compiled.regex.flags).toContain("i");
    expect(compiled.regex.test("Chapter 5 Title")).toBe(true);
  });

  it("剔除有状态的 g / y 标志，保证重复匹配稳定", () => {
    const compiled = compileRule(baseRule({ pattern: "^第\\d+章", flags: "gim" }));
    expect(compiled.regex.flags).not.toContain("g");
    expect(compiled.regex.test("第1章")).toBe(true);
    expect(compiled.regex.test("第1章")).toBe(true);
  });

  it("保留 capture 索引", () => {
    expect(compileRule(baseRule({ pattern: "^(Chapter \\d+)", capture: 1 })).capture).toBe(1);
  });

  it("关键词前缀模板只匹配行首", () => {
    const compiled = compileRule(baseRule({ mode: "keyword", pattern: "序|楔子" }));
    expect(compiled.regex.test("序章开始")).toBe(true);
    expect(compiled.regex.test("这是楔子")).toBe(false);
  });

  it("关键词 anywhere 模板能匹配行内", () => {
    const compiled = compileRule(baseRule({ mode: "keyword", pattern: "后记", keywordTemplate: "anywhere" }));
    expect(compiled.regex.test("这是后记内容")).toBe(true);
  });

  it("非法正则抛错", () => {
    expect(() => compileRule(baseRule({ pattern: "(" }))).toThrow();
    expect(() => compileRule(baseRule({ pattern: "[" }))).toThrow();
  });

  it("空 pattern 抛错", () => {
    expect(() => compileRule(baseRule({ pattern: "   " }))).toThrow();
  });

  it("非法 mode 抛错", () => {
    expect(() => compileRule(baseRule({ mode: "weird" as ChapterRule["mode"] }))).toThrow();
  });
});

describe("validateRule", () => {
  it("拒绝空名称", () => {
    expect(validateRule(baseRule({ name: "" })).ok).toBe(false);
    expect(validateRule(baseRule({ name: "   " })).ok).toBe(false);
  });

  it("拒绝空 pattern", () => {
    const rejected = validateRule(baseRule({ pattern: "" }));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain("正则");
  });

  it("拒绝非法正则并给出错误信息", () => {
    const rejected = validateRule(baseRule({ pattern: "(" }));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.length).toBeGreaterThan(0);
  });

  it("拒绝非法 flags", () => {
    expect(validateRule(baseRule({ flags: "z" })).ok).toBe(false);
    expect(validateRule(baseRule({ flags: "gg" })).ok).toBe(false);
    expect(validateRule(baseRule({ flags: "uv" })).ok).toBe(false);
  });

  it("拒绝超范围的 capture", () => {
    expect(validateRule(baseRule({ capture: -1 })).ok).toBe(false);
    expect(validateRule(baseRule({ capture: 1.5 })).ok).toBe(false);
  });

  it("接受合法正则", () => {
    expect(validateRule(baseRule()).ok).toBe(true);
    expect(validateRule(baseRule({ flags: "im" })).ok).toBe(true);
  });

  it("接受合法关键词", () => {
    expect(validateRule(baseRule({ mode: "keyword", pattern: "序|楔子" })).ok).toBe(true);
  });

  it("拒绝只有空 token 的关键词", () => {
    const rejected = validateRule(baseRule({ mode: "keyword", pattern: "|||" }));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain("关键词");
  });

  it("拒绝非法 keywordTemplate", () => {
    expect(
      validateRule(baseRule({ mode: "keyword", keywordTemplate: "middle" as "prefix" })).ok,
    ).toBe(false);
  });
});

describe("serializeRules / parseImportedRules", () => {
  it("导出再导入保持语义，且导入会重新生成 id", () => {
    const rules: ChapterRule[] = [
      baseRule({ id: "a", name: "正则", pattern: "^X", flags: "i" }),
      baseRule({ id: "b", name: "关键词", mode: "keyword", pattern: "序|楔子", keywordTemplate: "prefix", enabled: false }),
    ];
    const parsed = parseImportedRules(serializeRules(rules));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe("正则");
    expect(parsed[0].pattern).toBe("^X");
    expect(parsed[0].flags).toBe("i");
    expect(parsed[1].enabled).toBe(false);
    expect(parsed[1].keywordTemplate).toBe("prefix");
    expect(parsed[0].id).not.toBe("a");
    expect(parsed[1].id).not.toBe("b");
  });

  it("序列化结果里不含 builtin 字段（导出的是用户规则）", () => {
    const json = serializeRules([baseRule({ builtin: true })]);
    expect(json).not.toContain("builtin");
  });

  it("序列化结果是合法且易读的 JSON", () => {
    const json = serializeRules([baseRule()]);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).toContain("\n");
  });

  it("根节点不是数组时抛错", () => {
    expect(() => parseImportedRules('{"x":1}')).toThrow();
    expect(() => parseImportedRules("null")).toThrow();
    expect(() => parseImportedRules("42")).toThrow();
  });

  it("支持 { rules: [...] } 包装", () => {
    const json = JSON.stringify({ rules: [baseRule()] });
    expect(parseImportedRules(json)).toHaveLength(1);
  });

  it("跳过非法条目但保留合法条目", () => {
    const json = JSON.stringify([
      { id: "a", name: "ok", mode: "regex", pattern: "^a", enabled: true },
      { id: "b", mode: "unknown", pattern: "x", name: "bad-mode" },
      null,
      "not-an-object",
      { id: "c", name: "", mode: "regex", pattern: "^x" },
      { id: "d", name: "empty-pattern", mode: "regex", pattern: "  " },
      { id: "e", name: "ok2", mode: "keyword", pattern: "序", enabled: true },
    ]);
    const parsed = parseImportedRules(json);
    expect(parsed.map((r) => r.name)).toEqual(["ok", "ok2"]);
  });

  it("缺省 enabled 时默认 true", () => {
    const parsed = parseImportedRules(JSON.stringify([{ id: "a", name: "n", mode: "regex", pattern: "^a" }]));
    expect(parsed[0].enabled).toBe(true);
  });

  it("非法 JSON 文本抛错", () => {
    expect(() => parseImportedRules("{oops")).toThrow();
  });
});

describe("loadRules / saveRules（localStorage）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("无 localStorage 环境（Node 默认）下 loadRules 返回 []、saveRules 不抛错", () => {
    expect(typeof globalThis.localStorage).toBe("undefined");
    expect(loadRules()).toEqual([]);
    expect(() => saveRules([baseRule()])).not.toThrow();
  });

  it("有 localStorage 时能持久化再读回", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    });

    const rules = [baseRule({ id: "keep-1", name: "持久化" })];
    saveRules(rules);
    expect(store.get(STORAGE_KEY)).toBeTruthy();

    const loaded = loadRules();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("keep-1");
    expect(loaded[0].name).toBe("持久化");
  });

  it("localStorage 内容损坏时返回 [] 而不抛错", () => {
    const store = new Map<string, string>([[STORAGE_KEY, "{broken"]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    });
    expect(loadRules()).toEqual([]);
  });

  it("localStorage 写入抛错（配额不足）时被吞掉", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    });
    expect(() => saveRules([baseRule()])).not.toThrow();
  });
});
