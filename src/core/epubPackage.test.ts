// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildEpub } from "./epubBuilder";
import { countHtmlWords, createBlankEpub, isEpubFileName, readEpub, writeEpub } from "./epubPackage";
import type { BookMeta, Chapter, Cover, EpubBookMeta, EpubChapter } from "../types";

const SAMPLE_META: BookMeta = {
  title: "测试之书",
  author: "原作者",
  language: "zh-CN",
  publisher: "墨匣出版社",
  description: "这是一段原始简介。",
  tags: ["标签一", "标签二"],
};

/** 1x1 的 PNG（只用于字节比较，不要求真正可解码）。 */
const PNG_1X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function makeCover(bytes: Uint8Array, mimeType: string, fileName: string): Cover {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return { data: copy.buffer, mimeType, fileName };
}

function chapter(id: string, title: string, lines: string[]): Chapter {
  return { id, title, lines };
}

async function unzip(bytes: Uint8Array): Promise<JSZip> {
  return JSZip.loadAsync(bytes);
}

async function readText(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (!file) throw new Error("zip 中没有 " + path);
  return file.async("text");
}

function bytesEqual(left: ArrayBuffer | Uint8Array, right: Uint8Array): boolean {
  const leftBytes = left instanceof Uint8Array ? left : new Uint8Array(left);
  if (leftBytes.byteLength !== right.byteLength) return false;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    if (leftBytes[index] !== right[index]) return false;
  }
  return true;
}

/** 用 XHTML 解析器验证良构性，返回 parsererror 数量。 */
function xhtmlErrorCount(text: string): number {
  const doc = new DOMParser().parseFromString(text, "application/xhtml+xml");
  return doc.getElementsByTagName("parsererror").length;
}

async function buildSampleEpub(): Promise<Uint8Array> {
  return buildEpub(
    SAMPLE_META,
    [
      chapter("c1", "第1章 起", ["第一段。", "第二段。"]),
      chapter("c2", "第2章 承", ["第二章正文。"]),
      chapter("c3", "第3章 转", ["第三章正文。"]),
      chapter("c4", "第4章 合", ["第四章正文。"]),
    ],
    { cover: makeCover(PNG_1X1, "image/png", "cover.png"), includeNcx: true },
  );
}

/** 在 OPF 中插入自定义/未知元数据，用于验证增量写回是否原样保留。 */
async function withPatchedOpf(bytes: Uint8Array, transform: (opf: string) => string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const opf = await readText(zip, "OEBPS/content.opf");
  zip.file("OEBPS/content.opf", transform(opf));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: "application/epub+zip" });
}

describe("isEpubFileName", () => {
  it("识别 .epub 扩展名（大小写不敏感）", () => {
    expect(isEpubFileName("book.epub")).toBe(true);
    expect(isEpubFileName("BOOK.EPUB")).toBe(true);
    expect(isEpubFileName("  书名.epub  ")).toBe(true);
  });

  it("拒绝其他扩展名与空值", () => {
    expect(isEpubFileName("book.zip")).toBe(false);
    expect(isEpubFileName("book.epub.bak")).toBe(false);
    expect(isEpubFileName("epub")).toBe(false);
    expect(isEpubFileName("")).toBe(false);
    expect(isEpubFileName(null as unknown as string)).toBe(false);
  });
});

describe("countHtmlWords", () => {
  it("空输入返回 0", () => {
    expect(countHtmlWords("")).toBe(0);
    expect(countHtmlWords("   ")).toBe(0);
  });

  it("剔除标签后按非空白字符计数（中文标点计入）", () => {
    expect(countHtmlWords("<p>你好，世界</p>")).toBe(5);
    expect(countHtmlWords("<p>hello world</p>")).toBe(10);
    expect(countHtmlWords("<p>a<strong>b</strong>c</p>")).toBe(3);
  });

  it("忽略脚本与样式内容", () => {
    expect(countHtmlWords("<script>alert(1)</script>")).toBe(0);
    expect(countHtmlWords("<style>p { color: red; }</style>")).toBe(0);
  });

  it("解码常见 HTML 实体", () => {
    expect(countHtmlWords("<p>A&amp;B&nbsp;C</p>")).toBe(4);
    expect(countHtmlWords("<p>&#20320;&#x597D;</p>")).toBe(2);
  });
});

