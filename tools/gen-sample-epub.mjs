/**
 * 用真实测试小说跑一遍完整转换链路，产出 EPUB 供 EPUBCheck 校验（Lead 专用）。
 * 走的是产品代码本身（src/core），不是另写的假实现。
 *
 * 用法：node tools/gen-sample-epub.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "tools", "sample-output");

async function loadCore() {
  // 用 vite 的 SSR 构建能力，把 TS 的 src/core 直接当模块加载
  const server = await import("vite").then((v) => v.createServer({ root, server: { middlewareMode: true }, appType: "custom" }));
  const mod = async (p) => server.ssrLoadModule(path.join(root, "src", "core", p));
  return { server, mod };
}

const { server, mod } = await loadCore();
const { convertTxt } = await mod("convert.ts");
const { loadRules } = await mod("customRules.ts");
const { presetRules } = await mod("chapterParser.ts");

await fs.mkdir(outDir, { recursive: true });

const cases = [
  { file: "测试小说_001.txt", title: "测试小说 001", author: "测试作者 001" },
  { file: "测试小说_002.txt", title: "测试小说 002", author: "测试作者 002" },
];

// 用一张真实生成的小 PNG 当封面，验证封面链路
const coverPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const results = [];
for (const item of cases) {
  const sourcePath = path.join(root, "tests", "fixtures", item.file);
  const bytes = new Uint8Array(await fs.readFile(sourcePath));
  const started = Date.now();

  const result = await convertTxt(
    { sourceName: item.file, bytes },
    {
      meta: { title: item.title, author: item.author },
      rules: loadRules(),
      cover: {
        data: coverPng.buffer.slice(coverPng.byteOffset, coverPng.byteOffset + coverPng.byteLength),
        mimeType: "image/png",
        fileName: "cover.png",
      },
      typesetting: { indent: true, lineHeight: 1.8, fontSize: 1, paragraphSpacing: true },
    },
  );

  const outPath = path.join(outDir, `${item.title}.epub`);
  await fs.writeFile(outPath, result.bytes);
  results.push({
    source: item.file,
    output: outPath,
    bytes: result.byteLength,
    chapters: result.chapterCount,
    words: result.wordCount,
    declaredName: result.outputName,
    ms: Date.now() - started,
  });
  console.log(`生成 ${path.basename(outPath)}: ${result.chapterCount} 章 / ${result.wordCount} 字 / ${(result.byteLength / 1024).toFixed(0)} KB / ${Date.now() - started}ms`);
}

console.log("\n预设规则数量:", presetRules().length);
await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(results, null, 2));
await server.close();
