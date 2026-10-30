import { describe, expect, it } from "vitest";
import { countRuleMatches, parseChapters, presetRules } from "./chapterParser";
import { compileRule, validateRule, type ChapterRule } from "./customRules";
import type { Chapter, Language } from "../types";

const lang: Language = "zh-CN";

function titles(chapters: Chapter[]): string[] {
  return chapters.map((chapter) => chapter.title);
}

/** 取出预置规则里能匹配给定行的那些。 */
function presetsMatching(line: string): string[] {
  return presetRules()
    .filter((rule) => {
      const compiled = compileRule(rule);
      return compiled.regex.test(line);
    })
    .map((rule) => rule.id);
}

function userRule(patch: Partial<ChapterRule> = {}): ChapterRule {
  return {
    id: "user-1",
    name: "用户规则",
    mode: "regex",
    pattern: "^序章",
    enabled: true,
    ...patch,
  };
}

describe("presetRules", () => {
  it("返回非空数组，且每一条都可编译、带 builtin 标记", () => {
    const rules = presetRules();
    expect(rules.length).toBeGreaterThanOrEqual(5);
    for (const rule of rules) {
      expect(rule.builtin).toBe(true);
      expect(rule.enabled).toBe(true);
      expect(validateRule(rule).ok).toBe(true);
    }
  });

  it("id 唯一", () => {
    const ids = presetRules().map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每次调用返回新数组，改动不会污染后续调用", () => {
    const first = presetRules();
    first[0].name = "被改了";
    expect(presetRules()[0].name).not.toBe("被改了");
  });

  it("覆盖第N章 / 第N节 / 第N回 / Chapter N", () => {
    expect(presetsMatching("第1章 起风了")).toContain("preset-zhang");
    expect(presetsMatching("第一百零三章 大结局")).toContain("preset-zhang");
    expect(presetsMatching("第１２章 全角数字")).toContain("preset-zhang");
    expect(presetsMatching("第3节 试炼")).toContain("preset-jie");
    expect(presetsMatching("第二回 桃园结义")).toContain("preset-hui");
    expect(presetsMatching("Chapter 25")).toContain("preset-chapter-en");
    expect(presetsMatching("chapter 3 The End")).toContain("preset-chapter-en");
  });

  it("覆盖「1.Chapter0---1序」这类混排标题", () => {
    expect(presetsMatching("1.Chapter0---1序")).toContain("preset-chapter-en");
    expect(presetsMatching("330.Chapter25---2")).toContain("preset-chapter-en");
    expect(presetsMatching("12、Chapter 8")).toContain("preset-chapter-en");
  });

  it("覆盖序章 / 楔子 / 引子 / 前言 / 后记 / 尾声 / 番外", () => {
    for (const keyword of ["序章", "楔子", "引子", "前言", "后记", "尾声", "番外", "序言", "终章"]) {
      expect(presetsMatching(keyword).length).toBeGreaterThan(0);
    }
    expect(presetsMatching("序章 雪夜")).toContain("preset-special-prefixed");
    expect(presetsMatching("番外一")).toContain("preset-special-numbered");
  });

  it("第 N 卷 / 部 / 篇 也算章节标记", () => {
    expect(presetsMatching("第一卷 少年游")).toContain("preset-juan");
    expect(presetsMatching("第二部 风起")).toContain("preset-juan");
  });

  it("不误判以关键词开头的普通正文句子", () => {
    expect(presetsMatching("尾声渐渐远去，他站在原地很久很久，直到天亮才离开。")).toEqual([]);
    expect(presetsMatching("第一章的内容我已经看完了，接下来要做什么呢？")).toEqual([]);
    expect(presetsMatching("他说：「序章还没写完呢。」")).toEqual([]);
    expect(presetsMatching("这里提到 Chapter 3 的时候已经是很久以后")).toEqual([]);
  });
});

describe("parseChapters —— 兜底", () => {
  it("没有标题时返回单章「正文」，且保留全部行", () => {
    const lines = ["这是第一行", "这是第二行", "", "这是第四行"];
    const chapters = parseChapters(lines, lang);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe("正文");
    expect(chapters[0].lines).toEqual(lines);
    expect(chapters[0].isIntro).toBeUndefined();
  });

  it("空输入返回单章「正文」而不是空数组", () => {
    const chapters = parseChapters([], lang);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe("正文");
    expect(chapters[0].lines).toEqual([]);
  });

  it("全是空行时也返回单章，不崩溃", () => {
    const chapters = parseChapters(["", "   ", "\u3000"], lang);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe("正文");
  });

  it("英文语言用英文兜底标题", () => {
    const chapters = parseChapters(["just text"], "en");
    expect(chapters[0].title).toBe("Content");
  });

  it("防御非数组输入", () => {
    const chapters = parseChapters(undefined as unknown as string[], lang);
    expect(chapters).toHaveLength(1);
  });
});