describe("readEpub —— 解析已有 EPUB", () => {
  it("解析元信息、章节、封面与资源统计", async () => {
    const bytes = await buildSampleEpub();
    const project = await readEpub(bytes, "sample.epub");

    expect(project.sourceName).toBe("sample.epub");
    expect(project.opfPath).toBe("OEBPS/content.opf");
    expect(project.opfDir).toBe("OEBPS");
    expect(project.byteLength).toBe(bytes.byteLength);
    expect(project.sourceBytes).toBe(bytes);

    expect(project.meta.title).toBe("测试之书");
    expect(project.meta.author).toBe("原作者");
    expect(project.meta.language).toBe("zh-CN");
    expect(project.meta.publisher).toBe("墨匣出版社");
    expect(project.meta.description).toBe("这是一段原始简介。");
    expect(project.meta.tags).toEqual(["标签一", "标签二"]);
    expect(project.meta.identifier).toMatch(/^urn:uuid:/);

    expect(project.chapters).toHaveLength(4);
    expect(project.chapters.map((item) => item.title)).toEqual(["第1章 起", "第2章 承", "第3章 转", "第4章 合"]);
    for (const item of project.chapters) {
      expect(item.originalTitle).toBe(item.title);
      expect(item.originalHtml).toBe(item.html);
      expect(item.isNew).toBeFalsy();
      expect(item.linear).toBe(true);
    }
    expect(project.chapters[0].html).toContain("<p>第一段。</p>");
    expect(project.chapters[0].html).toContain("<p>第二段。</p>");
    // 章节模型里的正文不应包含 body / section 外壳与重复标题
    expect(project.chapters[0].html).not.toContain("<body");
    expect(project.chapters[0].html).not.toContain("<section");
    expect(project.chapters[0].html).not.toContain("<h1>");

    expect(project.cover).not.toBeNull();
    expect(project.cover?.mimeType).toBe("image/png");
    expect(project.cover?.fileName).toBe("cover.png");
    expect(bytesEqual(project.cover!.data, PNG_1X1)).toBe(true);

    // 资源 = style.css + images/cover.png（不含章节 XHTML / OPF / NCX / NAV / 结构文件）
    expect(project.resourceCount).toBe(2);
  });

  it("读取正文时剔除 script / style / iframe 等危险元素", async () => {
    const base = await buildEpub(SAMPLE_META, [chapter("c1", "第1章", ["正文。"])]);
    const zip = await JSZip.loadAsync(base);
    const chapterName = Object.keys(zip.files).find((name) => /OEBPS\/chapter-001.*\.xhtml$/.test(name));
    expect(chapterName).toBeTruthy();
    const original = await readText(zip, chapterName!);
    const polluted = original
      .replace("</section>", '<script>alert("x")</script><style>p{color:red}</style><iframe src="x.html"></iframe></section>')
      .replace("<p>正文。</p>", '<p onclick="evil()">正文。</p><script src="evil.js"></script>');
    zip.file(chapterName!, polluted);
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: "application/epub+zip" });

    const project = await readEpub(bytes, "polluted.epub");
    expect(project.chapters[0].html).toContain("正文。");
    expect(project.chapters[0].html).not.toContain("<script");
    expect(project.chapters[0].html).not.toContain("<style");
    expect(project.chapters[0].html).not.toContain("<iframe");
    expect(project.chapters[0].html).not.toContain("onclick");
  });

  it("支持多个 rootfile，取第一个 media-type 为 OPF 的", async () => {
    const base = await buildSampleEpub();
    const zip = await JSZip.loadAsync(base);
    const container = await readText(zip, "META-INF/container.xml");
    const patched = container.replace(
      "<rootfiles>",
      '<rootfiles>\n    <rootfile full-path="decoy/fake.opf" media-type="text/plain"/>\n    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>',
    );
    zip.file("META-INF/container.xml", patched);
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: "application/epub+zip" });

    const project = await readEpub(bytes, "multi-root.epub");
    expect(project.opfPath).toBe("OEBPS/content.opf");
    expect(project.meta.title).toBe("测试之书");
  });

  it("识别 meta refines + title-type=subtitle 的副标题", async () => {
    const base = await buildEpub(SAMPLE_META, [chapter("c1", "第1章", ["正文。"])]);
    const bytes = await withPatchedOpf(base, (opf) =>
      opf.replace(
        "<dc:title>测试之书</dc:title>",
        '<dc:title id="main-title">测试之书</dc:title><dc:title id="sub-title">副标题在此</dc:title><meta refines="#sub-title" property="title-type">subtitle</meta>',
      ),
    );
    const project = await readEpub(bytes, "subtitle.epub");
    expect(project.meta.title).toBe("测试之书");
    expect(project.meta.subtitle).toBe("副标题在此");
  });

  it("没有 nav 时用 toc.ncx 的 navLabel 作为章节标题", async () => {
    const base = await buildSampleEpub();
    const zip = await JSZip.loadAsync(base);
    const opf = await readText(zip, "OEBPS/content.opf");
    const patchedOpf = opf.replace(/\s*<item id="nav"[^>]*\/>/, "");
    zip.file("OEBPS/content.opf", patchedOpf);
    zip.remove("OEBPS/nav.xhtml");
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: "application/epub+zip" });

    const project = await readEpub(bytes, "ncx-only.epub");
    expect(project.chapters.map((item) => item.title)).toEqual(["第1章 起", "第2章 承", "第3章 转", "第4章 合"]);
  });

  it("没有 meta name=cover 时用 properties=cover-image 找封面", async () => {
    const base = await buildSampleEpub();
    const bytes = await withPatchedOpf(base, (opf) => opf.replace(/\s*<meta name="cover"[^>]*\/>/, ""));
    const project = await readEpub(bytes, "cover-props.epub");
    expect(project.cover).not.toBeNull();
    expect(project.cover?.mimeType).toBe("image/png");
  });

  it("零章节时返回单章「正文」", async () => {
    const empty = await buildEpub(SAMPLE_META, []);
    const project = await readEpub(empty, "empty.epub");
    expect(project.chapters).toHaveLength(1);
    expect(project.chapters[0].title).toBe("正文");
    expect(project.chapters[0].isNew).toBe(true);
  });
});

