/**
 * 生成一本「非 inkbox 生成」的真实结构 EPUB 3 样书，供 EPUB 编辑端到端验收使用。
 *
 * 特点：
 * - 手工写出完整 EPUB 3 结构：mimetype(STORE) / META-INF/container.xml /
 *   OEBPS/content.opf / nav.xhtml（两级嵌套目录）/ toc.ncx / 4 章 XHTML /
 *   styles/book.css / images/cover.png / cover.xhtml + meta name=cover。
 * - 不是走 buildEpub 生成的，防止「自己生、自己读」掩盖解析兼容性问题。
 *
 * 用法：node tools/gen-epub-fixture.mjs
 * 产物：tools/sample-output/sample-book.epub
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import JSZip from "jszip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "tools", "sample-output");
const outPath = path.join(outDir, "sample-book.epub");

const BOOK = {
  title: "雾里山河",
  author: "青灯客",
  language: "zh-CN",
  publisher: "青灯书局",
  description: "一部写在雾与山之间的江湖旧事：有人持刀，有人等信，有人沿着旧路走回故乡。",
  subjects: ["武侠", "长篇"],
  date: "2023-09-15",
  identifier: "urn:uuid:6b1f2a70-9d31-4c8e-8a52-2f0c4d7e9a10",
};

const CHAPTERS = [
  {
    file: "chapter-1.xhtml",
    title: "序章",
    paragraphs: [
      "雾从山脚漫上来的时候，青石镇还亮着三盏灯。一盏在客栈门口，一盏在渡口，最后一盏在镇东那间多年不开门的药铺里。",
      "老人把<strong>最后一封书信</strong>压在茶盏下，说起多年前那场没有落雪、<em>却冷透骨</em>的冬天。他的声音很轻，像怕惊动了窗外的雾。",
      "那时山里还有一条旧路，路上铺着碎青石，挑担的人从上面走过，脚步声能传出去很远。后来路被荒草封了，便再没有人记得它通向哪里。",
      "少年坐在门槛上听完，没有问信是写给谁的。他只看见老人把灯芯剪短，火苗缩了一截，屋里忽然暗下来。",
    ],
  },
  {
    file: "chapter-2.xhtml",
    title: "第一章 起风",
    paragraphs: [
      "风从北面来，卷着枯叶和细沙，撞在客栈的纸窗上，发出细碎的响声。",
      "少年<strong>握紧了刀</strong>，却没有拔出来。他知道，拔刀容易，收刀难；更难的是把已经起了的心思重新按回胸口。",
      "掌柜端来一碗热汤，汤面上浮着两片葱叶。他说今年风来得早，山里的路怕是要封了，劝客人多住两日。",
      "少年摇头，说自己在等一个人。那人若在今夜之前赶到，他便不必上山；若赶不到，他就替那人走完剩下的路。",
      "窗外有马蹄声由远及近，又很快消失在风里。少年抬眼，看见门帘动了一下，<em>像有人来过，又像只是风</em>。",
    ],
  },
  {
    file: "chapter-3.xhtml",
    title: "第二章 入夜",
    paragraphs: [
      "入夜后镇子安静得出奇。风停了，雾却更厚，把远处的山脊整个吞了进去。",
      "客栈的灯一盏盏熄灭，只剩堂屋中央那盏还亮着。少年把刀横在膝上，用布一遍遍擦着刀鞘上的旧痕。",
      "那封信终于被人送来。送信的是个穿蓑衣的老人，斗笠压得很低，进门只说了一句：<strong>山上的事，今晚要有个了断。</strong>",
      "少年拆开信，纸上只有短短三行字。他看了很久，最后把纸凑到灯前，看它一点点卷曲、发黑，化成灰落进铜盘。",
      "他起身时，客栈的门自己开了。雾从门外涌进来，带着松针和湿土的气味。<em>这一夜，注定没有人能安睡。</em>",
    ],
  },
  {
    file: "chapter-4.xhtml",
    title: "第三章 归途",
    paragraphs: [
      "天亮之前，少年走上了那条被荒草掩住的旧路。露水打湿了裤脚，碎石在脚下发出轻微的声响。",
      "山腰有一处废弃的茶亭，亭柱上还留着多年前刻下的字。他伸手擦去青苔，认出那是父亲的名字，笔画深而稳。",
      "再往上走，雾渐渐薄了。东边天线上透出一线灰白，山下的镇子像一枚落在掌心里的旧印。<strong>他忽然明白，所谓归途，并不是回去，而是把该还的东西还掉。</strong>",
      "风从背后吹来，推着他往前走。少年没有回头，只在路尽头停了一瞬，把刀卸下来，轻轻放在石头上。",
    ],
  },
];

/* ------------------------------------------------------------
   极简 PNG 编码器：生成一张渐变色封面（不依赖任何图像库）
   ------------------------------------------------------------ */

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function makeCoverPng(width, height) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter: None
    const t = y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const shimmer = Math.sin((x / width) * Math.PI) * 12;
      const r = Math.min(255, Math.round(26 + t * 128 + shimmer));
      const g = Math.min(255, Math.round(48 + t * 76 + shimmer * 0.4));
      const b = Math.min(255, Math.round(66 + t * 38 + shimmer * 0.2));
      const offset = rowStart + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------
   文档模板
   ------------------------------------------------------------ */

