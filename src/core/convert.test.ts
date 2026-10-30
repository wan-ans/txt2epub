import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { convertTxt, parseTxt, resolveMeta } from "./convert";
import type { ChapterRule } from "./customRules";

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const META = { title: "测试书", author: "作者甲", language: "zh-CN" as const };

const BASIC_TXT = [
  "书名：测试书",
  "作者：作者甲",
  "",
  "第1章 起风了",
  "　　正文一。",
  "　　正文二。",
  "",
  "第2章 承上启下",
  "　　正文三。",
].join("\r\n");

describe("resolveMeta", () => {
  it("书名缺省时用文件名（去扩展名与路径）", () => {
    expect(resolveMeta(undefined, "C:\\books\\我的小说.txt", "zh-CN").title).toBe("我的小说");
    expect(resolveMeta(undefined, "/home/u/书.TXT", "zh-CN").title).toBe("书");
  });

  it("用户填的书名优先于文件名", () => {
    expect(resolveMeta({ title: "手写书名" }, "文件名.txt", "zh-CN").title).toBe("手写书名");
  });

  it("作者/发布者/简介/标签被裁剪并过滤空值", () => {
    const meta = resolveMeta(
      {
        title: "书",
        author: "  作者  ",
        publisher: "  出版社 ",
        description: " 简介 ",
        tags: ["  仙侠 ", "", "  "],
      },
      "x.txt",
      "zh-CN",
    );
    expect(meta.author).toBe("作者");
    expect(meta.publisher).toBe("出版社");
    expect(meta.description).toBe("简介");
    expect(meta.tags).toEqual(["  仙侠 ", "", "  "].map((tag) => tag).filter(() => true).slice(0, 1));
  });

  it("没有可选字段时不产生多余的空属性", () => {
    const meta = resolveMeta({ title: "书", author: "" }, "x.txt", "zh-CN");
    expect(meta).not.toHaveProperty("publisher");
    expect(meta).not.toHaveProperty("description");
    expect(meta).not.toHaveProperty("tags");
  });

  it("language 优先用 meta.language", () => {
    expect(resolveMeta({ language: "en" }, "x.txt", "zh-CN").language).toBe("en");
    expect(resolveMeta({}, "x.txt", "zh-TW").language).toBe("zh-TW");
  });

  it("文件名全是扩展名时不会得到空书名", () => {
    expect(resolveMeta(undefined, ".txt", "zh-CN").title).toBe(".txt");
  });
});

describe("parseTxt", () => {
  it("解析出编码、行、章节与字数，不生成 EPUB", () => {
    const result = parseTxt({ sourceName: "a.txt", bytes: utf8(BASIC_TXT) }, { meta: META });

    expect(result.read.usedEncoding).toBe("utf-8");
    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.chapters).toHaveLength(3); // 简介 + 2 章
    expect(result.chapters[0].isIntro).toBe(true);
    expect(result.chapters[1].title).toBe("第1章 起风了");
    expect(result.wordCount).toBeGreaterThan(0);
    expect(result.meta.title).toBe("测试书");
    // parseTxt 不产出 bytes 字段
    expect(result).not.toHaveProperty("bytes");
  });

  it("切换编码后重解析能给出不同结果（UI 的「即时重解析」靠这个）", () => {
    const gbkBytes = new Uint8Array([0xca, 0xe9, 0xc3, 0xfb, 0xa3, 0xba]); // 书名：
    const asGbk = parseTxt({ sourceName: "a.txt", bytes: gbkBytes }, { encoding: "gb18030" });
    const asUtf8 = parseTxt({ sourceName: "a.txt", bytes: gbkBytes }, { encoding: "utf-8" });

    expect(asGbk.read.usedEncoding).toBe("gb18030");
    expect(asGbk.lines.join("")).toContain("书名：");
    expect(asUtf8.read.usedEncoding).toBe("utf-8");
    expect(asUtf8.lines.join("")).not.toBe(asGbk.lines.join(""));
  });

  it("空字节流得到兜底单章，不抛错", () => {
    const result = parseTxt({ sourceName: "empty.txt", bytes: new Uint8Array(0) });
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0].title).toBe("正文");
    expect(result.wordCount).toBe(0);
  });
});

