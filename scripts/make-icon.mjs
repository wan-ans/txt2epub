#!/usr/bin/env node
/**
 * 墨匣 · 图标生成器（纯 Node，零第三方依赖）
 *
 * 产出：
 *   build/icon.ico  —— 16 / 32 / 48 / 64 / 128（32 位 BMP 条目）+ 256（PNG 条目）
 *   build/icon.png  —— 512×512 RGBA PNG，供 Linux / 通用场景使用
 *
 * 视觉：深墨色圆角底（#2A241C → #14110D 渐变）+ 朱砂色（#C0392B）书本与书脊，
 * 书脊用更深的朱砂（#8C2318）拉开层次，纸色横线暗示书页。深色与浅色桌面上都能辨识。
 *
 * PNG / ICO 的编码与光栅化全部手写，只用 node:zlib 与 node:fs。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(rootDir, 'build');

// ---------------------------------------------------------------------------
// 颜色
// ---------------------------------------------------------------------------
const hex = (value) => {
  const s = value.replace('#', '');
  return {
    r: parseInt(s.slice(0, 2), 16) / 255,
    g: parseInt(s.slice(2, 4), 16) / 255,
    b: parseInt(s.slice(4, 6), 16) / 255,
  };
};

const COLOR = {
  inkTop: hex('#2A241C'),
  inkBottom: hex('#14110D'),
  rim: hex('#4A4238'),
  cinnabar: hex('#C0392B'),
  cinnabarDeep: hex('#8C2318'),
  paper: hex('#F3ECE0'),
};

// ---------------------------------------------------------------------------
// 极简光栅画布（直通 alpha，float 0..1）
// ---------------------------------------------------------------------------
function createCanvas(size) {
  return { size, data: new Float32Array(size * size * 4) };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 圆角矩形有符号距离场（归一化坐标）。 */
function sdRoundRect(px, py, x0, y0, x1, y1, radius) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hw = (x1 - x0) / 2;
  const hh = (y1 - y0) / 2;
  const r = Math.min(radius, hw, hh);
  const dx = Math.abs(px - cx) - (hw - r);
  const dy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

/** 有符号距离场 → 1px 抗锯齿覆盖率。 */
function coverageFromSdf(sdf, size) {
  return clamp01(0.5 - sdf * size);
}

/** 直通 alpha 的 source-over 合成。 */
function composite(canvas, x, y, sr, sg, sb, sa) {
  if (sa <= 0) return;
  const i = (y * canvas.size + x) * 4;
  const d = canvas.data;
  const da = d[i + 3];
  const outA = sa + da * (1 - sa);
  if (outA <= 0) {
    d[i] = 0;
    d[i + 1] = 0;
    d[i + 2] = 0;
    d[i + 3] = 0;
    return;
  }
  d[i] = (sr * sa + d[i] * da * (1 - sa)) / outA;
  d[i + 1] = (sg * sa + d[i + 1] * da * (1 - sa)) / outA;
  d[i + 2] = (sb * sa + d[i + 2] * da * (1 - sa)) / outA;
  d[i + 3] = outA;
}

/** 只遍历形状包围盒内的像素，快且够用。 */
function forEachPixelIn(canvas, x0, y0, x1, y1, fn) {
  const size = canvas.size;
  const px0 = Math.max(0, Math.floor(clamp01(x0) * size) - 2);
  const py0 = Math.max(0, Math.floor(clamp01(y0) * size) - 2);
  const px1 = Math.min(size - 1, Math.ceil(clamp01(x1) * size) + 2);
  const py1 = Math.min(size - 1, Math.ceil(clamp01(y1) * size) + 2);
  for (let y = py0; y <= py1; y++) {
    for (let x = px0; x <= px1; x++) {
      fn(x, y, (x + 0.5) / size, (y + 0.5) / size);
    }
  }
}

function fillRoundRect(canvas, rect, color, alpha = 1) {
  const { x0, y0, x1, y1, radius } = rect;
  forEachPixelIn(canvas, x0, y0, x1, y1, (x, y, u, v) => {
    const cov = coverageFromSdf(sdRoundRect(u, v, x0, y0, x1, y1, radius), canvas.size);
    if (cov <= 0) return;
    composite(canvas, x, y, color.r, color.g, color.b, cov * alpha);
  });
}

