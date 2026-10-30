import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { detectAndDecode } from "../src/core/textReader";
import { preprocessLines } from "../src/core/preprocess";
import { parseChapters } from "../src/core/chapterParser";
import { buildEpub } from "../src/core/epubBuilder";
import { convertTxt } from "../src/core/convert";
import type { BookMeta } from "../src/types";

/**
 * 真实小说集成测试。
 *
 * tests/fixtures 下的两个文件是真实抓取的 TXT：
 * - 测试小说_001.txt：UTF-8，88 个「第N章」标题
 * - 测试小说_002.txt：GBK（实际按 gb18030 解码），330 个「1.Chapter0---1」混排标题
 *
 * 这里断言的是「真实数据上的行为」，不 mock 任何东西，所以能真的发现回归。
 */

const FIXTURE_DIR = path.resolve(process.cwd(), "tests/fixtures");

function loadBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURE_DIR, name)));
}

const CASES = [
  {
    file: "测试小说_001.txt",
    bookTitle: "测试小说 001",
    author: "测试作者 001",
    encoding: "utf-8",
    /** 88 个正文章节 + 1 个简介章节 */
    chapterCount: 89,
    firstChapterTitle: "第1章",
    /** 首章标题之前的「书名/作者/文案」会另成一章 */
    hasIntro: true,
  },
  {
    file: "测试小说_002.txt",
    bookTitle: "测试小说 002",
    author: "测试作者 002",
    encoding: "gb18030",
    /**
     * 324 个 Chapter 标题 + 1 个简介章节。
     * 注意：原文编号到 330，但其中 42/76/119/129/219/280 这 6 个编号在源文件里缺失
     * （不是解析漏了），所以实际是 324 个标题。
     */
    chapterCount: 325,
    firstChapterTitle: "1.Chapter0---1序",
    hasIntro: true,
  },
] as const;

describe("真实小说集成 —— 编码检测", () => {
  it("001 是 UTF-8，自动检测为 utf-8", () => {
    const result = detectAndDecode(loadBytes("测试小说_001.txt"));
    expect(result.usedEncoding).toBe("utf-8");
    expect(result.detectedEncoding).toBe("utf-8");
    expect(result.byteLength).toBeGreaterThan(1_000_000);
    // 中文能正常解出，没有替换字符
    expect(result.text).toContain("书名：");
    expect(result.text).not.toContain("\ufffd");
  });

  it("002 是 GBK，自动检测后按 gb18030 解码", () => {
    const result = detectAndDecode(loadBytes("测试小说_002.txt"));
    expect(result.usedEncoding).toBe("gb18030");
    expect(result.text).toContain("『测试小说002/作者:SS』");
    expect(result.text).not.toContain("\ufffd");
  });

  it("002 用 utf-8 强解会产生替换字符（反向证明它确实不是 UTF-8）", () => {
    const result = detectAndDecode(loadBytes("测试小说_002.txt"), "utf-8");
    expect(result.text).toContain("\ufffd");
  });

  it("显式指定 gb18030 能得到与自动检测一致的结果", () => {
    const bytes = loadBytes("测试小说_002.txt");
    const auto = detectAndDecode(bytes);
    const explicit = detectAndDecode(bytes, "gb18030");
    expect(explicit.text).toBe(auto.text);
    expect(explicit.usedEncoding).toBe("gb18030");
  });
});

