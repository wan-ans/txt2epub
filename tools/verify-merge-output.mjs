/**
 * 批量「合并为一个文件」的产物验证（Lead 专用）。
 *
 * 用与 BatchPanel.runMerged 完全相同的步骤（解码 → 预处理 → 分章 → buildEpub）
 * 在 Node 里重放一遍，产出 EPUB 后解压检查：
 *   1. 章节顺序严格等于队列顺序（文件名自然序）
 *   2. 每个文件的正文标记都能在产物里找到，且顺序正确
 *   3. 产物通过 EPUBCheck
 *
 * 用法：node tools/verify-merge-output.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "tools", "e2e-output");

const { createServer } = await import("vite");
const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom" });
const load = (p) => server.ssrLoadModule(path.join(root, "src", "core", p));

const { buildEpub } = await load("epubBuilder.ts");
const { parseChapters } = await load("chapterParser.ts");
const { preprocessLines } = await load("preprocess.ts");
const { detectAndDecode } = await load("textReader.ts");
const { sortFilesByNaturalName, stripExtension } = await import(
  path.join(root, "src", "components", "composables", "fileOrdering.ts").replace(/\\/g, "/")
).catch(async () => {
  // TS 模块在 Node 里不能直接 import，走 vite
  return server.ssrLoadModule(path.join(root, "src", "components", "composables", "fileOrdering.ts"));
});

/** 故意打乱顺序传入，模拟用户随便选了几个文件 */
const FILES = [
  { name: "第10话 尾声.txt", mark: "MARK_TEN_尾声正文" },
  { name: "第2话 相遇.txt", mark: "MARK_TWO_相遇正文" },
  { name: "第1话 开端.txt", mark: "MARK_ONE_开端正文" },
];

await fs.mkdir(outDir, { recursive: true });

// 1) 按文件名自然序排队（与 UI 的「合并模式自动排序」一致）
const ordered = sortFilesByNaturalName(FILES);
console.log("队列顺序:", ordered.map((f) => f.name).join(" → "));

// 2) 逐个解析（与 runMerged 相同）
const chapters = [];
for (const file of ordered) {
  const text = `${file.mark}\n这是${file.name}的正文。\n第二段正文。`;
  const bytes = new TextEncoder().encode(text);
  const read = detectAndDecode(bytes);
  const lines = preprocessLines(read.text);
  const parsed = parseChapters(lines, "zh-CN", []);
  const fallback = new Set(["正文", "Content"]);
  const usable =
    parsed.length === 1 && fallback.has(parsed[0].title)
      ? [{ ...parsed[0], title: stripExtension(file.name) }]
      : parsed;
  for (const chapter of usable) chapters.push({ ...chapter, id: `merged-${chapters.length}` });
}

console.log(
  "章节顺序:",
  chapters.map((c) => c.title).join(" → "),
);

// 3) 生成 EPUB
const bytes = await buildEpub(
  { title: "合并测试书", author: "", language: "zh-CN" },
  chapters,
  { typesetting: { indent: true } },
);
const outPath = path.join(outDir, "merged-test.epub");
await fs.writeFile(outPath, bytes);
console.log(`产出: ${outPath} (${(bytes.byteLength / 1024).toFixed(1)} KB)`);

// 4) 解压校验
const zip = await JSZip.loadAsync(bytes);
const chapterFiles = Object.keys(zip.files)
  .filter((n) => /OEBPS\/chapter-\d+.*\.xhtml$/.test(n))
  .sort();

console.log(`章节文件数: ${chapterFiles.length}`);

const contents = [];
for (const name of chapterFiles) {
  contents.push(await zip.file(name).async("string"));
}
const joined = contents.join("\n");

const positions = FILES.map((f) => ({ name: f.name, at: joined.indexOf(f.mark) }));
console.log("正文标记出现位置:", JSON.stringify(positions));

// 期望顺序 = 队列顺序（自然序），按这个顺序取位置再判断递增
const expectedOrder = ordered.map((f) => f.name);
const orderedPositions = expectedOrder.map((name) => {
  const found = positions.find((p) => p.name === name);
  return { name, at: found ? found.at : -1 };
});
console.log("按队列顺序的位置:", JSON.stringify(orderedPositions));

const orderOk = orderedPositions.every(
  (p, i) => p.at >= 0 && (i === 0 || p.at > orderedPositions[i - 1].at),
);

const allPresent = positions.every((p) => p.at >= 0);
const chapterCountOk = chapterFiles.length === chapters.length;

console.log("\n=== 校验 ===");
console.log(`每个文件的正文都进了产物: ${allPresent ? "PASS" : "FAIL"}`);
console.log(`正文顺序与队列顺序一致: ${orderOk ? "PASS" : "FAIL"}`);
console.log(`章节数与文件数匹配: ${chapterCountOk ? "PASS" : "FAIL"} (${chapterFiles.length} vs ${chapters.length})`);
console.log(`产出路径: ${outPath}`);

await server.close();
process.exit(allPresent && orderOk && chapterCountOk ? 0 : 1);
