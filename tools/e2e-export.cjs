'use strict';

/**
 * 端到端导出验证（Lead 专用，最高优先级验证）。
 *
 * 目的：验证**用户在 UI 里点导出**这条真实路径产出的 EPUB 是否合格，
 * 而不是只验证 core 单元测试里的产物。
 *
 * 做法：在真实 Electron 渲染进程里注入测试小说 → 点导出 → 拦截下载字节，
 * 落到磁盘后再交给 EPUBCheck 校验。
 *
 * 注意：必须用 CJS（Electron 以 ESM 作主入口时拿不到主进程 API）。
 *
 * 用法：npx electron tools/e2e-export.cjs [--url ...]
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const urlArg = argv.indexOf('--url');
const target =
  urlArg >= 0
    ? argv[urlArg + 1]
    : `file://${path.join(root, 'dist', 'index.html').replace(/\\/g, '/')}`;

const outDir = path.join(root, 'tools', 'e2e-output');
const FIXTURE = path.join(root, 'tests', 'fixtures', '测试小说_001.txt');

const log = (...args) => console.log(...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  await fsp.mkdir(outDir, { recursive: true });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });

  // 拦截下载，抓 EPUB 字节
  const captured = [];
  win.webContents.session.on('will-download', (_event, item) => {
    const fileName = item.getFilename();
    if (!fileName.toLowerCase().endsWith('.epub')) {
      log(`跳过非 epub 下载: ${fileName}`);
      return;
    }
    const dest = path.join(outDir, fileName);
    item.setSavePath(dest);
    captured.push(dest);
    log(`拦截到 EPUB 下载: ${fileName} -> ${dest}`);
  });

  await win.loadURL(target);
  await sleep(2200);

  const fixtureBytes = await fsp.readFile(FIXTURE);
  const b64 = fixtureBytes.toString('base64');
  const inject = await win.webContents.executeJavaScript(`(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], ${JSON.stringify(path.basename(FIXTURE))}, { type: "text/plain" });
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    for (const input of inputs) {
      if (input.accept && input.accept.includes("json")) continue;
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, how: "input" };
      } catch (e) {}
    }
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      return { ok: true, how: "drop" };
    } catch (e) { return { ok: false, why: String(e) }; }
  })()`);
  log('注入文件:', JSON.stringify(inject));

  await sleep(5000);

  const before = await win.webContents.executeJavaScript(`(() => {
    const t = document.body.innerText || "";
    return {
      hasChapters: /第\\s*\\d*\\s*章|简介/.test(t),
      buttons: Array.from(document.querySelectorAll("button")).map(b => (b.innerText||"").replace(/\\s+/g,"")).filter(Boolean)
    };
  })()`);
  log('导入后状态:', JSON.stringify({ hasChapters: before.hasChapters }));

  // 点导出
  const click = await win.webContents.executeJavaScript(`(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const wanted = /^(导出|生成|保存)/;
    const btn = buttons.find(b => wanted.test((b.innerText||"").replace(/\\s+/g,"")));
    if (!btn) return { clicked: false, candidates: buttons.map(b=>(b.innerText||"").replace(/\\s+/g,"")) };
    btn.click();
    return { clicked: true, label: (btn.innerText||"").trim() };
  })()`);
  log('点击导出:', JSON.stringify(click));

  await sleep(7000);

  // 若还没下载，尝试点弹窗里的确认按钮
  if (!captured.length) {
    const confirm = await win.webContents.executeJavaScript(`(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const btn = buttons.find(b => /^(确定|确认|保存到|选择位置|继续|就这样)/.test((b.innerText||"").trim()));
      if (!btn) return { clicked: false, candidates: buttons.map(b=>(b.innerText||"").replace(/\\s+/g,"")) };
      btn.click();
      return { clicked: true, label: btn.innerText.trim() };
    })()`);
    log('二次确认:', JSON.stringify(confirm));
    await sleep(7000);
  }

  const shot = await win.webContents.capturePage();
  await fsp.writeFile(path.join(outDir, 'e2e-after-export.png'), shot.toPNG());

  const result = {
    target,
    injected: inject.ok === true,
    hasChapters: before.hasChapters,
    exportClicked: click.clicked === true,
    capturedFiles: captured.map((p) => ({ path: p, size: fs.existsSync(p) ? fs.statSync(p).size : 0 })),
    consoleErrors,
  };
  log('\n=== E2E 结果 ===');
  log(JSON.stringify(result, null, 2));

  win.destroy();
  app.exit(captured.length > 0 && consoleErrors.length === 0 ? 0 : 1);
}

app.whenReady().then(run).catch((err) => {
  console.error('E2E_FAILED', err);
  app.exit(1);
});