describe("writeEpub —— 增量回写", () => {
  /** 构造一份经过编辑的工程：改元信息、改一章、删一章、增一章、重排序。 */
  async function editSample(): Promise<{ project: Awaited<ReturnType<typeof readEpub>>; meta: EpubBookMeta; chapters: EpubChapter[]; output: Uint8Array }>
  {
    const bytes = await buildSampleEpub();
    const project = await readEpub(bytes, "sample.epub");
    const chapters = project.chapters.map((item) => ({ ...item }));

    chapters[0].title = "新第一章";
    chapters[0].html =
      '<p class="ql-align-center">改过的<strong>正文</strong></p><script>alert("x")</script><p onclick="evil()">安全段落</p><a href="javascript:alert(1)">危险链接</a><p class="ql-indent-2 ql-size-large">缩进大字</p>';
    // 删除第 3 章
    const remaining = [chapters[1], chapters[0], chapters[3]];
    const newChapter: EpubChapter = {
      id: "new-1",
      href: "",
      title: "新增章",
      originalTitle: "新增章",
      html: "<p>新增<em>内容</em></p><style>p{color:red}</style>",
      originalHtml: "",
      isNew: true,
      linear: true,
    };
    remaining.splice(2, 0, newChapter);

    const meta: EpubBookMeta = {
      ...project.meta,
      title: "新书名",
      author: "新作者",
      description: "新简介",
      publisher: "新出版社",
      tags: ["新标签A", "新标签B"],
      publishedAt: "2024-05-06",
    };
    const output = await writeEpub(project, meta, remaining);
    return { project, meta, chapters: remaining, output };
  }

  it("重新读取后元信息、章节顺序、标题与正文都正确", async () => {
    const { project, output } = await editSample();
    const reread = await readEpub(output, "edited.epub");

    expect(reread.meta.title).toBe("新书名");
    expect(reread.meta.author).toBe("新作者");
    expect(reread.meta.description).toBe("新简介");
    expect(reread.meta.publisher).toBe("新出版社");
    expect(reread.meta.tags).toEqual(["新标签A", "新标签B"]);
    expect(reread.meta.publishedAt).toBe("2024-05-06");
    expect(reread.meta.identifier).toBe(project.meta.identifier);

    expect(reread.chapters.map((item) => item.title)).toEqual(["第2章 承", "新第一章", "新增章", "第4章 合"]);
    expect(reread.chapters[1].html).toContain("<strong>正文</strong>");
    expect(reread.chapters[1].html).not.toContain("<script");
    expect(reread.chapters[2].html).toContain("<em>内容</em>");
    // 未编辑的章节标题/正文保持不变
    expect(reread.chapters[0].html).toContain("<p>第二章正文。</p>");
    expect(reread.chapters[3].html).toContain("<p>第四章正文。</p>");
  });

  it("HTML 被安全清洗，Quill class 映射为内联样式", async () => {
    const { output } = await editSample();
    const zip = await unzip(output);
    const editedName = "OEBPS/chapter-002-" + "第2章承" + ".xhtml";
    // 通过 manifest 找新第一章的真正文件：标题是「新第一章」但 href 保留原文件名
    const opf = await readText(zip, "OEBPS/content.opf");
    expect(opf).not.toContain("<script");
    expect(opf).not.toContain("onclick");

    const names = Object.keys(zip.files).filter((name) => /OEBPS\/chapter-.*\.xhtml$/.test(name));
    let combined = "";
    for (const name of names) combined += await readText(zip, name);
    expect(combined).not.toContain("<script");
    expect(combined).not.toContain("onclick=");
    expect(combined).not.toContain("javascript:");
    expect(combined).toContain("<strong>正文</strong>");
    expect(combined).toContain("text-align: center");
    expect(combined).toContain("margin-left: 4em");
    expect(combined).toContain("font-size: 1.5em");
    // 第二段仍保留
    expect(combined).toContain("安全段落");
    expect(editedName.length).toBeGreaterThan(0);
  });

  it("删除的章节文件消失，新增章节文件生成且 href 唯一", async () => {
    const { project, output } = await editSample();
    const zip = await unzip(output);
    const opf = await readText(zip, "OEBPS/content.opf");

    const deletedHref = project.chapters[2].href;
    expect(zip.file("OEBPS/" + deletedHref)).toBeNull();
    expect(opf).not.toContain(deletedHref);

    const newChapterName = Object.keys(zip.files).find((name) => /chapter-extra-001\.xhtml$/.test(name));
    expect(newChapterName).toBeTruthy();
    expect(opf).toContain("chapter-extra-001.xhtml");
    const newXhtml = await readText(zip, newChapterName!);
    expect(newXhtml).toContain("<h1>新增章</h1>");
    expect(newXhtml).toContain("<em>内容</em>");
  });

  it("mimetype 是第一个条目且 STORE，未编辑章节字节原样复制", async () => {
    const bytes = await buildSampleEpub();
    const project = await readEpub(bytes, "sample.epub");
    const output = await writeEpub(project, project.meta, project.chapters);

    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0);
    const sourceZip = await unzip(bytes);
    const outputZip = await unzip(output);
    expect(await readText(outputZip, "mimetype")).toBe("application/epub+zip");
    expect(Object.keys(outputZip.files).filter((name) => !outputZip.files[name].dir)[0]).toBe("mimetype");

    const secondHref = project.chapters[1].href;
    expect(await readText(outputZip, "OEBPS/" + secondHref)).toBe(await readText(sourceZip, "OEBPS/" + secondHref));
  });

  it("所有输出 XHTML 均无 parsererror", async () => {
    const { output } = await editSample();
    const zip = await unzip(output);
    const xhtmlNames = Object.keys(zip.files).filter((name) => name.endsWith(".xhtml"));
    expect(xhtmlNames.length).toBeGreaterThan(0);
    for (const name of xhtmlNames) {
      const text = await readText(zip, name);
      expect(xhtmlErrorCount(text), name + " 不是良构 XHTML").toBe(0);
    }
  });

  it("nav.xhtml 与 toc.ncx 按新章节顺序更新标题和 href", async () => {
    const { output } = await editSample();
    const zip = await unzip(output);
    const nav = await readText(zip, "OEBPS/nav.xhtml");
    const ncx = await readText(zip, "OEBPS/toc.ncx");

    for (const title of ["第2章 承", "新第一章", "新增章", "第4章 合"]) {
      expect(nav).toContain(title);
      expect(ncx).toContain(title);
    }
    expect(nav.indexOf("第2章 承")).toBeLessThan(nav.indexOf("新第一章"));
    expect(nav.indexOf("新第一章")).toBeLessThan(nav.indexOf("新增章"));
    expect(nav.indexOf("新增章")).toBeLessThan(nav.indexOf("第4章 合"));
    expect([...ncx.matchAll(/<navPoint /g)]).toHaveLength(4);
  });

  it("保留未知元数据与原始 dc:identifier", async () => {
    const base = await buildSampleEpub();
    const patched = await withPatchedOpf(base, (opf) =>
      opf.replace("<dc:title>测试之书</dc:title>", '<dc:title>测试之书</dc:title><dc:contributor id="contrib">外援作者</dc:contributor><meta property="custom:flag">keep-me</meta>'),
    );
    const project = await readEpub(patched, "unknown.epub");
    const output = await writeEpub(project, { ...project.meta, title: "改名之书" }, project.chapters);
    const zip = await unzip(output);
    const opf = await readText(zip, "OEBPS/content.opf");
    expect(opf).toContain("<dc:contributor id=\"contrib\">外援作者</dc:contributor>");
    expect(opf).toContain('<meta property="custom:flag">keep-me</meta>');
    expect(opf).toContain("<dc:title>改名之书</dc:title>");
    expect(opf).toContain(project.meta.identifier!);
  });

  it("写入副标题后再次读取能拿到副标题", async () => {
    const base = await buildEpub(SAMPLE_META, [chapter("c1", "第1章", ["正文。"])]);
    const bytes = await withPatchedOpf(base, (opf) =>
      opf.replace(
        "<dc:title>测试之书</dc:title>",
        '<dc:title id="main-title">测试之书</dc:title><dc:title id="sub-title">旧副标题</dc:title><meta refines="#sub-title" property="title-type">subtitle</meta>',
      ),
    );
    const project = await readEpub(bytes, "sub.epub");
    const output = await writeEpub(project, { ...project.meta, title: "新书名", subtitle: "新副标题" }, project.chapters);
    const reread = await readEpub(output, "sub2.epub");
    expect(reread.meta.title).toBe("新书名");
    expect(reread.meta.subtitle).toBe("新副标题");
  });

  it("dcterms:modified 更新为 UTC 秒级时间戳", async () => {
    const project = await readEpub(await buildSampleEpub(), "sample.epub");
    const output = await writeEpub(project, project.meta, project.chapters);
    const opf = await readText(await unzip(output), "OEBPS/content.opf");
    expect(opf).toMatch(/<meta property="dcterms:modified">\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/meta>/);
  });
});

