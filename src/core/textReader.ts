/**
 * 编码检测与解码。
 *
 * 策略（按优先级）：
 * 1. BOM 优先：EF BB BF → utf-8；FF FE → utf-16le；FE FF → utf-16be。
 * 2. 严格 UTF-8 校验：整篇能用 `TextDecoder("utf-8", { fatal: true })` 解出且含非 ASCII 字节 → utf-8。
 * 3. 纯 ASCII → utf-8。
 * 4. UTF-16 无 BOM 的 NUL 分布粗判。
 * 5. 其余按 GB18030 / Big5 / Shift_JIS 三个候选做字节结构与常用汉字频率评分，
 *    取最高分；全部不像文本时回退 utf-8。
 *
 * 这里刻意不依赖第三方字符集识别库：应用只需要覆盖中日文常见的这几种编码，
 * 自带评分器只有几 KB，而完整的识别库会带来约 1MB 的模型数据。
 *
 * 无论 `encoding` 是否为 "auto"，都会先算出「检测结果」写进 detectedEncoding / detectedRaw，
 * 这样 UI 才能在用户手动指定编码时同时展示「检测到 X / 实际使用 Y」。
 * 真正用于解码的编码写在 usedEncoding 里，失败回退时它也会如实反映。
 */

import type { EncodingChoice, ReadResult } from "../types";

/** detectAndDecode 的选项形式（契约要求导出，便于 UI 做类型标注）。 */
export interface DecodeOptions {
  encoding?: EncodingChoice;
}

/** 编码标签 → WHATWG/TextDecoder 标准标签。 */
const ENCODING_ALIASES: Record<string, string> = {
  // Unicode
  utf8: "utf-8",
  "utf-8": "utf-8",
  utf_8: "utf-8",
  unicode: "utf-16le",
  "utf-16": "utf-16le",
  "utf-16le": "utf-16le",
  "utf-16be": "utf-16be",
  ucs2: "utf-16le",
  "ucs-2": "utf-16le",
  // 纯 ASCII（字节级与 UTF-8 等价）
  ascii: "utf-8",
  "us-ascii": "utf-8",
  "ansi_x3.4-1968": "utf-8",
  // 简体中文
  gbk: "gb18030",
  gb2312: "gb18030",
  gb18030: "gb18030",
  "gb_2312-80": "gb18030",
  "x-gbk": "gb18030",
  cp936: "gb18030",
  "windows-936": "gb18030",
  hz: "hz-gb-2312",
  "hz-gb-2312": "hz-gb-2312",
  // 繁体中文
  big5: "big5",
  "big-5": "big5",
  "big5-hkscs": "big5",
  "x-x-big5": "big5",
  "cn-big5": "big5",
  cp950: "big5",
  // 日文
  shift_jis: "shift_jis",
  "shift-jis": "shift_jis",
  sjis: "shift_jis",
  "x-sjis": "shift_jis",
  ms_kanji: "shift_jis",
  "windows-31j": "shift_jis",
  cp932: "shift_jis",
  "euc-jp": "euc-jp",
  "iso-2022-jp": "iso-2022-jp",
  // 韩文
  "euc-kr": "euc-kr",
  cp949: "euc-kr",
  // 西欧
  "iso-8859-1": "windows-1252",
  latin1: "windows-1252",
  "latin-1": "windows-1252",
  "windows-1252": "windows-1252",
  cp1252: "windows-1252",
  // 俄文
  "windows-1251": "windows-1251",
  "koi8-r": "koi8-r",
};

/** 无法识别时的兜底编码（契约要求）。 */
const FALLBACK_ENCODING = "utf-8";

/**
 * 用于给候选编码打分的常用汉字集合（简体 + 繁体常见字）。
 * 长度约 500，压缩后不到 1KB；只需覆盖小说文本的高频字即可拉开错误编码的差距。
 */
