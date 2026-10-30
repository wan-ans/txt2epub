/**
 * EPUB 解析与增量回写。
 *
 * 设计目标：
 * - readEpub 把一本已有 EPUB 读成可编辑模型（EpubProject）：元信息、章节、封面、资源统计。
 * - writeEpub 在原始 zip 上做「外科手术式」增量修改：未编辑的章节与所有资源原样复制，
 *   只重写被编辑/新增章节，删除被删除章节，并同步 OPF / nav / NCX。
 *
 * 该模块不依赖 Vue / Electron，但允许使用浏览器标准的 DOMParser / XMLSerializer；
 * 单元测试运行在 jsdom 环境（npm run test:run 按文件顶部的 @vitest-environment 注释执行）。
 */

import type JSZip from "jszip";
import type { Cover, EpubBookMeta, EpubChapter, EpubProject, WriteEpubOptions } from "../types";
import { buildEpub, escapeXml, extensionForMime } from "./epubBuilder";

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const OPF_NS = "http://www.idpf.org/2007/opf";
const DC_NS = "http://purl.org/dc/elements/1.1/";
const EPUB_NS = "http://www.idpf.org/2007/ops";
const NCX_MEDIA_TYPE = "application/x-dtbncx+xml";

/** 判断文件名是否是 .epub（大小写不敏感，允许首尾空白）。 */
export function isEpubFileName(name: string): boolean {
  return typeof name === "string" && /\.epub$/i.test(name.trim());
}

/** 解码 HTML 实体（只处理常见命名实体与数字实体，足够用于字数统计）。 */
function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: "\u00a0",
    hellip: "…",
    mdash: "—",
    ndash: "–",
    ldquo: "“",
    rdquo: "”",
    lsquo: "‘",
    rsquo: "’",
    middot: "·",
  };
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.charAt(0) === "#") {
      const isHex = body.charAt(1) === "x" || body.charAt(1) === "X";
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    return named[body.toLowerCase()] ?? match;
  });
}

/**
 * 统计 HTML 片段中的「字数」：剔除标签与脚本/样式后，计非空白字符数（与 preprocess.countWords 一致）。
 */
export function countHtmlWords(html: string): number {
  if (typeof html !== "string" || html.length === 0) return 0;
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return decodeHtmlEntities(text).replace(/\s+/gu, "").length;
}

/* ============================================================
   通用小工具
   ============================================================ */

function normalizeZipPath(path: string): string {
  const replaced = String(path ?? "").replace(/\\/g, "/");
  const segments = replaced.split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

function dirname(path: string): string {
  const normalized = normalizeZipPath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function basename(path: string): string {
  const normalized = normalizeZipPath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 把 OPF 相对的 href 解析成 zip 内的绝对路径（去掉 #fragment / ?query）。 */
function resolveZipPath(baseDir: string, href: string): string {
  if (!href) return "";
  const withoutFragment = String(href).split("#")[0].split("?")[0];
  const decoded = safeDecodeUri(withoutFragment);
  return normalizeZipPath(baseDir ? baseDir + "/" + decoded : decoded);
}

/** 从 fromDir 到 toPath 的相对路径（用于 nav / ncx 的 href）。 */
function relativeZipPath(fromDir: string, toPath: string): string {
  const from = normalizeZipPath(fromDir).split("/").filter(Boolean);
  const to = normalizeZipPath(toPath).split("/").filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) {
    common += 1;
  }
  const parts: string[] = [];
  for (let index = common; index < from.length; index += 1) parts.push("..");
  parts.push(...to.slice(common));
  return parts.join("/");
}

function splitTokens(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return String(raw).trim().split(/\s+/).filter((token) => token.length > 0);
}

function collectElements(root: Document | Element, localName: string): Element[] {
  const target = localName.toLowerCase();
  const result: Element[] = [];
  const list = root.getElementsByTagName("*");
  for (let index = 0; index < list.length; index += 1) {
    const element = list[index];
    const name = (element.localName || element.tagName || "").toLowerCase();
    if (name === target) result.push(element);
  }
  if (root.nodeType === 1) {
    const self = root as Element;
    const selfName = (self.localName || self.tagName || "").toLowerCase();
    if (selfName === target) result.unshift(self);
  }
  return result;
}

function firstElement(root: Document | Element, localName: string): Element | null {
  return collectElements(root, localName)[0] ?? null;
}

/** 读取属性：先按原始名，再按 localName / 后缀宽容匹配（兼容 XML 命名空间与畸形 EPUB）。 */
function getAttributeValue(element: Element, name: string): string | null {
  const direct = element.getAttribute(name);
  if (direct !== null) return direct;
  const lower = name.toLowerCase();
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes[index];
    const attrName = String(attribute.name || "").toLowerCase();
    const local = String(attribute.localName || attribute.name || "").toLowerCase();
    if (attrName === lower || local === lower || attrName.endsWith(":" + lower)) {
      return attribute.value;
    }
  }
  return null;
}

function getEpubTypeTokens(element: Element): string[] {
  const raw = element.getAttribute("epub:type") ?? element.getAttributeNS(EPUB_NS, "type");
  return splitTokens(raw);
}

function hasParserError(doc: Document): boolean {
  const errors = doc.getElementsByTagName("parsererror");
  if (errors.length > 0) return true;
  const root = doc.documentElement;
  return !root || String(root.nodeName || "").toLowerCase() === "parsererror";
}

/** 宽容的 XML 解析：先 XHTML/XML，失败再尝试 text/xml。 */
function parseXmlDocument(text: string): Document | null {
  if (typeof DOMParser === "undefined") return null;
  const candidates: DOMParserSupportedType[] = ["application/xhtml+xml", "text/xml"];
  for (const type of candidates) {
    try {
      const doc = new DOMParser().parseFromString(text, type);
      if (doc && !hasParserError(doc)) return doc;
    } catch {
      /* 尝试下一种类型 */
    }
  }
  return null;
}

/** HTML 宽容解析（章节文档可能不是严格 XML）。 */
function parseHtmlDocument(text: string): Document | null {
  if (typeof DOMParser === "undefined") return null;
  try {
    return new DOMParser().parseFromString(text, "text/html");
  } catch {
    return null;
  }
}

function serializeXmlDocument(doc: Document): string {
  const serialized = new XMLSerializer().serializeToString(doc);
  return serialized.startsWith("<?xml") ? serialized : "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" + serialized;
}

function decodeTextBytes(bytes: Uint8Array): string {
  if (!bytes || bytes.byteLength === 0) return "";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  const offset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder("utf-8").decode(bytes.subarray(offset));
}

function findZipEntry(zip: JSZip, path: string): JSZip.JSZipObject | null {
  if (!path) return null;
  const normalized = normalizeZipPath(path);
  const direct = zip.file(normalized);
  if (direct) return direct;
  const lower = normalized.toLowerCase();
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir) continue;
    if (normalizeZipPath(name).toLowerCase() === lower) return entry;
  }
  return null;
}

async function readZipBytes(zip: JSZip, path: string): Promise<Uint8Array | null> {
  const file = findZipEntry(zip, path);
  if (!file) return null;
  try {
    return await file.async("uint8array");
  } catch {
    return null;
  }
}

async function readZipText(zip: JSZip, path: string): Promise<string | null> {
  const bytes = await readZipBytes(zip, path);
  if (!bytes) return null;
  return decodeTextBytes(bytes);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isDcElement(element: Element): boolean {
  if (element.namespaceURI === DC_NS) return true;
  return /^dc:/i.test(String(element.tagName || ""));
}

function readDcTexts(scope: Document | Element, localName: string): string[] {
  return collectElements(scope, localName)
    .filter(isDcElement)
    .map((element) => String(element.textContent ?? "").trim())
    .filter((text) => text.length > 0);
}

function normalizeLanguage(raw: string | null | undefined): EpubBookMeta["language"] {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value.startsWith("zh")) {
    if (/tw|hk|mo|hant|traditional/.test(value)) return "zh-TW";
    return "zh-CN";
  }
  if (value.startsWith("en")) return "en";
  return "zh-CN";
}

