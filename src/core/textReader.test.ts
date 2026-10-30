import { describe, expect, it } from "vitest";
import { detectAndDecode, normalizeEncoding } from "./textReader";

/** 用指定编码把文本编成字节（Node 的 TextEncoder 只支持 utf-8，其他编码手工构造）。 */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** GBK 编码的最小测试构造：只覆盖项目里用到的几个汉字。 */
const GBK_TABLE: Record<string, number[]> = {
  书: [0xca, 0xe9],
  名: [0xc3, 0xfb],
  第: [0xb5, 0xda],
  一: [0xd2, 0xbb],
  章: [0xd5, 0xc2],
  中: [0xd6, 0xd0],
  文: [0xce, 0xc4],
  "：": [0xa3, 0xba],
};

function gbk(text: string): Uint8Array {
  const out: number[] = [];
  for (const char of text) {
    const mapped = GBK_TABLE[char];
    if (mapped) out.push(...mapped);
    else if (char.charCodeAt(0) < 0x80) out.push(char.charCodeAt(0));
    else throw new Error(`GBK 测试表缺少字符：${char}`);
  }
  return new Uint8Array(out);
}

describe("normalizeEncoding", () => {
  it("把常见编码别名归一成 TextDecoder 标准标签", () => {
    expect(normalizeEncoding("utf-8")).toBe("utf-8");
    expect(normalizeEncoding("UTF-8")).toBe("utf-8");
    expect(normalizeEncoding("UTF8")).toBe("utf-8");
    expect(normalizeEncoding("GBK")).toBe("gb18030");
    expect(normalizeEncoding("gb2312")).toBe("gb18030");
    expect(normalizeEncoding("GB18030")).toBe("gb18030");
    expect(normalizeEncoding("Big5")).toBe("big5");
    expect(normalizeEncoding("Shift_JIS")).toBe("shift_jis");
    expect(normalizeEncoding("windows-1252")).toBe("windows-1252");
  });

  it("ascii 归一到 utf-8（字节级等价）", () => {
    expect(normalizeEncoding("ascii")).toBe("utf-8");
    expect(normalizeEncoding("US-ASCII")).toBe("utf-8");
  });

  it("空值 / undefined 回退 utf-8", () => {
    expect(normalizeEncoding()).toBe("utf-8");
    expect(normalizeEncoding("")).toBe("utf-8");
    expect(normalizeEncoding("   ")).toBe("utf-8");
  });

  it("未知标签回退 utf-8", () => {
    expect(normalizeEncoding("klingon-8")).toBe("utf-8");
    expect(normalizeEncoding("utf-32")).toBe("utf-8");
  });

  it("去掉标签两侧的引号", () => {
    expect(normalizeEncoding('"gbk"')).toBe("gb18030");
  });
});

describe("detectAndDecode —— BOM 优先", () => {
  it("UTF-8 BOM 被识别并剔除", () => {
    const body = utf8("第1章 开始");
    const bytes = new Uint8Array(body.length + 3);
    bytes.set([0xef, 0xbb, 0xbf], 0);
    bytes.set(body, 3);

    const result = detectAndDecode(bytes);
    expect(result.detectedEncoding).toBe("utf-8");
    expect(result.usedEncoding).toBe("utf-8");
    expect(result.confidence).toBe(1);
    expect(result.text).toBe("第1章 开始");
    expect(result.text.charCodeAt(0)).not.toBe(0xfeff);
    expect(result.byteLength).toBe(bytes.byteLength);
  });

  it("UTF-16LE BOM 被识别，正文正确还原", () => {
    const text = "第1章 开始";
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes.set([0xff, 0xfe], 0);
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      bytes[2 + i * 2] = code & 0xff;
      bytes[2 + i * 2 + 1] = code >> 8;
    }

    const result = detectAndDecode(bytes);
    expect(result.detectedEncoding).toBe("utf-16le");
    expect(result.usedEncoding).toBe("utf-16le");
    expect(result.text).toBe(text);
  });

  it("UTF-16BE BOM 被识别", () => {
    const text = "第一章";
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes.set([0xfe, 0xff], 0);
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      bytes[2 + i * 2] = code >> 8;
      bytes[2 + i * 2 + 1] = code & 0xff;
    }

    const result = detectAndDecode(bytes);
    expect(result.detectedEncoding).toBe("utf-16be");
    expect(result.text).toBe(text);
  });
});

