import { describe, expect, it } from "vitest";
import {
  collapseBlankLines,
  countBookWords,
  countWords,
  hasMeaningfulContent,
  isBlankLine,
  normalizeNewlines,
  preprocessLines,
  trimLines,
} from "./preprocess";
import type { Chapter } from "../types";

describe("normalizeNewlines", () => {
  it("把 CRLF / CR / U+2028 / U+2029 统一成 LF", () => {
    expect(normalizeNewlines("a\r\nb\rc\u2028d\u2029e")).toBe("a\nb\nc\nd\ne");
  });

  it("已经是 LF 的文本保持原样", () => {
    expect(normalizeNewlines("a\nb")).toBe("a\nb");
  });
});

describe("preprocessLines", () => {
  it("统一换行并裁掉行首行尾空白（含全角空格与制表符）", () => {
    const input = "  \u3000Hello world  \r\n\tSecond line   ";
    expect(preprocessLines(input)).toEqual(["Hello world", "Second line"]);
  });

  it("保留空行，但空行按裁剪后为空字符串", () => {
    expect(preprocessLines("Line one\n   \n\u3000\u3000\n  Line two  ")).toEqual([
      "Line one",
      "",
      "",
      "Line two",
    ]);
  });

  it("裁掉行首全角缩进，让「　　第1章」能被预置规则匹配", () => {
    expect(preprocessLines("\u3000\u3000第1章 起风了")).toEqual(["第1章 起风了"]);
  });

  it("去掉开头 BOM 与零宽字符", () => {
    expect(preprocessLines("\ufeff书名：测试")).toEqual(["书名：测试"]);
    expect(preprocessLines("\u200b第1章\u200b 标题")).toEqual(["第1章 标题"]);
  });

  it("正文中间的全角空格不被破坏（只裁首尾）", () => {
    expect(preprocessLines("\u3000\u3000他 说：「好」。\u3000")).toEqual(["他 说：「好」。"]);
  });

  it("空字符串与仅换行的输入返回合理的行数组", () => {
    expect(preprocessLines("")).toEqual([]);
    expect(preprocessLines("\n")).toEqual(["", ""]);
    expect(preprocessLines("\r\n")).toEqual(["", ""]);
  });

  it("不改动传入的原文以外的任何状态（纯函数）", () => {
    const input = "  a  \n  b  ";
    const first = preprocessLines(input);
    const second = preprocessLines(input);
    expect(first).toEqual(second);
    expect(input).toBe("  a  \n  b  ");
  });

  it("全角空格串单独成行时变成空字符串", () => {
    expect(preprocessLines("\u3000\u3000\u3000\n正文")).toEqual(["", "正文"]);
  });
});

describe("isBlankLine", () => {
  it("空字符串、空格、制表符、全角空格都算空行", () => {
    expect(isBlankLine("")).toBe(true);
    expect(isBlankLine("   ")).toBe(true);
    expect(isBlankLine("\t")).toBe(true);
    expect(isBlankLine("\u3000")).toBe(true);
  });

  it("有任何可见字符就不是空行", () => {
    expect(isBlankLine("字")).toBe(false);
    expect(isBlankLine(" 字 ")).toBe(false);
  });
});

describe("hasMeaningfulContent", () => {
  it("全是空白时返回 false", () => {
    expect(hasMeaningfulContent(["   ", "\t", "", "\u3000"])).toBe(false);
  });

  it("至少一行有内容时返回 true", () => {
    expect(hasMeaningfulContent(["   ", "内容", " "])).toBe(true);
  });

  it("空数组返回 false", () => {
    expect(hasMeaningfulContent([])).toBe(false);
  });

  it("防御非数组输入", () => {
    expect(hasMeaningfulContent(undefined as unknown as string[])).toBe(false);
  });
});

describe("countWords", () => {
  it("统计去掉空白后的字符数", () => {
    expect(countWords(["你好 世界", "测试"])).toBe(6);
  });

  it("全角空格不算字数", () => {
    expect(countWords(["\u3000\u3000你好\u3000\u3000"])).toBe(2);
  });

  it("标点计入字数（与常见字数工具一致）", () => {
    expect(countWords(["你好，世界。"])).toBe(6);
  });

  it("空数组与空行返回 0", () => {
    expect(countWords([])).toBe(0);
    expect(countWords(["", "  ", "\u3000"])).toBe(0);
  });

  it("emoji / 扩展平面字符按 UTF-16 单元计（与 JS length 一致，避免与 UI 显示冲突）", () => {
    expect(countWords(["👍"])).toBe(2);
  });
});

describe("countBookWords", () => {
  it("累加所有章节正文，不含标题", () => {
    const chapters: Chapter[] = [
      { id: "a", title: "第一章 很长很长的标题", lines: ["你好", "世界"] },
      { id: "b", title: "第二章", lines: ["测试"] },
    ];
    // "你好世界" = 4 + "测试" = 2；标题的字符完全不参与
    expect(countBookWords(chapters)).toBe(6);
  });

  it("空章节数组返回 0", () => {
    expect(countBookWords([])).toBe(0);
  });
});

describe("trimLines / collapseBlankLines", () => {
  it("trimLines 返回新数组且不修改入参", () => {
    const input = ["  a  ", "\u3000b"];
    const out = trimLines(input);
    expect(out).toEqual(["a", "b"]);
    expect(input[0]).toBe("  a  ");
    expect(out).not.toBe(input);
  });

  it("collapseBlankLines 默认把连续空行压成一个", () => {
    expect(collapseBlankLines(["a", "", "", "", "b"])).toEqual(["a", "", "b"]);
  });

  it("collapseBlankLines 支持保留 0 个空行", () => {
    expect(collapseBlankLines(["a", "", "", "b"], 0)).toEqual(["a", "b"]);
  });

  it("collapseBlankLines 保留 max 个空行", () => {
    expect(collapseBlankLines(["a", "", "", "", "b"], 2)).toEqual(["a", "", "", "b"]);
  });
});
