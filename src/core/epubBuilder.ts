/**
 * EPUB 3.0 生成。
 *
 * 产物结构（可通过 epubcheck 的基本校验）：
 *   mimetype                      ← STORE 且必须是 zip 的第一个条目
 *   META-INF/container.xml
 *   OEBPS/content.opf             ← OPF 3.0，含 dcterms:modified / cover-image / nav
 *   OEBPS/nav.xhtml               ← properties="nav"
 *   OEBPS/toc.ncx                 ← 可选，兼容老阅读器（includeNcx）
 *   OEBPS/style.css               ← 由排版选项生成
 *   OEBPS/cover.xhtml + OEBPS/images/cover.*   ← 有封面时
 *   OEBPS/chapter-001.xhtml …     ← 章节正文（全部 XML 转义）
 *
 * 约束：本模块只依赖 jszip，不触碰 DOM（在 Node 里也能跑，所以返回值是 Uint8Array）。
 */

import type { BookMeta, BuildEpubOptions, Chapter, Cover, TypesettingOptions } from "../types";
import { coverLabel, tocTitle, untitledBook } from "./i18n";

/** 目录 / OPF 所在目录。 */
const CONTENT_DIR = "OEBPS";

/** 默认排版参数。 */
export const DEFAULT_TYPESETTING: TypesettingOptions = {
  indent: true,
  lineHeight: 1.7,
  fontSize: 1,
  paragraphSpacing: false,
};

/** 字号/行高的安全区间，避免 UI 传进离谱数值。 */
const MIN_LINE_HEIGHT = 1;
const MAX_LINE_HEIGHT = 3;
const MIN_FONT_SIZE = 0.5;
const MAX_FONT_SIZE = 3;

/**
 * XML 转义。
 * 除五类实体外，还要剔除 XML 1.0 不允许的控制字符与落单的代理项，
 * 否则真实 TXT 里的 `\u0000` / `\u0001` 会让整本 EPUB 打不开。
 */
export function escapeXml(value: string): string {
  const text = String(value ?? "");
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    // 落单的代理项（不成对的 high/low surrogate）在 UTF-8 里无法编码，直接丢弃
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[index] + text[index + 1];
        index += 1;
        continue;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;

    // XML 1.0 合法字符：\t \n \r 与 >= 0x20（排除 0xFFFE/0xFFFF）
    if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0xfffe && code !== 0xffff)) {
      out += text[index];
    }
  }

  return out
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 转义属性值（与 escapeXml 同义，单独命名便于阅读）。 */
function escapeAttr(value: string): string {
  return escapeXml(value);
}

/** 生成一个书用的 UUID URN。 */
function makeBookId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `urn:uuid:${crypto.randomUUID()}`;
  }
  return `urn:uuid:${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

/** EPUB 规范要求的 dcterms:modified，格式固定为 UTC 秒级。 */
function modifiedTimestamp(): string {
  const now = new Date();
  const iso = now.toISOString();
  return `${iso.slice(0, 19)}Z`;
}

/** 把任意字符串变成合法的 XHTML id（字母开头，只含字母数字下划线与连字符）。 */
function toXmlId(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(3, "0")}`;
}

/** 排序后的清单项。 */
interface ManifestEntry {
  id: string;
  href: string;
  mediaType: string;
  properties?: string;
  /** 章节标题（NCX / nav 用） */
  title?: string;
}

/**
 * 章节 → 安全的文件名片段。
 *
 * 关键点（踩过 EPUBCheck 的坑）：
 * - **空格必须去掉**。href 是 URI 引用，路径段里出现空格是非法 URL，EPUBCheck 直接报
 *   RSC-020「Illegal character in path segment: space is not allowed」，
 *   而「第1章 起风了」这种带空格的标题极其常见。
 * - `#` `?` `%` 会让 href 被解析成片段 / 查询 / 转义序列，必须剔除。
 * - XML 元字符 < > & ' " 虽不产出非法 URL，但会干扰部分阅读器的解析。
 * - Windows 非法字符与 C0 控制字符一并剔除。
 * - 清洗后为空（如标题只有控制字符）时回退到带序号的默认名。
 *
 * 中文等非 ASCII 字符保留：它们在 href 里会被百分号编码，属于合法 URL，
 * 且保留可读性便于用户排查产物。唯一性由调用方追加的序号前缀保证。
 */