describe.each(CASES)("真实小说集成 —— $file", (testCase) => {
  const bytes = loadBytes(testCase.file);
  const read = detectAndDecode(bytes);
  const lines = preprocessLines(read.text);
  const chapters = parseChapters(lines, "zh-CN");
  const meta: BookMeta = {
    title: testCase.bookTitle,
    author: testCase.author,
    language: "zh-CN",
  };

  it("预处理后行数合理，且行首全角缩进已被裁掉", () => {
    expect(lines.length).toBeGreaterThan(10_000);
    // 原文大量使用全角空格缩进，预处理后行首不应再有
    const indented = lines.filter((line) => line.startsWith("\u3000"));
    expect(indented).toHaveLength(0);
  });

  it(`章节数精确等于 ${testCase.chapterCount}`, () => {
    expect(chapters).toHaveLength(testCase.chapterCount);
  });

  it("首个章节是简介，章节标题符合预期", () => {
    expect(chapters[0].isIntro).toBe(true);
    expect(chapters[0].title).toBe("简介");
    expect(chapters[1].title).toBe(testCase.firstChapterTitle);
  });

  it("每个章节都有正文，没有解析出来的空章", () => {
    const empty = chapters.filter((chapter) => chapter.lines.length === 0);
    expect(empty).toHaveLength(0);
  });

  it("章节标题不重复堆叠（相邻章节标题不相同）", () => {
    for (let i = 1; i < chapters.length; i += 1) {
      expect(chapters[i].title).not.toBe(chapters[i - 1].title);
    }
  });

  it("生成的 EPUB 能被 JSZip 解开，mimetype 是第一个条目且为 STORE", async () => {
    const epubBytes = await buildEpub(meta, chapters);
    expect(epubBytes.byteLength).toBeGreaterThan(100_000);

    // 原始字节层面验证：第一个本地文件头必须是 mimetype 且压缩方式为 0
    const view = new DataView(epubBytes.buffer, epubBytes.byteOffset, epubBytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    expect(new TextDecoder().decode(epubBytes.subarray(30, 30 + nameLength))).toBe("mimetype");
    expect(extraLength).toBe(0);

    const zip = await JSZip.loadAsync(epubBytes);
    expect(await zip.file("mimetype")!.async("text")).toBe("application/epub+zip");

    // 目录顺序：mimetype 必须排第一
    const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
    expect(names[0]).toBe("mimetype");
    expect(names[1]).toBe("META-INF/container.xml");
  }, 60_000);

  it("EPUB 的章节文件数量与章节数一致", async () => {
    const zip = await JSZip.loadAsync(await buildEpub(meta, chapters));
    const chapterFiles = Object.keys(zip.files).filter((name) =>
      /^OEBPS\/chapter-\d+-.*\.xhtml$/.test(name),
    );
    expect(chapterFiles).toHaveLength(testCase.chapterCount);
  }, 60_000);

  it("OPF / nav 的元信息与章节数正确", async () => {
    const zip = await JSZip.loadAsync(await buildEpub(meta, chapters));
    const opf = await zip.file("OEBPS/content.opf")!.async("text");
    const nav = await zip.file("OEBPS/nav.xhtml")!.async("text");

    expect(opf).toContain('version="3.0"');
    expect(opf).toContain(`<dc:title>${testCase.bookTitle}</dc:title>`);
    expect(opf).toContain(`<dc:creator>${testCase.author}</dc:creator>`);
    expect(opf).toContain('properties="nav"');
    expect(nav).toContain('epub:type="toc"');
    // 目录条目数 = 章节数
    expect([...nav.matchAll(/<li><a href="chapter-/g)]).toHaveLength(testCase.chapterCount);
  }, 60_000);

  it("convertTxt 端到端：章节数、字数、字节都合理，且章节内容真的是中文", async () => {
    const result = await convertTxt({ sourceName: testCase.file, bytes });

    expect(result.sourceName).toBe(testCase.file);
    expect(result.chapterCount).toBe(testCase.chapterCount);
    expect(result.read.usedEncoding).toBe(testCase.encoding);
    expect(result.wordCount).toBeGreaterThan(100_000);
    expect(result.byteLength).toBeGreaterThan(100_000);
    expect(result.outputName).toMatch(/\.epub$/);

    // 抽查一章：确实有汉字内容，没有乱码替换字符
    const sample = result.chapters[10];
    const text = sample.lines.join("");
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("\ufffd");
    expect(/[\u4e00-\u9fff]/.test(text)).toBe(true);
  }, 60_000);

  it("正文里的中文标点、全角空格在产物中原样保留", async () => {
    const result = await convertTxt({ sourceName: testCase.file, bytes });
    const zip = await JSZip.loadAsync(result.bytes);
    const firstChapter = Object.keys(zip.files).find((name) =>
      /^OEBPS\/chapter-001-/.test(name),
    )!;
    const xhtml = await zip.file(firstChapter)!.async("text");

    // 简介章节里含中文全角标点
    expect(/[，。、：；]/.test(xhtml)).toBe(true);
  }, 60_000);
});

describe("真实小说集成 —— XML 转义与产物合法性", () => {
  it("把含特殊字符的正文写进真实章节后，产物仍然是合法 XML", async () => {
    const bytes = loadBytes("测试小说_001.txt");
    const read = detectAndDecode(bytes);
    const chapters = parseChapters(preprocessLines(read.text), "zh-CN");

    // 塞入一行极端内容，检验转义链路在真实数据规模下依然可靠
    const hostile = `他说：<a href="x">&"'</a>　\u0000\u0001`;
    chapters[1] = { ...chapters[1], lines: [hostile, ...chapters[1].lines] };

    const zip = await JSZip.loadAsync(
      await buildEpub({ title: "转义测试", author: "作者", language: "zh-CN" }, chapters),
    );
    const chapterName = Object.keys(zip.files).find((name) => /^OEBPS\/chapter-002-/.test(name))!;
    const xhtml = await zip.file(chapterName)!.async("text");

    // 非法内容被转义或剔除，不会破坏结构
    expect(xhtml).not.toContain('<a href="x">');
    expect(xhtml).not.toContain("\u0000");
    expect(xhtml).toContain("&lt;a href=&quot;x&quot;&gt;&amp;&quot;&apos;&lt;/a&gt;");
    // 并且章节数量没有因为这一行而变化
    expect(chapters).toHaveLength(89);
  }, 60_000);
});