/** 用距离场画一圈描边。 */
function strokeRoundRect(canvas, rect, color, widthNorm, alpha = 1) {
  const { x0, y0, x1, y1, radius } = rect;
  const half = widthNorm / 2;
  forEachPixelIn(canvas, x0, y0, x1, y1, (x, y, u, v) => {
    const d = sdRoundRect(u, v, x0, y0, x1, y1, radius);
    const cov = clamp01(0.5 - (Math.abs(d) - half) * canvas.size);
    if (cov <= 0) return;
    composite(canvas, x, y, color.r, color.g, color.b, cov * alpha);
  });
}


// ---------------------------------------------------------------------------
// 图形：深墨圆角底 + 朱砂书本
// ---------------------------------------------------------------------------
const BG_RECT = { x0: 0.02, y0: 0.02, x1: 0.98, y1: 0.98, radius: 0.225 };
const BOOK_RECT = { x0: 0.285, y0: 0.235, x1: 0.695, y1: 0.775, radius: 0.048 };
const SPINE_RECT = { x0: 0.285, y0: 0.235, x1: 0.377, y1: 0.775, radius: 0.048 };
/** 书口（露出的纸页断面），让「封面 + 书脊」读起来像一本书而不是卡片。 */
const PAGES_RECT = { x0: 0.662, y0: 0.262, x1: 0.733, y1: 0.748, radius: 0.03 };

function renderIcon(size) {
  const canvas = createCanvas(size);
  const s = canvas.size;
  const large = size >= 48;

  // 1) 圆角底：墨色竖向渐变（近黑，深色桌面上靠内描边区分边界）
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const u = (x + 0.5) / s;
      const v = (y + 0.5) / s;
      const cov = coverageFromSdf(sdRoundRect(u, v, BG_RECT.x0, BG_RECT.y0, BG_RECT.x1, BG_RECT.y1, BG_RECT.radius), s);
      if (cov <= 0) continue;
      const t = clamp01((v - BG_RECT.y0) / (BG_RECT.y1 - BG_RECT.y0));
      const k = t * t * (3 - 2 * t) * 0.7 + t * 0.3;
      composited(canvas, x, y, COLOR.inkTop, COLOR.inkBottom, k, cov);
    }
  }

  // 2) 内描边：让深色桌面上也有可辨识的轮廓
  strokeRoundRect(canvas, BG_RECT, COLOR.rim, large ? 0.011 : 0.02, 0.5);

  // 3) 书口：封面下方先垫一层纸页断面，露出书本的厚度
  fillRoundRect(canvas, PAGES_RECT, COLOR.paper, 0.95);

  // 4) 封面主体（朱砂）
  fillRoundRect(canvas, BOOK_RECT, COLOR.cinnabar, 1);

  // 5) 书脊：更深的朱砂，左缘与封面圆角对齐
  fillRoundRect(canvas, SPINE_RECT, COLOR.cinnabarDeep, 1);

  // 6) 书脊压印：两道浅色横杠（大尺寸才有，小尺寸会糊）
  if (large) {
    for (const ly of [0.315, 0.665]) {
      fillRoundRect(
        canvas,
        { x0: 0.303, y0: ly, x1: 0.359, y1: ly + 0.024, radius: 0.012 },
        COLOR.paper,
        0.45,
      );
    }
  }

  // 7) 封面题签 + 书名线（纸色）：16px 只留三条粗线，缩放后仍可辨认
  const lineX0 = 0.408;
  const lineX1 = 0.632;
  const lineH = large ? 0.036 : 0.058;
  const lines = large ? [0.325, 0.44, 0.555] : [0.36, 0.52];
  for (const ly of lines) {
    fillRoundRect(
      canvas,
      { x0: lineX0, y0: ly, x1: lineX1, y1: ly + lineH, radius: lineH / 2 },
      COLOR.paper,
      1,
    );
  }

  // 8) 封面题签框：大尺寸下给书名线一个印记式的框
  if (size >= 128) {
    strokeRoundRect(
      canvas,
      { x0: 0.39, y0: 0.294, x1: 0.65, y1: 0.642, radius: 0.026 },
      COLOR.paper,
      0.011,
      0.55,
    );
  }

  return toRgbaBytes(canvas);
}

/** 渐变写入：t=0 取 a，t=1 取 b。 */
function composited(canvas, x, y, a, b, t, alpha) {
  const r = a.r + (b.r - a.r) * t;
  const g = a.g + (b.g - a.g) * t;
  const bl = a.b + (b.b - a.b) * t;
  composite(canvas, x, y, r, g, bl, alpha);
}

