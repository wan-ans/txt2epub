/**
 * 验证「合并模式下改的章节标题」真的写进了产出的 EPUB（Lead 专用）。
 *
 * 分两种情况（与 UI 上的说明对应）：
 *   A. 文件只切出 1 章 → 改的名字就是该章标题
 *   B. 文件切出多章   → 改的名字作为章节前缀，形如「卷一 · 第1章」
 *
 * 用法：node tools/verify-rename-output.mjs
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
const { stripExtension } = await server.ssrLoadModule(
  path.join(root, "src", "components", "composables", "fileOrdering.ts"),
);

await fs.mkdir(outDir, { recursive: true });

/**
 * 复刻 BatchPanel.runMerged 的取名逻辑。
 * 这段逻辑与组件里的实现必须一致 —— 若组件改了，这里要同步。
 */
function buildMergedChapters(sources) {
  const chapters = [];
  for (const src of sources) {
    const read = detectAndDecode(new TextEncoder().encode(src.text));
    const lines = preprocessLines(read.text);
    const parsed = parseChapters(lines, "zh-CN", []);
    const fallback = new Set(["正文", "Content"]);
    const baseTitle = stripExtension(src.name);
    const renamed = (src.customTitle ?? "").trim();

    const usable =
      parsed.length === 1 && fallback.has(parsed[0].title)
        ? [{ ...parsed[0], title: baseTitle }]
        : parsed;

    const titled = usable.map((chapter) => {
      if (!renamed) return chapter;
      if (usable.length === 1) return { ...chapter, title: renamed };
      return { ...chapter, title: `${renamed} · ${chapter.title}` };
    });

    for (const chapter of titled) chapters.push({ ...chapter, id: `m-${chapters.length}` });
  }
  return chapters;
}

const cases = [
  {
    label: "A. 单章文件改名",
    sources: [
      { name: "第1话 开端.txt", text: "只有一段正文，没有章节标记。", customTitle: "楔子 · 风起" },
      { name: "第2话 相遇.txt", text: "另一段正文，同样没有章节标记。" },
    ],
    expect: (titles) => titles[0] === "楔子 · 风起" && titles[1] === "第2话 相遇",
  },
  {
    label: "B. 多章文件改名（作为前缀）",
    sources: [
      { name: "第一卷.txt", text: "第1章 起风\n内容\n第2章 落雨\n内容", customTitle: "卷一" },
      { name: "第二卷.txt", text: "第1章 远行\n内容" },
    ],
    expect: (titles) =>
      titles[0] === "卷一 · 第1章 起风" &&
      titles[1] === "卷一 · 第2章 落雨" &&
      titles[2] === "第1章 远行",
  },
  {
    label: "C. 不改名（回归：标题取文件名）",
    sources: [
      { name: "第5话 独行.txt", text: "单段正文。" },
    ],
    expect: (titles) => titles[0] === "第5话 独行",
  },
];

let allOk = true;
const report = [];

for (const testCase of cases) {
  const chapters = buildMergedChapters(testCase.sources);
  const titles = chapters.map((c) => c.title);
  const bytes = await buildEpub(
    { title: "改名测试", author: "", language: "zh-CN" },
    chapters,
    { typesetting: { indent: true } },
  );
  const outPath = path.join(outDir, `rename-${testCase.label.slice(0, 1)}.epub`);
  await fs.writeFile(outPath, bytes);

  const zip = await JSZip.loadAsync(bytes);
  const files = Object.keys(zip.files)
    .filter((n) => /OEBPS\/chapter-\d+.*\.xhtml$/.test(n))
    .sort();
  const nav = await zip.file("OEBPS/nav.xhtml").async("string");

  // 校验标题确实进了 nav 与章节 XHTML（不是只在内存里改了）
  const titlesInNav = titles.every((t) => nav.includes(t.replace(/&/g, "&amp;")));
  const ok = testCase.expect(titles) && titlesInNav;
  allOk = allOk && ok;

  report.push({ case: testCase.label, titles, titlesInNav, ok, file: outPath });
  console.log(`\n=== ${testCase.label} ===`);
  console.log("章节标题:", JSON.stringify(titles));
  console.log("标题已写入 nav.xhtml:", titlesInNav ? "PASS" : "FAIL");
  console.log("断言:", ok ? "PASS" : "FAIL");
}

console.log("\n========== 汇总 ==========");
console.log(JSON.stringify(report, null, 2));
await server.close();
process.exit(allOk ? 0 : 1);
