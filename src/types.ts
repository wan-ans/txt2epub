/**
 * 墨匣 (Inkbox) —— 全项目共享的类型契约。
 * 任何模块改动公共类型都必须先改这里，并在 docs/CONTRACT.md 同步。
 */

export type Language = "zh-CN" | "zh-TW" | "en";

/** 编码选项："auto" 表示自动检测；其余为 TextDecoder 标准标签。 */
export type EncodingChoice =
  | "auto"
  | "utf-8"
  | "gb18030"
  | "big5"
  | "shift_jis"
  | "utf-16le"
  | "utf-16be";

export interface BookMeta {
  title: string;
  author: string;
  language: Language;
  publisher?: string;
  description?: string;
  tags?: string[];
}

export interface Chapter {
  id: string;
  title: string;
  /** 章节正文，已按行切分；保留空字符串行用于控制空行。 */
  lines: string[];
  /** 文件开头、首个章节标记之前的内容。 */
  isIntro?: boolean;
  /** 解析时的原始标题，用于判断用户是否改过标题。 */
  originalTitle?: string;
  /** 用户是否手动改过正文（删减文字）。重新解析会丢弃这类改动，需要提示。 */
  bodyEdited?: boolean;
}

export interface ReadResult {
  text: string;
  /** 检测到的编码（未做别名归一化前的原始标签也放在 detectedRaw）。 */
  detectedEncoding: string;
  detectedRaw?: string;
  /** 实际用于解码的编码。 */
  usedEncoding: string;
  byteLength: number;
  /** 检测置信度 0-1，无法给出时为 undefined。 */
  confidence?: number;
}

export interface Cover {
  data: ArrayBuffer;
  mimeType: string;
  fileName: string;
}

/** 段落排版选项，最终写进 EPUB 的样式表。 */
export interface TypesettingOptions {
  /** 段首缩进两个汉字宽。 */
  indent: boolean;
  /** 行高倍数。 */
  lineHeight: number;
  /** 正文基础字号（em 前的数字，如 1 = 100%）。 */
  fontSize: number;
  /** 段间是否额外留白。 */
  paragraphSpacing: boolean;
}

export interface BuildEpubOptions {
  cover?: Cover | null;
  typesetting?: Partial<TypesettingOptions>;
  /** 除 EPUB3 nav 之外再生成 NCX，兼容老阅读器。 */
  includeNcx?: boolean;
}

/** 单个 TXT 文件的转换结果（批量转换与单文件转换共用）。 */
export interface ConvertResult {
  sourceName: string;
  outputName: string;
  byteLength: number;
  chapterCount: number;
  wordCount: number;
  bytes: Uint8Array;
}

/* ============================================================
   EPUB 编辑（把已有 EPUB 读进墨匣做二次编辑）
   ============================================================ */

/** EPUB 编辑用的书籍元信息：在 TXT 转换字段之外保留副标题、出版日期与标识符。 */
export interface EpubBookMeta extends BookMeta {
  /** 副标题（EPUB 的 title-type=subtitle 细化字段；没有则为空）。 */
  subtitle?: string;
  /** 出版日期原文（dc:date）。 */
  publishedAt?: string;
  /** 原书 dc:identifier；写回时原样保留，不随编辑变化。 */
  identifier?: string;
}

/** EPUB 中的一章（对应 spine 里的一份可编辑 XHTML 文档）。 */
export interface EpubChapter {
  /** UI 稳定 id：已有章节由 href 派生，新章节使用随机 id。 */
  id: string;
  /** 相对 OPF 目录的 XHTML 路径，如 "Text/chapter1.xhtml"。 */
  href: string;
  title: string;
  originalTitle: string;
  /** 正文 HTML 片段（body 内部，已按编辑器能力清洗）。 */
  html: string;
  originalHtml: string;
  /** 是否是 spine 中 linear="yes" 的章节（新章节恒为 true）。 */
  linear?: boolean;
  /** epub:type，例如 chapter / preface / afterword。 */
  epubType?: string;
  /** 新建、尚未写入 OPF 的章节。 */
  isNew?: boolean;
}

/** 一本已经读入的 EPUB 工程；导出时在原始 zip 上做增量修改，最大限度保留原书资源。 */
export interface EpubProject {
  /** 原始 EPUB 字节；新建空白书时是本程序生成的初始 EPUB。 */
  sourceBytes: Uint8Array | null;
  sourceName: string;
  /** OPF 路径（相对 zip 根），例如 "OEBPS/content.opf"。 */
  opfPath: string;
  /** OPF 所在目录，例如 "OEBPS"。 */
  opfDir: string;
  meta: EpubBookMeta;
  chapters: EpubChapter[];
  cover: Cover | null;
  byteLength: number;
  /** 正文之外的资源数量（图片 / 字体 / CSS / 音频等），用于界面展示。 */
  resourceCount: number;
}

export interface WriteEpubOptions {
  /** undefined = 保持原封面；null = 移除封面；对象 = 替换或新增封面。 */
  cover?: Cover | null;
}