describe("parseChapters —— 中文分章", () => {
  it("按第N章正确切分正文", () => {
    const lines = ["第1章 开始", "内容一", "内容二", "第2章 继续", "下一章内容"];
    const chapters = parseChapters(lines, lang);
    expect(titles(chapters)).toEqual(["第1章 开始", "第2章 继续"]);
    expect(chapters[0].lines).toEqual(["内容一", "内容二"]);
    expect(chapters[1].lines).toEqual(["下一章内容"]);
  });

  it("章节标题行的内容不混进上一章的正文", () => {
    const chapters = parseChapters(["第1章 A", "正文", "第2章 B", "正文2"], lang);
    expect(chapters[0].lines).toEqual(["正文"]);
    expect(chapters[1].lines).toEqual(["正文2"]);
  });

  it("首章之前的非空内容成为「简介」章节", () => {
    const lines = ["书名：测试小说", "作者：某人", "", "第1章 正文开始", "正文内容……"];
    const chapters = parseChapters(lines, lang);
    expect(chapters).toHaveLength(2);
    expect(chapters[0].isIntro).toBe(true);
    expect(chapters[0].title).toBe("简介");
    expect(chapters[0].lines).toEqual(["书名：测试小说", "作者：某人", ""]);
    expect(chapters[1].title).toBe("第1章 正文开始");
    expect(chapters[1].isIntro).toBeUndefined();
  });

  it("首章之前全是空行时不生成「简介」章节", () => {
    const chapters = parseChapters(["", "", "第1章 开始", "内容"], lang);
    expect(titles(chapters)).toEqual(["第1章 开始"]);
    expect(chapters[0].isIntro).toBeUndefined();
  });

  it("最后一章一直取到文件末尾", () => {
    const lines = ["第1章 A", "a1", "a2", "a3"];
    const chapters = parseChapters(lines, lang);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].lines).toEqual(["a1", "a2", "a3"]);
  });

  it("记录 originalTitle 便于判断用户是否改过标题", () => {
    const chapters = parseChapters(["第1章 开始", "内容", "第2章 继续", "内容"], lang);
    expect(chapters[0].originalTitle).toBe("第1章 开始");
    expect(chapters[1].originalTitle).toBe("第2章 继续");
  });

  it("章节 id 稳定且唯一（同一输入两次解析结果一致）", () => {
    const lines = ["简介行", "第1章 A", "内容", "第2章 B", "内容"];
    const first = parseChapters(lines, lang);
    const second = parseChapters(lines, lang);
    expect(first.map((c) => c.id)).toEqual(second.map((c) => c.id));
    expect(new Set(first.map((c) => c.id)).size).toBe(first.length);
  });

  it("简介章节不会挤占正文编号", () => {
    const chapters = parseChapters(["前言文字", "第1章 A", "x"], lang);
    expect(chapters[0].id).toBe("intro");
    expect(chapters[1].id).toBe("chapter-1");
  });

  it("支持节 / 回 / 卷混排", () => {
    const lines = ["第1节 开端", "a", "第1回 相遇", "b", "第二卷 远行", "c"];
    expect(titles(parseChapters(lines, lang))).toEqual(["第1节 开端", "第1回 相遇", "第二卷 远行"]);
  });

  it("全角数字与中文数字都支持", () => {
    const lines = ["第１章 全角", "a", "第一百章 中文", "b"];
    expect(titles(parseChapters(lines, lang))).toEqual(["第１章 全角", "第一百章 中文"]);
  });
});

describe("parseChapters —— 英文 / 混排分章", () => {
  it("Chapter N 分章", () => {
    const lines = ["Chapter 1 Start", "body", "Chapter 2 Next", "body2"];
    expect(titles(parseChapters(lines, "en"))).toEqual(["Chapter 1 Start", "Chapter 2 Next"]);
  });

  it("1.Chapter0---1 这类混排标题", () => {
    const lines = ["1.Chapter0---1序", "a", "2.Chapter0---2序", "b"];
    expect(titles(parseChapters(lines, lang))).toEqual(["1.Chapter0---1序", "2.Chapter0---2序"]);
  });

  it("大小写不敏感", () => {
    const lines = ["CHAPTER 1", "a", "chapter 2", "b"];
    expect(titles(parseChapters(lines, "en"))).toEqual(["CHAPTER 1", "chapter 2"]);
  });
});

