/**
 * 截图与冒烟验证工具（Lead 专用，不属于产品代码）。
 *
 * 用法：
 *   node tools/capture.mjs [--url http://localhost:5199] [--out docs/ui] [--theme light|dark] [--wait 2500]
 *   node tools/capture.mjs --electron            # 直接用 electron 加载 dist/，走真实桌面渲染
 *
 * 依赖：仅 electron（已作为 devDependency 安装）。
 */
import { app, BrowserWindow, nativeTheme } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { url: "", out: path.join(root, "docs", "ui"), theme: "light", wait: 2500, electron: false, name: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--electron") out.electron = true;
    else if (key === "--url") out.url = argv[++i];
    else if (key === "--out") out.out = path.resolve(root, argv[++i]);
    else if (key === "--theme") out.theme = argv[++i];
    else if (key === "--wait") out.wait = Number(argv[++i]);
    else if (key === "--name") out.name = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const target = args.electron || !args.url ? `file://${path.join(root, "dist", "index.html").replace(/\\/g, "/")}` : args.url;

async function main() {
  await fs.mkdir(args.out, { recursive: true });
  nativeTheme.themeSource = args.theme === "dark" ? "dark" : "light";

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: args.theme === "dark" ? "#14120f" : "#faf6ee",
    webPreferences: { offscreen: false, contextIsolation: true, nodeIntegration: false },
  });

  const errors = [];
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) errors.push(`[console:${level}] ${message}`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    errors.push(`[did-fail-load] ${code} ${desc} ${url}`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    errors.push(`[render-process-gone] ${JSON.stringify(details)}`);
  });

  await win.loadURL(target);
  await new Promise((resolve) => setTimeout(resolve, args.wait));

  // 让页面把主题切成目标主题，再等一帧让 CSS 生效
  await win.webContents.executeJavaScript(
    `document.documentElement.dataset.theme = ${JSON.stringify(args.theme)}; window.dispatchEvent(new Event('inkbox:capture'));`,
  );
  await new Promise((resolve) => setTimeout(resolve, 350));

  const image = await win.webContents.capturePage();
  const fileName = args.name || `app-${args.theme}.png`;
  const filePath = path.join(args.out, fileName);
  await fs.writeFile(filePath, image.toPNG());

  const title = await win.webContents.executeJavaScript("document.title");
  const bodyText = await win.webContents.executeJavaScript(
    "(document.body.innerText || '').slice(0, 400)",
  );
  const hasApp = await win.webContents.executeJavaScript(
    "Boolean(document.querySelector('#app') && document.querySelector('#app').children.length)",
  );

  console.log(JSON.stringify({ filePath, title, hasApp, errors, bodyPreview: bodyText }, null, 2));
  win.destroy();
  app.quit();
}

app.whenReady().then(main).catch((err) => {
  console.error("CAPTURE_FAILED", err);
  app.exit(1);
});
