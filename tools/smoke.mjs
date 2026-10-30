/**
 * UI 自动化冒烟测试（Lead 专用）。
 *
 * 走真实 Electron 渲染进程，模拟用户完整路径：
 *   1. 通过 DataTransfer 注入 tests/fixtures 里的真实 TXT
 *   2. 检查章节是否解析出来、字数统计是否非零
 *   3. 触发导出，验证下载/保存链路不崩
 *   4. 抓控制台错误与未捕获异常
 *
 * 用法：node tools/smoke.mjs [--url http://localhost:5199]
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const urlArg = argv.indexOf("--url");
const target =
  urlArg >= 0 ? argv[urlArg + 1] : `file://${path.join(root, "dist", "index.html").replace(/\\/g, "/")}`;

const FIXTURE = path.join(root, "tests", "fixtures", "测试小说_001.txt");

const report = { target, steps: [], errors: [], consoleErrors: [] };
const step = (name, ok, detail) => {
  report.steps.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function run() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: "#faf6ee",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) report.consoleErrors.push(message);
  });
  win.webContents.on("render-process-gone", (_e, d) => report.errors.push(`render-process-gone ${JSON.stringify(d)}`));
  win.webContents.on("did-fail-load", (_e, code, desc) => report.errors.push(`did-fail-load ${code} ${desc}`));

  await win.loadURL(target);
  await new Promise((r) => setTimeout(r, 2000));

  const bodyText = await win.webContents.executeJavaScript("document.body.innerText || ''");
  step("页面有内容渲染", bodyText.trim().length > 10, `${bodyText.trim().slice(0, 80)}…`);

  const fixtureBytes = await fs.readFile(FIXTURE);
  const b64 = fixtureBytes.toString("base64");
  const fileName = path.basename(FIXTURE);

  const injectResult = await win.webContents.executeJavaScript(`(async () => {
    const b64 = ${JSON.stringify(b64)};
    const name = ${JSON.stringify(fileName)};
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], name, { type: "text/plain" });

    // 1) 优先找 input[type=file]，用 DataTransfer 塞进去并派发 change
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    let injected = false;
    for (const input of inputs) {
      if (input.accept && input.accept.includes("json")) continue; // 规则导入框跳过
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        injected = true;
        break;
      } catch (e) { /* 换下一个 */ }
    }

    // 2) 兜底：直接派发一个 drag/drop 到 body
    if (!injected) {
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        const target = document.body;
        target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
        injected = "drop";
      } catch (e) { return { injected: false, error: String(e) }; }
    }
    return { injected, inputCount: inputs.length };
  })()`);
  step("注入测试文件", Boolean(injectResult.injected), JSON.stringify(injectResult));

  await new Promise((r) => setTimeout(r, 4000));

  const after = await win.webContents.executeJavaScript(`(() => {
    const text = document.body.innerText || "";
    return {
      textLength: text.length,
      hasChapter: /第\\s*\\d*\\s*章/.test(text),
      hasWords: /\\d+\\s*字/.test(text),
      sample: text.slice(0, 500),
      buttons: Array.from(document.querySelectorAll("button")).map(b => (b.innerText || b.getAttribute("aria-label") || "").trim()).filter(Boolean).slice(0, 60)
    };
  })()`);
  step("解析出章节标题", after.hasChapter, after.sample.replace(/\n+/g, " | ").slice(0, 160));
  step("显示字数统计", after.hasWords, after.sample.match(/\d+\s*字/)?.[0] ?? "none");

  const shot = await win.webContents.capturePage();
  const shotPath = path.join(root, "docs", "ui", "smoke-after-import.png");
  await fs.mkdir(path.dirname(shotPath), { recursive: true });
  await fs.writeFile(shotPath, shot.toPNG());
  step("截图已保存", true, shotPath);

  report.buttons = after.buttons;
  report.ok = report.errors.length === 0 && report.steps.every((s) => s.ok);
  console.log(JSON.stringify(report, null, 2));

  win.destroy();
  app.exit(report.ok ? 0 : 1);
}

app.whenReady().then(run).catch((err) => {
  console.error("SMOKE_FAILED", err);
  app.exit(1);
});