const COMMON_CJK = new Set(
  "的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间知世什两次使身者被高已亲其进此话常与活正感见明问力理点文几定本公特做外孩相西果走将月十实向声车全信重三机工物气每并别真打太新比才便夫再书部水像眼等体却加电主界门利海受听表德少克代员许先口由死安写性马光白或住难望教命花结乐色更拉东神记处让母父应直字场平报友关放至张认接告入笑内英军候民岁往何度山觉路带万男边风解叫任金快原吃妈变通师立象数四失满战远格士音轻目条呢病始达深完今提求清王化空业思切怎非找片罗钱吗语元喜曾离飞科言干流欢约各即指合反题必该论交终林请医晚制球决传画保读运及则房早院量苦火布品近坐产答星精视五连司巴" +
    "的一是了我不人在他有這個上們來到時大地為子中你說生國年著就那和要她出也得裡後自以會家可下而過天去能對小多然於心學麼之都好看起發當沒成只如事把還用第樣道想作種開美總從無情己面最女但現前些所同日手又行意動方期它頭經長兒回位分愛老因很給名法間知世什兩次使身者被高已親其進此話常與活正感見明問力理點文幾定本公特做外孩相西果走將月十實向聲車全信重三機工物氣每並別真打太新比才便夫再書部水像眼等體卻加電主界門利海受聽表德少克代員許先口由死安寫性馬光白或住難望教命花結樂色更拉東神記處讓母父應直字場平報友關放至張認接告入笑內英軍候民歲往何度山覺路帶萬男邊風解叫任金快原吃媽變通師立象數四失滿戰遠格士音輕目條呢病始達深完今提求清王化空業思切怎非找片羅錢嗎語元喜曾離飛科言乾流歡約各即指合反題必該論交終林請醫晚制球決傳畫保讀運及則房早院量苦火布品近坐產答星精視五連司巴",
);

const LEGACY_CANDIDATES = ["gb18030", "big5", "shift_jis"] as const;
type LegacyEncoding = (typeof LEGACY_CANDIDATES)[number];

const DETECTION_SAMPLE = 64 * 1024;

/** TextDecoder 是否支持该标签（大小写不敏感）。 */
function isSupportedEncoding(label: string): boolean {
  try {
    // 只为探测合法性，不解码任何数据
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把任意编码标签归一成 TextDecoder 认识的标准标签。
 * 无法识别、空值或不被运行时支持时返回 "utf-8"。
 */
export function normalizeEncoding(label?: string): string {
  if (typeof label !== "string") return FALLBACK_ENCODING;
  const trimmed = label.trim().toLowerCase();
  if (!trimmed) return FALLBACK_ENCODING;
  // 去掉偶尔带上的引号
  const key = trimmed.replace(/^["']|["']$/g, "");

  const mapped = ENCODING_ALIASES[key];
  if (mapped) {
    return isSupportedEncoding(mapped) ? mapped : FALLBACK_ENCODING;
  }
  if (isSupportedEncoding(key)) return key;
  return FALLBACK_ENCODING;
}

/** BOM 检测结果。 */
type BomInfo = { encoding: string; length: number };

/** 读取前若干字节判断 BOM。 */
function detectBom(bytes: Uint8Array): BomInfo | null {
  if (bytes.length >= 4) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00) {
      // UTF-32LE：TextDecoder 不支持，按 UTF-16LE 尽力解（避免整篇乱码）
      return { encoding: "utf-16le", length: 4 };
    }
    if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff) {
      return { encoding: "utf-16be", length: 4 };
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: "utf-8", length: 3 };
  }
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: "utf-16le", length: 2 };
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: "utf-16be", length: 2 };
  }
  return null;
}

/** 是否含非 ASCII 字节（含非 ASCII 才需要真正判定编码）。 */
function hasNonAscii(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] > 0x7f) return true;
  }
  return false;
}

/**
 * 整篇是否合法 UTF-8。
 * 按 256KB 分块流式校验，避免 100MB 文件在检测阶段先生成一整条超大字符串。
 */
function isValidUtf8(bytes: Uint8Array): boolean {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const CHUNK = 256 * 1024;
  try {
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      const end = Math.min(bytes.length, offset + CHUNK);
      decoder.decode(bytes.subarray(offset, end), { stream: end < bytes.length });
    }
    return true;
  } catch {
    return false;
  }
}