function normalizeCoverMime(mimeType: string, fileName: string): string {
  const normalized = String(mimeType ?? "").toLowerCase().split(";")[0].trim();
  if (/^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(normalized)) return normalized;
  const extension = String(fileName ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (extension === "png") return "image/png";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  if (extension === "svg") return "image/svg+xml";
  return "image/jpeg";
}

function guessImageMime(href: string): string {
  const extension = String(href ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (extension === "png") return "image/png";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  if (extension === "svg") return "image/svg+xml";
  if (extension === "bmp") return "image/bmp";
  return "image/jpeg";
}

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

function modifiedTimestamp(): string {
  const iso = new Date().toISOString();
  return iso.slice(0, 19) + "Z";
}

function isXhtmlMediaType(mediaType: string, href: string): boolean {
  const normalized = String(mediaType ?? "").toLowerCase().trim();
  if (normalized.includes("xhtml")) return true;
  if (normalized === "text/html") return true;
  if (!normalized) return /\.x?html?$/i.test(String(href ?? ""));
  return false;
}

/* ============================================================
   OPF / manifest / spine 解析
   ============================================================ */

interface ManifestItemInfo {
  id: string;
  href: string;
  mediaType: string;
  properties: string[];
  zipPath: string;
  element: Element;
}

interface SpineRefInfo {
  element: Element;
  idref: string;
  linear: boolean;
}

function readManifestItems(doc: Document, opfDir: string): ManifestItemInfo[] {
  const manifestElement = firstElement(doc, "manifest");
  if (!manifestElement) return [];
  return collectElements(manifestElement, "item").map((element, index) => {
    const id = getAttributeValue(element, "id") ?? "item-" + (index + 1);
    const href = getAttributeValue(element, "href") ?? "";
    const mediaType = getAttributeValue(element, "media-type") ?? "";
    const properties = splitTokens(getAttributeValue(element, "properties"));
    return { id, href, mediaType, properties, zipPath: resolveZipPath(opfDir, href), element };
  });
}

function readSpineRefs(doc: Document): SpineRefInfo[] {
  const spineElement = firstElement(doc, "spine");
  if (!spineElement) return [];
  return collectElements(spineElement, "itemref").map((element) => ({
    element,
    idref: getAttributeValue(element, "idref") ?? "",
    linear: String(getAttributeValue(element, "linear") ?? "yes").toLowerCase() !== "no",
  }));
}

function readOpfMetadata(doc: Document): EpubBookMeta {
  const metadataElement = firstElement(doc, "metadata") ?? doc.documentElement;
  const titleElements = collectElements(metadataElement, "title").filter(isDcElement);
  const titles = titleElements.map((element) => ({
    id: getAttributeValue(element, "id") ?? "",
    text: String(element.textContent ?? "").trim(),
  }));

  let subtitle = "";
  const subtitleIds = new Set<string>();
  for (const meta of collectElements(metadataElement, "meta")) {
    const properties = splitTokens(getAttributeValue(meta, "property")).map((token) => token.toLowerCase());
    const type = String(meta.textContent ?? "").trim().toLowerCase();
    if (!properties.includes("title-type") || type !== "subtitle") continue;
    const refines = getAttributeValue(meta, "refines") ?? "";
    const id = refines.startsWith("#") ? refines.slice(1) : refines;
    if (!id) continue;
    subtitleIds.add(id);
    const matched = titles.find((title) => title.id === id);
    if (matched) subtitle = matched.text;
  }

  const mainTitle = titles.find((title) => !title.id || !subtitleIds.has(title.id))?.text ?? titles[0]?.text ?? "";
  const creators = readDcTexts(metadataElement, "creator");
  const languages = readDcTexts(metadataElement, "language");
  const publishers = readDcTexts(metadataElement, "publisher");
  const descriptions = readDcTexts(metadataElement, "description");
  const dates = readDcTexts(metadataElement, "date");
  const subjects = readDcTexts(metadataElement, "subject");
  const identifierElements = collectElements(metadataElement, "identifier").filter(isDcElement);
  const uniqueIdentifier = getAttributeValue(doc.documentElement, "unique-identifier");
  let identifier = "";
  if (uniqueIdentifier) {
    identifier =
      identifierElements.find((element) => getAttributeValue(element, "id") === uniqueIdentifier)?.textContent?.trim() ?? "";
  }
  if (!identifier) identifier = identifierElements[0]?.textContent?.trim() ?? "";

  const result: EpubBookMeta = {
    title: mainTitle,
    author: creators[0] ?? "",
    language: normalizeLanguage(languages[0]),
  };
  if (subtitle) result.subtitle = subtitle;
  if (publishers[0]) result.publisher = publishers[0];
  if (descriptions[0]) result.description = descriptions[0];
  if (subjects.length > 0) result.tags = subjects;
  if (dates[0]) result.publishedAt = dates[0];
  if (identifier) result.identifier = identifier;
  return result;
}

/** 读取 container.xml 里的 OPF 路径：优先第一个 media-type 正确的 rootfile，其次第一个 rootfile，最后搜索 .opf。 */
async function findOpfPath(zip: JSZip): Promise<string> {
  const containerText = await readZipText(zip, "META-INF/container.xml");
  if (containerText) {
    const containerDoc = parseXmlDocument(containerText);
    if (containerDoc) {
      const rootfiles = collectElements(containerDoc, "rootfile");
      const preferred =
        rootfiles.find(
          (element) => String(getAttributeValue(element, "media-type") ?? "").toLowerCase() === "application/oebps-package+xml",
        ) ?? rootfiles[0];
      const fullPath = preferred ? getAttributeValue(preferred, "full-path") : null;
      if (fullPath) return normalizeZipPath(safeDecodeUri(fullPath));
    }
  }
  const candidates = Object.keys(zip.files)
    .filter((name) => !zip.files[name].dir && /\.opf$/i.test(name))
    .sort((left, right) => left.split("/").length - right.split("/").length);
  return candidates[0] ?? "";
}

/* ============================================================
   nav / ncx 标题
   ============================================================ */

function collapseWhitespace(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function readAnchorTitles(doc: Document | Element, baseDir: string, target: Map<string, string>): void {
  for (const anchor of collectElements(doc, "a")) {
    const href = getAttributeValue(anchor, "href");
    const label = collapseWhitespace(anchor.textContent ?? "");
    if (!href || !label) continue;
    const path = resolveZipPath(baseDir, href);
    if (path && !target.has(path)) target.set(path, label);
  }
}

function readNavPointTitles(doc: Document | Element, baseDir: string, target: Map<string, string>): void {
  for (const navPoint of collectElements(doc, "navPoint")) {
    const labelElement = firstElement(navPoint, "text");
    const contentElement = firstElement(navPoint, "content");
    const label = collapseWhitespace(labelElement?.textContent ?? "");
    const src = contentElement ? getAttributeValue(contentElement, "src") : null;
    if (!label || !src) continue;
    const path = resolveZipPath(baseDir, src);
    if (path && !target.has(path)) target.set(path, label);
  }
}

async function loadTocTitles(zip: JSZip, manifest: ManifestItemInfo[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();

  const navItem =
    manifest.find((item) => item.properties.includes("nav")) ??
    manifest.find((item) => /(^|\/)nav\.x?html?$/i.test(item.href));
  if (navItem?.zipPath) {
    const text = await readZipText(zip, navItem.zipPath);
    if (text) {
      const doc = parseXmlDocument(text) ?? parseHtmlDocument(text);
      if (doc) {
        const navs = collectElements(doc, "nav");
        const toc =
          navs.find((element) => getEpubTypeTokens(element).includes("toc")) ??
          navs.find((element) => String(getAttributeValue(element, "id") ?? "").toLowerCase() === "toc") ??
          navs[0];
        if (toc) readAnchorTitles(toc, dirname(navItem.zipPath), titles);
      }
    }
  }

  const ncxItem =
    manifest.find((item) => item.mediaType.toLowerCase() === NCX_MEDIA_TYPE) ??
    manifest.find((item) => /\.ncx$/i.test(item.href));
  if (ncxItem?.zipPath) {
    const text = await readZipText(zip, ncxItem.zipPath);
    if (text) {
      const doc = parseXmlDocument(text) ?? parseHtmlDocument(text);
      if (doc) readNavPointTitles(doc, dirname(ncxItem.zipPath), titles);
    }
  }

  return titles;
}

/* ============================================================
   封面读取
   ============================================================ */

async function readCoverFromOpf(
  zip: JSZip,
  doc: Document,
  manifest: ManifestItemInfo[],
  opfDir: string,
): Promise<Cover | null> {
  const metadataElement = firstElement(doc, "metadata");
  const metaElements = metadataElement ? collectElements(metadataElement, "meta") : [];
  const coverMeta = metaElements.find(
    (element) => String(getAttributeValue(element, "name") ?? "").toLowerCase() === "cover",
  );
  const content = coverMeta ? getAttributeValue(coverMeta, "content") : null;
  let coverItem: ManifestItemInfo | undefined;
  if (content) {
    coverItem =
      manifest.find((item) => item.id === content) ??
      manifest.find((item) => item.zipPath === resolveZipPath(opfDir, content));
  }
  if (!coverItem) coverItem = manifest.find((item) => item.properties.includes("cover-image"));
  if (!coverItem?.zipPath) return null;

  const bytes = await readZipBytes(zip, coverItem.zipPath);
  if (!bytes || bytes.byteLength === 0) return null;
  return {
    data: toArrayBuffer(bytes),
    mimeType: coverItem.mediaType || guessImageMime(coverItem.href),
    fileName: basename(safeDecodeUri(coverItem.href)),
  };
}

/* ============================================================
   章节正文提取
   ============================================================ */

interface ExtractedChapterBody {
  html: string;
  headingTitle: string;
  epubType: string;
}

const UNSAFE_READ_TAGS = new Set([
  "script",
  "style",
  "link",
  "iframe",
  "object",
  "embed",
  "noscript",
  "template",
  "base",
  "meta",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "option",
  "svg",
  "math",
]);

function isUnsafeUrl(value: string, allowImageData = false): boolean {
  const compact = String(value ?? "").replace(/[\u0000-\u0020]/g, "").toLowerCase();
  if (!compact) return false;
  if (compact.startsWith("javascript:") || compact.startsWith("vbscript:")) return true;
  if (compact.startsWith("data:")) return !(allowImageData && compact.startsWith("data:image/"));
  return false;
}

function sanitizeReadAttributes(element: Element): void {
  for (const attribute of Array.from(element.attributes)) {
    const name = String(attribute.name || "").toLowerCase();
    if (name.startsWith("on")) {
      element.removeAttribute(attribute.name);
      continue;
    }
    const isUrlAttribute = name === "href" || name === "src" || name.endsWith(":href") || name.endsWith(":src");
    if (isUrlAttribute && isUnsafeUrl(attribute.value, name === "src")) {
      element.removeAttribute(attribute.name);
    }
  }
}

function removeUnsafeReadElements(root: Element): void {
  const elements = Array.from(root.getElementsByTagName("*"));
  for (const element of elements) {
    const tag = String(element.localName || element.tagName || "").toLowerCase();
    if (UNSAFE_READ_TAGS.has(tag)) {
      element.remove();
      continue;
    }
    sanitizeReadAttributes(element);
  }
  sanitizeReadAttributes(root);
}

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

function serializeReadAttributes(element: Element): string {
  let output = "";
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name;
    if (!name || /^xmlns(:|$)/i.test(name)) continue;
    if (/^on/i.test(name)) continue;
    output += " " + name + "=\"" + escapeXml(attribute.value) + "\"";
  }
  return output;
}

function serializeDomNode(node: Node): string {
  if (node.nodeType === 3 || node.nodeType === 4) {
    return escapeXml(node.nodeValue ?? "");
  }
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  const tag = String(element.localName || element.tagName || "").toLowerCase();
  if (!tag) return "";
  const attributes = serializeReadAttributes(element);
  if (VOID_ELEMENTS.has(tag)) return "<" + tag + attributes + " />";
  let children = "";
  for (let index = 0; index < element.childNodes.length; index += 1) {
    children += serializeDomNode(element.childNodes[index]);
  }
  return "<" + tag + attributes + ">" + children + "</" + tag + ">";
}

function serializeDomChildren(parent: Node): string {
  let output = "";
  for (let index = 0; index < parent.childNodes.length; index += 1) {
    output += serializeDomNode(parent.childNodes[index]);
  }
  return output;
}

function extractChapterBody(doc: Document): ExtractedChapterBody {
  const body = doc.body ?? firstElement(doc, "body");
  if (!body) return { html: "", headingTitle: "", epubType: "" };
  const clone = body.cloneNode(true) as Element;
  removeUnsafeReadElements(clone);

  let container: Element = clone;
  const topChildren = Array.from(clone.children);
  if (topChildren.length === 1 && /^(section|article)$/i.test(String(topChildren[0].tagName || ""))) {
    container = topChildren[0];
  }

  let headingTitle = "";
  const children = Array.from(container.children);
  if (children.length > 0 && /^h[1-6]$/i.test(String(children[0].tagName || ""))) {
    headingTitle = collapseWhitespace(children[0].textContent ?? "");
    children[0].remove();
  }

  const sectionTypes = collectElements(clone, "section").flatMap((element) => getEpubTypeTokens(element));
  const epubType = [...getEpubTypeTokens(body), ...sectionTypes].find(Boolean) ?? "";

  return {
    html: serializeDomChildren(container).trim(),
    headingTitle,
    epubType,
  };
}

function chapterTitleFromDocument(doc: Document): string {
  const titleElement = firstElement(doc, "title");
  return collapseWhitespace(titleElement?.textContent ?? "");
}

function makeChapterId(href: string, index: number, usedIds: Set<string>): string {
  const base = String(href || "chapter")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  let candidate = "ch-" + (base || String(index + 1));
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = "ch-" + (base || String(index + 1)) + "-" + suffix;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

/* ============================================================
   readEpub
   ============================================================ */

/** 解析不到任何章节时使用的兜底章节（契约要求返回单章「正文」）。 */
function makeFallbackChapter(): EpubChapter {
  const html = "<p>&#160;</p>";
  return {
    id: "chapter-1",
    href: "Text/chapter-001.xhtml",
    title: "正文",
    originalTitle: "正文",
    html,
    originalHtml: html,
    linear: true,
    isNew: true,
  };
}

function countResources(zip: JSZip, manifest: ManifestItemInfo[], opfPath: string): number {
  const excluded = new Set<string>();
  excluded.add(normalizeZipPath(opfPath));
  excluded.add("mimetype");
  for (const item of manifest) {
    if (item.properties.includes("nav")) excluded.add(item.zipPath);
    if (item.mediaType.toLowerCase() === NCX_MEDIA_TYPE || /\.ncx$/i.test(item.href)) excluded.add(item.zipPath);
  }
  let count = 0;
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir) continue;
    const normalized = normalizeZipPath(name);
    if (excluded.has(normalized)) continue;
    if (normalized === "mimetype" || normalized.startsWith("META-INF/")) continue;
    if (/\.(xhtml|html?)$/i.test(normalized)) continue;
    if (/\.(opf|ncx)$/i.test(normalized)) continue;
    count += 1;
  }
  return count;
}

/**
 * 解压并解析一本 EPUB。
 *
 * 只有 spine 中 linear="yes" 的 XHTML 文档才会进入 chapters；nav / cover / titlepage 会被跳过，
 * 章节 html 取 body 内部 HTML（去掉会重复的标题 h1-h6），封面与资源统计一并返回。
 */
export async function readEpub(bytes: Uint8Array, sourceName: string): Promise<EpubProject> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error("EPUB 内容为空，无法解析");
  }
  let zip: JSZip;
  try {
    const { default: JSZipImpl } = await import("jszip");
    zip = await JSZipImpl.loadAsync(bytes);
  } catch {
    throw new Error("无法解压 EPUB 文件");
  }

  const opfPath = await findOpfPath(zip);
  if (!opfPath) throw new Error("EPUB 中找不到 OPF 包文档");
  const opfText = await readZipText(zip, opfPath);
  if (opfText === null) throw new Error("无法读取 OPF：" + opfPath);
  const opfDoc = parseXmlDocument(opfText);
  if (!opfDoc) throw new Error("OPF 不是合法的 XML：" + opfPath);

  const opfDir = dirname(opfPath);
  const manifest = readManifestItems(opfDoc, opfDir);
  const spineRefs = readSpineRefs(opfDoc);
  const metadata = readOpfMetadata(opfDoc);
  const tocTitles = await loadTocTitles(zip, manifest);
  const cover = await readCoverFromOpf(zip, opfDoc, manifest, opfDir);

  const chapters: EpubChapter[] = [];
  const usedChapterIds = new Set<string>();

  for (const ref of spineRefs) {
    if (!ref.linear) continue;
    const item = manifest.find((candidate) => candidate.id === ref.idref);
    if (!item?.zipPath) continue;
    if (!isXhtmlMediaType(item.mediaType, item.href)) continue;
    if (item.properties.includes("nav")) continue;

    const chapterText = await readZipText(zip, item.zipPath);
    if (chapterText === null) continue;
    const chapterDoc = parseHtmlDocument(chapterText);
    if (!chapterDoc) continue;

    const body = chapterDoc.body ?? firstElement(chapterDoc, "body");
    if (body) {
      const types = [...getEpubTypeTokens(body), ...collectElements(chapterDoc, "section").flatMap((element) => getEpubTypeTokens(element))];
      if (types.includes("cover") || types.includes("titlepage")) continue;
    }

    const extracted = extractChapterBody(chapterDoc);
    const navTitle = tocTitles.get(item.zipPath) ?? "";
    const docTitle = chapterTitleFromDocument(chapterDoc);
    const title = navTitle || docTitle || extracted.headingTitle || "第 " + (chapters.length + 1) + " 章";
    const id = makeChapterId(item.href, chapters.length, usedChapterIds);

    chapters.push({
      id,
      href: item.href,
      title,
      originalTitle: title,
      html: extracted.html,
      originalHtml: extracted.html,
      linear: true,
      epubType: extracted.epubType || undefined,
    });
  }

  if (chapters.length === 0) chapters.push(makeFallbackChapter());

  return {
    sourceBytes: bytes,
    sourceName: String(sourceName ?? ""),
    opfPath,
    opfDir,
    meta: metadata,
    chapters,
    cover,
    byteLength: bytes.byteLength,
    resourceCount: countResources(zip, manifest, opfPath),
  };
}

