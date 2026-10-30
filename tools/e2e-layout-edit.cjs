'use strict';

/**
 * 本轮四项改动的端到端验证（Lead 专用）。
 *
 *   A. 右侧设置面板可收起 / 展开，且收起后正文变宽
 *   B. 左侧主导航与章节列表各自独立收起（互不联动）
 *   C. 「退出本书」按钮存在，点击后回到空状态
 *   D. 正文编辑：删减文字 → 保存 → 字数/行数变化 → 标记「正文已修改」
 *
 * 用法：npx electron tools/e2e-layout-edit.cjs
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
const results = [];

/** 截图失败不应让功能断言挂掉：无显示环境（窗口 hidden）下 capturePage 会报错 */
async function safeShot(win, filePath) {
  try {
    const img = await win.webContents.capturePage();
    await fsp.writeFile(filePath, img.toPNG());
    return true;
  } catch (err) {
    log(`（截图跳过：${err && err.message}）`);
    return false;
  }
}

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function importFixture(win) {
  const b = await fsp.readFile(FIX);
  const b64 = b.toString('base64');
  return win.webContents.executeJavaScript(`(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], '测试小说_001.txt', { type: 'text/plain' });
    const input = document.querySelector('input[type="file"]:not([accept*="json"])');
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

async function run() {
  await fsp.mkdir(outDir, { recursive: true });
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    backgroundColor: '#faf6ee',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  const consoleErrors = [];
  win.webContents.on('console-message', (event) => {
    const level = event?.level;
    if (level === 'error' || level === 3) consoleErrors.push(String(event?.message ?? ''));
  });

  await win.loadURL(target);
  await sleep(2300);
  await importFixture(win);
  await sleep(5000);

  /* ================= A. 右侧面板收起 ================= */
  log('\n--- A. 右侧设置面板 ---');

  const asideInitial = await win.webContents.executeJavaScript(`(() => {
    const aside = document.querySelector('.convert__aside');
    const viewer = document.querySelector('.viewer');
    return {
      asideVisible: Boolean(aside && aside.offsetParent !== null),
      asideWidth: aside ? Math.round(aside.getBoundingClientRect().width) : 0,
      viewerWidth: viewer ? Math.round(viewer.getBoundingClientRect().width) : 0,
      collapseBtn: Boolean(document.querySelector('.tabs__collapse')),
    };
  })()`);
  check('右侧面板初始展开', asideInitial.asideVisible === true, `width=${asideInitial.asideWidth}`);
  check('有收起按钮', asideInitial.collapseBtn === true, '');

  await win.webContents.executeJavaScript(`document.querySelector('.tabs__collapse')?.click()`);
  await sleep(600);

  const asideCollapsed = await win.webContents.executeJavaScript(`(() => {
    const aside = document.querySelector('.convert__aside');
    const viewer = document.querySelector('.viewer');
    const restore = document.querySelector('.aside-restore');
    const head = document.querySelector('.viewer__head');
    const bodyEl = document.querySelector('.viewer__body');
    const rr = restore ? restore.getBoundingClientRect() : null;
    const br = bodyEl ? bodyEl.getBoundingClientRect() : null;
    const lastAction = document.querySelector('.viewer__nav')?.getBoundingClientRect();
    return {
      asideVisible: Boolean(aside && aside.offsetParent !== null),
      oldRailExists: Boolean(document.querySelector('.convert__aside-rail')),
      restoreVisible: Boolean(restore && restore.offsetParent !== null),
      insideToolbar: Boolean(restore && head && head.contains(restore)),
      // 横向：宽度应明显大于高度
      horizontal: rr ? rr.width > rr.height : false,
      restoreRect: rr ? { x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width), h: Math.round(rr.height) } : null,
      lastActionRight: lastAction ? Math.round(lastAction.right) : null,
      // 在正文之上，而不是正文下方
      aboveBody: Boolean(rr && br && rr.bottom <= br.top + 2),
      viewerWidth: viewer ? Math.round(viewer.getBoundingClientRect().width) : 0,
    };
  })()`);
  check('收起后右侧面板隐藏', asideCollapsed.asideVisible === false, '');
  check('旧的正文下方竖条已移除', asideCollapsed.oldRailExists === false, '');
  check('工具栏内出现恢复入口', asideCollapsed.restoreVisible === true && asideCollapsed.insideToolbar === true,
    JSON.stringify(asideCollapsed.restoreRect));
  check('恢复入口为横向', asideCollapsed.horizontal === true, '');
  check('恢复入口在正文之上（不在下方）', asideCollapsed.aboveBody === true, '');
  check('恢复入口在操作按钮之后', asideCollapsed.restoreRect && asideCollapsed.lastActionRight !== null
    ? asideCollapsed.restoreRect.x >= asideCollapsed.lastActionRight - 2 : false,
    `restore.x=${asideCollapsed.restoreRect?.x} lastAction.right=${asideCollapsed.lastActionRight}`);
  check('收起后正文变宽', asideCollapsed.viewerWidth > asideInitial.viewerWidth,
    `${asideInitial.viewerWidth} → ${asideCollapsed.viewerWidth}`);

  await win.webContents.executeJavaScript(`document.querySelector('.aside-restore__toggle')?.click()`);
  await sleep(600);
  const asideRestored = await win.webContents.executeJavaScript(
    `Boolean(document.querySelector('.convert__aside')?.offsetParent !== null)`,
  );
  check('点工具栏入口可重新展开', asideRestored === true, '');

  /* ================= B. 左侧两处独立收起 ================= */
  log('\n--- B. 主导航 / 章节列表独立收起 ---');

  const layoutBefore = await win.webContents.executeJavaScript(`(() => {
    const nav = document.querySelector('.nav');
    const chapters = document.querySelector('.chapters');
    return {
      navWidth: nav ? Math.round(nav.getBoundingClientRect().width) : 0,
      chapterVisible: Boolean(chapters && chapters.offsetParent !== null),
    };
  })()`);
  log('初始布局:', JSON.stringify(layoutBefore));

  // 只点主题栏的「主导航」按钮
  await win.webContents.executeJavaScript(`(() => {
    const btn = document.querySelector('.titlebar__toggle');
    btn?.click();
  })()`);
  await sleep(600);
  const afterNavCollapse = await win.webContents.executeJavaScript(`(() => {
    const nav = document.querySelector('.nav');
    const chapters = document.querySelector('.chapters');
    return {
      navWidth: nav ? Math.round(nav.getBoundingClientRect().width) : 0,
      navCollapsed: nav ? nav.classList.contains('nav--collapsed') : null,
      chapterVisible: Boolean(chapters && chapters.offsetParent !== null),
    };
  })()`);
  check('收起主导航：导航变窄', afterNavCollapse.navCollapsed === true, `width=${afterNavCollapse.navWidth}`);
  check('收起主导航：章节列表不受影响', afterNavCollapse.chapterVisible === true, '');

  // 再点章节列表自己的收起按钮
  await win.webContents.executeJavaScript(`(() => {
    const btn = Array.from(document.querySelectorAll('.chapters__icon-btn')).find(b => (b.getAttribute('aria-label')||'').includes('收起'));
    btn?.click();
  })()`);
  await sleep(600);
  const afterChapterCollapse = await win.webContents.executeJavaScript(`(() => {
    const nav = document.querySelector('.nav');
    const chapters = document.querySelector('.chapters');
    const reopen = document.querySelector('.convert__reopen');
    return {
      navWidth: nav ? Math.round(nav.getBoundingClientRect().width) : 0,
      chapterVisible: Boolean(chapters && chapters.offsetParent !== null),
      reopenVisible: Boolean(reopen && reopen.offsetParent !== null),
    };
  })()`);
  check('收起章节列表：列表隐藏', afterChapterCollapse.chapterVisible === false, '');
  check('收起章节列表：出现展开窄条', afterChapterCollapse.reopenVisible === true, '');
  check('收起章节列表：导航保持原状', afterChapterCollapse.navWidth === afterNavCollapse.navWidth,
    `${afterNavCollapse.navWidth} → ${afterChapterCollapse.navWidth}`);

  // 恢复
  await win.webContents.executeJavaScript(`document.querySelector('.convert__reopen')?.click()`);
  await sleep(500);
  await win.webContents.executeJavaScript(`document.querySelector('.titlebar__toggle')?.click()`);
  await sleep(500);

  await safeShot(win, path.join(outDir, 'layout-collapsed.png'));

  /* ================= D. 正文编辑 ================= */
  log('\n--- D. 正文编辑（删减文字） ---');

  // 选中一个正文较长的章节（第 5 章）
  await win.webContents.executeJavaScript(`(() => {
    const rows = Array.from(document.querySelectorAll('.chapter-row'));
    const target = rows[5] ?? rows[1];
    target?.click();
  })()`);
  await sleep(700);

  const beforeEdit = await win.webContents.executeJavaScript(`(() => {
    const strip = document.querySelector('.viewer__strip');
    const text = strip ? strip.innerText.replace(/\\s+/g, ' ') : '';
    return {
      stripText: text,
      hasEditBtn: Array.from(document.querySelectorAll('button')).some(b => (b.innerText||'').includes('编辑正文')),
      isInlineEditable: document.querySelector('.prose--editable')?.getAttribute('contenteditable') === 'true',
      hasTextarea: Boolean(document.querySelector('.viewer__textarea')),
    };
  })()`);
  check('正文内联可编辑（无按钮、无 textarea）',
    beforeEdit.isInlineEditable === true && beforeEdit.hasEditBtn === false && beforeEdit.hasTextarea === false,
    `editable=${beforeEdit.isInlineEditable} btn=${beforeEdit.hasEditBtn} textarea=${beforeEdit.hasTextarea}`);
  log('编辑前:', beforeEdit.stripText);

  const editorState = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.prose--editable');
    return {
      hasEditor: Boolean(el),
      length: el ? el.innerText.length : 0,
      lineCount: el ? el.innerText.split('\\n').length : 0,
    };
  })()`);
  check('正文区可接受输入', editorState.hasEditor === true, `${editorState.length} 字符 / ${editorState.lineCount} 行`);

  // 在光标处删字，模拟「删减文字」
  const editResult = await win.webContents.executeJavaScript(`(async () => {
    const el = document.querySelector('.prose--editable');
    const before = el.innerText;
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    // 删掉末尾 12 个字符（等价于连续退格）
    for (let i = 0; i < 12; i++) document.execCommand('delete');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1000));
    return { ok: true, beforeLength: before.length, afterLength: el.innerText.length };
  })()`);
  check('删减正文内容', editResult.ok && editResult.afterLength < editResult.beforeLength,
    `${editResult.beforeLength} → ${editResult.afterLength} 字符`);

  await sleep(700);
  const afterSave = await win.webContents.executeJavaScript(`(() => {
    const strip = document.querySelector('.viewer__strip');
    const text = strip ? strip.innerText.replace(/\\s+/g, ' ') : '';
    return {
      stripText: text,
      editedBadge: Boolean(document.querySelector('.viewer__strip-edited')),
      autoSavedBadge: Boolean(document.querySelector('.viewer__strip-saved')),
    };
  })()`);
  check('显示「正文已修改」标记', afterSave.editedBadge === true, '');
  check('显示「已自动保存」', afterSave.autoSavedBadge === true, '');
  check('行数已更新', /\d+ 行/.test(afterSave.stripText) && afterSave.stripText !== beforeEdit.stripText,
    `before="${beforeEdit.stripText}" after="${afterSave.stripText}"`);

  await safeShot(win, path.join(outDir, 'body-edited.png'));

  /* ================= C. 退出本书 ================= */
  log('\n--- C. 退出本书 ---');

  const exitBtn = await win.webContents.executeJavaScript(`(() => {
    const btn = Array.from(document.querySelectorAll('.titlebar__exit'));
    return { count: btn.length, text: btn[0] ? btn[0].innerText.trim() : '' };
  })()`);
  check('标题栏有「退出本书」按钮', exitBtn.count === 1, exitBtn.text);

  await win.webContents.executeJavaScript(`document.querySelector('.titlebar__exit')?.click()`);
  await sleep(700);
  const confirmModal = await win.webContents.executeJavaScript(`(() => {
    const modal = document.querySelector('.modal, [role="dialog"]');
    return { open: Boolean(modal), text: modal ? modal.innerText.replace(/\\s+/g,' ').slice(0, 120) : '' };
  })()`);
  check('点退出弹出确认框', confirmModal.open === true, confirmModal.text);

  // 确认清空
  await win.webContents.executeJavaScript(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText||'').includes('清空工作区'));
    btn?.click();
  })()`);
  await sleep(1200);
  const afterExit = await win.webContents.executeJavaScript(`(() => {
    const t = document.body.innerText;
    return {
      backToEmpty: /把 TXT 送进墨匣/.test(t),
      hasExitBtn: document.querySelectorAll('.titlebar__exit').length,
      hasChapters: /章节/.test(t) && document.querySelectorAll('.chapter-row').length > 0,
    };
  })()`);
  check('退出后回到空状态', afterExit.backToEmpty === true, '');
  check('退出后不再显示本书按钮', afterExit.hasExitBtn === 0, `count=${afterExit.hasExitBtn}`);
  check('退出后章节已清空', afterExit.hasChapters === false, '');

  const failed = results.filter((r) => !r.ok);
  log(`\n========== 汇总: ${results.length - failed.length}/${results.length} 通过 ==========`);
  if (failed.length) log(JSON.stringify(failed, null, 2));
  if (consoleErrors.length) log('控制台错误:', JSON.stringify(consoleErrors.slice(0, 5)));

  await fsp.writeFile(path.join(outDir, 'layout-edit-report.json'), JSON.stringify({ results, consoleErrors }, null, 2));
  win.destroy();
  app.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(run).catch((e) => {
  console.error('E2E_FAILED', e);
  app.exit(1);
});