describe("writeEpub —— 封面", () => {
  it("options.cover 省略时保留原封面", async () => {
    const project = await readEpub(await buildSampleEpub(), "sample.epub");
    const output = await writeEpub(project, project.meta, project.chapters);
    const reread = await readEpub(output, "keep-cover.epub");
    expect(reread.cover).not.toBeNull();
    expect(reread.cover?.mimeType).toBe("image/png");
    expect(bytesEqual(reread.cover!.data, PNG_1X1)).toBe(true);
  });

  it("options.cover = null 移除封面标记", async () => {
    const project = await readEpub(await buildSampleEpub(), "sample.epub");
    const output = await writeEpub(project, project.meta, project.chapters, { cover: null });
    const zip = await unzip(output);
    const opf = await readText(zip, "OEBPS/content.opf");
    expect(opf).not.toContain('properties="cover-image"');
    expect(opf).not.toContain('name="cover"');
    expect(opf).not.toContain('idref="cover-page"');
    expect(zip.file("OEBPS/cover.xhtml")).toBeNull();
    const reread = await readEpub(output, "no-cover.epub");
    expect(reread.cover).toBeNull();
  });

  it("替换封面并在扩展名变化时同步 cover.xhtml", async () => {
    const project = await readEpub(await buildSampleEpub(), "sample.epub");
    const jpeg = makeCover(PNG_1X1, "image/jpeg", "new-cover.jpg");
    const output = await writeEpub(project, project.meta, project.chapters, { cover: jpeg });
    const zip = await unzip(output);
    const opf = await readText(zip, "OEBPS/content.opf");
    const coverPage = await readText(zip, "OEBPS/cover.xhtml");

    expect(zip.file("OEBPS/images/cover.jpg")).not.toBeNull();
    expect(zip.file("OEBPS/images/cover.png")).toBeNull();
    expect(opf).toContain('media-type="image/jpeg"');
    expect(opf).toContain("images/cover.jpg");
    expect(coverPage).toContain('src="images/cover.jpg"');

    const reread = await readEpub(output, "jpeg-cover.epub");
    expect(reread.cover?.mimeType).toBe("image/jpeg");
    expect(reread.cover?.fileName).toBe("cover.jpg");
    expect(bytesEqual(reread.cover!.data, PNG_1X1)).toBe(true);
  });

  it("原本没有封面时新增 cover.xhtml 并放到 spine 首项", async () => {
    const noCover = await buildEpub(SAMPLE_META, [chapter("c1", "第1章", ["正文。"])]);
    const project = await readEpub(noCover, "no-cover.epub");
    expect(project.cover).toBeNull();

    const output = await writeEpub(project, project.meta, project.chapters, {
      cover: makeCover(PNG_1X1, "image/png", "added.png"),
    });
    const zip = await unzip(output);
    const opf = await readText(zip, "OEBPS/content.opf");
    const spineIds = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((match) => match[1]);
    expect(spineIds[0]).toBe("cover-page");
    expect(zip.file("OEBPS/cover.xhtml")).not.toBeNull();
    const coverPage = await readText(zip, "OEBPS/cover.xhtml");
    expect(coverPage).toContain("<img");

    const reread = await readEpub(output, "added-cover.epub");
    expect(reread.cover).not.toBeNull();
    expect(reread.cover?.mimeType).toBe("image/png");
    expect(reread.chapters).toHaveLength(1);
  });
});