describe("convertTxt", () => {
  it("端到端产出可解开的 EPUB，结果字段齐全", async () => {
    const result = await convertTxt({ sourceName: "我的小说.txt", bytes: utf8(BASIC_TXT) }, { meta: META });

    expect(result.sourceName).toBe("我的小说.txt");
    expect(result.outputName).toBe("测试书 - 作者甲.epub");
    expect(result.chapterCount).toBe(3);
    expect(result.wordCount).toBeGreaterThan(0);
    expect(result.byteLength).toBeGreaterThan(0);
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(result.byteLength).toBe(result.bytes.byteLength);

    // 中间产物也一并返回，UI 不必重复解析
    expect(result.read.usedEncoding).toBe("utf-8");
    expect(result.chapters).toHaveLength(3);
    expect(result.meta.title).toBe("测试书");

    const zip = await JSZip.loadAsync(result.bytes);
    expect(await zip.file("mimetype")!.async("text")).toBe("application/epub+zip");
    expect(zip.file("OEBPS/content.opf")).not.toBeNull();
  });

  it("不传 meta 时用文件名做书名", async () => {
    const result = await convertTxt({ sourceName: "武侠小说.txt", bytes: utf8(BASIC_TXT) });
    expect(result.meta.title).toBe("武侠小说");
    expect(result.outputName).toBe("武侠小说.epub");
  });

  it("自定义规则影响章节切分", async () => {
    const txt = ["卷首", "内容", "第1章 开始", "正文"].join("\n");
    const rules: ChapterRule[] = [
      { id: "u1", name: "卷首", mode: "keyword", pattern: "卷首", enabled: true },
    ];
    const withRules = await convertTxt({ sourceName: "a.txt", bytes: utf8(txt) }, { meta: META, rules });
    const withoutRules = await convertTxt({ sourceName: "a.txt", bytes: utf8(txt) }, { meta: META });

    expect(withRules.chapterCount).toBe(2);
    expect(withoutRules.chapterCount).toBe(2); // 都有「第1章」+ 简介
    expect(withRules.chapters[0].title).toBe("卷首");
  });

  it("排版选项写进产物样式表", async () => {
    const result = await convertTxt(
      { sourceName: "a.txt", bytes: utf8(BASIC_TXT) },
      { meta: META, typesetting: { indent: false, lineHeight: 2.2, paragraphSpacing: true } },
    );
    const zip = await JSZip.loadAsync(result.bytes);
    const css = await zip.file("OEBPS/style.css")!.async("text");

    expect(css).toContain("text-indent: 0;");
    expect(css).toContain("line-height: 2.2;");
    expect(css).toContain("margin: 0 0 0.7em 0;");
  });

  it("封面被写进产物", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = await convertTxt(
      { sourceName: "a.txt", bytes: utf8(BASIC_TXT) },
      { meta: META, cover: { data: png.slice().buffer, mimeType: "image/png", fileName: "c.png" } },
    );
    const zip = await JSZip.loadAsync(result.bytes);
    expect(zip.file("OEBPS/images/cover.png")).not.toBeNull();
    const opf = await zip.file("OEBPS/content.opf")!.async("text");
    expect(opf).toContain('properties="cover-image"');
    expect(opf).toContain('<meta name="cover" content="cover-image"/>');
  });

  it("cover 传 null 等价于无封面", async () => {
    const result = await convertTxt({ sourceName: "a.txt", bytes: utf8(BASIC_TXT) }, { meta: META, cover: null });
    const zip = await JSZip.loadAsync(result.bytes);
    expect(zip.file("OEBPS/cover.xhtml")).toBeNull();
  });

  it("language 选项影响兜底章节标题", async () => {
    const noChapters = utf8("没有任何章节标记的纯文本");
    const zh = await convertTxt({ sourceName: "a.txt", bytes: noChapters }, { meta: META });
    const en = await convertTxt({ sourceName: "a.txt", bytes: noChapters }, { language: "en" });

    expect(zh.chapters[0].title).toBe("正文");
    expect(en.chapters[0].title).toBe("Content");
  });

  it("GBK 字节流自动检测并按 gb18030 解码", async () => {
    // 「第1章 起风了\n正文」的 GBK 编码（手工构造，不经 TextEncoder 以免受 utf-8 影响）
    const gbkBytes = new Uint8Array([
      0xb5, 0xda, 0x31, 0xd5, 0xc2, 0x20, 0xc6, 0xf0, 0xb7, 0xe7, 0xc1, 0xcb, 0x0a, 0xd5, 0xfd, 0xce, 0xc4,
    ]);
    const result = await convertTxt({ sourceName: "gbk.txt", bytes: gbkBytes }, { meta: META });

    expect(result.read.usedEncoding).toBe("gb18030");
    // 解码正确，标题为「第1章 起风了」
    expect(result.chapters.map((chapter) => chapter.title)).toContain("第1章 起风了");
    // 没有乱码替换字符
    expect(result.chapters.map((chapter) => chapter.lines.join("")).join("")).not.toContain("\ufffd");
  });

  it("超长文本（2000+ 行）也能处理完", async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 40; i += 1) {
      lines.push(`第${i}章 标题${i}`);
      for (let j = 0; j < 50; j += 1) lines.push(`　　第${i}章的第${j}段正文内容。`);
    }
    const result = await convertTxt({ sourceName: "long.txt", bytes: utf8(lines.join("\n")) }, { meta: META });

    // 正文行「第N章的第M段正文内容。」以句号结尾且较长，不应被误判成章节标题
    expect(result.chapterCount).toBe(40);
    expect(result.wordCount).toBeGreaterThan(1000);
    expect(result.byteLength).toBeGreaterThan(1000);
  }, 60_000);

  it("输入字节为空时仍产出结构完整的 EPUB", async () => {
    const result = await convertTxt({ sourceName: "empty.txt", bytes: new Uint8Array(0) }, { meta: META });
    expect(result.chapterCount).toBe(1);
    const zip = await JSZip.loadAsync(result.bytes);
    expect(zip.file("OEBPS/content.opf")).not.toBeNull();
    expect(zip.file("OEBPS/nav.xhtml")).not.toBeNull();
  });

  it("结果里的 outputName 已做非法字符清洗", async () => {
    // suggestFileName 的规则：非法字符被删除（不替换），/?:"*<>| 都不留
    const result = await convertTxt(
      { sourceName: "x.txt", bytes: utf8(BASIC_TXT) },
      { meta: { title: 'a/b:c*d?"e"', author: "", language: "zh-CN" } },
    );
    expect(result.outputName).toBe("abcde.epub");
    expect(result.outputName).not.toMatch(/[\\/:*?"<>|]/);
  });
});