describe("detectAndDecode —— 无 BOM 判定", () => {
  it("纯 ASCII 判定为 utf-8", () => {
    const result = detectAndDecode(utf8("Chapter 1 Start"));
    expect(result.detectedEncoding).toBe("utf-8");
    expect(result.text).toBe("Chapter 1 Start");
    expect(result.confidence).toBe(1);
  });

  it("合法 UTF-8 中文判定为 utf-8", () => {
    const result = detectAndDecode(utf8("　　“你好，世界！”　　"));
    expect(result.detectedEncoding).toBe("utf-8");
    expect(result.usedEncoding).toBe("utf-8");
    expect(result.text).toBe("　　“你好，世界！”　　");
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("非法 UTF-8 且非 ASCII 时按候选编码评分（GBK 文本识别为 gb18030）", () => {
    const text = "书名：第一中文章：";
    const result = detectAndDecode(gbk(text.repeat(40)));
    expect(result.usedEncoding).toBe("gb18030");
    expect(result.text).toContain("书名：");
    expect(result.text).toContain("第一中文章：");
    // 不应出现 UTF-8 解码失败的替换字符
    expect(result.text).not.toContain("\ufffd");
  });

  it("空字节流回退 utf-8，text 为空串", () => {
    const result = detectAndDecode(new Uint8Array(0));
    expect(result.detectedEncoding).toBe("utf-8");
    expect(result.usedEncoding).toBe("utf-8");
    expect(result.text).toBe("");
    expect(result.byteLength).toBe(0);
  });

  it("Big5 文本自动识别并用 big5 解码", () => {
    // 「書名：測試小說 / 第一章 開始 / 這是一個關於江湖的故事…」的 Big5 字节
    const bytes = new Uint8Array([
      0xae, 0xd1, 0xa6, 0x57, 0xa1, 0x47, 0xb4, 0xfa, 0xb8, 0xd5, 0xa4, 0x70, 0xbb, 0xa1, 0x0a,
      0xb2, 0xc4, 0xa4, 0x40, 0xb3, 0xb9, 0x20, 0xb6, 0x7d, 0xa9, 0x6c, 0x0a, 0xb3, 0x6f, 0xac,
      0x4f, 0xa4, 0x40, 0xad, 0xd3, 0xc3, 0xf6, 0xa9, 0xf3, 0xa6, 0xbf, 0xb4, 0xf2, 0xaa, 0xba,
      0xac, 0x47, 0xa8, 0xc6, 0xa1, 0x41, 0xa4, 0xd6, 0xa6, 0x7e, 0xa6, 0x62, 0xb6, 0xc3, 0xa5,
      0x40, 0xa4, 0xa4, 0xa6, 0xa8, 0xaa, 0xf8, 0xa1, 0x41, 0xb3, 0xcc, 0xb2, 0xd7, 0xa6, 0xa8,
      0xac, 0xb0, 0xa4, 0x40, 0xa5, 0x4e, 0xa4, 0x6a, 0xab, 0x4c, 0xa1, 0x43,
    ]);
    const result = detectAndDecode(bytes);
    expect(result.usedEncoding).toBe("big5");
    expect(result.detectedEncoding).toBe("big5");
    expect(result.text).toContain("書名：測試小說");
    expect(result.text).toContain("這是一個關於江湖的故事");
    expect(result.text).not.toContain("\ufffd");
  });

  it("Shift_JIS 文本自动识别并用 shift_jis 解码", () => {
    // 「第1章 始まり / これは日本語の小説のテストです。東京へ行きます。」的 Shift_JIS 字节
    const bytes = new Uint8Array([
      0x91, 0xe6, 0x31, 0x8f, 0xcd, 0x20, 0x8e, 0x6e, 0x82, 0xdc, 0x82, 0xe8, 0x0a, 0x82, 0xb1,
      0x82, 0xea, 0x82, 0xcd, 0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x82, 0xcc, 0x8f, 0xac, 0x90,
      0xe0, 0x82, 0xcc, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x82, 0xc5, 0x82, 0xb7, 0x81, 0x42,
      0x93, 0x8c, 0x8b, 0x9e, 0x82, 0xd6, 0x8d, 0x73, 0x82, 0xab, 0x82, 0xdc, 0x82, 0xb7, 0x81,
      0x42,
    ]);
    const result = detectAndDecode(bytes);
    expect(result.usedEncoding).toBe("shift_jis");
    expect(result.detectedEncoding).toBe("shift_jis");
    expect(result.text).toContain("これは日本語の小説のテストです");
    expect(result.text).toContain("東京へ行きます");
    expect(result.text).not.toContain("\ufffd");
  });
});

describe("detectAndDecode —— 手动指定编码", () => {
  it("显式指定 gb18030 时按该编码解码，usedEncoding 如实反映", () => {
    const bytes = gbk("书名：第一中文章：".repeat(20));
    const result = detectAndDecode(bytes, "gb18030");
    expect(result.usedEncoding).toBe("gb18030");
    expect(result.text).toContain("书名：");
  });

  it("显式指定 utf-8 解 GBK 字节时如实返回 utf-8（不悄悄改成检测值）", () => {
    const bytes = gbk("书名：第一中文章：".repeat(20));
    const result = detectAndDecode(bytes, "utf-8");
    expect(result.usedEncoding).toBe("utf-8");
    expect(result.text).toContain("\ufffd");
    // detectedEncoding 仍保留检测结果，供 UI 提示「检测到 X / 实际使用 Y」
    expect(result.detectedEncoding).not.toBe("utf-8");
  });

  it("显式 UTF-8 解码 UTF-8 文本", () => {
    const result = detectAndDecode(utf8("第1章"), "utf-8");
    expect(result.usedEncoding).toBe("utf-8");
    expect(result.text).toBe("第1章");
  });

  it('encoding="auto" 等价于不传', () => {
    const bytes = utf8("第1章 开始");
    expect(detectAndDecode(bytes, "auto").text).toBe(detectAndDecode(bytes).text);
    expect(detectAndDecode(bytes, "auto").usedEncoding).toBe("utf-8");
  });

  it("手动指定编码时也一并给出检测结果与原始标签", () => {
    const bytes = gbk("第一中文章：".repeat(30));
    const result = detectAndDecode(bytes, "gb18030");
    expect(result.detectedEncoding).toBeTruthy();
    expect(result.detectedRaw).toBeTruthy();
    expect(result.byteLength).toBe(bytes.byteLength);
  });
});

describe("detectAndDecode —— 健壮性", () => {
  it("处理输入中的 BOM 之外的控制字符而不抛错", () => {
    const bytes = utf8("第1章\u0000\u0001正文");
    const result = detectAndDecode(bytes);
    expect(result.text).toContain("第1章");
  });

  it("CRLF 与全角空格原样保留（由 preprocess 处理）", () => {
    const raw = "\u3000\u3000第1章\r\n\u3000\u3000正文\r\n";
    const result = detectAndDecode(utf8(raw));
    expect(result.text).toBe(raw);
  });

  it("极短非 ASCII 输入不抛错", () => {
    expect(() => detectAndDecode(new Uint8Array([0xa1, 0xba]))).not.toThrow();
  });

  it("接收 Node Buffer（Uint8Array 子类）", () => {
    const buffer = Buffer.from("第1章 开始", "utf8");
    const result = detectAndDecode(buffer);
    expect(result.text).toBe("第1章 开始");
  });
});