describe("createBlankEpub", () => {
  it("生成可直接编辑与写回的空白书", async () => {
    const project = await createBlankEpub({ title: "空白书", author: "", language: "zh-CN" });
    expect(project.sourceBytes).not.toBeNull();
    expect(project.opfPath).toBe("OEBPS/content.opf");
    expect(project.cover).toBeNull();
    expect(project.chapters).toHaveLength(1);
    expect(project.chapters[0].title).toBe("正文");

    const output = await writeEpub(
      project,
      { title: "空白书", author: "新作者", language: "zh-CN" },
      project.chapters.map((item) => ({ ...item, html: "<p>第一章内容</p>" })),
    );
    const reread = await readEpub(output, "blank-written.epub");
    expect(reread.meta.title).toBe("空白书");
    expect(reread.meta.author).toBe("新作者");
    expect(reread.chapters).toHaveLength(1);
    expect(reread.chapters[0].html).toContain("第一章内容");
  });

  it("两个新章节不会互相覆盖，href 唯一", async () => {
    const project = await createBlankEpub({ title: "空白书", author: "", language: "zh-CN" });
    const chapters: EpubChapter[] = [
      {
        id: "n1",
        href: "",
        title: "新章一",
        originalTitle: "新章一",
        html: "<p>一</p>",
        originalHtml: "",
        isNew: true,
        linear: true,
      },
      {
        id: "n2",
        href: "",
        title: "新章二",
        originalTitle: "新章二",
        html: "<p>二</p>",
        originalHtml: "",
        isNew: true,
        linear: true,
      },
    ];
    const output = await writeEpub(project, project.meta, chapters);
    const zip = await unzip(output);
    const names = Object.keys(zip.files).filter((name) => /chapter-extra-\d+\.xhtml$/.test(name));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    const reread = await readEpub(output, "two-new.epub");
    expect(reread.chapters.map((item) => item.title)).toEqual(["新章一", "新章二"]);
  });
});