/* ============================================================
   空白书
   ============================================================ */

/** 用 buildEpub 生成空包，再交给同一套 readEpub 模型（解析不到章节时会自动补单章「正文」）。 */
export async function createBlankEpub(meta: EpubBookMeta): Promise<EpubProject> {
  const safeMeta: EpubBookMeta = {
    ...meta,
    title: String(meta?.title ?? ""),
    author: String(meta?.author ?? ""),
    language: meta?.language ?? "zh-CN",
  };
  const bytes = await buildEpub(safeMeta, []);
  const project = await readEpub(bytes, (safeMeta.title.trim() || "未命名") + ".epub");
  project.meta = {
    ...project.meta,
    ...safeMeta,
    identifier: safeMeta.identifier ?? project.meta.identifier,
  };
  return project;
}

/* ============================================================
   章节 HTML 安全清洗（写回用）
   ============================================================ */

const SANITIZE_DROP_TAGS = new Set([
  "script",
  "style",
  "link",
  "meta",
  "iframe",
  "object",
  "embed",
  "noscript",
  "template",
  "base",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "option",
  "svg",
  "math",
  "audio",
  "video",
  "source",
  "track",
  "canvas",
  "frame",
  "frameset",
  "applet",
]);

const SANITIZE_TAG_ALIASES: Record<string, string> = {
  b: "strong",
  i: "em",
  strike: "s",
  del: "s",
  ins: "u",
  tt: "code",
  kbd: "code",
  samp: "code",
  var: "em",
  center: "div",
  big: "span",
  acronym: "abbr",
};

const SANITIZE_ALLOWED_TAGS = new Set([
  "p",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "u",
  "s",
  "blockquote",
  "ol",
  "ul",
  "li",
  "a",
  "img",
  "span",
  "div",
  "pre",
  "code",
  "hr",
  "sub",
  "sup",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "colgroup",
  "col",
  "figure",
  "figcaption",
  "section",
  "mark",
  "small",
  "abbr",
  "dl",
  "dt",
  "dd",
]);

const GLOBAL_ALLOWED_ATTRS = new Set(["id", "title", "lang", "dir", "role", "epub:type"]);

