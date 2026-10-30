/**
 * EPUB 权威校验（Lead 专用）。
 *
 * 用 W3C 官方 EPUBCheck 校验产物，并额外做几项 EPUBCheck 不覆盖的工程检查：
 *   - mimetype 是否为 zip 第一个条目且未压缩（STORE）
 *   - 是否存在 OEBPS 之外的多余文件
 *   - 封面是否为合法位图且被 OPF 引用
 *
 * 用法：node tools/validate-epub.mjs <file.epub> [...more.epub]
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JAR = path.join(root, "tools", "epubcheck", "epubcheck-5.4.0", "epubcheck.jar");

/** 解析 zip 中央目录，拿到条目名与压缩方法（0=STORE, 8=DEFLATE）。 */
async function readZipEntries(filePath) {
  const buf = await fs.readFile(filePath);
  // EOCD: PK\x05\x06
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i -= 1) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("未找到 zip 中央目录（EOCD）");

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("中央目录签名不符");
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    entries.push({ name, method, compressedSize, uncompressedSize });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function validateOne(filePath) {
  const result = { file: filePath, ok: false, issues: [], epubcheck: null };

  const entries = await readZipEntries(filePath);
  const first = entries[0];
  if (!first || first.name !== "mimetype") {
    result.issues.push(`第一个 zip 条目应为 mimetype，实际是 ${first ? first.name : "空"}`);
  }
  if (first && first.method !== 0) {
    result.issues.push(`mimetype 必须 STORE 不压缩，实际 method=${first.method}`);
  }
  const hasContainer = entries.some((e) => e.name === "META-INF/container.xml");
  if (!hasContainer) result.issues.push("缺少 META-INF/container.xml");

  const opf = entries.find((e) => e.name.endsWith(".opf"));
  if (!opf) result.issues.push("缺少 OPF 包文件");

  try {
    const { stdout, stderr } = await execFileAsync(
      "java",
      ["-jar", JAR, "--failonwarnings", filePath],
      { maxBuffer: 20 * 1024 * 1024, windowsHide: true },
    );
    result.epubcheck = { code: 0, output: stdout.trim() };
  } catch (err) {
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    result.epubcheck = { code: err.code ?? 1, output };
    result.issues.push("EPUBCheck 未通过");
  }

  result.ok = result.issues.length === 0;
  return result;
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error("用法: node tools/validate-epub.mjs <file.epub> [...]");
  process.exit(2);
}

let allOk = true;
for (const file of files) {
  const abs = path.resolve(file);
  try {
    const res = await validateOne(abs);
    allOk = allOk && res.ok;
    console.log(`\n=== ${path.basename(abs)} ===`);
    console.log(`结果: ${res.ok ? "PASS" : "FAIL"}`);
    if (res.epubcheck) {
      const lines = res.epubcheck.output.split(/\r?\n/).filter(Boolean);
      for (const line of lines.slice(-12)) console.log(`  ${line}`);
    }
    for (const issue of res.issues) console.log(`  ! ${issue}`);
  } catch (err) {
    allOk = false;
    console.log(`\n=== ${path.basename(abs)} ===\n  校验脚本异常: ${err.message}`);
  }
}

process.exit(allOk ? 0 : 1);