const escapeXml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

function joinLines(lines) {
  return lines.join("\n") + "\n";
}

function chapterXhtml(chapter) {
  const paragraphLines = chapter.paragraphs.map((item) => "      <p>" + item + "</p>");
  return joinLines([
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!DOCTYPE html>',
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <title>' + escapeXml(chapter.title) + '</title>',
    '    <link rel="stylesheet" type="text/css" href="../styles/book.css" />',
    '  </head>',
    '  <body>',
    '    <section epub:type="chapter" class="chapter">',
    '      <h2>' + escapeXml(chapter.title) + '</h2>',
    ...paragraphLines,
    '    </section>',
    '  </body>',
    '</html>',
  ]);
}

function navXhtml() {
  return joinLines([
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!DOCTYPE html>',
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <title>目录</title>',
    '    <link rel="stylesheet" type="text/css" href="styles/book.css" />',
    '  </head>',
    '  <body>',
    '    <nav epub:type="toc" id="toc">',
    '      <h1>目录</h1>',
    '      <ol>',
    '        <li><a href="Text/chapter-1.xhtml">序章</a></li>',
    '        <li>',
    '          <span>第一卷 · 风起</span>',
    '          <ol>',
    '            <li><a href="Text/chapter-2.xhtml">第一章 起风</a></li>',
    '            <li><a href="Text/chapter-3.xhtml">第二章 入夜</a></li>',
    '          </ol>',
    '        </li>',
    '        <li><a href="Text/chapter-4.xhtml">第三章 归途</a></li>',
    '      </ol>',
    '    </nav>',
    '  </body>',
    '</html>',
  ]);
}

function tocNcx() {
  return joinLines([
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="zh-CN">',
    '  <head>',
    '    <meta name="dtb:uid" content="' + BOOK.identifier + '" />',
    '    <meta name="dtb:depth" content="2" />',
    '    <meta name="dtb:totalPageCount" content="0" />',
    '    <meta name="dtb:maxPageNumber" content="0" />',
    '  </head>',
    '  <docTitle><text>' + escapeXml(BOOK.title) + '</text></docTitle>',
    '  <navMap>',
    '    <navPoint id="navPoint-1" playOrder="1">',
    '      <navLabel><text>序章</text></navLabel>',
    '      <content src="Text/chapter-1.xhtml" />',
    '    </navPoint>',
    '    <navPoint id="navPoint-2" playOrder="2">',
    '      <navLabel><text>第一卷 · 风起</text></navLabel>',
    '      <content src="Text/chapter-2.xhtml" />',
    '      <navPoint id="navPoint-3" playOrder="3">',
    '        <navLabel><text>第二章 入夜</text></navLabel>',
    '        <content src="Text/chapter-3.xhtml" />',
    '      </navPoint>',
    '    </navPoint>',
    '    <navPoint id="navPoint-4" playOrder="4">',
    '      <navLabel><text>第三章 归途</text></navLabel>',
    '      <content src="Text/chapter-4.xhtml" />',
    '    </navPoint>',
    '  </navMap>',
    '</ncx>',
  ]);
}

function coverXhtml() {
  return joinLines([
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!DOCTYPE html>',
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <title>封面</title>',
    '    <link rel="stylesheet" type="text/css" href="../styles/book.css" />',
    '  </head>',
    '  <body epub:type="cover">',
    '    <section epub:type="cover" class="cover">',
    '      <img src="../images/cover.png" alt="' + escapeXml(BOOK.title) + ' 封面" />',
    '    </section>',
    '  </body>',
    '</html>',
  ]);
}

function bookCss() {
  return joinLines([
    '@charset "utf-8";',
    '',
    'body {',
    '  margin: 0;',
    '  font-family: "Songti SC", "SimSun", serif;',
    '  line-height: 1.8;',
    '  color: #2b2620;',
    '  background: #fbf7ef;',
    '}',
    '',
    '.chapter {',
    '  max-width: 36em;',
    '  margin: 0 auto;',
    '  padding: 2em 1.2em;',
    '}',
    '',
    '.chapter h2 {',
    '  margin: 0 0 1.2em;',
    '  font-size: 1.5em;',
    '  letter-spacing: 0.08em;',
    '}',
    '',
    '.chapter p {',
    '  margin: 0 0 0.9em;',
    '  text-indent: 2em;',
    '  text-align: justify;',
    '}',
    '',
    '.cover {',
    '  margin: 0;',
    '  padding: 0;',
    '  text-align: center;',
    '}',
    '',
    '.cover img {',
    '  max-width: 100%;',
    '  height: auto;',
    '}',
  ]);
}