const ALLOWED_ATTRS_BY_TAG: Record<string, Set<string>> = {
  a: new Set(["href", "rel", "hreflang", "type"]),
  img: new Set(["src", "alt", "width", "height"]),
  ol: new Set(["start", "reversed", "type"]),
  li: new Set(["value"]),
  td: new Set(["colspan", "rowspan", "headers", "scope", "abbr"]),
  th: new Set(["colspan", "rowspan", "headers", "scope", "abbr"]),
  blockquote: new Set(["cite"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
};

const DANGEROUS_STYLE_PATTERN = /url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:/i;
const SAFE_STYLE_VALUE = /^[-#a-zA-Z0-9.,%\s()"'!]*$/;

const ALLOWED_STYLE_PROPS = new Set([
  "text-align",
  "text-indent",
  "text-decoration",
  "margin",
  "margin-left",
  "margin-right",
  "margin-top",
  "margin-bottom",
  "padding-left",
  "padding-right",
  "font-size",
  "font-weight",
  "font-style",
  "font-family",
  "line-height",
  "color",
  "background-color",
  "white-space",
  "vertical-align",
]);

function quillClassStyles(token: string): string[] {
  const lower = token.toLowerCase();
  const align = lower.match(/^ql-align-(left|right|center|justify)$/);
  if (align) return ["text-align: " + align[1]];
  const indent = lower.match(/^ql-indent-(\d+)$/);
  if (indent) {
    const level = Math.min(8, Math.max(0, Number(indent[1])));
    if (level > 0) return ["margin-left: " + level * 2 + "em"];
  }
  const size = lower.match(/^ql-size-(small|large|huge)$/);
  if (size) {
    const sizes: Record<string, string> = { small: "0.75em", large: "1.5em", huge: "2em" };
    return ["font-size: " + sizes[size[1]]];
  }
  return [];
}

function sanitizeStyleText(cssText: string): string[] {
  const declarations: string[] = [];
  for (const chunk of String(cssText ?? "").split(";")) {
    const parts = chunk.split(":");
    if (parts.length < 2) continue;
    const property = parts[0].trim().toLowerCase();
    const value = parts.slice(1).join(":").trim();
    if (!property || !value) continue;
    if (!ALLOWED_STYLE_PROPS.has(property)) continue;
    if (DANGEROUS_STYLE_PATTERN.test(value)) continue;
    if (!SAFE_STYLE_VALUE.test(value)) continue;
    if (value.length > 200) continue;
    declarations.push(property + ": " + value);
  }
  return declarations;
}

function sanitizeTagAttributes(element: Element, tag: string): string {
  const styles: string[] = [];
  const classes: string[] = [];
  let output = "";
  const tagAttrs = ALLOWED_ATTRS_BY_TAG[tag];

  for (const attribute of Array.from(element.attributes)) {
    const name = String(attribute.name || "").toLowerCase();
    const value = String(attribute.value ?? "");
    if (!name || name.startsWith("on")) continue;

    if (name === "class") {
      const kept: string[] = [];
      for (const token of splitTokens(value)) {
        const mapped = quillClassStyles(token);
        if (mapped.length > 0) styles.push(...mapped);
        else if (!token.toLowerCase().startsWith("ql-")) kept.push(token);
      }
      if (kept.length > 0) classes.push(...kept);
      continue;
    }
    if (name === "style") {
      styles.push(...sanitizeStyleText(value));
      continue;
    }
    if (name === "href") {
      if (tag === "a" && !isUnsafeUrl(value)) output += " href=\"" + escapeXml(value.trim()) + "\"";
      continue;
    }
    if (name === "src") {
      if (tag === "img" && !isUnsafeUrl(value, true)) output += " src=\"" + escapeXml(value.trim()) + "\"";
      continue;
    }
    const allowed = GLOBAL_ALLOWED_ATTRS.has(name) || tagAttrs?.has(name);
    if (!allowed) continue;
    if (name === "id" && !/^[A-Za-z_][\w:.-]*$/.test(value.trim())) continue;
    output += " " + name + "=\"" + escapeXml(value) + "\"";
  }

  if (classes.length > 0) output = " class=\"" + escapeXml(classes.join(" ")) + "\"" + output;
  if (styles.length > 0) output += " style=\"" + escapeXml(styles.join("; ")) + "\"";
  if (tag === "img" && !/ alt=/.test(output)) output += " alt=\"\"";
  return output;
}

function sanitizeHtmlNode(node: Node): string {
  if (node.nodeType === 3 || node.nodeType === 4) return escapeXml(node.nodeValue ?? "");
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  const originalTag = String(element.localName || element.tagName || "").toLowerCase();
  if (!originalTag || SANITIZE_DROP_TAGS.has(originalTag)) return "";

  const tag = SANITIZE_TAG_ALIASES[originalTag] ?? originalTag;
  if (!SANITIZE_ALLOWED_TAGS.has(tag)) {
    return Array.from(element.childNodes)
      .map((child) => sanitizeHtmlNode(child))
      .join("");
  }
  if (tag === "img") {
    const src = getAttributeValue(element, "src") ?? "";
    if (!src.trim() || isUnsafeUrl(src, true)) return "";
  }
  const attributes = sanitizeTagAttributes(element, tag);
  if (VOID_ELEMENTS.has(tag)) return "<" + tag + attributes + " />";
  let children = "";
  for (const child of Array.from(element.childNodes)) children += sanitizeHtmlNode(child);
  // 没有 href 的 <a> 降级成 span，避免生成无意义的空链接
  if (tag === "a" && !/ href=/.test(attributes)) return children;
  return "<" + tag + attributes + ">" + children + "</" + tag + ">";
}

/** 清洗编辑器产出的 HTML 片段（只保留语义标签与安全属性，Quill class 映射为内联样式）。 */
function sanitizeChapterHtml(html: string): string {
  const source = String(html ?? "");
  if (source.trim().length === 0) return "";
  const doc = parseHtmlDocument(source);
  if (!doc?.body) return "";
  const topChildren = Array.from(doc.body.children);
  if (topChildren.length > 0 && /^h[1-6]$/i.test(String(topChildren[0].tagName || ""))) {
    topChildren[0].remove();
  }
  let output = "";
  for (const node of Array.from(doc.body.childNodes)) output += sanitizeHtmlNode(node);
  return output.trim();
}

/* ============================================================
   写回：OPF / 章节文档生成
   ============================================================ */

const NCX_NS = "http://www.daisy.org/z3986/2005/ncx/";

interface ZipMutations {
  replacements: Map<string, string | Uint8Array>;
  additions: Map<string, string | Uint8Array>;
  deletions: Set<string>;
}

function setMutationFile(mutations: ZipMutations, sourceZip: JSZip, path: string, data: string | Uint8Array): void {
  const normalized = normalizeZipPath(path);
  if (findZipEntry(sourceZip, normalized)) {
    mutations.replacements.set(normalized, data);
  } else {
    mutations.additions.set(normalized, data);
  }
}

function ensureOpfChild(doc: Document, localName: string): Element {
  const existing = firstElement(doc, localName);
  if (existing) return existing;
  const element = doc.createElementNS(OPF_NS, localName);
  const root = doc.documentElement;
  const order = ["metadata", "manifest", "spine", "guide"];
  const position = order.indexOf(localName);
  let nextSibling: Element | null = null;
  for (let index = position + 1; index < order.length; index += 1) {
    const candidate = firstElement(doc, order[index]);
    if (candidate) {
      nextSibling = candidate;
      break;
    }
  }
  if (nextSibling?.parentNode) nextSibling.parentNode.insertBefore(element, nextSibling);
  else root.appendChild(element);
  return element;
}

function uniqueElementId(base: string, used: Set<string>): string {
  const cleaned = String(base ?? "item")
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "");
  let stem = cleaned || "item";
  if (!/^[A-Za-z_]/.test(stem)) stem = "item-" + stem;
  let candidate = stem;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = stem + "-" + counter;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

function createManifestItem(doc: Document, id: string, href: string, mediaType: string, properties: string): Element {
  const element = doc.createElementNS(OPF_NS, "item");
  element.setAttribute("id", id);
  element.setAttribute("href", href);
  element.setAttribute("media-type", mediaType);
  if (properties) element.setAttribute("properties", properties);
  return element;
}

function removeElementList(elements: Element[]): void {
  for (const element of elements) element.parentNode?.removeChild(element);
}

function makeBookId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return "urn:uuid:" + crypto.randomUUID();
  }
  return "urn:uuid:" + Date.now().toString(16) + "-" + Math.random().toString(16).slice(2, 10);
}

function dcPrefix(doc: Document): string {
  const root = doc.documentElement;
  for (const attribute of Array.from(root.attributes)) {
    if (/^xmlns:/i.test(attribute.name) && attribute.value === DC_NS) {
      return attribute.name.split(":")[1] || "dc";
    }
  }
  return "dc";
}

function createDcElement(doc: Document, localName: string): Element {
  return doc.createElementNS(DC_NS, dcPrefix(doc) + ":" + localName);
}

function setOrRemoveDc(
  doc: Document,
  metadataElement: Element,
  localName: string,
  value: string | undefined,
  removeWhenEmpty: boolean,
): void {
  if (value === undefined) return;
  const text = String(value ?? "").trim();
  const elements = collectElements(metadataElement, localName).filter(isDcElement);
  if (!text) {
    if (removeWhenEmpty) removeElementList(elements);
    return;
  }
  const target = elements[0] ?? createDcElement(doc, localName);
  if (elements.length === 0) metadataElement.appendChild(target);
  target.textContent = text;
}

function collectSubtitleIds(metadataElement: Element): Set<string> {
  const ids = new Set<string>();
  for (const metaElement of collectElements(metadataElement, "meta")) {
    const properties = splitTokens(getAttributeValue(metaElement, "property")).map((token) => token.toLowerCase());
    const type = String(metaElement.textContent ?? "").trim().toLowerCase();
    if (!properties.includes("title-type") || type !== "subtitle") continue;
    const refines = getAttributeValue(metaElement, "refines") ?? "";
    const id = refines.startsWith("#") ? refines.slice(1) : refines;
    if (id) ids.add(id);
  }
  return ids;
}

function ensureUniqueIdentifier(doc: Document, metadataElement: Element, meta: EpubBookMeta): void {
  const root = doc.documentElement;
  let identifiers = collectElements(metadataElement, "identifier").filter(isDcElement);
  if (identifiers.length === 0) {
    const identifierElement = createDcElement(doc, "identifier");
    identifierElement.setAttribute("id", "bookid");
    identifierElement.textContent = String(meta.identifier ?? "").trim() || makeBookId();
    metadataElement.appendChild(identifierElement);
    identifiers = [identifierElement];
  }
  const uniqueIdentifier = getAttributeValue(root, "unique-identifier");
  const hasUnique = uniqueIdentifier
    ? identifiers.some((element) => getAttributeValue(element, "id") === uniqueIdentifier)
    : false;
  if (!hasUnique) {
    let id = getAttributeValue(identifiers[0], "id") ?? "";
    if (!id) {
      id = "bookid";
      identifiers[0].setAttribute("id", id);
    }
    root.setAttribute("unique-identifier", id);
  }
}

function updateOpfMetadata(doc: Document, meta: EpubBookMeta): void {
  const metadataElement = ensureOpfChild(doc, "metadata");
  const titles = collectElements(metadataElement, "title").filter(isDcElement);
  const subtitleIds = collectSubtitleIds(metadataElement);
  const titleText = String(meta.title ?? "").trim() || (meta.language === "en" ? "Untitled" : "未命名");
  let mainTitle =
    titles.find((element) => {
      const id = getAttributeValue(element, "id") ?? "";
      return !id || !subtitleIds.has(id);
    }) ?? titles[0];
  if (!mainTitle) {
    mainTitle = createDcElement(doc, "title");
    metadataElement.appendChild(mainTitle);
  }
  mainTitle.textContent = titleText;

  if (meta.subtitle !== undefined) {
    const subtitleText = String(meta.subtitle ?? "").trim();
    const subtitleTitle = titles.find((element) => subtitleIds.has(getAttributeValue(element, "id") ?? ""));
    if (subtitleText) {
      let target = subtitleTitle;
      if (!target) {
        const usedIds = new Set<string>();
        for (const element of collectElements(metadataElement, "*")) {
          const id = getAttributeValue(element, "id");
          if (id) usedIds.add(id);
        }
        const id = uniqueElementId("subtitle", usedIds);
        target = createDcElement(doc, "title");
        target.setAttribute("id", id);
        metadataElement.appendChild(target);
        const refineMeta = doc.createElementNS(OPF_NS, "meta");
        refineMeta.setAttribute("refines", "#" + id);
        refineMeta.setAttribute("property", "title-type");
        refineMeta.textContent = "subtitle";
        metadataElement.appendChild(refineMeta);
      }
      target.textContent = subtitleText;
    } else {
      const refineMetas = collectElements(metadataElement, "meta").filter((metaElement) => {
        const properties = splitTokens(getAttributeValue(metaElement, "property")).map((token) => token.toLowerCase());
        return properties.includes("title-type") && String(metaElement.textContent ?? "").trim().toLowerCase() === "subtitle";
      });
      for (const refineMeta of refineMetas) {
        const refines = getAttributeValue(refineMeta, "refines") ?? "";
        const id = refines.startsWith("#") ? refines.slice(1) : refines;
        if (id) {
          const target = titles.find((element) => getAttributeValue(element, "id") === id);
          if (target?.parentNode) target.parentNode.removeChild(target);
        }
        refineMeta.parentNode?.removeChild(refineMeta);
      }
    }
  }

  setOrRemoveDc(doc, metadataElement, "creator", meta.author, true);
  setOrRemoveDc(doc, metadataElement, "language", meta.language, false);
  setOrRemoveDc(doc, metadataElement, "publisher", meta.publisher, true);
  setOrRemoveDc(doc, metadataElement, "description", meta.description, true);
  setOrRemoveDc(doc, metadataElement, "date", meta.publishedAt, true);

  if (meta.tags !== undefined) {
    removeElementList(collectElements(metadataElement, "subject").filter(isDcElement));
    for (const tag of meta.tags ?? []) {
      const text = String(tag ?? "").trim();
      if (!text) continue;
      const subject = createDcElement(doc, "subject");
      subject.textContent = text;
      metadataElement.appendChild(subject);
    }
  }

  const modifiedMetas = collectElements(metadataElement, "meta").filter((metaElement) =>
    splitTokens(getAttributeValue(metaElement, "property")).some((token) => token.toLowerCase() === "dcterms:modified"),
  );
  const modified = modifiedMetas[0] ?? doc.createElementNS(OPF_NS, "meta");
  if (modifiedMetas.length === 0) {
    modified.setAttribute("property", "dcterms:modified");
    metadataElement.appendChild(modified);
  }
  for (let index = 1; index < modifiedMetas.length; index += 1) modifiedMetas[index].parentNode?.removeChild(modifiedMetas[index]);
  modified.textContent = modifiedTimestamp();

  ensureUniqueIdentifier(doc, metadataElement, meta);
}

interface ChapterTemplate {
  headParts: string[];
  bodyAttributes: string;
  dir: string;
}

function extractChapterTemplate(text: string): ChapterTemplate {
  const doc = parseHtmlDocument(text);
  if (!doc) return { headParts: [], bodyAttributes: "", dir: "" };
  const headParts: string[] = [];
  if (doc.head) {
    for (const child of Array.from(doc.head.children)) {
      const tag = String(child.localName || child.tagName || "").toLowerCase();
      if (tag === "link") {
        const rel = String(child.getAttribute("rel") ?? "").toLowerCase();
        if (!rel || splitTokens(rel).includes("stylesheet")) headParts.push(serializeDomNode(child));
      } else if (tag === "style") {
        headParts.push(serializeDomNode(child));
      }
    }
  }
  const bodyAttributes: string[] = [];
  if (doc.body) {
    for (const attribute of Array.from(doc.body.attributes)) {
      const name = attribute.name;
      if (!name || /^on/i.test(name) || /^xmlns(:|$)/i.test(name)) continue;
      bodyAttributes.push(name + "=\"" + escapeXml(attribute.value) + "\"");
    }
  }
  const dir = doc.documentElement.getAttribute("dir") ?? "";
  return { headParts, bodyAttributes: bodyAttributes.join(" "), dir };
}

function buildChapterBodyHtml(title: string, sanitizedHtml: string, epubType?: string): string {
  const typeTokens = splitTokens(epubType).filter((token) => /^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/.test(token));
  const sectionType = typeTokens.length > 0 ? typeTokens.join(" ") : "chapter";
  const content = sanitizedHtml.trim() || "<p>&#160;</p>";
  const indented = content
    .split("\n")
    .map((line) => "      " + line)
    .join("\n");
  return (
    "    <section epub:type=\"" +
    escapeXml(sectionType) +
    "\">\n      <h1>" +
    escapeXml(title) +
    "</h1>\n" +
    indented +
    "\n    </section>"
  );
}

interface ChapterDocumentOptions {
  title: string;
  bodyHtml: string;
  headParts: string[];
  bodyAttributes: string;
  dir: string;
  language: string;
}

function buildChapterXhtmlDocument(options: ChapterDocumentOptions): string {
  const headLines = ["    <meta charset=\"utf-8\" />", "    <title>" + escapeXml(options.title) + "</title>"];
  for (const part of options.headParts) headLines.push("    " + part);
  const dirAttribute = options.dir ? " dir=\"" + escapeXml(options.dir) + "\"" : "";
  const bodyAttributeText = options.bodyAttributes ? " " + options.bodyAttributes : "";
  return (
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" xml:lang=\"" +
    escapeXml(options.language) +
    "\" lang=\"" +
    escapeXml(options.language) +
    "\"" +
    dirAttribute +
    ">\n  <head>\n" +
    headLines.join("\n") +
    "\n  </head>\n  <body" +
    bodyAttributeText +
    ">\n" +
    options.bodyHtml +
    "\n  </body>\n</html>\n"
  );
}

function findStylesheetHref(manifestItems: ManifestItemInfo[], zip: JSZip, chapterZipPath: string): string | null {
  for (const item of manifestItems) {
    if (item.mediaType.toLowerCase() !== "text/css") continue;
    if (!findZipEntry(zip, item.zipPath)) continue;
    return relativeZipPath(dirname(chapterZipPath), item.zipPath);
  }
  return null;
}

function buildChapterDocumentForWrite(args: {
  title: string;
  html: string;
  epubType?: string;
  originalText: string | null;
  chapterZipPath: string;
  manifestItems: ManifestItemInfo[];
  sourceZip: JSZip;
  meta: EpubBookMeta;
}): string {
  const sanitized = sanitizeChapterHtml(args.html);
  const bodyHtml = buildChapterBodyHtml(args.title, sanitized, args.epubType);
  const template = args.originalText ? extractChapterTemplate(args.originalText) : { headParts: [], bodyAttributes: "", dir: "" };
  let headParts = template.headParts;
  if (headParts.length === 0) {
    const stylesheet = findStylesheetHref(args.manifestItems, args.sourceZip, args.chapterZipPath);
    if (stylesheet) headParts = ["<link rel=\"stylesheet\" type=\"text/css\" href=\"" + escapeXml(stylesheet) + "\" />"];
  }
  return buildChapterXhtmlDocument({
    title: args.title,
    bodyHtml,
    headParts,
    bodyAttributes: template.bodyAttributes,
    dir: template.dir,
    language: args.meta.language,
  });
}

function normalizeNewChapterHref(value: string): string {
  let href = String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!href) return "";
  href = normalizeZipPath(href);
  if (!/\.[a-z0-9]+$/i.test(href)) href += ".xhtml";
  else if (/\.html?$/i.test(href)) href = href.replace(/\.html?$/i, ".xhtml");
  return href;
}