/** utf-16 没有 BOM 时，用 NUL 字节分布粗判字节序。 */
function guessUtf16WithoutBom(bytes: Uint8Array): string | null {
  const sample = Math.min(bytes.length, 4096);
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < sample; i += 1) {
    if (bytes[i] !== 0x00) continue;
    if (i % 2 === 0) evenZeros += 1;
    else oddZeros += 1;
  }
  const pairs = Math.max(1, Math.floor(sample / 2));
  if (evenZeros / pairs > 0.3 && oddZeros === 0) return "utf-16be";
  if (oddZeros / pairs > 0.3 && evenZeros === 0) return "utf-16le";
  return null;
}

/** 解码后的文本去掉开头残留的 BOM / 零宽字符。 */
function stripLeadingInvisibles(text: string): string {
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0xfeff || code === 0x200b || code === 0x200c || code === 0x200d || code === 0x2060) {
      index += 1;
      continue;
    }
    break;
  }
  return index === 0 ? text : text.slice(index);
}

/** 用指定编码解码；编码不被支持时退回 utf-8，并返回真实使用的标签。 */
function decodeBytes(bytes: Uint8Array, encoding: string): { text: string; used: string } {
  const label = isSupportedEncoding(encoding) ? encoding : FALLBACK_ENCODING;
  try {
    const text = new TextDecoder(label, { fatal: false }).decode(bytes);
    return { text: stripLeadingInvisibles(text), used: label };
  } catch {
    const text = new TextDecoder(FALLBACK_ENCODING, { fatal: false }).decode(bytes);
    return { text: stripLeadingInvisibles(text), used: FALLBACK_ENCODING };
  }
}

interface DetectionOutcome {
  encoding: string;
  raw?: string;
  confidence?: number;
}

interface TextScore {
  cjk: number;
  common: number;
  kana: number;
  bad: number;
  length: number;
}

function scoreDecodedText(text: string): TextScore {
  let cjk = 0;
  let common = 0;
  let kana = 0;
  let bad = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp === 0xfffd || (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d)) {
      bad += 1;
    } else if (cp >= 0x4e00 && cp <= 0x9fff) {
      cjk += 1;
      if (COMMON_CJK.has(char)) common += 1;
    } else if (cp >= 0x3040 && cp <= 0x30ff) {
      kana += 1;
    }
  }
  return { cjk, common, kana, bad, length: text.length };
}

/** 字节层面的结构提示：GB18030 高频使用 0xE0 以上首字节，Big5 常用 0x40-0x7E 尾字节，Shift_JIS 大量 0x82/0x83 假名首字节。 */
function byteHints(sample: Uint8Array): { highLead: number; big5AsciiTrail: number; sjisKanaLead: number } {
  let pairs = 0;
  let highLead = 0;
  let big5AsciiTrail = 0;
  let sjisKanaLead = 0;
  for (let i = 0; i < sample.length - 1; i += 1) {
    const lead = sample[i];
    if (lead < 0x80) continue;
    const trail = sample[i + 1];
    pairs += 1;
    if (lead >= 0xe0) highLead += 1;
    if (lead >= 0xa4 && lead <= 0xc6 && trail >= 0x40 && trail <= 0x7e) big5AsciiTrail += 1;
    if (lead === 0x82 || lead === 0x83) sjisKanaLead += 1;
    i += 1;
  }
  const ratio = (value: number) => (pairs ? value / pairs : 0);
  return { highLead: ratio(highLead), big5AsciiTrail: ratio(big5AsciiTrail), sjisKanaLead: ratio(sjisKanaLead) };
}

/** 严格解码；采样边界可能截断一个多字节字符，最多回退 4 个字节重试。 */
function decodeSample(label: string, sample: Uint8Array): { text: string; strict: boolean } {
  for (let trim = 0; trim <= 4; trim += 1) {
    const view = trim === 0 ? sample : sample.subarray(0, Math.max(0, sample.length - trim));
    try {
      return { text: new TextDecoder(label, { fatal: true }).decode(view), strict: true };
    } catch {
      // 继续尝试裁掉尾部残字
    }
  }
  return { text: new TextDecoder(label, { fatal: false }).decode(sample), strict: false };
}