/** float RGBA → 8bit RGBA（直通 alpha）。 */
function toRgbaBytes(canvas) {
  const n = canvas.size * canvas.size;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const a = clamp01(canvas.data[i * 4 + 3]);
    out[i * 4] = Math.round(clamp01(canvas.data[i * 4]) * 255);
    out[i * 4 + 1] = Math.round(clamp01(canvas.data[i * 4 + 1]) * 255);
    out[i * 4 + 2] = Math.round(clamp01(canvas.data[i * 4 + 2]) * 255);
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG 编码
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

function encodePng(rgba, width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行前置 filter 字节（0 = None），zlib 默认压缩已足够
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// ICO 编码
// ---------------------------------------------------------------------------
/** 32 位 BMP（BITMAPINFOHEADER + BGRA 自下而上 + 全零 AND 掩码）。 */
function encodeBmpEntry(rgba, size) {
  const headerSize = 40;
  const xorSize = size * size * 4;
  const andRowBytes = Math.ceil(size / 32) * 4;
  const andSize = andRowBytes * size;
  const buffer = Buffer.alloc(headerSize + xorSize + andSize);

  buffer.writeUInt32LE(40, 0); // biSize
  buffer.writeInt32LE(size, 4); // biWidth
  buffer.writeInt32LE(size * 2, 8); // biHeight = XOR + AND
  buffer.writeUInt16LE(1, 12); // biPlanes
  buffer.writeUInt16LE(32, 14); // biBitCount
  buffer.writeUInt32LE(0, 16); // BI_RGB
  buffer.writeUInt32LE(xorSize + andSize, 20); // biSizeImage
  buffer.writeInt32LE(0, 24);
  buffer.writeInt32LE(0, 28);
  buffer.writeUInt32LE(0, 32);
  buffer.writeUInt32LE(0, 36);

  let offset = headerSize;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      buffer[offset++] = rgba[i + 2]; // B
      buffer[offset++] = rgba[i + 1]; // G
      buffer[offset++] = rgba[i]; // R
      buffer[offset++] = rgba[i + 3]; // A
    }
  }
  // AND 掩码保持全 0：透明度由 alpha 通道决定
  return buffer;
}

function encodeIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(count, 4);

  const directory = Buffer.alloc(16 * count);
  let offset = 6 + directory.length;
  const blobs = [];

  entries.forEach((entry, index) => {
    const isPng = entry.format === 'png';
    const widthByte = entry.size >= 256 ? 0 : entry.size;
    const heightByte = entry.size >= 256 ? 0 : entry.size;
    const base = index * 16;
    directory[base] = widthByte;
    directory[base + 1] = heightByte;
    directory[base + 2] = 0; // color count
    directory[base + 3] = 0; // reserved
    directory.writeUInt16LE(1, base + 4); // planes
    directory.writeUInt16LE(isPng ? 32 : 32, base + 6); // bit count
    directory.writeUInt32LE(entry.data.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.data.length;
    blobs.push(entry.data);
  });

  return Buffer.concat([header, directory, ...blobs]);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  fs.mkdirSync(buildDir, { recursive: true });

  const desired = [256, 128, 64, 48, 32, 16];
  const entries = [];
  for (const size of desired) {
    const rgba = renderIcon(size);
    // 256 用 PNG 压缩，其余用 32 位 BMP，兼容性最好
    const data = size >= 256 ? encodePng(rgba, size, size) : encodeBmpEntry(rgba, size);
    entries.push({ size, format: size >= 256 ? 'png' : 'bmp', data });
  }

  const ico = encodeIco(entries);
  const icoPath = path.join(buildDir, 'icon.ico');
  fs.writeFileSync(icoPath, ico);

  const bigSize = 512;
  const pngPath = path.join(buildDir, 'icon.png');
  fs.writeFileSync(pngPath, encodePng(renderIcon(bigSize), bigSize, bigSize));

  // 顺带存一张 256 的工作图，方便人工核对
  const previewPath = path.join(buildDir, 'icon-256.png');
  fs.writeFileSync(previewPath, encodePng(renderIcon(256), 256, 256));

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log('[make-icon] 已生成：');
  console.log(`  ${icoPath}  (${kb(ico.length)}，含 ${desired.join('/')})`);
  console.log(`  ${pngPath}  (${kb(fs.statSync(pngPath).size)}，${bigSize}×${bigSize})`);
  console.log(`  ${previewPath}  (${kb(fs.statSync(previewPath).size)}，256×256 预览)`);
}

try {
  main();
} catch (err) {
  console.error('[make-icon] 生成失败:', err);
  process.exit(1);
}