function makeNewChapterHref(
  preferred: string,
  opfDir: string,
  sourceZip: JSZip,
  usedPaths: Set<string>,
  index: number,
): string {
  const preferredClean = normalizeNewChapterHref(preferred);
  if (preferredClean) {
    const preferredZipPath = resolveZipPath(opfDir, preferredClean);
    if (!findZipEntry(sourceZip, preferredZipPath) && !usedPaths.has(preferredZipPath)) {
      usedPaths.add(preferredZipPath);
      return preferredClean;
    }
  }
  const baseDir = preferredClean.includes("/") ? dirname(preferredClean) || "Text" : "Text";
  for (let counter = 1; counter < 10000; counter += 1) {
    const href = baseDir + "/chapter-extra-" + String(counter).padStart(3, "0") + ".xhtml";
    const zipPath = resolveZipPath(opfDir, href);
    if (!findZipEntry(sourceZip, zipPath) && !usedPaths.has(zipPath)) {
      usedPaths.add(zipPath);
      return href;
    }
  }
  return "chapter-extra-" + String(index + 1) + ".xhtml";
}

/* ============================================================
   写回：封面
   ============================================================ */

function findCoverMetaElements(metadataElement: Element): Element[] {
  return collectElements(metadataElement, "meta").filter(
    (element) => String(getAttributeValue(element, "name") ?? "").toLowerCase() === "cover",
  );
}

function findCoverImageItem(manifestItems: ManifestItemInfo[], metadataElement: Element, opfDir: string): ManifestItemInfo | null {
  const coverMeta = findCoverMetaElements(metadataElement)[0];
  const content = coverMeta ? getAttributeValue(coverMeta, "content") : null;
  if (content) {
    const byId = manifestItems.find((item) => item.id === content);
    if (byId) return byId;
    const byPath = manifestItems.find((item) => item.zipPath === resolveZipPath(opfDir, content));
    if (byPath) return byPath;
  }
  return manifestItems.find((item) => item.properties.includes("cover-image")) ?? null;
}

function findCoverPageItem(manifestItems: ManifestItemInfo[]): ManifestItemInfo | null {
  return (
    manifestItems.find((item) => item.id === "cover-page") ??
    manifestItems.find((item) => /(^|\/)cover\.x?html?$/i.test(item.href)) ??
    null
  );
}

function setItemProperties(item: ManifestItemInfo, mutate: (tokens: string[]) => string[]): void {
  const next = mutate(item.properties.slice());
  item.properties = next;
  if (next.length > 0) item.element.setAttribute("properties", next.join(" "));
  else item.element.removeAttribute("properties");
}

function ensureCoverMeta(doc: Document, metadataElement: Element, itemId: string): void {
  const coverMetas = findCoverMetaElements(metadataElement);
  const target = coverMetas[0] ?? doc.createElementNS(OPF_NS, "meta");
  if (coverMetas.length === 0) {
    target.setAttribute("name", "cover");
    metadataElement.appendChild(target);
  }
  target.setAttribute("content", itemId);
  for (let index = 1; index < coverMetas.length; index += 1) coverMetas[index].parentNode?.removeChild(coverMetas[index]);
}