/** 在 GB18030 / Big5 / Shift_JIS 中选出最像文本的编码。 */
function detectLegacyEncoding(bytes: Uint8Array): { encoding: LegacyEncoding; confidence: number } | null {
  const sample = bytes.subarray(0, Math.min(bytes.length, DETECTION_SAMPLE));
  const hints = byteHints(sample);
  const scored = LEGACY_CANDIDATES.map((label) => {
    const { text, strict } = decodeSample(label, sample);
    const score = scoreDecodedText(text);
    const commonRatio = score.cjk ? score.common / score.cjk : 0;
    const kanaRatio = score.length ? score.kana / score.length : 0;
    const badRatio = score.length ? score.bad / score.length : 0;

    let value = (strict ? 1 : -0.75) + commonRatio * 2 - badRatio * 4;
    if (label === "gb18030") value += Math.min(0.6, hints.highLead * 2);
    else if (label === "big5") value += Math.min(0.6, hints.big5AsciiTrail * 2);
    else if (strict && kanaRatio > 0.05) value += 2 + Math.min(1, kanaRatio * 2) + Math.min(0.6, hints.sjisKanaLead * 2);
    else value += Math.min(0.6, hints.sjisKanaLead * 2);

    return { label, value, commonRatio };
  }).sort((a, b) => b.value - a.value);

  const best = scored[0];
  if (!best || best.value < -0.1) return null;

  const margin = best.value - (scored[1]?.value ?? -1);
  const confidence = Math.max(0.5, Math.min(0.95, 0.5 + margin * 0.12 + best.commonRatio * 0.2));
  return { encoding: best.label, confidence };
}

const DETECTED_LABELS: Record<LegacyEncoding, string> = {
  gb18030: "GB18030",
  big5: "Big5",
  shift_jis: "Shift_JIS",
};

/**
 * 计算「检测结果」——不参与用户手动指定编码的决策，仅用于展示。
 */
function detectEncoding(bytes: Uint8Array): DetectionOutcome {
  if (bytes.length === 0) {
    return { encoding: FALLBACK_ENCODING, confidence: 1 };
  }

  const bom = detectBom(bytes);
  if (bom) {
    // BOM 是确定性信号，不再采样统计
    return { encoding: bom.encoding, raw: bom.encoding.toUpperCase(), confidence: 1 };
  }

  if (!hasNonAscii(bytes)) {
    // 纯 ASCII 字节序列同时也是合法 UTF-8
    return { encoding: FALLBACK_ENCODING, raw: "ascii", confidence: 1 };
  }

  if (isValidUtf8(bytes)) {
    return { encoding: FALLBACK_ENCODING, raw: "utf-8", confidence: 0.99 };
  }

  const guessedUtf16 = guessUtf16WithoutBom(bytes);
  if (guessedUtf16) {
    return { encoding: guessedUtf16, raw: guessedUtf16, confidence: 0.8 };
  }

  const legacy = detectLegacyEncoding(bytes);
  if (!legacy) return { encoding: FALLBACK_ENCODING };
  return {
    encoding: legacy.encoding,
    raw: DETECTED_LABELS[legacy.encoding],
    confidence: legacy.confidence,
  };
}

/**
 * 检测并解码字节流。
 *
 * @param bytes   文件原始字节（Uint8Array / Node Buffer 均可）
 * @param encoding "auto" 或不传时使用检测结果；其余值强制指定编码
 */
export function detectAndDecode(bytes: Uint8Array, encoding?: EncodingChoice): ReadResult {
  const data = bytes ?? new Uint8Array(0);
  const detection = detectEncoding(data);

  const explicit = encoding && encoding !== "auto" ? normalizeEncoding(encoding) : null;
  const requested = explicit ?? detection.encoding;

  const bom = detectBom(data);
  // 用户手动指定编码时以其为准；但 UTF-16 系列的 BOM 也要从字节里去掉，
  // 否则解出来的文本开头会残留 U+FEFF（TextDecoder 会自动吃掉，这里作为冗余保护）。
  const payload = bom && bom.encoding === requested ? data.subarray(bom.length) : data;

  const { text, used } = decodeBytes(payload, requested);

  return {
    text,
    detectedEncoding: detection.encoding,
    ...(detection.raw ? { detectedRaw: detection.raw } : {}),
    usedEncoding: used,
    byteLength: data.byteLength,
    ...(detection.confidence !== undefined ? { confidence: detection.confidence } : {}),
  };
}
