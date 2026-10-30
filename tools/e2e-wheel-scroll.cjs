'use strict';

/**
 * 正文滚轮滚动回归测试（Lead 专用）。
 *
 * 背景：`.viewer` 作为 grid 子项时 `min-height` 默认 auto，内容一长就把
 * 整块撑到 7000+ px（父容器只有 635px），`.viewer__body` 因此没有可滚动空间，
 * 表现为「只能用方向键、滚轮滚不动」。
 *
 * 本测试用 Electron 的 sendInputEvent 发**真实滚轮事件**（合成 JS 事件不会
 * 触发原生滚动），覆盖三种情况：
 *   A. 正文区分焦态（未点击正文）
 *   B. 正文区聚焦态（点击正文进入编辑后）
 *   C. 940 窄窗口（上下堆叠，滚动交给外层 .convert__body）
 *
 * 用法：npx electron tools/e2e-wheel-scroll.cjs
 */

const { app, BrowserWindow } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tools', 'e2e-output');
const target = `file://${path.join(root, 'dist', 'index.html').replace(/\\/g, '/')}`;
const FIX = path.join(root, 'tests', 'fixtures', '测试小说_001.txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// 关掉第一个窗口后不要自动退出，否则第二个窗口还没建起来 app 就结束了
app.on('window-all-closed', () => {});
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function openFixture(win, width) {
  await win.loadURL(target);
  await sleep(2300);
  const b = await fsp.readFile(FIX);
  const b64 = b.toString('base64');
  await win.webContents.executeJavaScript(`(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const f = new File([arr], '测试小说_001.txt', { type: 'text/plain' });
    const inp = document.querySelector('input[type="file"]:not([accept*="json"])');
    const dt = new DataTransfer(); dt.items.add(f);
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(5000);
  await win.webContents.executeJavaScript(`(() => {
    const rows = Array.from(document.querySelectorAll('.chapter-row'));
    (rows[5] ?? rows[1])?.click();
  })()`);
  await sleep(800);
}

/** 发 n 次真实滚轮事件 */
async function wheel(win, x, y, times = 6, deltaY = -120) {
  for (let i = 0; i < times; i += 1) {
    win.webContents.sendInputEvent({
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY,
      wheelTicksX: 0,
      wheelTicksY: Math.sign(-deltaY),
      canScroll: true,
    });
    await sleep(100);
  }
  await sleep(500);
}

async function readScroll(win, selector) {
  return win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { missing: true };
    const r = el.getBoundingClientRect();
    return {
      top: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + Math.min(180, r.height / 2)),
    };
  })()`);
}

async function run() {
  await fsp.mkdir(outDir, { recursive: true });

  /* ---------- A/B. 1440 宽：未聚焦 + 聚焦 ---------- */
  const wide = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await openFixture(wide);

  const wideBefore = await readScroll(wide, '.viewer__body');
  check('滚动容器高度被约束（不再随内容撑满）',
    wideBefore.clientHeight > 0 && wideBefore.clientHeight < wideBefore.scrollHeight,
    `client=${wideBefore.clientHeight} scroll=${wideBefore.scrollHeight}`);

  // A. 未聚焦
  await wheel(wide, wideBefore.x, wideBefore.y);
  const afterUnfocused = await readScroll(wide, '.viewer__body');
  check('A. 未聚焦时滚轮可滚动', afterUnfocused.top > 20, `top 0 → ${afterUnfocused.top}`);

  // 回顶部再测聚焦态
  await wide.webContents.executeJavaScript(`(() => { document.querySelector('.viewer__body').scrollTop = 0; })()`);
  await sleep(400);

  // 点击正文，使编辑区获得焦点
  const clickPoint = await wide.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('.viewer__body');
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 160) };
  })()`);
  wide.webContents.sendInputEvent({ type: 'mouseDown', x: clickPoint.x, y: clickPoint.y, button: 'left', clickCount: 1 });
  wide.webContents.sendInputEvent({ type: 'mouseUp', x: clickPoint.x, y: clickPoint.y, button: 'left', clickCount: 1 });
  await sleep(400);
  const focused = await wide.webContents.executeJavaScript(
    `document.activeElement?.classList?.contains('prose--editable') || false`,
  );
  check('点击正文后编辑区获得焦点', focused === true, '');

  await wheel(wide, clickPoint.x, clickPoint.y);
  const afterFocused = await readScroll(wide, '.viewer__body');
  check('B. 聚焦编辑时滚轮同样可滚动', afterFocused.top > 20, `top 0 → ${afterFocused.top}`);

  // 方向键仍然可用（不因修复被破坏）
  await wide.webContents.executeJavaScript(`(() => { document.querySelector('.viewer__body').scrollTop = 0; })()`);
  await sleep(300);
  await wide.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.prose--editable');
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el); range.collapse(false);
    sel.removeAllRanges(); sel.addRange(range);
  })()`);
  await sleep(200);
  const beforeArrow = await wide.webContents.executeJavaScript(`document.querySelector('.viewer__body').scrollTop`);
  for (let i = 0; i < 5; i += 1) {
    wide.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Up' });
    await sleep(80);
  }
  await sleep(400);
  const afterArrow = await wide.webContents.executeJavaScript(`document.querySelector('.viewer__body').scrollTop`);
  check('方向键仍能移动（未回退）', afterArrow >= 0, `top=${afterArrow}`);

  const imgWide = await wide.webContents.capturePage();
  await fsp.writeFile(path.join(outDir, 'wheel-wide.png'), imgWide.toPNG());
  wide.destroy();

  /* ---------- C. 940 窄：外层滚动 ---------- */
  const narrow = new BrowserWindow({
    width: 940,
    height: 640,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await openFixture(narrow, 940);

  const narrowOuter = await readScroll(narrow, '.convert__body');
  check('窄窗：外层容器是滚动容器',
    narrowOuter.scrollHeight > narrowOuter.clientHeight,
    `client=${narrowOuter.clientHeight} scroll=${narrowOuter.scrollHeight}`);

  await wheel(narrow, narrowOuter.x, narrowOuter.y);
  const narrowAfter = await readScroll(narrow, '.convert__body');
  check('C. 940 窄窗口滚轮可滚动', narrowAfter.top > 20, `top 0 → ${narrowAfter.top}`);

  const noHScroll = await narrow.webContents.executeJavaScript(
    `document.documentElement.scrollWidth <= document.documentElement.clientWidth`,
  );
  check('窄窗无横向滚动', noHScroll === true, '');

  const imgNarrow = await narrow.webContents.capturePage();
  await fsp.writeFile(path.join(outDir, 'wheel-narrow.png'), imgNarrow.toPNG());
  narrow.destroy();

  const failed = results.filter((r) => !r.ok);
  log(`\n========== 汇总: ${results.length - failed.length}/${results.length} 通过 ==========`);
  if (failed.length) log(JSON.stringify(failed, null, 2));

  await fsp.writeFile(path.join(outDir, 'wheel-report.json'), JSON.stringify({ results }, null, 2));
  app.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(run).catch((e) => {
  console.error('E2E_WHEEL_FAILED', e);
  app.exit(1);
});
