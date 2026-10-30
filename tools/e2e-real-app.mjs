/**
 * 真实应用入口的端到端验证（Lead 专用）。
 *
 * 与 tools/e2e-export.cjs 的区别：
 *   - e2e-export.cjs 自己 new BrowserWindow，绕过 electron/main.cjs，
 *     因此拿不到主进程注入的 CSP / preload / 菜单，只能验证「渲染层逻辑」。
 *   - 本脚本用 INKBOX_SELF_CHECK=1 + INKBOX_DEBUG_LOG 启动**真实的 main.cjs**，
 *     验证的是产品真实启动路径：preload 桥接、CSP 是否消除安全告警、窗口是否正常。
 *
 * 用法：
 *   npx electron . --e2e-check      （由 package.json 的 electron . 入口 + 本脚本无关）
 *   node tools/e2e-real-app.mjs     （推荐：自动清 ELECTRON_RUN_AS_NODE 后拉起真应用）
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logFile = path.join(root, "tools", "e2e-output", "real-app.log");
const outDir = path.dirname(logFile);

await fs.mkdir(outDir, { recursive: true });
await fs.rm(logFile, { force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 本机坑：会导致 electron 退化成纯 node
delete env.VITE_DEV_SERVER_URL;  // 走生产构建产物

env.INKBOX_SELF_CHECK = "1";
env.INKBOX_DEBUG_LOG = logFile;

const electronBin = path.join(
  root,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);

const child = spawn(electronBin, ["."], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => {
  stdout += d.toString();
  process.stdout.write(d);
});
child.stderr.on("data", (d) => {
  stderr += d.toString();
  process.stderr.write(d);
});

const finished = new Promise((resolve) => {
  child.on("exit", (code) => resolve(code));
});

// 给应用 8 秒完成启动 + 自检，然后主动退出
await new Promise((r) => setTimeout(r, 8000));
try {
  child.kill();
} catch {
  /* 已退出 */
}
await Promise.race([finished, new Promise((r) => setTimeout(r, 3000))]);

let log = "";
try {
  log = await fs.readFile(logFile, "utf8");
} catch {
  /* 没有日志 */
}

const report = {
  selfCheckLine: (stdout.match(/\[main\] self-check: .*/) ?? [])[0] ?? null,
  hasBridgeWarning: /window\.inkbox|桥接/.test(stderr),
  cspWarning: /Insecure Content-Security-Policy/.test(stderr),
  gpuWarnings: /GPU|gpu_/.test(stderr) ? "有（无害）" : "无",
  stderrTail: stderr.split(/\r?\n/).filter(Boolean).slice(-12),
  logTail: log.split(/\r?\n/).filter(Boolean).slice(-20),
};

console.log("\n=== 真实应用启动验证 ===");
console.log(JSON.stringify(report, null, 2));

const ok = Boolean(report.selfCheckLine) && !report.cspWarning;
console.log(`\n结论: ${ok ? "PASS" : "FAIL"}（selfCheck=${Boolean(report.selfCheckLine)}，cspWarning=${report.cspWarning}）`);
process.exit(ok ? 0 : 1);