function removeCoverMarkers(
  opfDir: string,
  metadataElement: Element,
  manifestItems: ManifestItemInfo[],
  spineElement: Element,
  sourceZip: JSZip,
  mutations: ZipMutations,
): void {
  const coverMetas = findCoverMetaElements(metadataElement);
  const coverIds = new Set<string>();
  for (const metaElement of coverMetas) {
    const content = getAttributeValue(metaElement, "content");
    if (content) coverIds.add(content);
  }
  for (const item of manifestItems) {
    if (item.properties.includes("cover-image")) coverIds.add(item.id);
  }
  removeElementList(coverMetas);

  const removedItemIds = new Set<string>();
  for (const item of manifestItems) {
    if (!coverIds.has(item.id) && !item.properties.includes("cover-image")) continue;
    removedItemIds.add(item.id);
    item.element.parentNode?.removeChild(item.element);
    if (item.zipPath && findZipEntry(sourceZip, item.zipPath)) mutations.deletions.add(item.zipPath);
  }

  const pageItem = findCoverPageItem(manifestItems);
  if (pageItem && !removedItemIds.has(pageItem.id)) {
    removedItemIds.add(pageItem.id);
    pageItem.element.parentNode?.removeChild(pageItem.element);
    if (pageItem.zipPath && findZipEntry(sourceZip, pageItem.zipPath)) mutations.deletions.add(pageItem.zipPath);
  }

  for (const itemref of collectElements(spineElement, "itemref")) {
    const idref = getAttributeValue(itemref, "idref") ?? "";
    if (removedItemIds.has(idref)) itemref.parentNode?.removeChild(itemref);
  }

  // 极端来源（manifest 没有 cover 页条目但文件存在）也一并清掉
  const fallbackCoverPage = normalizeZipPath(opfDir ? opfDir + "/cover.xhtml" : "cover.xhtml");
  if (findZipEntry(sourceZip, fallbackCoverPage)) mutations.deletions.add(fallbackCoverPage);

}

function coverLabelForLanguage(language: EpubBookMeta["language"]): string {
  return language === "en" ? "Cover" : "封面";
}

function buildCoverPageXhtml(meta: EpubBookMeta, imageHref: string, alt: string): string {
  return (
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" xml:lang=\"" +
    escapeXml(meta.language) +
    "\" lang=\"" +
    escapeXml(meta.language) +
    "\">\n  <head>\n    <meta charset=\"utf-8\" />\n    <title>" +
    escapeXml(alt) +
    "</title>\n  </head>\n  <body class=\"cover\">\n    <section epub:type=\"cover\">\n      <img src=\"" +
    escapeXml(imageHref) +
    "\" alt=\"" +
    escapeXml(alt) +
    "\" />\n    </section>\n  </body>\n</html>\n"
  );
}

function updateCoverPageMarkup(pageText: string, pageZipPath: string, oldImagePath: string | null, newImagePath: string): string | null {
  const doc = parseXmlDocument(pageText);
  if (!doc) return null;
  const images = collectElements(doc, "img");
  if (images.length === 0) return null;
  const pageDir = dirname(pageZipPath);
  let changed = false;
  for (const image of images) {
    const src = getAttributeValue(image, "src") ?? "";
    if (!src) continue;
    const resolved = resolveZipPath(pageDir, src);
    if (oldImagePath !== null && resolved !== oldImagePath) continue;
    image.setAttribute("src", relativeZipPath(pageDir, newImagePath));
    changed = true;
  }
  if (!changed) return null;
  return serializeXmlDocument(doc);
}

async function applyCoverChange(
  opfDoc: Document,
  meta: EpubBookMeta,
  opfDir: string,
  sourceZip: JSZip,
  mutations: ZipMutations,
  option: Cover | null | undefined,
): Promise<void> {
  if (option === undefined) return;
  const metadataElement = ensureOpfChild(opfDoc, "metadata");
  const manifestElement = ensureOpfChild(opfDoc, "manifest");
  const spineElement = ensureOpfChild(opfDoc, "spine");
  const manifestItems = readManifestItems(opfDoc, opfDir);
  const coverItem = findCoverImageItem(manifestItems, metadataElement, opfDir);

  if (option === null) {
    removeCoverMarkers(opfDir, metadataElement, manifestItems, spineElement, sourceZip, mutations);
    return;
  }

  const imageBytes = coverBytes(option);
  if (imageBytes.byteLength === 0) {
    removeCoverMarkers(opfDir, metadataElement, manifestItems, spineElement, sourceZip, mutations);
    return;
  }
  const mimeType = normalizeCoverMime(option.mimeType, option.fileName);
  const extension = extensionForMime(mimeType);
  const pageItem = findCoverPageItem(manifestItems);
  const pageExists = pageItem ? findZipEntry(sourceZip, pageItem.zipPath) !== null : false;

  if (coverItem) {
    const oldPath = coverItem.zipPath;
    const oldHref = coverItem.href;
    const oldDir = dirname(oldHref);
    const stem = basename(oldHref).replace(/\.[^.]+$/, "") || "cover";
    let newHref = (oldDir ? oldDir + "/" : "") + stem + "." + extension;
    let newPath = resolveZipPath(opfDir, newHref);
    if (newPath !== oldPath && findZipEntry(sourceZip, newPath)) {
      newHref = (oldDir ? oldDir + "/" : "") + stem + "-cover." + extension;
      newPath = resolveZipPath(opfDir, newHref);
    }
    if (newPath !== oldPath) {
      mutations.deletions.add(oldPath);
      mutations.additions.set(newPath, imageBytes);
    } else {
      mutations.replacements.set(oldPath, imageBytes);
    }
    coverItem.element.setAttribute("href", newHref);
    coverItem.element.setAttribute("media-type", mimeType);
    setItemProperties(coverItem, (tokens) => (tokens.includes("cover-image") ? tokens : [...tokens, "cover-image"]));
    ensureCoverMeta(opfDoc, metadataElement, coverItem.id);
    if (pageExists && pageItem) {
      const pageText = await readZipText(sourceZip, pageItem.zipPath);
      if (pageText) {
        const updated = updateCoverPageMarkup(pageText, pageItem.zipPath, oldPath, newPath);
        if (updated) setMutationFile(mutations, sourceZip, pageItem.zipPath, updated);
      }
    }
    return;
  }

  // 没有封面：新增图片、封面页（若不存在）与 manifest / spine 条目
  const usedIds = new Set(manifestItems.map((item) => item.id));
  const usedPaths = new Set(Object.keys(sourceZip.files).map((name) => normalizeZipPath(name)));
  const existingImageItem = manifestItems.find((item) => item.mediaType.toLowerCase().startsWith("image/"));
  const imageDir = existingImageItem ? dirname(existingImageItem.href) : "images";
  let imageHref = (imageDir ? imageDir + "/" : "") + "cover." + extension;
  let counter = 2;
  while (
    findZipEntry(sourceZip, resolveZipPath(opfDir, imageHref)) ||
    usedPaths.has(resolveZipPath(opfDir, imageHref))
  ) {
    imageHref = (imageDir ? imageDir + "/" : "") + "cover-" + counter + "." + extension;
    counter += 1;
  }
  const imagePath = resolveZipPath(opfDir, imageHref);
  mutations.additions.set(imagePath, imageBytes);
  const imageId = uniqueElementId("cover-image", usedIds);
  manifestElement.appendChild(createManifestItem(opfDoc, imageId, imageHref, mimeType, "cover-image"));
  ensureCoverMeta(opfDoc, metadataElement, imageId);

  let pageHref = pageItem?.href ?? "";
  if (!pageItem) {
    let candidate = "cover.xhtml";
    counter = 2;
    while (
      findZipEntry(sourceZip, resolveZipPath(opfDir, candidate)) ||
      usedPaths.has(resolveZipPath(opfDir, candidate))
    ) {
      candidate = "cover-" + counter + ".xhtml";
      counter += 1;
    }
    pageHref = candidate;
    const pageId = uniqueElementId("cover-page", usedIds);
    manifestElement.appendChild(createManifestItem(opfDoc, pageId, pageHref, "application/xhtml+xml", ""));
    const itemref = opfDoc.createElementNS(OPF_NS, "itemref");
    itemref.setAttribute("idref", pageId);
    spineElement.insertBefore(itemref, spineElement.firstChild);
  }
  const pageZipPath = resolveZipPath(opfDir, pageHref);
  const pageDir = dirname(pageZipPath);
  const imageRelative = relativeZipPath(pageDir, imagePath);
  const alt = (String(meta.title ?? "").trim() || (meta.language === "en" ? "Untitled" : "未命名")) + " " + coverLabelForLanguage(meta.language);
  const existingPageText = pageExists && pageItem ? await readZipText(sourceZip, pageZipPath) : null;
  let pageContent = existingPageText ? updateCoverPageMarkup(existingPageText, pageZipPath, null, imagePath) : null;
  if (!pageContent) pageContent = buildCoverPageXhtml(meta, imageRelative, alt.trim());
  setMutationFile(mutations, sourceZip, pageZipPath, pageContent);
}

/** 删除被删章节后，清掉 OPF <guide> 中指向已删除文件的引用，避免 EPUBCheck 报死链。 */
function cleanupGuideReferences(doc: Document, opfDir: string, deletedPaths: Set<string>): void {
  const guide = firstElement(doc, "guide");
  if (!guide) return;
  for (const reference of collectElements(guide, "reference")) {
    const href = getAttributeValue(reference, "href");
    if (!href) continue;
    if (deletedPaths.has(resolveZipPath(opfDir, href))) reference.parentNode?.removeChild(reference);
  }
  if (guide.childElementCount === 0) guide.parentNode?.removeChild(guide);
}

/* ============================================================
   写回：nav / NCX
   ============================================================ */

interface TocEntry {
  zipPath: string;
  title: string;
}

function tocLabel(language: EpubBookMeta["language"]): string {
  return language === "en" ? "Contents" : "目录";
}

function findFallbackXhtmlPath(manifestItems: ManifestItemInfo[]): string {
  const candidates = manifestItems.filter(
    (item) => isXhtmlMediaType(item.mediaType, item.href) && !item.properties.includes("nav"),
  );
  const preferred =
    candidates.find((item) => /(^|\/)(titlepage|title-page|cover)\.x?html?$/i.test(item.href)) ??
    candidates.find((item) => !item.properties.includes("nav")) ??
    candidates[0];
  return preferred?.zipPath ?? "";
}