function contentOpf() {
  const subjectLines = BOOK.subjects.map((subject) => '    <dc:subject>' + escapeXml(subject) + '</dc:subject>');
  return joinLines([
    '<?xml version="1.0" encoding="utf-8"?>',
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="' + BOOK.language + '">',
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '    <dc:identifier id="book-id">' + BOOK.identifier + '</dc:identifier>',
    '    <dc:title>' + escapeXml(BOOK.title) + '</dc:title>',
    '    <dc:creator>' + escapeXml(BOOK.author) + '</dc:creator>',
    '    <dc:language>' + BOOK.language + '</dc:language>',
    '    <dc:publisher>' + escapeXml(BOOK.publisher) + '</dc:publisher>',
    '    <dc:description>' + escapeXml(BOOK.description) + '</dc:description>',
    ...subjectLines,
    '    <dc:date>' + BOOK.date + '</dc:date>',
    '    <meta property="dcterms:modified">2023-09-15T08:00:00Z</meta>',
    '    <meta name="cover" content="cover-image" />',
    '  </metadata>',
    '  <manifest>',
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />',
    '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />',
    '    <item id="css" href="styles/book.css" media-type="text/css" />',
    '    <item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image" />',
    '    <item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml" />',
    '    <item id="chapter-1" href="Text/chapter-1.xhtml" media-type="application/xhtml+xml" />',
    '    <item id="chapter-2" href="Text/chapter-2.xhtml" media-type="application/xhtml+xml" />',
    '    <item id="chapter-3" href="Text/chapter-3.xhtml" media-type="application/xhtml+xml" />',
    '    <item id="chapter-4" href="Text/chapter-4.xhtml" media-type="application/xhtml+xml" />',
    '  </manifest>',
    '  <spine toc="ncx">',
    '    <itemref idref="cover" />',
    '    <itemref idref="chapter-1" />',
    '    <itemref idref="chapter-2" />',
    '    <itemref idref="chapter-3" />',
    '    <itemref idref="chapter-4" />',
    '  </spine>',
    '  <guide>',
    '    <reference type="cover" href="Text/cover.xhtml" title="封面" />',
    '  </guide>',
    '</package>',
  ]);
}

function containerXml() {
  return joinLines([
    '<?xml version="1.0" encoding="utf-8"?>',
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
    '  <rootfiles>',
    '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />',
    '  </rootfiles>',
    '</container>',
  ]);
}

/* ------------------------------------------------------------
   打包
   ------------------------------------------------------------ */

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const zip = new JSZip();
  const fixedDate = new Date("2023-09-15T08:00:00Z");
  const addText = (name, text, options = {}) =>
    zip.file(name, text, { createFolders: false, date: fixedDate, ...options });

  // mimetype 必须是第一个条目且不压缩（STORE）
  addText("mimetype", "application/epub+zip", { compression: "STORE" });
  addText("META-INF/container.xml", containerXml());
  addText("OEBPS/content.opf", contentOpf());
  addText("OEBPS/nav.xhtml", navXhtml());
  addText("OEBPS/toc.ncx", tocNcx());
  addText("OEBPS/styles/book.css", bookCss());
  addText("OEBPS/Text/cover.xhtml", coverXhtml());
  for (const chapter of CHAPTERS) {
    addText("OEBPS/Text/" + chapter.file, chapterXhtml(chapter));
  }
  const cover = makeCoverPng(480, 640);
  zip.file("OEBPS/images/cover.png", cover, { createFolders: false, date: fixedDate, compression: "DEFLATE" });

  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    mimeType: "application/epub+zip",
  });
  await fs.writeFile(outPath, bytes);

  console.log("生成样书:", path.relative(root, outPath));
  console.log("  EPUB 版本: 3.0 / 章节数: " + CHAPTERS.length + " / 文件大小: " + (bytes.length / 1024).toFixed(1) + " KB");
  console.log("  书名: " + BOOK.title + " / 作者: " + BOOK.author);
  console.log("  章节: " + CHAPTERS.map((chapter) => chapter.title).join(" / "));
  console.log("  封面: 480x640 PNG (" + (cover.length / 1024).toFixed(1) + " KB), meta name=cover 已写入");
}

main().catch((error) => {
  console.error("生成样书失败:", error);
  process.exit(1);
});
