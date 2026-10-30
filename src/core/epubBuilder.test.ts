import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  DEFAULT_TYPESETTING,
  buildEpub,
  buildStyleSheet,
  escapeXml,
  extensionForMime,
  resolveTypesetting,
  suggestFileName,
  toEpubBlob,
} from "./epubBuilder";
import type { BookMeta, Chapter, Cover } from "../types";

const meta: BookMeta = {
  title: "测试之书",
  author: "测试作者",
  language: "zh-CN",
};

function chapter(title: string, lines: string[], id = title): Chapter {
  return { id, title, lines };
}

/** 解开 EPUB 方便断言。 */
async function unzip(bytes: Uint8Array): Promise<JSZip> {
  return JSZip.loadAsync(bytes);
}

/** 读取 zip 内文本。 */
async function readText(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (!file) throw new Error(`zip 中没有 ${path}`);
  return file.async("text");
}

/** 1x1 的 PNG，用于封面测试。 */
const PNG_1X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/** 把字节包成 Cover。 */
function makeCover(bytes: Uint8Array, mimeType: string, fileName: string): Cover {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return { data: copy.buffer, mimeType, fileName };
}

describe("escapeXml", () => {
  it("转义五类 XML 实体", () => {
    expect(escapeXml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&apos;");
  });

  it("先转义 & 再转义其他，不会双重转义", () => {
    expect(escapeXml("a & <b>")).toBe("a &amp; &lt;b&gt;");
  });

  it("中文与全角标点原样保留", () => {
    expect(escapeXml("“你好”，世界…———")).toBe("“你好”，世界…———");
  });

  it("剔除 XML 1.0 不允许的控制字符", () => {
    expect(escapeXml("a\u0000b\u0001c\u0008d")).toBe("abcd");
  });

  it("保留制表符、换行、回车", () => {
    expect(escapeXml("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  it("剔除 U+FFFE 与落单代理项", () => {
    expect(escapeXml("a\ufffeb")).toBe("ab");
    expect(escapeXml("a\ud800b")).toBe("ab");
  });

  it("保留成对的代理项（emoji）", () => {
    expect(escapeXml("👍")).toBe("👍");
  });

  it("null / undefined 安全处理", () => {
    expect(escapeXml(null as unknown as string)).toBe("");
    expect(escapeXml(undefined as unknown as string)).toBe("");
  });
});

describe("resolveTypesetting", () => {
  it("不传时使用默认排版", () => {
    expect(resolveTypesetting()).toEqual(DEFAULT_TYPESETTING);
    expect(resolveTypesetting({})).toEqual(DEFAULT_TYPESETTING);
  });

  it("裁剪越界数值", () => {
    const huge = resolveTypesetting({ lineHeight: 99, fontSize: 99 });
    expect(huge.lineHeight).toBeLessThanOrEqual(3);
    expect(huge.fontSize).toBeLessThanOrEqual(3);

    const tiny = resolveTypesetting({ lineHeight: 0.1, fontSize: 0.01 });
    expect(tiny.lineHeight).toBeGreaterThanOrEqual(1);
    expect(tiny.fontSize).toBeGreaterThanOrEqual(0.5);
  });

  it("把像素字号换算成 em", () => {
    expect(resolveTypesetting({ fontSize: 16 }).fontSize).toBe(1);
    expect(resolveTypesetting({ fontSize: 20 }).fontSize).toBe(1.25);
  });

  it("非数字回退默认值", () => {
    const result = resolveTypesetting({ lineHeight: Number.NaN, fontSize: Number.NaN });
    expect(result.lineHeight).toBe(DEFAULT_TYPESETTING.lineHeight);
    expect(result.fontSize).toBe(DEFAULT_TYPESETTING.fontSize);
  });

  it("布尔选项被保留", () => {
    expect(resolveTypesetting({ indent: false }).indent).toBe(false);
    expect(resolveTypesetting({ paragraphSpacing: true }).paragraphSpacing).toBe(true);
  });
});

describe("buildStyleSheet", () => {
  it("默认开启中文段首缩进两字", () => {
    expect(buildStyleSheet()).toContain("text-indent: 2em;");
  });

  it("关闭缩进时写 text-indent: 0", () => {
    const css = buildStyleSheet({ indent: false });
    expect(css).toContain("text-indent: 0;");
    expect(css).not.toContain("text-indent: 2em;");
  });

  it("行高与字号写进样式表", () => {
    const css = buildStyleSheet({ lineHeight: 2.1, fontSize: 1.2 });
    expect(css).toContain("line-height: 2.1;");
    expect(css).toContain("font-size: 1.2em;");
  });

  it("段间距开关影响 p 的 margin", () => {
    expect(buildStyleSheet({ paragraphSpacing: true })).toContain("margin: 0 0 0.7em 0;");
    expect(buildStyleSheet({ paragraphSpacing: false })).toContain("margin: 0;");
  });
});

describe("extensionForMime", () => {
  it("常见图片类型映射正确", () => {
    expect(extensionForMime("image/jpeg")).toBe("jpg");
    expect(extensionForMime("image/png")).toBe("png");
    expect(extensionForMime("image/gif")).toBe("gif");
    expect(extensionForMime("image/webp")).toBe("webp");
  });

  it("未知类型回退 jpg", () => {
    expect(extensionForMime("application/octet-stream")).toBe("jpg");
    expect(extensionForMime("")).toBe("jpg");
  });
});

describe("buildEpub —— 基础结构", () => {
  it("mimetype 是第一个条目且以 STORE 方式存储", async () => {
    const bytes = await buildEpub(meta, [chapter("第1章", ["正文"])]);
    const zip = await unzip(bytes);

    // zip 条目顺序：mimetype 必须排在最前
    const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
    expect(names[0]).toBe("mimetype");
    expect(await readText(zip, "mimetype")).toBe("application/epub+zip");

    // 直接看 zip 原始字节：mimetype 的本地文件头必须紧跟文件名、且压缩方式为 0（STORE）
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // local file header 签名 0x04034b50
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    // 偏移 8 是压缩方式（2 字节），0 = STORE
    expect(view.getUint16(8, true)).toBe(0);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const fileName = new TextDecoder("utf-8").decode(bytes.subarray(30, 30 + nameLength));
    expect(fileName).toBe("mimetype");
    expect(extraLength).toBe(0);
    // STORE 意味着 mimetype 内容是明文可读的
    const contentStart = 30 + nameLength;
    expect(new TextDecoder("utf-8").decode(bytes.subarray(contentStart, contentStart + 20))).toBe(
      "application/epub+zip",
    );
  });

  it("包含 META-INF/container.xml 且指向 OEBPS/content.opf", async () => {
    const bytes = await buildEpub(meta, [chapter("第1章", ["正文"])]);
    const zip = await unzip(bytes);
    const container = await readText(zip, "META-INF/container.xml");
    expect(container).toContain('full-path="OEBPS/content.opf"');
    expect(container).toContain("application/oebps-package+xml");
    expect(container).toContain("urn:oasis:names:tc:opendocument:xmlns:container");
  });

  it("OPF 是 3.0，含 dcterms:modified 与 dc 元信息", async () => {
    const bytes = await buildEpub(
      { ...meta, publisher: "墨匣出版社", description: "一本书的简介", tags: ["仙侠", "连载"] },
      [chapter("第1章", ["正文"])],
    );
    const zip = await unzip(bytes);
    const opf = await readText(zip, "OEBPS/content.opf");

    expect(opf).toContain('version="3.0"');
    expect(opf).toContain('unique-identifier="bookid"');
    expect(opf).toContain("<dc:identifier id=\"bookid\">urn:uuid:");
    expect(opf).toContain("<dc:title>测试之书</dc:title>");
    expect(opf).toContain("<dc:creator>测试作者</dc:creator>");
    expect(opf).toContain("<dc:language>zh-CN</dc:language>");
    expect(opf).toContain("<dc:publisher>墨匣出版社</dc:publisher>");
    expect(opf).toContain("<dc:description>一本书的简介</dc:description>");
    expect(opf).toContain("<dc:subject>仙侠</dc:subject>");
    expect(opf).toContain("<dc:subject>连载</dc:subject>");
    expect(opf).toMatch(/<meta property="dcterms:modified">\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/meta>/);
  });

  it("nav.xhtml 存在且声明 properties=\"nav\"，manifest 与 spine 引用一致", async () => {
    const bytes = await buildEpub(meta, [chapter("第1章 起", ["甲"]), chapter("第2章 承", ["乙"])]);
    const zip = await unzip(bytes);
    const opf = await readText(zip, "OEBPS/content.opf");
    const nav = await readText(zip, "OEBPS/nav.xhtml");

    expect(opf).toContain('href="nav.xhtml"');
    expect(opf).toContain('properties="nav"');
    expect(nav).toContain('epub:type="toc"');
    expect(nav).toContain('xmlns:epub="http://www.idpf.org/2007/ops"');
    expect(nav).toContain("第1章 起");
    expect(nav).toContain("第2章 承");

    // spine 里的每个 idref 都必须在 manifest 里出现过
    const manifestIds = [...opf.matchAll(/<item id="([^"]+)"/g)].map((m) => m[1]);
    const spineIds = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((m) => m[1]);
    expect(spineIds.length).toBeGreaterThan(0);
    for (const id of spineIds) expect(manifestIds).toContain(id);

    // manifest 里引用的每个文件都必须真实存在于 zip 中
    const hrefs = [...opf.matchAll(/<item [^>]*href="([^"]+)"/g)].map((m) => m[1]);
    for (const href of hrefs) {
      expect(zip.file(`OEBPS/${href}`), `manifest 引用的 ${href} 不存在`).not.toBeNull();
    }
  });

  it("样式表被打包且被章节引用", async () => {
    const bytes = await buildEpub(meta, [chapter("第1章", ["正文"])], {
      typesetting: { indent: true, lineHeight: 1.8 },
    });
    const zip = await unzip(bytes);
    const css = await readText(zip, "OEBPS/style.css");
    const chapterXhtml = await readText(zip, "OEBPS/chapter-001-第1章.xhtml");

    expect(css).toContain("text-indent: 2em;");
    expect(css).toContain("line-height: 1.8;");
    expect(chapterXhtml).toContain('href="style.css"');
  });

  it("默认不生成 NCX，includeNcx 时才生成并挂到 spine toc", async () => {
    const withoutNcx = await unzip(await buildEpub(meta, [chapter("第1章", ["a"])]));
    expect(withoutNcx.file("OEBPS/toc.ncx")).toBeNull();
    const opfWithout = await readText(withoutNcx, "OEBPS/content.opf");
    expect(opfWithout).not.toContain("toc.ncx");

    const withNcx = await unzip(await buildEpub(meta, [chapter("第1章", ["a"])], { includeNcx: true }));
    const ncx = await readText(withNcx, "OEBPS/toc.ncx");
    expect(ncx).toContain("<navMap>");
    expect(ncx).toContain("第1章");
    const opfWith = await readText(withNcx, "OEBPS/content.opf");
    expect(opfWith).toContain('media-type="application/x-dtbncx+xml"');
    expect(opfWith).toContain('toc="ncx"');
  });

  it("章节数量与 spine 中的章节条目数一致", async () => {
    const chapters = Array.from({ length: 5 }, (_, i) => chapter(`第${i + 1}章`, [`内容${i + 1}`]));
    const zip = await unzip(await buildEpub(meta, chapters));
    const opf = await readText(zip, "OEBPS/content.opf");
    const chapterFiles = Object.keys(zip.files).filter((name) => /OEBPS\/chapter-\d+/.test(name));
    expect(chapterFiles).toHaveLength(5);
    const chapterRefs = [...opf.matchAll(/<itemref idref="chapter-\d+"/g)];
    expect(chapterRefs).toHaveLength(5);
  });

  it("章节 HTML 是一行一个 <p>，空行保留为占位段落", async () => {
    const zip = await unzip(
      await buildEpub(meta, [chapter("第1章", ["第一段。", "", "第二段。"])]),
    );
    const xhtml = await readText(zip, "OEBPS/chapter-001-第1章.xhtml");
    expect(xhtml).toContain("<p>第一段。</p>");
    expect(xhtml).toContain("<p>第二段。</p>");
    expect(xhtml).toContain('<p class="blank">');
  });

  it("空章节也能生成合法 XHTML（不产出空 body）", async () => {
    const zip = await unzip(await buildEpub(meta, [chapter("空章", [])]));
    const xhtml = await readText(zip, "OEBPS/chapter-001-空章.xhtml");
    expect(xhtml).toContain("<body>");
    expect(xhtml).toContain("<h1>空章</h1>");
    expect(xhtml.trim().endsWith("</html>")).toBe(true);
  });

  it("零章节时仍产出结构完整的 EPUB", async () => {
    const bytes = await buildEpub(meta, []);
    const zip = await unzip(bytes);
    expect(zip.file("META-INF/container.xml")).not.toBeNull();
    expect(zip.file("OEBPS/content.opf")).not.toBeNull();
    expect(zip.file("OEBPS/nav.xhtml")).not.toBeNull();
    expect(await readText(zip, "mimetype")).toBe("application/epub+zip");
  });
});

describe("buildEpub —— XML 转义", () => {
  it("正文中的 <>&\"' 全部被转义，不会产出非法 XML", async () => {
    const tricky = `他说："a < b && c > d"，还有 'single'。`;
    const zip = await unzip(await buildEpub(meta, [chapter("第1章", [tricky])]));
    const xhtml = await readText(zip, "OEBPS/chapter-001-第1章.xhtml");

    // 原始字符不应出现在元素内容里
    expect(xhtml).not.toContain("< b");
    expect(xhtml).not.toContain("&&");
    expect(xhtml).toContain('他说：&quot;a &lt; b &amp;&amp; c &gt; d&quot;，还有 &apos;single&apos;。');
  });

  it("章节标题中的特殊字符被转义", async () => {
    const zip = await unzip(
      await buildEpub(meta, [chapter(`第1章 <script>alert("x")</script>`, ["a"])]),
    );
    const names = Object.keys(zip.files).filter((name) => name.includes("OEBPS/chapter-"));
    const xhtml = await readText(zip, names[0]);
    expect(xhtml).not.toContain("<script>");
    expect(xhtml).toContain("&lt;script&gt;");
    // h1 与 title 都转义
    expect(xhtml).toContain("<title>第1章 &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</title>");
  });

  it("书名与作者里的特殊字符被转义", async () => {
    const zip = await unzip(
      await buildEpub({ title: `A&B <C>`, author: `"D"`, language: "en" }, [chapter("Ch 1", ["x"])]),
    );
    const opf = await readText(zip, "OEBPS/content.opf");
    expect(opf).toContain("<dc:title>A&amp;B &lt;C&gt;</dc:title>");
    expect(opf).toContain("<dc:creator>&quot;D&quot;</dc:creator>");
  });

  it("含有 NUL 等控制字符的正文不会破坏 XHTML", async () => {
    const zip = await unzip(await buildEpub(meta, [chapter("第1章", ["a\u0000b\u0007c"])]));
    const xhtml = await readText(zip, "OEBPS/chapter-001-第1章.xhtml");
    expect(xhtml).not.toContain("\u0000");
    expect(xhtml).toContain("<p>abc</p>");
  });

  it("nav.xhtml 与 toc.ncx 里的标题同样转义", async () => {
    const zip = await unzip(
      await buildEpub(meta, [chapter(`第1章 <b>&</b>`, ["x"])], { includeNcx: true }),
    );
    const nav = await readText(zip, "OEBPS/nav.xhtml");
    const ncx = await readText(zip, "OEBPS/toc.ncx");
    for (const doc of [nav, ncx]) {
      expect(doc).not.toContain("<b>");
      expect(doc).toContain("&lt;b&gt;&amp;&lt;/b&gt;");
    }
  });
});

describe("buildEpub —— 封面", () => {
  it("有封面时生成 cover-image 属性、meta name=cover 与封面页", async () => {
    const cover = makeCover(PNG_1X1, "image/png", "我的封面.png");
    const zip = await unzip(await buildEpub(meta, [chapter("第1章", ["a"])], { cover }));

    const opf = await readText(zip, "OEBPS/content.opf");
    expect(opf).toContain('properties="cover-image"');
    expect(opf).toContain('<meta name="cover" content="cover-image"/>');
    expect(opf).toContain('media-type="image/png"');
    expect(opf).toContain('href="images/cover.png"');

    // 封面图片与封面页都真实存在
    expect(zip.file("OEBPS/images/cover.png")).not.toBeNull();
    const coverPage = await readText(zip, "OEBPS/cover.xhtml");
    expect(coverPage).toContain('src="images/cover.png"');

    // 封面页在 spine 中且排在最前
    const spineIds = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((m) => m[1]);
    expect(spineIds[0]).toBe("cover-page");

    // 图片字节原样写入
    const imageBytes = await zip.file("OEBPS/images/cover.png")!.async("uint8array");
    expect(Array.from(imageBytes)).toEqual(Array.from(PNG_1X1));
  });

  it("JPEG / WEBP 封面用对应扩展名与 media-type", async () => {
    const jpeg = await unzip(
      await buildEpub(meta, [chapter("第1章", ["a"])], {
        cover: makeCover(PNG_1X1, "image/jpeg", "c.jpg"),
      }),
    );
    expect(jpeg.file("OEBPS/images/cover.jpg")).not.toBeNull();
    expect(await readText(jpeg, "OEBPS/content.opf")).toContain('media-type="image/jpeg"');

    const webp = await unzip(
      await buildEpub(meta, [chapter("第1章", ["a"])], {
        cover: makeCover(PNG_1X1, "image/webp", "c.webp"),
      }),
    );
    expect(webp.file("OEBPS/images/cover.webp")).not.toBeNull();
  });

  it("MIME 缺失时按文件名推断", async () => {
    const zip = await unzip(
      await buildEpub(meta, [chapter("第1章", ["a"])], {
        cover: makeCover(PNG_1X1, "", "cover.png"),
      }),
    );
    expect(await readText(zip, "OEBPS/content.opf")).toContain('media-type="image/png"');
  });

  it("无封面时不产出 cover.xhtml / cover-image", async () => {
    const zip = await unzip(await buildEpub(meta, [chapter("第1章", ["a"])]));
    expect(zip.file("OEBPS/cover.xhtml")).toBeNull();
    const opf = await readText(zip, "OEBPS/content.opf");
    expect(opf).not.toContain("cover-image");
    expect(opf).not.toContain('name="cover"');
  });

  it("封面字节为空时按无封面处理（不产出坏引用）", async () => {
    const zip = await unzip(
      await buildEpub(meta, [chapter("第1章", ["a"])], {
        cover: makeCover(new Uint8Array(0), "image/png", "empty.png"),
      }),
    );
    expect(zip.file("OEBPS/cover.xhtml")).toBeNull();
    const opf = await readText(zip, "OEBPS/content.opf");
    expect(opf).not.toContain("cover-image");
  });
});

describe("buildEpub —— 文件名与健壮性", () => {
  it("章节文件名做了非法字符清洗", async () => {
    const zip = await unzip(await buildEpub(meta, [chapter('第1章 a/b:c*d?"e"<f>|g', ["x"])]));
    const names = Object.keys(zip.files).filter((name) => name.includes("OEBPS/chapter-"));
    expect(names).toHaveLength(1);
    expect(names[0]).not.toMatch(/[:*?"<>|]/);
  });

  it("超长章节标题不会产生超长文件名", async () => {
    const zip = await unzip(await buildEpub(meta, [chapter("长".repeat(300), ["x"])]));
    const names = Object.keys(zip.files).filter((name) => name.includes("OEBPS/chapter-"));
    expect(names[0].length).toBeLessThan(120);
    // 标题本身在 XHTML 里完整保留
    const xhtml = await readText(zip, names[0]);
    expect(xhtml).toContain("长".repeat(300));
  });

  it("章节标题为空时用兜底文件名与标题", async () => {
    const zip = await unzip(await buildEpub(meta, [{ id: "x", title: "   ", lines: ["正文"] }]));
    const names = Object.keys(zip.files).filter((name) => name.includes("OEBPS/chapter-"));
    expect(names).toHaveLength(1);
    const xhtml = await readText(zip, names[0]);
    expect(xhtml).toContain("<h1>未命名</h1>");
  });

  it("书名为空时 OPF 用「未命名」兜底", async () => {
    const zip = await unzip(
      await buildEpub({ title: "", author: "", language: "zh-CN" }, [chapter("第1章", ["a"])]),
    );
    expect(await readText(zip, "OEBPS/content.opf")).toContain("<dc:title>未命名</dc:title>");
  });

  it("大量章节（600+）能正常生成且不重复文件名", async () => {
    const chapters = Array.from({ length: 620 }, (_, i) => chapter(`第${i + 1}章`, [`内容第${i + 1}节`]));
    const zip = await unzip(await buildEpub(meta, chapters));
    const names = Object.keys(zip.files).filter((name) => name.includes("OEBPS/chapter-"));
    expect(names).toHaveLength(620);
    expect(new Set(names).size).toBe(620);
    const opf = await readText(zip, "OEBPS/content.opf");
    expect([...opf.matchAll(/<itemref idref="chapter-\d+"/g)]).toHaveLength(620);
  }, 30_000);

  it("生成的字节以 ZIP 魔数开头", async () => {
    const bytes = await buildEpub(meta, [chapter("第1章", ["a"])]);
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);
  });

  it("不同次调用产生不同的 book id（不会撞书）", async () => {
    const first = await readText(await unzip(await buildEpub(meta, [chapter("第1章", ["a"])])), "OEBPS/content.opf");
    const second = await readText(await unzip(await buildEpub(meta, [chapter("第1章", ["a"])])), "OEBPS/content.opf");
    const idOf = (opf: string) => opf.match(/<dc:identifier id="bookid">([^<]+)<\/dc:identifier>/)?.[1];
    expect(idOf(first)).toBeTruthy();
    expect(idOf(first)).not.toBe(idOf(second));
  });
});

describe("toEpubBlob", () => {
  it("包出 application/epub+zip 类型的 Blob，且内容与输入一致", async () => {
    const bytes = await buildEpub(meta, [chapter("第1章", ["a"])]);
    const blob = toEpubBlob(bytes);
    expect(blob.type).toBe("application/epub+zip");
    expect(blob.size).toBe(bytes.byteLength);
    const roundTrip = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(roundTrip.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("复制而不是复用原 buffer（调用方可安全释放原数组）", () => {
    const source = new Uint8Array([1, 2, 3]);
    const blob = toEpubBlob(source);
    source[0] = 99;
    expect(blob.size).toBe(3);
  });

  it("空输入不抛错", () => {
    expect(toEpubBlob(new Uint8Array(0)).size).toBe(0);
  });
});

describe("suggestFileName", () => {
  it("用书名 + 作者，补 .epub 后缀", () => {
    expect(suggestFileName(meta)).toBe("测试之书 - 测试作者.epub");
  });

  it("没有作者时只用书名", () => {
    expect(suggestFileName({ title: "孤书", author: "", language: "zh-CN" })).toBe("孤书.epub");
  });

  it("清洗 Windows 下的非法字符（删除而不是替换）", () => {
    // a/b:c*d?"e" → 去掉 / : * ? " 后剩 abcde
    expect(suggestFileName({ title: 'a/b:c*d?"e"', author: "", language: "zh-CN" })).toBe("abcde.epub");
    // 每一类非法字符都被删掉
    expect(suggestFileName({ title: "a<b>c|d\\e", author: "", language: "zh-CN" })).toBe("abcde.epub");
  });

  it("裁掉首尾空白，去掉结尾的点（Windows 不允许）", () => {
    expect(suggestFileName({ title: "  书名.  ", author: "", language: "zh-CN" })).toBe("书名.epub");
  });

  it("书名与作者都为空时用「未命名」", () => {
    expect(suggestFileName({ title: "", author: "", language: "zh-CN" })).toBe("未命名.epub");
    expect(suggestFileName({ title: "   ", author: "  ", language: "zh-CN" })).toBe("未命名.epub");
  });

  it("英文语言用 Untitled 兜底", () => {
    expect(suggestFileName({ title: "", author: "", language: "en" })).toBe("Untitled.epub");
  });

  it("超长书名被截断但仍有 .epub 后缀", () => {
    const name = suggestFileName({ title: "长".repeat(500), author: "", language: "zh-CN" });
    expect(name.endsWith(".epub")).toBe(true);
    expect(name.length).toBeLessThan(140);
  });

  it("同名作者里也有非法字符时一并清洗", () => {
    expect(suggestFileName({ title: "书", author: "作/者", language: "zh-CN" })).toBe("书 - 作者.epub");
  });
});

/* ============================================================
   回归测试：EPUBCheck 5.4.0 查出的真问题
   ------------------------------------------------------------
   这两类缺陷的共同点都是「生成了容器却没有内容」或「产出了非法 URL」，
   单元测试里很难自然覆盖，但会让真实阅读器打不开书，所以固化成断言。
   ============================================================ */

/** 找出文档中所有 <ol>...</ol> 的内容（用于断言没有空列表）。 */
function allOrderedLists(doc: string): string[] {
  return [...doc.matchAll(/<ol>([\s\S]*?)<\/ol>/g)].map((match) => match[1]);
}

describe("回归：nav.xhtml 不能出现空 <ol>（EPUBCheck RSC-005）", () => {
  it("无封面 + 多章时，每个 <ol> 都有 <li>（landmarks 只剩 bodymatter）", async () => {
    const zip = await unzip(
      await buildEpub(meta, [chapter("第1章 起", ["a"]), chapter("第2章 承", ["b"])]),
    );
    const nav = await readText(zip, "OEBPS/nav.xhtml");

    // 有正文锚点，landmarks 应当存在且指向第一章
    expect(nav).toContain('epub:type="landmarks"');
    expect(nav).toMatch(/epub:type="bodymatter"\s+href="chapter-001-[^"]*\.xhtml"/);
    // 但没有封面就不该有 cover landmark
    expect(nav).not.toContain('epub:type="cover"');

    // 最本质的断言：文档里任何一个 <ol> 都必须至少有一个 <li>
    // （这正是 EPUBCheck RSC-005 的判定，空 <ol> 会让整本书校验失败）
    const lists = allOrderedLists(nav);
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      expect(list).toContain("<li>");
    }
  });

  it("有封面时 landmarks 同时含 cover 与 bodymatter", async () => {
    const cover = makeCover(PNG_1X1, "image/png", "c.png");
    const zip = await unzip(
      await buildEpub(meta, [chapter("第1章 起", ["a"]), chapter("第2章 承", ["b"])], { cover }),
    );
    const nav = await readText(zip, "OEBPS/nav.xhtml");

    expect(nav).toContain('epub:type="landmarks"');
    expect(nav).toContain('epub:type="cover"');
    expect(nav).toContain('epub:type="bodymatter"');
    // 封面 landmark 指向 cover.xhtml，正文 landmark 指向第一章
    expect(nav).toMatch(/epub:type="cover"\s+href="cover\.xhtml"/);
    expect(nav).toMatch(/epub:type="bodymatter"\s+href="chapter-001-[^"]*\.xhtml"/);

    for (const list of allOrderedLists(nav)) {
      expect(list).toContain("<li>");
    }
  });

  it("零章节时目录 <ol> 仍有可跳转条目（不再是空的）", async () => {
    const zip = await unzip(await buildEpub(meta, []));
    const nav = await readText(zip, "OEBPS/nav.xhtml");

    for (const list of allOrderedLists(nav)) {
      expect(list).toContain("<li>");
    }
    // 兜底指向真实存在的书名页
    expect(nav).toContain('href="titlepage.xhtml"');
    expect(zip.file("OEBPS/titlepage.xhtml")).not.toBeNull();
  });
});

describe("回归：toc.ncx 的 navMap 不能为空（NCX DTD）", () => {
  it("零章节 + includeNcx 时 navMap 仍至少有一个 navPoint", async () => {
    const zip = await unzip(await buildEpub(meta, [], { includeNcx: true }));
    const ncx = await readText(zip, "OEBPS/toc.ncx");
    const navMap = ncx.match(/<navMap>([\s\S]*?)<\/navMap>/)?.[1] ?? "";

    expect(navMap).toContain("<navPoint");
    // 兜底指向真实存在的文件，不能是死链
    expect(navMap).toContain('src="titlepage.xhtml"');
    expect(zip.file("OEBPS/titlepage.xhtml")).not.toBeNull();
  });

  it("有章节时 navPoint 数量与章节数一致", async () => {
    const chapters = Array.from({ length: 4 }, (_, i) => chapter(`第${i + 1}章`, [`内容${i + 1}`]));
    const zip = await unzip(await buildEpub(meta, chapters, { includeNcx: true }));
    const ncx = await readText(zip, "OEBPS/toc.ncx");
    expect([...ncx.matchAll(/<navPoint /g)]).toHaveLength(4);
    // playOrder 从 1 连续递增
    const orders = [...ncx.matchAll(/playOrder="(\d+)"/g)].map((m) => Number(m[1]));
    expect(orders).toEqual([1, 2, 3, 4]);
  });
});

describe("回归：章节文件名不能含空格等非法 URL 字符（EPUBCheck RSC-020）", () => {
  /** 从 OPF 里取出所有章节 href。 */
  async function chapterHrefs(zip: JSZip): Promise<string[]> {
    const opf = await readText(zip, "OEBPS/content.opf");
    return [...opf.matchAll(/<item [^>]*href="(chapter-[^"]+)"/g)].map((m) => m[1]);
  }

  it("标题里带空格时文件名不含空格，且 href 与 zip 条目一一对应", async () => {
    // 「第1章 起风了」是最常见的中文标题形态，曾经直接导致 EPUBCheck 报错
    const zip = await unzip(
      await buildEpub(meta, [chapter("第1章 起风了", ["a"]), chapter("第2章 承上启下", ["b"])]),
    );
    const hrefs = await chapterHrefs(zip);

    expect(hrefs).toHaveLength(2);
    for (const href of hrefs) {
      expect(href).not.toContain(" ");
      // 路径段里不允许出现的字符一并检查
      expect(href).not.toMatch(/[#?%\\]/);
      // 声明的文件必须真实存在
      expect(zip.file(`OEBPS/${href}`), `${href} 不存在`).not.toBeNull();
    }
  });

  it("标题含 XML 元字符与全角空格时也能得到合法的 href", async () => {
    const zip = await unzip(
      await buildEpub(meta, [
        chapter(`第1章\u3000<b>&"'`, ["x"]),
        chapter("第2章 a b c", ["y"]),
      ]),
    );
    const hrefs = await chapterHrefs(zip);

    expect(hrefs).toHaveLength(2);
    for (const href of hrefs) {
      expect(href).not.toMatch(/[\s<>"'&]/);
      expect(zip.file(`OEBPS/${href}`)).not.toBeNull();
    }
  });

  it("标题清洗后为空时回退到带序号的默认文件名", async () => {
    const zip = await unzip(
      await buildEpub(meta, [
        { id: "a", title: "\u0000\u0001\u0002", lines: ["正文"] },
        { id: "b", title: "   ", lines: ["正文"] },
      ]),
    );
    const hrefs = await chapterHrefs(zip);

    expect(hrefs).toHaveLength(2);
    expect(hrefs[0]).toBe("chapter-001-chapter-001.xhtml");
    expect(hrefs[1]).toBe("chapter-002-chapter-002.xhtml");
    // 两个文件仍然各自存在，没有互相覆盖
    expect(zip.file(`OEBPS/${hrefs[0]}`)).not.toBeNull();
    expect(zip.file(`OEBPS/${hrefs[1]}`)).not.toBeNull();
  });

  it("nav 与 ncx 引用的 href 与 OPF 完全一致（不能有转义/未转义混用）", async () => {
    const zip = await unzip(
      await buildEpub(meta, [chapter("第1章 起风了", ["a"])], { includeNcx: true }),
    );
    const opf = await readText(zip, "OEBPS/content.opf");
    const nav = await readText(zip, "OEBPS/nav.xhtml");
    const ncx = await readText(zip, "OEBPS/toc.ncx");

    const href = (await chapterHrefs(zip))[0];
    expect(nav).toContain(`href="${href}"`);
    expect(ncx).toContain(`src="${href}"`);
    expect(opf).toContain(`href="${href}"`);
  });
});

describe("回归：标题全是非法字符时不能产出空 <title>/<h1>", () => {
  it("章节标题只有控制字符时用兜底标题，XHTML 不出现空标签", async () => {
    const zip = await unzip(
      await buildEpub(meta, [{ id: "a", title: "\u0000\u0001", lines: ["正文"] }]),
    );
    const names = Object.keys(zip.files).filter((name) => name.includes("OEBPS/chapter-"));
    const xhtml = await readText(zip, names[0]);

    expect(xhtml).not.toContain("<title></title>");
    expect(xhtml).not.toContain("<h1></h1>");
    expect(xhtml).toContain("<h1>未命名</h1>");
  });

  it("书名只有控制字符时 OPF / nav / ncx 都用兜底书名", async () => {
    const zip = await unzip(
      await buildEpub({ title: "\u0000", author: "", language: "zh-CN" }, [chapter("第1章", ["a"])], {
        includeNcx: true,
      }),
    );
    const opf = await readText(zip, "OEBPS/content.opf");
    const ncx = await readText(zip, "OEBPS/toc.ncx");

    expect(opf).toContain("<dc:title>未命名</dc:title>");
    expect(opf).not.toContain("<dc:title></dc:title>");
    expect(ncx).toContain("<docTitle><text>未命名</text></docTitle>");
  });
});

describe("回归：所有生成的 XHTML 结构完整（无空容器）", () => {
  it("任何配置下 body 都非空，且 <ol>/<ul> 都不为空", async () => {
    const cover = makeCover(PNG_1X1, "image/png", "c.png");
    const configs: Array<{ label: string; chapters: Chapter[]; options: Parameters<typeof buildEpub>[2] }> = [
      { label: "零章节无封面", chapters: [], options: undefined },
      { label: "零章节有封面", chapters: [], options: { cover } },
      { label: "零章节带 NCX", chapters: [], options: { includeNcx: true } },
      { label: "单章空正文", chapters: [{ id: "a", title: "空章", lines: [] }], options: undefined },
      { label: "多章有封面带 NCX", chapters: [chapter("第1章 甲", ["a"]), chapter("第2章 乙", ["b"])], options: { cover, includeNcx: true } },
    ];

    for (const config of configs) {
      const zip = await unzip(await buildEpub(meta, config.chapters, config.options));
      const xhtmlFiles = Object.keys(zip.files).filter((name) => name.endsWith(".xhtml"));
      expect(xhtmlFiles.length, config.label).toBeGreaterThan(0);

      for (const name of xhtmlFiles) {
        const doc = await readText(zip, name);
        const body = doc.match(/<body[^>]*>([\s\S]*?)<\/body>/)?.[1] ?? "";
        expect(body.trim().length, `${config.label} / ${name} 的 body 为空`).toBeGreaterThan(0);
        for (const list of allOrderedLists(doc)) {
          expect(list, `${config.label} / ${name} 存在空 <ol>`).toContain("<li>");
        }
      }
    }
  });

  it("manifest 与 spine 都不为空，且 spine 至少有一项", async () => {
    const zip = await unzip(await buildEpub(meta, []));
    const opf = await readText(zip, "OEBPS/content.opf");

    const manifestItems = [...opf.matchAll(/<item [^>]*\/>/g)];
    const spineItems = [...opf.matchAll(/<itemref [^>]*\/>/g)];
    expect(manifestItems.length).toBeGreaterThan(0);
    expect(spineItems.length).toBeGreaterThan(0);

    // 每个 idref 都能在 manifest 里找到
    const ids = [...opf.matchAll(/<item id="([^"]+)"/g)].map((m) => m[1]);
    for (const [, idref] of opf.matchAll(/<itemref idref="([^"]+)"/g)) {
      expect(ids).toContain(idref);
    }
    // nav 必须在 manifest 里（EPUB3 必需）
    expect(ids).toContain("nav");
  });
});