function appendNavListEntries(
  doc: Document,
  listElement: Element,
  entries: TocEntry[],
  baseDir: string,
  fallbackZipPath: string,
): void {
  const effective: TocEntry[] =
    entries.length > 0 ? entries : [{ zipPath: fallbackZipPath, title: tocLabel("zh-CN") }];
  for (const entry of effective) {
    const item = doc.createElementNS(XHTML_NS, "li");
    if (entry.zipPath) {
      const anchor = doc.createElementNS(XHTML_NS, "a");
      anchor.setAttribute("href", relativeZipPath(baseDir, entry.zipPath));
      anchor.textContent = entry.title;
      item.appendChild(anchor);
    } else {
      const span = doc.createElementNS(XHTML_NS, "span");
      span.textContent = entry.title;
      item.appendChild(span);
    }
    listElement.appendChild(item);
  }
}

function buildFreshNavXhtml(meta: EpubBookMeta, entries: TocEntry[], navDir: string, fallbackZipPath: string): string {
  const label = tocLabel(meta.language);
  const items =
    entries.length > 0
      ? entries
          .map(
            (entry) =>
              "        <li><a href=\"" +
              escapeXml(relativeZipPath(navDir, entry.zipPath)) +
              "\">" +
              escapeXml(entry.title) +
              "</a></li>",
          )
          .join("\n")
      : fallbackZipPath
        ? "        <li><a href=\"" + escapeXml(relativeZipPath(navDir, fallbackZipPath)) + "\">" + escapeXml(label) + "</a></li>"
        : "        <li><span>" + escapeXml(label) + "</span></li>";
  return (
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" xml:lang=\"" +
    escapeXml(meta.language) +
    "\" lang=\"" +
    escapeXml(meta.language) +
    "\">\n  <head>\n    <meta charset=\"utf-8\" />\n    <title>" +
    escapeXml(label) +
    "</title>\n  </head>\n  <body>\n    <nav epub:type=\"toc\" id=\"toc\">\n      <h1>" +
    escapeXml(label) +
    "</h1>\n      <ol>\n" +
    items +
    "\n      </ol>\n    </nav>\n  </body>\n</html>\n"
  );
}

function findTocNavElement(doc: Document): Element | null {
  const navs = collectElements(doc, "nav");
  return (
    navs.find((element) => getEpubTypeTokens(element).includes("toc")) ??
    navs.find((element) => String(getAttributeValue(element, "id") ?? "").toLowerCase() === "toc") ??
    navs[0] ??
    null
  );
}

async function updateNavigation(
  opfDoc: Document,
  meta: EpubBookMeta,
  opfDir: string,
  sourceZip: JSZip,
  mutations: ZipMutations,
  entries: TocEntry[],
): Promise<void> {
  const manifestElement = ensureOpfChild(opfDoc, "manifest");
  let manifestItems = readManifestItems(opfDoc, opfDir);
  let navItem =
    manifestItems.find((item) => item.properties.includes("nav")) ??
    manifestItems.find((item) => /(^|\/)nav\.x?html?$/i.test(item.href) && isXhtmlMediaType(item.mediaType, item.href));
  const usedIds = new Set(manifestItems.map((item) => item.id));
  const usedPaths = new Set(Object.keys(sourceZip.files).map((name) => normalizeZipPath(name)));

  if (!navItem) {
    let navHref = "nav.xhtml";
    let counter = 2;
    while (
      findZipEntry(sourceZip, resolveZipPath(opfDir, navHref)) ||
      usedPaths.has(resolveZipPath(opfDir, navHref))
    ) {
      navHref = "nav-" + counter + ".xhtml";
      counter += 1;
    }
    const navId = uniqueElementId("nav", usedIds);
    manifestElement.appendChild(createManifestItem(opfDoc, navId, navHref, "application/xhtml+xml", "nav"));
    manifestItems = readManifestItems(opfDoc, opfDir);
    navItem = manifestItems.find((item) => item.id === navId) ?? undefined;
  }
  if (!navItem) return;

  const navDir = dirname(navItem.zipPath);
  const fallbackZipPath = findFallbackXhtmlPath(manifestItems);
  const existingText = await readZipText(sourceZip, navItem.zipPath);
  let content: string | null = null;
  if (existingText) {
    const doc = parseXmlDocument(existingText);
    if (doc) {
      const toc = findTocNavElement(doc);
      if (toc) {
        let list = firstElement(toc, "ol");
        if (!list) {
          list = doc.createElementNS(XHTML_NS, "ol");
          toc.appendChild(list);
        }
        while (list.firstChild) list.removeChild(list.firstChild);
        appendNavListEntries(doc, list, entries, navDir, fallbackZipPath);
        if (entries.length > 0) {
          const landmarks = collectElements(doc, "nav").find((element) => getEpubTypeTokens(element).includes("landmarks"));
          if (landmarks) {
            for (const anchor of collectElements(landmarks, "a")) {
              if (getEpubTypeTokens(anchor).includes("bodymatter")) anchor.setAttribute("href", relativeZipPath(navDir, entries[0].zipPath));
            }
          }
        }
        content = serializeXmlDocument(doc);
      }
    }
  }
  if (!content) content = buildFreshNavXhtml(meta, entries, navDir, fallbackZipPath);
  setMutationFile(mutations, sourceZip, navItem.zipPath, content);
}

function appendNcxNavPoint(doc: Document, navMap: Element, title: string, href: string, order: number): void {
  const navPoint = doc.createElementNS(NCX_NS, "navPoint");
  navPoint.setAttribute("id", "navPoint-" + order);
  navPoint.setAttribute("playOrder", String(order));
  const navLabel = doc.createElementNS(NCX_NS, "navLabel");
  const text = doc.createElementNS(NCX_NS, "text");
  text.textContent = title;
  navLabel.appendChild(text);
  navPoint.appendChild(navLabel);
  const content = doc.createElementNS(NCX_NS, "content");
  content.setAttribute("src", href);
  navPoint.appendChild(content);
  navMap.appendChild(navPoint);
}

async function updateNcx(
  opfDoc: Document,
  meta: EpubBookMeta,
  opfDir: string,
  sourceZip: JSZip,
  mutations: ZipMutations,
  entries: TocEntry[],
): Promise<void> {
  const manifestItems = readManifestItems(opfDoc, opfDir);
  const ncxItem =
    manifestItems.find((item) => item.mediaType.toLowerCase() === NCX_MEDIA_TYPE) ??
    manifestItems.find((item) => /\.ncx$/i.test(item.href));
  if (!ncxItem?.zipPath) return;
  const ncxText = await readZipText(sourceZip, ncxItem.zipPath);
  if (!ncxText) return;
  const doc = parseXmlDocument(ncxText);
  if (!doc) return;
  const navMap = firstElement(doc, "navMap");
  if (!navMap) return;
  const ncxDir = dirname(ncxItem.zipPath);
  const fallbackZipPath = findFallbackXhtmlPath(manifestItems);
  if (entries.length === 0 && !fallbackZipPath) return;
  while (navMap.firstChild) navMap.removeChild(navMap.firstChild);
  if (entries.length === 0) {
    appendNcxNavPoint(doc, navMap, tocLabel(meta.language), relativeZipPath(ncxDir, fallbackZipPath), 1);
  } else {
    entries.forEach((entry, index) => {
      appendNcxNavPoint(doc, navMap, entry.title, relativeZipPath(ncxDir, entry.zipPath), index + 1);
    });
  }
  const docTitle = firstElement(doc, "docTitle");
  if (docTitle) {
    let textElement = firstElement(docTitle, "text");
    if (!textElement) {
      textElement = doc.createElementNS(NCX_NS, "text");
      docTitle.appendChild(textElement);
    }
    textElement.textContent = String(meta.title ?? "").trim() || (meta.language === "en" ? "Untitled" : "未命名");
  }
  setMutationFile(mutations, sourceZip, ncxItem.zipPath, serializeXmlDocument(doc));
}

/* ============================================================
   写回：spine
   ============================================================ */

interface ChapterWritePlan {
  chapter: EpubChapter;
  index: number;
  title: string;
  isNew: boolean;
  oldZipPath: string;
  newZipPath: string;
  newHref: string;
  itemId: string;
  existingItem: ManifestItemInfo | null;
  outputContent: string | null;
}

function isFrontMatterIdref(idref: string, manifestItems: ManifestItemInfo[]): boolean {
  const item = manifestItems.find((candidate) => candidate.id === idref);
  if (!item) return /cover|title/i.test(idref);
  return /(^|\/)(cover|titlepage|title-page)[^/]*\.x?html?$/i.test(item.href);
}

function rebuildSpine(
  doc: Document,
  spineElement: Element,
  originalSpineRefs: SpineRefInfo[],
  originalChapterItemIds: Set<string>,
  plans: ChapterWritePlan[],
  manifestItems: ManifestItemInfo[],
): void {
  interface SpineEntry {
    oldElement?: Element;
    idref?: string;
    linear?: boolean;
  }
  const entries: SpineEntry[] = [];
  let planIndex = 0;
  let lastNewIndex = -1;
  for (const ref of originalSpineRefs) {
    if (originalChapterItemIds.has(ref.idref)) {
      if (planIndex < plans.length) {
        const plan = plans[planIndex];
        entries.push({ idref: plan.itemId, linear: plan.chapter.linear !== false });
        lastNewIndex = entries.length - 1;
        planIndex += 1;
      }
      continue;
    }
    entries.push({ oldElement: ref.element });
  }
  if (planIndex < plans.length) {
    const remaining = plans.slice(planIndex).map((plan) => ({
      idref: plan.itemId,
      linear: plan.chapter.linear !== false,
    }));
    let insertAt = lastNewIndex >= 0 ? lastNewIndex + 1 : 0;
    if (lastNewIndex < 0) {
      while (insertAt < entries.length && entries[insertAt].oldElement && isFrontMatterIdref(getAttributeValue(entries[insertAt].oldElement as Element, "idref") ?? "", manifestItems)) {
        insertAt += 1;
      }
    }
    entries.splice(insertAt, 0, ...remaining);
  }
  while (spineElement.firstChild) spineElement.removeChild(spineElement.firstChild);
  for (const entry of entries) {
    if (entry.oldElement) {
      spineElement.appendChild(entry.oldElement);
      continue;
    }
    const itemref = doc.createElementNS(OPF_NS, "itemref");
    itemref.setAttribute("idref", entry.idref ?? "");
    if (entry.linear === false) itemref.setAttribute("linear", "no");
    spineElement.appendChild(itemref);
  }
}

