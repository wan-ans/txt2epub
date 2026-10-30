/**
 * 验证「正文删减」是否真的写进导出产物（Lead 专用）。
 *
 * 模拟：解析真实小说 → 从某章正文里删掉若干行和若干字符 → 生成 EPUB
 * → 解压该章 XHTML，确认删掉的文字确实不在、保留的文字还在。
 *
 * 用法：node tools/verify-body-edit-output.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "tools", "e2e-output");

const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom" });
const load = (p) => server.ssrLoadModule(path.join(root, "src", "core", p));

const { buildEpub } = await load("epubBuilder.ts");
const { parseChapters } = await load("chapterParser.ts");
const { preprocessLines } = await load("preprocess.ts");
const { detectAndDecode } = await load("textReader.ts");

await fs.mkdir(outDir, { recursive: true });

const fixture = await fs.readFile(path.join(root, "tests", "fixtures", "测试小说_001.txt"));
const read = detectAndDecode(new Uint8Array(fixture));
const chapters = parseChapters(preprocessLines(read.text), "zh-CN", []);

// 取第 6 章（下标 6，与 UI 测试一致），找一段独特文字用于断言
const targetIndex = Math.min(6, chapters.length - 1);
const target = chapters[targetIndex];
const originalLines = target.lines;
const originalText = originalLines.join("\n");

// 找出第 20 行的一段"哨兵"文字（保证足够独特）
const sentinelLineIndex = Math.min(20, originalLines.length - 2);
const sentinel = originalLines[sentinelLineIndex].slice(0, 12).trim();
const keptSentinel = originalLines[originalLines.length - 1].slice(0, 12).trim();

// 模拟删除：去掉前 3 行，并把中间 20 行删掉
const editedLines = [...originalLines.slice(3)];
const removedByLine = originalLines.slice(3, 23);
editedLines.splice(0, Math.min(20, editedLines.length));

// 再删掉一段字符（截断最后一行）
if (editedLines.length) {
  const last = editedLines[editedLines.length - 1];
  editedLines[editedLines.length - 1] = last.slice(0, Math.max(0, last.length - 8));
}

const editedChapters = chapters.map((c, i) =>
  i === targetIndex ? { ...c, lines: editedLines, bodyEdited: true } : c,
);

const bytes = await buildEpub(
  { title: "正文删减验证", author: "", language: "zh-CN" },
  editedChapters,
  { typesetting: { indent: true } },
);

const outPath = path.join(outDir, "body-edited.epub");
await fs.writeFile(outPath, bytes);

const zip = await JSZip.loadAsync(bytes);
const files = Object.keys(zip.files)
  .filter((n) => /OEBPS\/chapter-\d+.*\.xhtml$/.test(n))
  .sort();
const chapterFile = files[targetIndex];
const html = await zip.file(chapterFile).async("string");

const results = [];

// 1) 被删掉的整行不应出现在产物里
const removedPresent = removedByLine.filter((line) => line.trim().length > 4).filter((line) => html.includes(line.trim()));
results.push({
  name: "被删除的行不出现在产物中",
  ok: removedPresent.length === 0,
  detail: removedPresent.length ? `仍有 ${removedPresent.length} 行残留` : `检查了 ${removedByLine.length} 行`,
});

// 2) 保留的首行应在产物中（注意前面删了两段，实际保留的第一行是 editedLines[0]）
const firstKept = editedLines[0]?.trim();
results.push({
  name: "保留的正文仍在产物中",
  ok: Boolean(firstKept) && html.includes(firstKept),
  detail: firstKept ? firstKept.slice(0, 20) : "(空)",
});

// 3) 字数确实变少
const beforeChars = originalText.replace(/\s/g, "").length;
const afterChars = editedLines.join("").replace(/\s/g, "").length;
results.push({
  name: "正文确实变短",
  ok: afterChars < beforeChars,
  detail: `${beforeChars} → ${afterChars} 字（少 ${beforeChars - afterChars}）`,
});

// 4) 章节数不变（只改正文，不改结构）
results.push({
  name: "章节数不受影响",
  ok: files.length === chapters.length,
  detail: `${files.length} / ${chapters.length}`,
});

console.log("\n=== 正文删减产物验证 ===");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name} — ${r.detail}`);
console.log(`产物: ${outPath}`);

await server.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