describe("parseChapters —— 自定义规则", () => {
  it("用户关键词规则能补上预置规则漏掉的标题", () => {
    const lines = ["序章", "这里是开头", "第1章 开始", "正文"];
    const chapters = parseChapters(lines, lang, [
      userRule({ mode: "keyword", pattern: "序章", capture: undefined }),
    ]);
    expect(titles(chapters)).toEqual(["序章", "第1章 开始"]);
    expect(chapters[0].lines).toEqual(["这里是开头"]);
  });

  it("预置规则优先于用户规则", () => {
    const chapters = parseChapters(["第1章 开始", "内容"], lang, [
      userRule({ pattern: "^第", capture: 0 }),
    ]);
    expect(titles(chapters)).toEqual(["第1章 开始"]);
  });

  it("停用的规则不生效", () => {
    // 用一个预置规则不认识的关键词，才能确认「没被切分」确实来自规则停用
    const chapters = parseChapters(["卷首", "内容"], lang, [
      userRule({ mode: "keyword", pattern: "卷首", enabled: false }),
    ]);
    expect(titles(chapters)).toEqual(["正文"]);
  });

  it("同一条规则启用后就会生效（对照组）", () => {
    const chapters = parseChapters(["卷首", "内容"], lang, [
      userRule({ mode: "keyword", pattern: "卷首", enabled: true }),
    ]);
    expect(titles(chapters)).toEqual(["卷首"]);
  });

  it("语法错误的规则被跳过，不影响其他规则与预置规则", () => {
    const lines = ["楔子", "内容", "第1章 开始", "正文"];
    const chapters = parseChapters(lines, lang, [
      userRule({ id: "bad", pattern: "(" }),
      userRule({ id: "good", mode: "keyword", pattern: "楔子" }),
    ]);
    expect(titles(chapters)).toEqual(["楔子", "第1章 开始"]);
  });

  it("使用自定义捕获组作为标题", () => {
    const chapters = parseChapters(["TAG: 第一卷", "内容"], lang, [
      userRule({ pattern: "^TAG:\\s*(.+)$", capture: 1 }),
    ]);
    expect(chapters[0].title).toBe("第一卷");
  });

  it("捕获组未参与匹配时退回整行", () => {
    const chapters = parseChapters(["卷首语", "内容"], lang, [
      userRule({ pattern: "^卷首语(?:\\s+(.+))?$", capture: 1 }),
    ]);
    expect(chapters[0].title).toBe("卷首语");
  });

  it("调用方把 presetRules() 一并传进来时不会重复命中", () => {
    const lines = ["第1章 开始", "内容", "第2章 结束", "内容"];
    const withPresets = parseChapters(lines, lang, presetRules());
    expect(titles(withPresets)).toEqual(["第1章 开始", "第2章 结束"]);
    expect(withPresets).toEqual(parseChapters(lines, lang));
  });

  it("rules 传 undefined / 空数组等价", () => {
    const lines = ["第1章 开始", "内容"];
    expect(parseChapters(lines, lang, undefined)).toEqual(parseChapters(lines, lang));
    expect(parseChapters(lines, lang, [])).toEqual(parseChapters(lines, lang));
  });
});

describe("parseChapters —— 误判防护", () => {
  it("正文里以「第X章」开头的长句子不被当作标题", () => {
    const longLine = "第一章的内容我已经看完了，接下来要做的是把整部作品从头再读一遍，找出所有伏笔。";
    const lines = ["第1章 开始", longLine, "第2章 结束"];
    const chapters = parseChapters(lines, lang);
    expect(titles(chapters)).toEqual(["第1章 开始", "第2章 结束"]);
    expect(chapters[0].lines).toContain(longLine);
  });

  it("超长行不参与标题判定", () => {
    const giant = `第1章 ${"很".repeat(200)}`;
    const chapters = parseChapters([giant, "正文"], lang);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe("正文");
  });

  it("同名的重复标题都被保留（不同章节可能同名）", () => {
    const lines = ["番外 一", "a", "番外 一", "b"];
    const chapters = parseChapters(lines, lang);
    expect(chapters).toHaveLength(2);
    expect(chapters[1].title).toBe("番外 一");
  });
});

describe("countRuleMatches", () => {
  it("统计某条规则在行数组里的命中数", () => {
    const lines = ["第1章 A", "正文", "第2章 B", "正文"];
    expect(countRuleMatches(lines, userRule({ pattern: "^第\\d+章" }))).toBe(2);
  });

  it("语法错误的规则返回 0", () => {
    expect(countRuleMatches(["第1章"], userRule({ pattern: "(" }))).toBe(0);
  });

  it("关键词规则也能统计", () => {
    const lines = ["序章", "b", "楔子", "c", "第一章"];
    expect(countRuleMatches(lines, userRule({ mode: "keyword", pattern: "序章|楔子" }))).toBe(2);
  });

  it("空行数组返回 0", () => {
    expect(countRuleMatches([], userRule())).toBe(0);
  });
});