describe("writeEpub —— 结构完整性与 spine 过滤", () => {
  it("输出 OPF 可解析，manifest href 均存在，spine idref 均在 manifest 中", async () => {
    const project = await readEpub(await buildSampleEpub(), "sample.epub");
    const output = await writeEpub(project, project.meta, project.chapters);
    const zip = await unzip(output);
    const opf = await readText(zip, "OEBPS/content.opf");

    const opfDoc = new DOMParser().parseFromString(opf, "application/xhtml+xml");
    expect(opfDoc.getElementsByTagName("parsererror").length).toBe(0);

    const manifestHrefs = [...opf.matchAll(/<item [^>]*href="([^"]+)"/g)].map((match) => match[1]);
    for (const href of manifestHrefs) {
      expect(zip.file("OEBPS/" + href), "manifest 引用的文件不存在：" + href).not.toBeNull();
    }
    const ids = [...opf.matchAll(/<item id="([^"]+)"/g)].map((match) => match[1]);
    const idrefs = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((match) => match[1]);
    expect(idrefs.length).toBeGreaterThan(0);
    for (const idref of idrefs) expect(ids).toContain(idref);
    expect(ids).toContain("nav");
    expect(opf).toContain('properties="nav"');
    expect(opf).toMatch(/<meta property="dcterms:modified">\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/meta>/);
  });

  it("readEpub 跳过 spine 中 linear=\"no\" 的文档", async () => {
    const base = await buildEpub(SAMPLE_META, [
      chapter("c1", "第1章", ["一"]),
      chapter("c2", "第2章", ["二"]),
      chapter("c3", "第3章", ["三"]),
    ]);
    const zip = await JSZip.loadAsync(base);
    const opf = await readText(zip, "OEBPS/content.opf");
    expect(opf).toContain('<itemref idref="chapter-002"/>');
    zip.file("OEBPS/content.opf", opf.replace('<itemref idref="chapter-002"/>', '<itemref idref="chapter-002" linear="no"/>'));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: "application/epub+zip" });

    const project = await readEpub(bytes, "linear-no.epub");
    expect(project.chapters.map((item) => item.title)).toEqual(["第1章", "第3章"]);
  });
});