/* ============================================================
   writeEpub
   ============================================================ */

/**
 * 在 project.sourceBytes 上增量写回：
 * - mimetype 第一且 STORE；
 * - 其余条目按原顺序复制，只替换被编辑/新增章节、OPF、nav、NCX 与封面；
 * - 删除被删除章节的文件；
 * - 同步 OPF 元信息、manifest、spine、nav、NCX。
 */
export async function writeEpub(
  project: EpubProject,
  meta: EpubBookMeta,
  chapters: EpubChapter[],
  options?: WriteEpubOptions,
): Promise<Uint8Array> {
  if (!project) throw new Error("缺少 EPUB 工程数据");
  const safeMeta: EpubBookMeta = {
    ...meta,
    title: String(meta?.title ?? ""),
    author: String(meta?.author ?? ""),
    language: meta?.language ?? "zh-CN",
  };
  const chapterList = (Array.isArray(chapters) ? chapters : []).filter(Boolean);

  const baseBytes =
    project.sourceBytes && project.sourceBytes.byteLength > 0
      ? project.sourceBytes
      : await buildEpub(safeMeta, []);
  const { default: JSZip } = await import("jszip");
  const sourceZip = await JSZip.loadAsync(baseBytes);
  let opfPath = String(project.opfPath ?? "").trim();
  if (!opfPath || !findZipEntry(sourceZip, opfPath)) opfPath = await findOpfPath(sourceZip);
  if (!opfPath) throw new Error("找不到 OPF 包文档，无法写回");
  const opfText = await readZipText(sourceZip, opfPath);
  if (opfText === null) throw new Error("无法读取 OPF：" + opfPath);
  const opfDoc = parseXmlDocument(opfText);
  if (!opfDoc) throw new Error("OPF 不是合法的 XML，无法写回");

  const opfDir = dirname(opfPath);
  const packageElement = opfDoc.documentElement;
  packageElement.setAttribute("version", "3.0");
  ensureOpfChild(opfDoc, "metadata");
  const manifestElement = ensureOpfChild(opfDoc, "manifest");
  const spineElement = ensureOpfChild(opfDoc, "spine");

  const manifestItems = readManifestItems(opfDoc, opfDir);
  const originalSpineRefs = readSpineRefs(opfDoc);
  const originals = (Array.isArray(project.chapters) ? project.chapters : []).filter(Boolean);
  const originalByPath = new Map<string, EpubChapter>();
  for (const original of originals) {
    const path = resolveZipPath(opfDir, original.href);
    if (path) originalByPath.set(path, original);
  }
  const originalItemIdByPath = new Map<string, string>();
  for (const item of manifestItems) originalItemIdByPath.set(item.zipPath, item.id);
  const originalChapterItemIds = new Set<string>();
  for (const original of originals) {
    const id = originalItemIdByPath.get(resolveZipPath(opfDir, original.href));
    if (id) originalChapterItemIds.add(id);
  }

  const mutations: ZipMutations = { replacements: new Map(), additions: new Map(), deletions: new Set() };
  const usedItemIds = new Set(manifestItems.map((item) => item.id));
  const usedZipPaths = new Set(Object.keys(sourceZip.files).map((name) => normalizeZipPath(name)));
  const claimedOriginalPaths = new Set<string>();
  const plans: ChapterWritePlan[] = [];

  for (let index = 0; index < chapterList.length; index += 1) {
    const chapter = chapterList[index];
    const requestedHref = String(chapter.href ?? "").trim();
    const requestedZipPath = requestedHref ? resolveZipPath(opfDir, requestedHref) : "";
    let original: EpubChapter | undefined;
    if (!chapter.isNew) {
      if (requestedZipPath) original = originalByPath.get(requestedZipPath);
      if (!original) {
        original = originals.find((candidate) => {
          if (candidate.id !== chapter.id) return false;
          const path = resolveZipPath(opfDir, candidate.href);
          return path.length > 0 && !claimedOriginalPaths.has(path);
        });
      }
    }
    let oldZipPath = original ? resolveZipPath(opfDir, original.href) : "";
    if (original && (!oldZipPath || !findZipEntry(sourceZip, oldZipPath) || claimedOriginalPaths.has(oldZipPath))) {
      original = undefined;
      oldZipPath = "";
    }
    if (original) claimedOriginalPaths.add(oldZipPath);

    const title = String(chapter.title ?? "").trim() || "第 " + (index + 1) + " 章";
    let isNew = !original;
    let newHref = original?.href ?? "";
    let newZipPath = oldZipPath;
    let existingItem: ManifestItemInfo | null = original
      ? manifestItems.find((item) => item.zipPath === oldZipPath) ?? null
      : null;

    if (original) {
      if (requestedZipPath && requestedZipPath !== oldZipPath && !usedZipPaths.has(requestedZipPath)) {
        newHref = requestedHref;
        newZipPath = requestedZipPath;
        usedZipPaths.add(newZipPath);
      }
    } else {
      isNew = true;
      newHref = makeNewChapterHref(requestedHref, opfDir, sourceZip, usedZipPaths, index);
      newZipPath = resolveZipPath(opfDir, newHref);
    }

    const itemId = existingItem
      ? existingItem.id
      : uniqueElementId("chapter-extra-" + String(index + 1).padStart(3, "0"), usedItemIds);

    const originalHtml = original ? String(original.originalHtml ?? original.html ?? "") : "";
    const originalTitle = original ? String(original.originalTitle ?? original.title ?? "").trim() : "";
    const htmlChanged = !original || String(chapter.html ?? "") !== originalHtml;
    const titleChanged = !original || title !== originalTitle;
    const hrefChanged = Boolean(original) && newZipPath !== oldZipPath;
    let outputContent: string | null = null;
    if (!original || htmlChanged || titleChanged) {
      const originalText = original ? await readZipText(sourceZip, oldZipPath) : null;
      outputContent = buildChapterDocumentForWrite({
        title,
        html: String(chapter.html ?? ""),
        epubType: chapter.epubType ?? original?.epubType,
        originalText,
        chapterZipPath: newZipPath,
        manifestItems,
        sourceZip,
        meta: safeMeta,
      });
    } else if (hrefChanged) {
      outputContent = await readZipText(sourceZip, oldZipPath);
    }

    plans.push({
      chapter,
      index,
      title,
      isNew,
      oldZipPath,
      newZipPath,
      newHref,
      itemId,
      existingItem,
      outputContent,
    });
  }

  // manifest：更新已有章节、删除被删章节、新增章节
  for (const plan of plans) {
    if (plan.existingItem) {
      plan.existingItem.element.setAttribute("href", plan.newHref);
      if (!isXhtmlMediaType(plan.existingItem.mediaType, plan.existingItem.href)) {
        plan.existingItem.element.setAttribute("media-type", "application/xhtml+xml");
      }
    } else {
      manifestElement.appendChild(createManifestItem(opfDoc, plan.itemId, plan.newHref, "application/xhtml+xml", ""));
    }
  }
  const activeOriginalPaths = new Set(plans.filter((plan) => plan.oldZipPath).map((plan) => plan.oldZipPath));
  for (const original of originals) {
    const path = resolveZipPath(opfDir, original.href);
    if (!path || activeOriginalPaths.has(path)) continue;
    const item = manifestItems.find((candidate) => candidate.zipPath === path);
    if (item) {
      item.element.parentNode?.removeChild(item.element);
      usedItemIds.delete(item.id);
    }
    if (findZipEntry(sourceZip, path)) mutations.deletions.add(path);
  }
  cleanupGuideReferences(opfDoc, opfDir, mutations.deletions);

  // 章节文件
  for (const plan of plans) {
    if (plan.outputContent !== null) {
      if (plan.isNew || plan.newZipPath !== plan.oldZipPath) {
        setMutationFile(mutations, sourceZip, plan.newZipPath, plan.outputContent);
      } else {
        mutations.replacements.set(plan.newZipPath, plan.outputContent);
      }
    }
    if (plan.oldZipPath && plan.newZipPath !== plan.oldZipPath) {
      mutations.deletions.add(plan.oldZipPath);
    }
  }

  // spine：非章节项保持原位，章节按 chapters 顺序
  const currentManifestItems = readManifestItems(opfDoc, opfDir);
  rebuildSpine(opfDoc, spineElement, originalSpineRefs, originalChapterItemIds, plans, currentManifestItems);
  const ncxExists = currentManifestItems.some((item) => item.mediaType.toLowerCase() === NCX_MEDIA_TYPE);
  if (!ncxExists) spineElement.removeAttribute("toc");

  updateOpfMetadata(opfDoc, safeMeta);
  await applyCoverChange(opfDoc, safeMeta, opfDir, sourceZip, mutations, options?.cover);

  const tocEntries: TocEntry[] = plans.map((plan) => ({ zipPath: plan.newZipPath, title: plan.title }));
  await updateNavigation(opfDoc, safeMeta, opfDir, sourceZip, mutations, tocEntries);
  await updateNcx(opfDoc, safeMeta, opfDir, sourceZip, mutations, tocEntries);

  mutations.replacements.set(normalizeZipPath(opfPath), serializeXmlDocument(opfDoc));

  // 重新打包：mimetype 必须第一个写入且 STORE，其余按原顺序复制
  const outputZip = new JSZip();
  outputZip.file("mimetype", "application/epub+zip", { compression: "STORE", createFolders: false });
  const sourceNames = Object.keys(sourceZip.files).filter((name) => !sourceZip.files[name].dir);
  for (const name of sourceNames) {
    if (name === "mimetype") continue;
    const normalized = normalizeZipPath(name);
    if (mutations.deletions.has(normalized)) continue;
    const replacement = mutations.replacements.get(normalized);
    if (replacement !== undefined) {
      outputZip.file(normalized, replacement, { createFolders: false });
      continue;
    }
    const originalEntry = sourceZip.files[name];
    const bytes = await originalEntry.async("uint8array");
    const compression = (originalEntry as unknown as { options?: { compression?: string } }).options?.compression;
    outputZip.file(normalized, bytes, {
      createFolders: false,
      compression: compression === "STORE" ? "STORE" : "DEFLATE",
    });
  }
  for (const [path, data] of mutations.additions) {
    if (mutations.deletions.has(path) || mutations.replacements.has(path)) continue;
    outputZip.file(path, data, { createFolders: false });
  }
  return outputZip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    mimeType: "application/epub+zip",
  });
}