function sanitizeFileStem(name: string, fallback: string): string {
  const stem = String(name ?? "")
    .replace(/[\\/:*?"<>|&'#?%\u0000-\u001f\u007f]/g, "")
    // 所有空白（含全角空格）直接删除，而不是替换成下划线，避免再次引入 URL 问题
    .replace(/[\s\u3000]+/g, "")
    .slice(0, 60)
    .trim();
  return stem.length > 0 ? stem : fallback;
}

/** 由 MIME 猜扩展名。 */
export function extensionForMime(mimeType: string): string {
  const normalized = String(mimeType ?? "").toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("svg")) return "svg";
  if (normalized.includes("bmp")) return "bmp";
  return "jpg";
}

/** 校验/兜底封面的 MIME 类型。 */
function normalizeCoverMime(mimeType: string, fileName: string): string {
  const normalized = String(mimeType ?? "").toLowerCase().split(";")[0].trim();
  if (/^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(normalized)) return normalized;
  const ext = String(fileName ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  return "image/jpeg";
}

/** 数字裁剪工具。 */
function clamp(value: number, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

/** 归一排版选项：UI 只传部分字段时用默认值补齐并做区间裁剪。 */
export function resolveTypesetting(partial?: Partial<TypesettingOptions>): TypesettingOptions {
  const source = partial ?? {};
  const rawFontSize = Number(source.fontSize);
  // 允许 UI 传像素值（如 18）——大于 3 时按 16px 基准换算成 em
  const fontSizeEm = Number.isFinite(rawFontSize)
    ? rawFontSize > MAX_FONT_SIZE
      ? rawFontSize / 16
      : rawFontSize
    : DEFAULT_TYPESETTING.fontSize;

  return {
    indent: source.indent ?? DEFAULT_TYPESETTING.indent,
    lineHeight: clamp(source.lineHeight ?? DEFAULT_TYPESETTING.lineHeight, MIN_LINE_HEIGHT, MAX_LINE_HEIGHT, DEFAULT_TYPESETTING.lineHeight),
    fontSize: clamp(fontSizeEm, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_TYPESETTING.fontSize),
    paragraphSpacing: source.paragraphSpacing ?? DEFAULT_TYPESETTING.paragraphSpacing,
  };
}

/** 由排版选项生成样式表。中文正文按「段首缩进两字」处理。 */
export function buildStyleSheet(options?: Partial<TypesettingOptions>): string {
  const typesetting = resolveTypesetting(options);
  const indentRule = typesetting.indent ? "  text-indent: 2em;\n" : "  text-indent: 0;\n";
  const marginRule = typesetting.paragraphSpacing ? "  margin: 0 0 0.7em 0;\n" : "  margin: 0;\n";

  return `@charset "utf-8";

html {
  font-size: 100%;
}

body {
  margin: 0 5%;
  font-size: ${typesetting.fontSize}em;
  line-height: ${typesetting.lineHeight};
  text-align: justify;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

h1 {
  font-size: 1.4em;
  line-height: 1.4;
  margin: 1.2em 0 0.9em 0;
  text-align: center;
  text-indent: 0;
  font-weight: 600;
  page-break-before: always;
  break-before: page;
}

h2 {
  font-size: 1.15em;
  margin: 1em 0 0.6em 0;
  text-indent: 0;
}

p {
${indentRule}${marginRule}  text-align: justify;
}

p.blank {
  text-indent: 0;
  margin: 0;
  min-height: 1em;
}

img {
  max-width: 100%;
  height: auto;
}

.cover {
  margin: 0;
  padding: 0;
  text-align: center;
}

.cover img {
  max-width: 100%;
  max-height: 100%;
}

.title-page {
  text-align: center;
  padding-top: 30%;
}

.title-page h1 {
  page-break-before: auto;
  break-before: auto;
}
`;
}

/**
 * 归一标题：先按 XML 规则清洗非法字符，清洗后为空则用兜底文案。
 *
 * 必要性：形如 "\u0000\u0001" 的标题能通过 `trim()` 非空判断，
 * 但 escapeXml 会把控制字符全部剔除，最终产出 <title></title> 与空的 <h1>，
 * 这既是无效的语义，也会让目录条目在阅读器里显示为空白。
 */
function safeTitle(raw: unknown, fallback: string): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  const cleaned = escapeXml(text).trim();
  return cleaned.length > 0 ? text : fallback;
}

/** 章节正文 → 段落 HTML。空行转成占位段落，保留原作的空行节奏。 */
function chapterBodyToHtml(lines: string[]): string {
  const safeLines = Array.isArray(lines) ? lines : [];
  if (safeLines.length === 0) {
    return '      <p class="blank">&#160;</p>';
  }
  const paragraphs: string[] = [];
  for (const line of safeLines) {
    const text = String(line ?? "");
    if (text.trim().length === 0) {
      // 空行用不可见占位符保留垂直间距（epubcheck 不接受空 <p></p> 的语义问题不大，但这样更稳）
      paragraphs.push('      <p class="blank">&#160;</p>');
      continue;
    }
    paragraphs.push(`      <p>${escapeXml(text)}</p>`);
  }
  return paragraphs.join("\n");
}

/** 构造单个章节的 XHTML 文档。 */
function buildChapterXhtml(chapter: Chapter, language: string, spineIndex: number): string {
  const title = safeTitle(chapter?.title, untitledBook(language as BookMeta["language"]));
  const sectionId = toXmlId("chapter", spineIndex);
  const body = chapterBodyToHtml(chapter?.lines ?? []);

  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeAttr(language)}" lang="${escapeAttr(language)}">
  <head>
    <meta charset="utf-8" />
    <title>${escapeXml(title)}</title>
    <link rel="stylesheet" type="text/css" href="style.css" />
  </head>
  <body>
    <section id="${sectionId}" epub:type="chapter" aria-label="${escapeAttr(title)}">
      <h1>${escapeXml(title)}</h1>
${body}
    </section>
  </body>
</html>
`;
}

/** 封面页 XHTML。 */
function buildCoverXhtml(meta: BookMeta, coverHref: string, altText: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeAttr(meta.language)}" lang="${escapeAttr(meta.language)}">
  <head>
    <meta charset="utf-8" />
    <title>${escapeXml(altText)}</title>
    <link rel="stylesheet" type="text/css" href="style.css" />
  </head>
  <body class="cover">
    <section epub:type="cover">
      <img src="${escapeAttr(coverHref)}" alt="${escapeAttr(altText)}" />
    </section>
  </body>
</html>
`;
}

/** 书名页 XHTML（EPUB3 推荐有 titlepage，也是给老阅读器一个像样的开头）。 */
function buildTitlePageXhtml(meta: BookMeta): string {
  const title = safeTitle(meta.title, untitledBook(meta.language));
  const authorLine = meta.author?.trim()
    ? `      <p class="author">${escapeXml(meta.author.trim())}</p>\n`
    : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeAttr(meta.language)}" lang="${escapeAttr(meta.language)}">
  <head>
    <meta charset="utf-8" />
    <title>${escapeXml(title)}</title>
    <link rel="stylesheet" type="text/css" href="style.css" />
  </head>
  <body>
    <section class="title-page" epub:type="titlepage">
      <h1>${escapeXml(title)}</h1>
${authorLine}    </section>
  </body>
</html>
`;
}

/** nav.xhtml：EPUB3 目录，必须声明 properties="nav"。 */
function buildNavXhtml(
  meta: BookMeta,
  entries: ManifestEntry[],
  extras?: { coverHref?: string; bodyHref?: string },
): string {
  const items = entries
    .map((entry) => `        <li><a href="${escapeAttr(entry.href)}">${escapeXml(entry.title ?? "")}</a></li>`)
    .join("\n");

  // 空 <ol> 在 XHTML 里是非法的（EPUBCheck RSC-005）。
  // 0 章节时（buildEpub 允许传空数组）改为列出书名页这个真实存在的入口，
  // 既不产出空列表，也保留了可跳转的目录结构。
  const tocList = items.length
    ? `      <ol>\n${items}\n      </ol>`
    : `      <ol>\n        <li><a href="titlepage.xhtml">${escapeXml(tocTitle(meta.language))}</a></li>\n      </ol>`;

  const landmarks: string[] = [];
  if (extras?.coverHref) {
    landmarks.push(
      `          <li><a epub:type="cover" href="${escapeAttr(extras.coverHref)}">${escapeXml(coverLabel(meta.language))}</a></li>`,
    );
  }
  if (extras?.bodyHref) {
    landmarks.push(
      `          <li><a epub:type="bodymatter" href="${escapeAttr(extras.bodyHref)}">${escapeXml(tocTitle(meta.language))}</a></li>`,
    );
  }

  // 空 <ol> 在 XHTML 里是非法的（EPUBCheck RSC-005），没有条目就整块不输出
  const landmarksBlock = landmarks.length
    ? [
        '      <nav epub:type="landmarks" id="landmarks" hidden="hidden">',
        "        <h2>Landmarks</h2>",
        "        <ol>",
        ...landmarks,
        "        </ol>",
        "      </nav>",
      ].join("\n")
    : "";

  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeAttr(meta.language)}" lang="${escapeAttr(meta.language)}">
  <head>
    <meta charset="utf-8" />
    <title>${escapeXml(tocTitle(meta.language))}</title>
    <link rel="stylesheet" type="text/css" href="style.css" />
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>${escapeXml(tocTitle(meta.language))}</h1>
${tocList}
    </nav>
${landmarksBlock}
  </body>
</html>
`;
}

