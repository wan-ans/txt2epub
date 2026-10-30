import { describe, expect, it } from "vitest";
import {
  chapterTitleFromFile,
  compareNaturally,
  moveItem,
  sortFilesByNaturalName,
  stripExtension,
} from "./fileOrdering";

describe("stripExtension", () => {
  it("去掉扩展名", () => {
    expect(stripExtension("第一章.txt")).toBe("第一章");
    expect(stripExtension("a.b.txt")).toBe("a.b");
  });

  it("只取文件名部分，不含路径", () => {
    expect(stripExtension("C:\\books\\第二卷.txt")).toBe("第二卷");
    expect(stripExtension("/home/u/第三卷.TXT")).toBe("第三卷");
  });

  it("空输入有兜底", () => {
    expect(stripExtension("")).toBe("未命名");
    expect(stripExtension(undefined as unknown as string)).toBe("未命名");
  });
});

describe("chapterTitleFromFile", () => {
  it("剥掉开头的纯序号前缀", () => {
    expect(chapterTitleFromFile("01.楔子.txt")).toBe("楔子");
    expect(chapterTitleFromFile("2-第3章 重逢.txt")).toBe("第3章 重逢");
    expect(chapterTitleFromFile("03、后记.txt")).toBe("后记");
    expect(chapterTitleFromFile("10 番外.txt")).toBe("番外");
  });

  it("全角数字前缀也能剥掉", () => {
    expect(chapterTitleFromFile("０１、引子.txt")).toBe("引子");
  });

  it("没有序号时保留原标题", () => {
    expect(chapterTitleFromFile("序章.txt")).toBe("序章");
    expect(chapterTitleFromFile("Chapter 5.txt")).toBe("Chapter 5");
  });

  it("剥完为空时退回原名", () => {
    expect(chapterTitleFromFile("01.txt")).toBe("01");
    expect(chapterTitleFromFile("2、.txt")).toBe("2、");
  });
});

describe("compareNaturally / sortFilesByNaturalName", () => {
  it("数字按大小排，而不是按字典序", () => {
    const files = ["第10话.txt", "第2话.txt", "第1话.txt"].map((name) => ({ name }));
    expect(sortFilesByNaturalName(files).map((f) => f.name)).toEqual([
      "第1话.txt",
      "第2话.txt",
      "第10话.txt",
    ]);
  });

  it("中文与数字混排稳定", () => {
    const files = ["01 楔子.txt", "02 第一章.txt", "10 后记.txt"].map((name) => ({ name }));
    expect(sortFilesByNaturalName(files).map((f) => f.name)).toEqual([
      "01 楔子.txt",
      "02 第一章.txt",
      "10 后记.txt",
    ]);
  });

  it("排序不修改原数组", () => {
    const files = [{ name: "b.txt" }, { name: "a.txt" }];
    const sorted = sortFilesByNaturalName(files);
    expect(files.map((f) => f.name)).toEqual(["b.txt", "a.txt"]);
    expect(sorted.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("相同名字返回 0", () => {
    expect(compareNaturally("第1章", "第1章")).toBe(0);
  });
});

describe("moveItem", () => {
  it("往下移动", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("往上移动", () => {
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("原地不动", () => {
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });

  it("越界时安全返回", () => {
    expect(moveItem(["a", "b"], -1, 0)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 0, 5)).toEqual(["a", "b"]);
  });

  it("不修改原数组", () => {
    const original = ["a", "b", "c"];
    moveItem(original, 0, 2);
    expect(original).toEqual(["a", "b", "c"]);
  });
});