/** NCX：EPUB2 老阅读器的目录。 */
function buildNcx(meta: BookMeta, entries: ManifestEntry[], bookId: string): string {
  const title = safeTitle(meta.title, untitledBook(meta.language));

  // navMap 至少要有一个 navPoint（空 navMap 是 NCX DTD 不允许的）。
  // 0 章节时指向书名页，保证结构合法且仍可跳转。
  const points = (
    entries.length
      ? entries
      : [{ id: "title-page", href: "titlepage.xhtml", mediaType: "application/xhtml+xml", title }]
  )
    .map((entry, index) => {
      const order = index + 1;
      return `    <navPoint id="navPoint-${order}" playOrder="${order}">
      <navLabel><text>${escapeXml(entry.title ?? "")}</text></navLabel>
      <content src="${escapeAttr(entry.href)}"/>
    </navPoint>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${escapeAttr(meta.language)}">
  <head>
    <meta name="dtb:uid" content="${escapeAttr(bookId)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
${points}
  </navMap>
</ncx>
`;
}

/** OPF 3.0 包文档。 */
function buildContentOpf(
  meta: BookMeta,
  entries: ManifestEntry[],
  spineEntries: Array<{ id: string; nonLinear?: boolean }>,
  options: {
    bookId: string;
    modified: string;
    coverImageId?: string;
    coverImageHref?: string;
    coverImageMime?: string;
    hasNcx: boolean;
  },
): string {
  const title = safeTitle(meta.title, untitledBook(meta.language));
  const manifestLines: string[] = [];

  for (const entry of entries) {
    const attrs = [
      `id="${escapeAttr(entry.id)}"`,
      `href="${escapeAttr(entry.href)}"`,
      `media-type="${escapeAttr(entry.mediaType)}"`,
    ];
    if (entry.properties) attrs.push(`properties="${escapeAttr(entry.properties)}"`);
    manifestLines.push(`    <item ${attrs.join(" ")}/>`);
  }

  if (options.coverImageId && options.coverImageHref && options.coverImageMime) {
    manifestLines.push(
      `    <item id="${escapeAttr(options.coverImageId)}" href="${escapeAttr(options.coverImageHref)}" media-type="${escapeAttr(options.coverImageMime)}" properties="cover-image"/>`,
    );
  }
  if (options.hasNcx) {
    manifestLines.push('    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
  }

  const spineLines = spineEntries.map(
    (entry) => `    <itemref idref="${escapeAttr(entry.id)}"${entry.nonLinear ? ' linear="no"' : ""}/>`,
  );

  const metadata: string[] = [
    `    <dc:identifier id="bookid">${escapeXml(options.bookId)}</dc:identifier>`,
    `    <dc:title>${escapeXml(title)}</dc:title>`,
    `    <dc:language>${escapeXml(meta.language)}</dc:language>`,
  ];
  if (meta.author?.trim()) {
    metadata.push(`    <dc:creator>${escapeXml(meta.author.trim())}</dc:creator>`);
  }
  if (meta.publisher?.trim()) {
    metadata.push(`    <dc:publisher>${escapeXml(meta.publisher.trim())}</dc:publisher>`);
  }
  if (meta.description?.trim()) {
    metadata.push(`    <dc:description>${escapeXml(meta.description.trim())}</dc:description>`);
  }
  const tags = (meta.tags ?? []).map((tag) => String(tag ?? "").trim()).filter((tag) => tag.length > 0);
  for (const tag of tags) {
    metadata.push(`    <dc:subject>${escapeXml(tag)}</dc:subject>`);
  }
  metadata.push(`    <meta property="dcterms:modified">${escapeXml(options.modified)}</meta>`);
  // EPUB2 阅读器（以及部分国产阅读器）依赖这个 meta 找封面
  if (options.coverImageId) {
    metadata.push(`    <meta name="cover" content="${escapeAttr(options.coverImageId)}"/>`);
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${escapeAttr(meta.language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
${metadata.join("\n")}
  </metadata>
  <manifest>
${manifestLines.join("\n")}
  </manifest>
  <spine${options.hasNcx ? ' toc="ncx"' : ""}>
${spineLines.join("\n")}
  </spine>
</package>
`;
}

/** container.xml：固定指向 OEBPS/content.opf。 */
const CONTAINER_XML = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${CONTENT_DIR}/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

/** 把 Cover.data 统一成 Uint8Array（兼容 ArrayBuffer / Uint8Array / 带 buffer 的视图）。 */
function coverBytes(cover: Cover): Uint8Array {
  const data = cover?.data as unknown;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data as ArrayBufferView)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return new Uint8Array(0);
}

/**
 * 生成 EPUB 字节流。
 *
 * 注意：这是 async 的（JSZip 压缩是异步的），UI 侧必须 await，
 * 并且要对大文件做 loading 态提示。
 */
export async function buildEpub(
  meta: BookMeta,
  chapters: Chapter[],
  options?: BuildEpubOptions,
): Promise<Uint8Array> {
  // JSZip 只在真正生成 EPUB 时才需要，按需加载可让首屏少下载约 97 KB。
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const language = meta?.language ?? "zh-CN";
  const normalizedMeta: BookMeta = {
    ...meta,
    title: meta?.title ?? "",
    author: meta?.author ?? "",
    language,
  };

  // 1) mimetype —— 必须第一个写入，且不能被压缩（EPUB 规范的硬性要求）
  zip.file("mimetype", "application/epub+zip", {
    compression: "STORE",
    createFolders: false,
  });

  // 2) META-INF/container.xml
  zip.file("META-INF/container.xml", CONTAINER_XML, { createFolders: false });

  const chapterList = Array.isArray(chapters) && chapters.length > 0 ? chapters : [];
  const cover = options?.cover ?? null;
  const typesetting = options?.typesetting;
  const includeNcx = options?.includeNcx === true;

  // 3) 章节文件
  const contentEntries: ManifestEntry[] = [];
  const chapterFiles: Array<{ href: string; content: string; title: string }> = [];

  chapterList.forEach((chapter, index) => {
    const order = index + 1;
    const stem = sanitizeFileStem(chapter?.title ?? "", `chapter-${String(order).padStart(3, "0")}`);
    // 章节多时靠序号保证文件名唯一、排序稳定
    const href = `chapter-${String(order).padStart(3, "0")}-${stem}.xhtml`;
    const title = safeTitle(chapter?.title, untitledBook(language as BookMeta["language"]));
    chapterFiles.push({ href, content: buildChapterXhtml({ ...chapter, title }, language, order), title });

    contentEntries.push({
      id: `chapter-${String(order).padStart(3, "0")}`,
      href,
      mediaType: "application/xhtml+xml",
      title,
    });
  });

  // 4) 封面（图片字节为空时视为无封面，避免产出指向不存在文件的 cover.xhtml）
  let coverImageId: string | undefined;
  let coverImageHref: string | undefined;
  let coverImageMime: string | undefined;
  let coverPageEntry: ManifestEntry | null = null;

  if (cover) {
    const bytes = coverBytes(cover);
    if (bytes.byteLength > 0) {
      const mime = normalizeCoverMime(cover.mimeType, cover.fileName);
      coverImageHref = `images/cover.${extensionForMime(mime)}`;
      coverImageMime = mime;
      coverImageId = "cover-image";
      coverPageEntry = { id: "cover-page", href: "cover.xhtml", mediaType: "application/xhtml+xml" };
      zip.file(`${CONTENT_DIR}/${coverImageHref}`, bytes, { createFolders: false });
      zip.file(
        `${CONTENT_DIR}/cover.xhtml`,
        buildCoverXhtml(
          normalizedMeta,
          coverImageHref,
          `${safeTitle(normalizedMeta.title, untitledBook(language))} ${coverLabel(language)}`.trim(),
        ),
        { createFolders: false },
      );
    }
  }

  // 5) 书名页 + 章节 + 样式
  const titlePageEntry: ManifestEntry = {
    id: "title-page",
    href: "titlepage.xhtml",
    mediaType: "application/xhtml+xml",
  };
  zip.file(`${CONTENT_DIR}/titlepage.xhtml`, buildTitlePageXhtml(normalizedMeta), { createFolders: false });

  for (const file of chapterFiles) {
    zip.file(`${CONTENT_DIR}/${file.href}`, file.content, { createFolders: false });
  }
  zip.file(`${CONTENT_DIR}/style.css`, buildStyleSheet(typesetting), { createFolders: false });

  const styleEntry: ManifestEntry = {
    id: "style",
    href: "style.css",
    mediaType: "text/css",
  };

  // 6) nav / NCX
  const tocEntries = contentEntries.map((entry) => ({ ...entry, title: entry.title ?? "" }));
  const navEntry: ManifestEntry = {
    id: "nav",
    href: "nav.xhtml",
    mediaType: "application/xhtml+xml",
    properties: "nav",
  };
  // landmarks 指向封面（若有）与正文起始章，方便阅读器「跳转到正文」
  const firstBodyHref = contentEntries[0]?.href;
  zip.file(
    `${CONTENT_DIR}/nav.xhtml`,
    buildNavXhtml(normalizedMeta, tocEntries, {
      coverHref: coverPageEntry?.href,
      bodyHref: firstBodyHref,
    }),
    { createFolders: false },
  );

  const bookId = makeBookId();
  if (includeNcx) {
    zip.file(`${CONTENT_DIR}/toc.ncx`, buildNcx(normalizedMeta, tocEntries, bookId), { createFolders: false });
  }

  // 7) OPF：manifest 顺序 = nav / 封面页 / 书名页 / 正文 / 样式
  const manifestEntries: ManifestEntry[] = [
    navEntry,
    ...(coverPageEntry ? [coverPageEntry] : []),
    titlePageEntry,
    ...contentEntries,
    styleEntry,
  ];
  // spine 顺序：封面页 → 书名页 → 正文
  const spineEntries: Array<{ id: string; nonLinear?: boolean }> = [
    ...(coverPageEntry ? [{ id: coverPageEntry.id }] : []),
    { id: titlePageEntry.id },
    ...contentEntries.map((entry) => ({ id: entry.id })),
  ];

  zip.file(
    `${CONTENT_DIR}/content.opf`,
    buildContentOpf(normalizedMeta, manifestEntries, spineEntries, {
      bookId,
      modified: modifiedTimestamp(),
      coverImageId,
      coverImageHref,
      coverImageMime,
      hasNcx: includeNcx,
    }),
    { createFolders: false },
  );

  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    mimeType: "application/epub+zip",
  });
}

/** 浏览器侧把 EPUB 字节包成 Blob（供 URL.createObjectURL 下载）。 */
export function toEpubBlob(bytes: Uint8Array): Blob {
  // 复制一份，避免把调用方的大 buffer 钉在内存里
  const copy = new Uint8Array(bytes?.byteLength ?? 0);
  if (bytes && bytes.byteLength > 0) copy.set(bytes);
  return new Blob([copy], { type: "application/epub+zip" });
}

/** 文件名里不允许出现的字符（Windows 最严格）。 */
const ILLEGAL_FILENAME = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

/**
 * 建议的下载文件名：清洗非法字符、去掉首尾空格与点、限制长度，并补 .epub 后缀。
 */
export function suggestFileName(meta: BookMeta): string {
  const rawTitle = (meta?.title ?? "").trim();
  let base = rawTitle.length > 0 ? rawTitle : untitledBook(meta?.language ?? "zh-CN");

  base = base
    .replace(ILLEGAL_FILENAME, "")
    .replace(/\s+/g, " ")
    .trim()
    // Windows 不允许文件名以点或空格结尾
    .replace(/[. ]+$/g, "")
    .slice(0, 120)
    .trim();

  if (base.length === 0) base = untitledBook(meta?.language ?? "zh-CN");

  const author = (meta?.author ?? "").trim().replace(ILLEGAL_FILENAME, "").slice(0, 40);
  const withAuthor = author.length > 0 ? `${base} - ${author}` : base;
  const name = withAuthor.length > 0 ? withAuthor : base;

  return `${name}.epub`;
}
