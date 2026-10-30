'use strict';

/**
 * EPUB 编辑端到端验收（task-5，qa-verifier 独立验收脚本）。
 *
 * 覆盖：
 *   1. 导航「EPUB 编辑」出现并可切换视图；
 *   2. 通过 input[accept*=".epub"] 注入 tools/sample-output/sample-book.epub（非 inkbox 生成的样书）；
 *   3. 章节数量 / 标题顺序 / 书籍信息 / Quill 正文 / 加粗斜体；
 *   4. 修改书名、修改一章标题、新增章节、上移/下移、删除新增章节；
 *   5. 点击「保存 EPUB」走浏览器下载路径：拦截 URL.createObjectURL 与 anchor click，
 *      捕获导出的 Blob 字节并写到 tools/e2e-output/epub-edited.epub；
 *   6. 把导出的 EPUB 重新注入应用，断言书名与章节顺序持久化；
 *   7. 浅色 / 深色截图（1440x900 窗口）写入 docs/ui/。
 *
 * 用法：npx electron tools/e2e-epub-edit.cjs
 * 前置：node tools/gen-epub-fixture.mjs && npm run build:web
 */

const { app, BrowserWindow } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');

// 本机/CI 的 Electron 窗口可能没有可用的硬件合成表面：
// 关闭硬件加速后由软件合成器出帧，capturePage 才能稳定拿到当前主题的画面。
app.disableHardwareAcceleration();

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tools', 'e2e-output');
const shotsDir = path.join(root, 'docs', 'ui');
const fixturePath = path.join(root, 'tools', 'sample-output', 'sample-book.epub');
const exportedPath = path.join(outDir, 'epub-edited.epub');
const reportPath = path.join(outDir, 'epub-edit-report.json');
const distEntry = path.join(root, 'dist', 'index.html');
const targetUrl = 'file://' + distEntry.replace(/\\/g, '/');

const EXPECTED_TITLES = ['序章', '第一章 起风', '第二章 入夜', '第三章 归途'];
const BOOK_TITLE = '雾里山河';
const BOOK_AUTHOR = '青灯客';
const EDITED_TITLE = '雾里山河（精修版）';
const RENAMED_CHAPTER = '第一章 起风（修订）';
const FINAL_ORDER = ['序章', '第一章 起风（修订）', '第三章 归途', '第二章 入夜'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const consoleErrors = [];
let pageErrors = [];

function check(name, ok, detail) {
  const passed = ok === true;
  results.push({ name: name, ok: passed, detail: detail === undefined || detail === null ? '' : String(detail) });
  console.log((passed ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
}

async function evalJs(win, source) {
  return win.webContents.executeJavaScript(source, true);
}

async function waitUntil(win, source, predicate, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 15000);
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await evalJs(win, source);
    } catch (error) {
      last = { evalError: String(error && error.message ? error.message : error) };
    }
    try {
      if (predicate(last)) return last;
    } catch (error) {
      last = { predicateError: String(error) };
    }
    await sleep(250);
  }
  throw new Error('等待超时: ' + label + ' | last=' + JSON.stringify(last));
}

/* ------------------------------------------------------------
   页面内脚本生成器（全部用字符串拼接，方便在 executeJavaScript 中执行）
   ------------------------------------------------------------ */

const SNAPSHOT_SOURCE =
  '(function(){' +
  '  var rows = Array.prototype.slice.call(document.querySelectorAll(".chapter-row"));' +
  '  var titles = rows.map(function(row){ var el = row.querySelector(".chapter-row__title"); return el ? (el.innerText || "").replace(/\\s+/g, " ").trim() : ""; });' +
  '  var titleInput = document.querySelector("#epub-meta-title");' +
  '  var authorInput = document.querySelector("#epub-meta-author");' +
  '  var publisherInput = document.querySelector("#epub-meta-publisher");' +
  '  var editor = document.querySelector(".ql-editor");' +
  '  var editorTitleEl = document.querySelector("#epub-editor-title");' +
  '  var navItem = Array.prototype.slice.call(document.querySelectorAll(".nav__item")).filter(function(b){ return (b.innerText || "").indexOf("EPUB 编辑") >= 0; })[0];' +
  '  var aside = document.querySelector(".epub__aside");' +
  '  var chapters = document.querySelector(".chapters");' +
  '  var nav = document.querySelector(".nav");' +
  '  var exportButton = document.querySelector(".epub-fab");' +
  '  return {' +
  '    viewEpub: !!document.querySelector(".app__view--epub"),' +
  '    dropVisible: !!document.querySelector(".drop"),' +
  '    dropTitle: document.querySelector("#epub-drop-title") ? document.querySelector("#epub-drop-title").innerText.trim() : "",' +
  '    navItemFound: !!navItem,' +
  '    navItemActive: !!(navItem && navItem.className.indexOf("nav__item--active") >= 0),' +
  '    ready: !!document.querySelector(".epub"),' +
  '    rowCount: rows.length,' +
  '    titles: titles,' +
  '    selectedTitle: rows.filter(function(r){ return r.className.indexOf("chapter-row--on") >= 0; }).map(function(r){ var el = r.querySelector(".chapter-row__title"); return el ? el.innerText.trim() : ""; })[0] || "",' +
  '    metaTitle: titleInput ? titleInput.value : null,' +
  '    metaAuthor: authorInput ? authorInput.value : null,' +
  '    metaPublisher: publisherInput ? publisherInput.value : null,' +
  '    editorTitle: editorTitleEl ? editorTitleEl.innerText.trim() : "",' +
  '    qlExists: !!editor,' +
  '    qlText: editor ? (editor.innerText || "").replace(/\\s+/g, " ").trim() : "",' +
  '    qlParagraphs: editor ? editor.querySelectorAll("p").length : 0,' +
  '    qlStrong: editor ? editor.querySelectorAll("strong").length : 0,' +
  '    qlEm: editor ? editor.querySelectorAll("em").length : 0,' +
  '    toastTexts: Array.prototype.slice.call(document.querySelectorAll(".toast")).map(function(t){ return (t.innerText || "").replace(/\\s+/g, " ").trim(); }),' +
  '    sourceName: document.querySelector(".titlebar__file") ? document.querySelector(".titlebar__file").innerText.replace(/\\s+/g, " ").trim() : "",' +
  '    exportButtonFound: !!exportButton,' +
  '    importButtonFound: !!document.querySelector(".drop__actions button"),' +
  '    layout: {' +
  '      nav: !!(nav && nav.offsetParent !== null && nav.getBoundingClientRect().width > 0),' +
  '      navCollapsed: !!(nav && nav.className.indexOf("nav--collapsed") >= 0),' +
  '      chapters: !!(chapters && chapters.offsetParent !== null && chapters.getBoundingClientRect().width > 0),' +
  '      aside: !!(aside && aside.offsetParent !== null && aside.getBoundingClientRect().width > 0),' +
  '      asideRestore: !!(document.querySelector(".aside-restore__toggle") && document.querySelector(".aside-restore__toggle").offsetParent !== null),' +
  '      editor: !!(document.querySelector(".editor") && document.querySelector(".editor").getBoundingClientRect().width > 0)' +
  '    },' +
  '    uncaughtErrors: window.__uncaughtErrors ? window.__uncaughtErrors.slice() : []' +
  '  };' +
  '})()';

function setInputSource(selector, value) {
  return (
    '(function(){' +
    '  var el = document.querySelector(' + JSON.stringify(selector) + ');' +
    '  if (!el) return { ok: false, reason: "missing" };' +
    '  var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;' +
    '  var setter = Object.getOwnPropertyDescriptor(proto, "value").set;' +
    '  setter.call(el, ' + JSON.stringify(value) + ');' +
    '  el.dispatchEvent(new Event("input", { bubbles: true }));' +
    '  return { ok: true, value: el.value };' +
    '})()'
  );
}

function clickButtonByTextSource(scopeSelector, text) {
  const compact = String(text).replace(/\s+/g, '');
  return (
    '(function(){' +
    '  var scope = ' + (scopeSelector ? 'document.querySelector(' + JSON.stringify(scopeSelector) + ')' : 'document') + ';' +
    '  if (!scope) return { clicked: false, reason: "scope-missing" };' +
    '  var buttons = Array.prototype.slice.call(scope.querySelectorAll("button"));' +
    '  var btn = buttons.filter(function(b){ return (b.innerText || "").replace(/\\s+/g, "").indexOf(' + JSON.stringify(compact) + ') >= 0; })[0];' +
    '  if (!btn) return { clicked: false, candidates: buttons.map(function(b){ return (b.innerText || "").replace(/\\s+/g, ""); }) };' +
    '  btn.click();' +
    '  return { clicked: true, label: (btn.innerText || "").trim() };' +
    '})()'
  );
}

function clickThemeSource(label) {
  return (
    '(function(){' +
    '  var buttons = Array.prototype.slice.call(document.querySelectorAll(".seg__btn"));' +
    '  var btn = buttons.filter(function(b){ return (b.getAttribute("aria-label") || "") === ' + JSON.stringify(label) + '; })[0];' +
    '  if (!btn) return { clicked: false, labels: buttons.map(function(b){ return b.getAttribute("aria-label"); }) };' +
    '  btn.click();' +
    '  return { clicked: true };' +
    '})()'
  );
}

function clickRowActionSource(title, ariaLabel) {
  return (
    '(function(){' +
    '  var rows = Array.prototype.slice.call(document.querySelectorAll(".chapter-row"));' +
    '  var row = rows.filter(function(r){ var el = r.querySelector(".chapter-row__title"); return el && (el.innerText || "").indexOf(' + JSON.stringify(title) + ') >= 0; })[0];' +
    '  if (!row) return { clicked: false, reason: "row-not-found", titles: rows.map(function(r){ var el = r.querySelector(".chapter-row__title"); return el ? el.innerText.trim() : ""; }) };' +
    '  var btn = row.querySelector(' + JSON.stringify('[aria-label="' + ariaLabel + '"]') + ');' +
    '  if (!btn) return { clicked: false, reason: "button-not-found" };' +
    '  btn.click();' +
    '  return { clicked: true, disabled: !!btn.disabled };' +
    '})()'
  );
}

function selectRowSource(index) {
  return (
    '(function(){' +
    '  var rows = document.querySelectorAll(".chapter-row");' +
    '  if (!rows[' + index + ']) return false;' +
    '  rows[' + index + '].click();' +
    '  return true;' +
    '})()'
  );
}

function importEpubSource(base64, fileName) {
  return (
    '(async function(){' +
    '  var bin = atob(' + JSON.stringify(base64) + ');' +
    '  var arr = new Uint8Array(bin.length);' +
    '  for (var i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);' +
    '  var file = new File([arr], ' + JSON.stringify(fileName) + ', { type: "application/epub+zip" });' +
    '  var input = document.querySelector(' + JSON.stringify('input[accept*=".epub"]') + ');' +
    '  if (!input) return { ok: false, reason: "no-epub-input" };' +
    '  var dt = new DataTransfer();' +
    '  dt.items.add(file);' +
    '  input.files = dt.files;' +
    '  input.dispatchEvent(new Event("change", { bubbles: true }));' +
    '  return { ok: true, inputAccept: input.accept };' +
    '})()'
  );
}

const INSTALL_CAPTURE_SOURCE =
  '(function(){' +
  '  window.__epubCapture = { blobs: [], anchors: [] };' +
  '  window.URL.createObjectURL = function(blob){ window.__epubCapture.blobs.push(blob); return "blob:captured-epub"; };' +
  '  window.URL.revokeObjectURL = function(){};' +
  '  var originalClick = window.HTMLAnchorElement && window.HTMLAnchorElement.prototype.click;' +
  '  window.HTMLAnchorElement.prototype.click = function(){' +
  '    window.__epubCapture.anchors.push({ href: this.href, download: this.download, rel: this.rel });' +
  '  };' +
  '  return { installed: true, hadOriginalClick: typeof originalClick === "function" };' +
  '})()';

const READ_CAPTURE_SOURCE =
  '(async function(){' +
  '  var capture = window.__epubCapture;' +
  '  if (!capture || capture.blobs.length === 0) return null;' +
  '  var blob = capture.blobs[capture.blobs.length - 1];' +
  '  var buffer = new Uint8Array(await blob.arrayBuffer());' +
  '  var binary = "";' +
  '  var chunkSize = 0x8000;' +
  '  for (var i = 0; i < buffer.length; i += chunkSize) {' +
  '    binary += String.fromCharCode.apply(null, buffer.subarray(i, i + chunkSize));' +
  '  }' +
  '  return {' +
  '    size: buffer.length,' +
  '    type: blob.type,' +
  '    base64: btoa(binary),' +
  '    anchors: capture.anchors.slice(),' +
  '    blobCount: capture.blobs.length' +
  '  };' +
  '})()';

const DISABLE_TRANSITIONS_SOURCE =
  '(function(){' +
  '  if (document.getElementById("__qa_no_transition")) return false;' +
  '  var style = document.createElement("style");' +
  '  style.id = "__qa_no_transition";' +
  '  style.textContent = "*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; transition-delay: 0s !important; animation-delay: 0s !important; } ::selection { background-color: transparent !important; color: inherit !important; }";' +
  '  document.head.appendChild(style);' +
  '  return true;' +
  '})()';

const THEME_INFO_SOURCE =
  '(function(){' +
  '  var app = document.querySelector(".app");' +
  '  return {' +
  '    attr: document.documentElement.dataset.theme || "system",' +
  '    appBg: app ? getComputedStyle(app).backgroundColor : null,' +
  '    bodyBg: getComputedStyle(document.body).backgroundColor' +
  '  };' +
  '})()';

const CLEAR_SELECTION_SOURCE =
  '(function(){' +
  '  try { var selection = window.getSelection(); if (selection) selection.removeAllRanges(); } catch (error) {}' +
  '  var active = document.activeElement;' +
  '  if (active && typeof active.blur === "function") active.blur();' +
  '  return true;' +
  '})()';

const DISMISS_TOASTS_SOURCE =
  '(function(){' +
  '  var buttons = Array.prototype.slice.call(document.querySelectorAll(".toast__close"));' +
  '  buttons.forEach(function(btn){ btn.click(); });' +
  '  return buttons.length;' +
  '})()';

/* ------------------------------------------------------------
   截图
   ------------------------------------------------------------ */

function imageAverage(image) {
  const bitmap = image.toBitmap();
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let i = 0; i < bitmap.length; i += 4) {
    blue += bitmap[i];
    green += bitmap[i + 1];
    red += bitmap[i + 2];
    count += 1;
  }
  if (!count) return { r: 0, g: 0, b: 0, sum: 0 };
  const r = Math.round(red / count);
  const g = Math.round(green / count);
  const b = Math.round(blue / count);
  return { r: r, g: g, b: b, sum: r + g + b };
}

async function captureShot(win, filePath) {
  // 隐藏窗口的合成器有时会返回上一帧：先 invalidate + 预热一次 capturePage，
  // 等一帧后再取真正要落盘的画面（否则浅色截图可能拿到导入前的空状态旧帧）。
  try {
    if (typeof win.webContents.invalidate === 'function') win.webContents.invalidate();
  } catch (error) {
    /* 忽略：部分平台没有该 API */
  }
  try {
    await win.webContents.capturePage();
  } catch (error) {
    /* 预热失败也继续，正式捕获会重试 */
  }
  await sleep(450);
  let lastError = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const image = await win.webContents.capturePage();
      const size = image.getSize();
      const png = image.toPNG();
      await fsp.writeFile(filePath, png);
      const stat = await fsp.stat(filePath);
      return { path: filePath, width: size.width, height: size.height, bytes: stat.size, attempts: attempt, avg: imageAverage(image) };
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw new Error('截图失败: ' + String(lastError && lastError.message ? lastError.message : lastError));
}

/* ------------------------------------------------------------
   主流程
   ------------------------------------------------------------ */

async function run() {
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.mkdir(shotsDir, { recursive: true });

  try {
    await fsp.access(fixturePath);
  } catch (error) {
    throw new Error('缺少样书，请先运行 node tools/gen-epub-fixture.mjs：' + fixturePath);
  }
  try {
    await fsp.access(distEntry);
  } catch (error) {
    throw new Error('缺少 dist/index.html，请先运行 npm run build:web：' + distEntry);
  }

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#faf6ee',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 隐藏窗口默认会被 Chromium 节流样式重算与绘制，导致截图拿到上一帧
      backgroundThrottling: false,
      paintWhenInitiallyHidden: true,
    },
  });
  win.webContents.on('console-message', function () {
    const args = Array.prototype.slice.call(arguments);
    const first = args[0];
    let level;
    let message;
    if (first && typeof first === 'object' && 'level' in first) {
      level = first.level;
      message = first.message;
    } else {
      level = args[1];
      message = args[2];
    }
    if (level === 'error' || level === 3) consoleErrors.push(String(message === undefined ? '' : message));
  });
  win.webContents.on('render-process-gone', function (_event, details) {
    pageErrors.push('render-process-gone: ' + JSON.stringify(details));
  });
  win.webContents.on('preload-error', function (_event, preloadPath, error) {
    pageErrors.push('preload-error: ' + preloadPath + ' ' + String(error));
  });

  console.log('加载页面:', targetUrl);
  await win.loadURL(targetUrl);
  await sleep(1600);

  // 捕获未处理的页面错误
  await evalJs(
    win,
    '(function(){' +
      '  window.__uncaughtErrors = [];' +
      '  window.addEventListener("error", function(e){ window.__uncaughtErrors.push("error: " + String(e.message || e.error)); });' +
      '  window.addEventListener("unhandledrejection", function(e){ window.__uncaughtErrors.push("unhandledrejection: " + String(e.reason)); });' +
      '  return true;' +
      '})()',
  );

  /* ---------- 1. 导航 ---------- */
  console.log('\n--- 1. 导航与视图切换 ---');
  const navReady = await waitUntil(
    win,
    SNAPSHOT_SOURCE,
    function (state) {
      return state && state.navItemFound === true;
    },
    8000,
    '主导航出现',
  );
  check('主导航出现「EPUB 编辑」入口', navReady.navItemFound === true, '');

  const navClick = await evalJs(win, clickButtonByTextSource('.nav', 'EPUB 编辑'));
  check('点击「EPUB 编辑」', navClick.clicked === true, navClick.label || JSON.stringify(navClick));

  await sleep(600);
  const emptyState = await evalJs(win, SNAPSHOT_SOURCE);
  check('视图切换到 EPUB 编辑', emptyState.viewEpub === true && emptyState.navItemActive === true, '');
  check('空状态显示「打开 EPUB」', emptyState.dropVisible === true && emptyState.dropTitle === '打开 EPUB', emptyState.dropTitle);
  check('空状态有导入按钮', emptyState.importButtonFound === true, '');

  /* ---------- 2. 注入样书 ---------- */
  console.log('\n--- 2. 导入非 inkbox 结构样书 ---');
  const fixtureBytes = await fsp.readFile(fixturePath);
  const fixtureBase64 = fixtureBytes.toString('base64');
  const importResult = await evalJs(win, importEpubSource(fixtureBase64, 'sample-book.epub'));
  check('通过 input[accept*=".epub"] 注入样书', importResult.ok === true && importResult.inputAccept.indexOf('.epub') >= 0, importResult.inputAccept || JSON.stringify(importResult));

  const imported = await waitUntil(
    win,
    SNAPSHOT_SOURCE,
    function (state) {
      return state && state.ready === true && state.rowCount === 4;
    },
    25000,
    '样书解析完成',
  );

  check('章节行数量为 4', imported.rowCount === 4, 'rowCount=' + imported.rowCount);
  check('章节标题顺序正确', imported.titles.join('|') === EXPECTED_TITLES.join('|'), imported.titles.join(' / '));
  check('书籍信息显示书名', imported.metaTitle === BOOK_TITLE, 'value=' + imported.metaTitle);
  check('书籍信息显示作者', imported.metaAuthor === BOOK_AUTHOR, 'value=' + imported.metaAuthor);
  check('书籍信息显示出版方', imported.metaPublisher === '青灯书局', 'value=' + imported.metaPublisher);
  check('标题栏显示导入文件名', imported.sourceName.indexOf('sample-book.epub') >= 0, imported.sourceName);
  check('Quill 编辑区存在', imported.qlExists === true, '');
  check('Quill 正文包含首章内容', imported.qlText.indexOf('雾从山脚漫上来') >= 0, 'chars=' + imported.qlText.length);
  check('Quill 正文为多个段落', imported.qlParagraphs >= 4, 'paragraphs=' + imported.qlParagraphs);
  check('Quill 保留加粗', imported.qlStrong >= 1, 'strong=' + imported.qlStrong);
  check('Quill 保留斜体', imported.qlEm >= 1, 'em=' + imported.qlEm);
  check('默认选中第一章且编辑器标题正确', imported.selectedTitle === '序章' && imported.editorTitle === '序章', 'selected=' + imported.selectedTitle + ' editor=' + imported.editorTitle);
  check('右下角「保存 EPUB」悬浮按钮存在', imported.exportButtonFound === true, '');
  check(
    '打开 EPUB 后主导航默认收起',
    imported.layout.navCollapsed === true,
    JSON.stringify(imported.layout),
  );
  check(
    '打开 EPUB 后右侧书籍信息默认收起且有恢复入口',
    imported.layout.aside === false && imported.layout.asideRestore === true,
    JSON.stringify(imported.layout),
  );
  check(
    '章节列表与编辑区完整可见',
    imported.layout.nav && imported.layout.chapters && imported.layout.editor,
    JSON.stringify(imported.layout),
  );

  /* ---------- 3. 截图（浅色 / 深色） ---------- */
  console.log('\n--- 3. 截图 ---');
  const selectSecond = await evalJs(win, selectRowSource(1));
  check('选中「第一章 起风」', selectSecond === true, '');
  const selectedForShot = await waitUntil(
    win,
    SNAPSHOT_SOURCE,
    function (state) {
      return state && state.editorTitle === '第一章 起风' && state.qlText.indexOf('风从北面来') >= 0;
    },
    8000,
    '第二章正文加载',
  );
  check('选中章节正文已加载', selectedForShot.qlText.indexOf('风从北面来') >= 0, 'chars=' + selectedForShot.qlText.length);

  const dismissed = await evalJs(win, DISMISS_TOASTS_SOURCE);
  await evalJs(win, CLEAR_SELECTION_SOURCE);
  await sleep(300);
  // 该验收环境里 Electron 窗口可能被判定为不可见，CSS transition 不会推进，
  // 导致主题切换只改 CSS 变量、不重绘颜色。截图前禁用过渡，保证截图反映最终主题。
  const transitionsOff = await evalJs(win, DISABLE_TRANSITIONS_SOURCE);
  check('截图前已禁用 CSS 过渡（环境无可见桌面时避免主题不重绘）', transitionsOff === true, '');
  const lightClick = await evalJs(win, clickThemeSource('浅色'));
  check('切换到浅色主题', lightClick.clicked === true, JSON.stringify(lightClick));
  await evalJs(win, 'document.documentElement.getBoundingClientRect(); document.body.offsetHeight; true;');
  await sleep(1000);
  const lightTheme = await evalJs(win, THEME_INFO_SOURCE);
  check('浅色主题已应用', lightTheme.attr === 'light', JSON.stringify(lightTheme));
  await evalJs(win, CLEAR_SELECTION_SOURCE);
  const lightShot = await captureShot(win, path.join(shotsDir, 'epub-editor-light.png'));
  check('浅色截图已生成', lightShot.bytes > 50000 && lightShot.width >= 1440 && lightShot.height >= 900, JSON.stringify({ bytes: lightShot.bytes, width: lightShot.width, height: lightShot.height }));
  check('浅色截图整体为浅色（不是旧帧）', lightShot.avg && lightShot.avg.sum > 600, JSON.stringify(lightShot.avg));

  const darkClick = await evalJs(win, clickThemeSource('深色'));
  check('切换到深色主题', darkClick.clicked === true, JSON.stringify(darkClick));
  await evalJs(win, 'document.documentElement.getBoundingClientRect(); document.body.offsetHeight; true;');
  await sleep(1200);
  const darkTheme = await evalJs(win, THEME_INFO_SOURCE);
  check('深色主题已应用', darkTheme.attr === 'dark' && darkTheme.appBg !== lightTheme.appBg, JSON.stringify(darkTheme));
  await evalJs(win, CLEAR_SELECTION_SOURCE);
  const darkShot = await captureShot(win, path.join(shotsDir, 'epub-editor-dark.png'));
  check('深色截图已生成', darkShot.bytes > 50000 && darkShot.width >= 1440 && darkShot.height >= 900, JSON.stringify({ bytes: darkShot.bytes, width: darkShot.width, height: darkShot.height }));
  check('深色截图整体为深色', darkShot.avg && darkShot.avg.sum < 180, JSON.stringify(darkShot.avg));
  check('浅色 / 深色截图内容有明显差异', Math.abs(lightShot.avg.sum - darkShot.avg.sum) > 300, 'lightAvg=' + lightShot.avg.sum + ' darkAvg=' + darkShot.avg.sum);

  const lightRestore = await evalJs(win, clickThemeSource('浅色'));
  check('恢复浅色主题继续编辑', lightRestore.clicked === true, '');
  await sleep(500);
  console.log('截图:', JSON.stringify({ light: lightShot, dark: darkShot, dismissedToasts: dismissed }));

  /* ---------- 4. 修改书名 ---------- */
  console.log('\n--- 4. 修改书籍信息 ---');
  const metaSet = await evalJs(win, setInputSource('#epub-meta-title', EDITED_TITLE));
  check('书名输入框可编辑', metaSet.ok === true, JSON.stringify(metaSet));
  await sleep(400);
  const afterMeta = await evalJs(win, SNAPSHOT_SOURCE);
  check('书名已更新为修改值', afterMeta.metaTitle === EDITED_TITLE, 'value=' + afterMeta.metaTitle);
  check('书名改动即时保存提示出现', afterMeta.toastTexts.length >= 0 && (await evalJs(win, '!!document.querySelector(".meta__saved--on")')) === true, '');

  /* ---------- 5. 修改章节标题 ---------- */
  console.log('\n--- 5. 修改章节标题 ---');
  const renameOpen = await evalJs(win, clickButtonByTextSource('.editor__actions', '重命名'));
  check('进入章节重命名状态', renameOpen.clicked === true, renameOpen.label || JSON.stringify(renameOpen));
  await waitUntil(win, '!!document.querySelector(".editor__title-input")', function (value) { return value === true; }, 5000, '章节标题输入框');
  const titleSet = await evalJs(win, setInputSource('.editor__title-input', RENAMED_CHAPTER));
  check('章节标题输入成功', titleSet.ok === true, JSON.stringify(titleSet));
  const renameSave = await evalJs(win, clickButtonByTextSource('.editor__actions', '保存'));
  check('提交章节重命名', renameSave.clicked === true, renameSave.label || JSON.stringify(renameSave));
  await sleep(500);
  const afterRename = await evalJs(win, SNAPSHOT_SOURCE);
  check('章节标题已更新', afterRename.titles[1] === RENAMED_CHAPTER && afterRename.editorTitle === RENAMED_CHAPTER, afterRename.titles.join(' / '));

  /* ---------- 6. 新增 / 移动 / 删除章节 ---------- */
  console.log('\n--- 6. 新增 / 移动 / 删除章节 ---');
  const addClick = await evalJs(win, 'document.querySelector(".chapters__add") ? (document.querySelector(".chapters__add").click(), true) : false');
  check('点击「新增章节」', addClick === true, '');
  const afterAdd = await waitUntil(
    win,
    SNAPSHOT_SOURCE,
    function (state) {
      return state && state.rowCount === 5;
    },
    8000,
    '新增章节后数量 +1',
  );
  check('新增章节后数量 +1', afterAdd.rowCount === 5, 'rowCount=' + afterAdd.rowCount);
  check('新增章节标题为「新章节」且被选中', afterAdd.titles[4] === '新章节' && afterAdd.selectedTitle === '新章节', afterAdd.titles.join(' / '));

  const moveUp = await evalJs(win, clickRowActionSource('新章节', '上移本章'));
  check('点击「上移本章」', moveUp.clicked === true, JSON.stringify(moveUp));
  await sleep(350);
  const afterUp = await evalJs(win, SNAPSHOT_SOURCE);
  const expectedAfterUp = ['序章', RENAMED_CHAPTER, '第二章 入夜', '新章节', '第三章 归途'];
  check('上移后顺序正确', afterUp.titles.join('|') === expectedAfterUp.join('|'), afterUp.titles.join(' / '));

  const moveDown = await evalJs(win, clickRowActionSource('新章节', '下移本章'));
  check('点击「下移本章」', moveDown.clicked === true, JSON.stringify(moveDown));
  await sleep(350);
  const afterDown = await evalJs(win, SNAPSHOT_SOURCE);
  const expectedAfterDown = ['序章', RENAMED_CHAPTER, '第二章 入夜', '第三章 归途', '新章节'];
  check('下移后顺序恢复', afterDown.titles.join('|') === expectedAfterDown.join('|'), afterDown.titles.join(' / '));

  const deleteClick = await evalJs(win, clickRowActionSource('新章节', '删除本章'));
  check('点击「删除本章」', deleteClick.clicked === true, JSON.stringify(deleteClick));
  const dialog = await waitUntil(win, '!!document.querySelector(".modal")', function (value) { return value === true; }, 5000, '删除确认框');
  check('弹出删除确认框', dialog === true, '');
  const confirmDelete = await evalJs(win, clickButtonByTextSource('.modal__foot', '删除章节'));
  check('确认删除新增章节', confirmDelete.clicked === true, confirmDelete.label || JSON.stringify(confirmDelete));
  await sleep(500);
  const afterDelete = await evalJs(win, SNAPSHOT_SOURCE);
  check('删除后数量恢复为 4', afterDelete.rowCount === 4, 'rowCount=' + afterDelete.rowCount);
  check('新增章节已从列表移除', afterDelete.titles.indexOf('新章节') < 0, afterDelete.titles.join(' / '));

  /* ---------- 7. 调整既有章节顺序并保存 ---------- */
  console.log('\n--- 7. 调整既有章节顺序并保存 ---');
  const moveExisting = await evalJs(win, clickRowActionSource('第三章 归途', '上移本章'));
  check('点击「第三章 归途」的上移', moveExisting.clicked === true, JSON.stringify(moveExisting));
  await sleep(400);
  const beforeSave = await evalJs(win, SNAPSHOT_SOURCE);
  check('保存前章节顺序已调整', beforeSave.titles.join('|') === FINAL_ORDER.join('|'), beforeSave.titles.join(' / '));

  const captureInstalled = await evalJs(win, INSTALL_CAPTURE_SOURCE);
  check('下载拦截已安装（createObjectURL / anchor click）', captureInstalled.installed === true, JSON.stringify(captureInstalled));

  const saveClick = await evalJs(win, 'document.querySelector(".epub-fab") ? (document.querySelector(".epub-fab").click(), true) : false');
  check('点击「保存 EPUB」悬浮按钮', saveClick === true, String(saveClick));

  await waitUntil(
    win,
    '!!(window.__epubCapture && window.__epubCapture.anchors.length > 0)',
    function (value) {
      return value === true;
    },
    30000,
    '捕获浏览器下载',
  );
  const captured = await evalJs(win, READ_CAPTURE_SOURCE);
  check('捕获到导出的 Blob', captured !== null && captured.size > 1000, captured ? 'size=' + captured.size + ' type=' + captured.type : 'null');
  check('下载锚点文件名为 EPUB', captured !== null && /\.epub$/i.test(captured.anchors[0] && captured.anchors[0].download), captured && captured.anchors[0] ? captured.anchors[0].download : '');
  check('Blob MIME 为 application/epub+zip', captured !== null && captured.type === 'application/epub+zip', captured ? captured.type : '');
  check('createObjectURL 只被导出调用一次', captured !== null && captured.blobCount === 1, captured ? 'blobCount=' + captured.blobCount : '');

  if (captured === null) throw new Error('未能捕获导出的 EPUB 字节');
  const exportedBytes = Buffer.from(captured.base64, 'base64');
  await fsp.writeFile(exportedPath, exportedBytes);
  const exportedStat = await fsp.stat(exportedPath);
  check('导出 EPUB 已写入磁盘', exportedStat.size === captured.size && exportedStat.size > 1000, exportedPath + ' (' + exportedStat.size + ' bytes)');

  const afterSave = await evalJs(win, SNAPSHOT_SOURCE);
  check('保存后出现下载提示', afterSave.toastTexts.some(function (text) { return text.indexOf('EPUB 已开始下载') >= 0; }), afterSave.toastTexts.join(' | '));

  // 额外在 Node 侧检查导出包的 OPF / nav（与应用内的再次解析互相印证）
  const JSZip = require('jszip');
  const exportedZip = await JSZip.loadAsync(exportedBytes);
  const opfEntry = exportedZip.file('OEBPS/content.opf');
  const navEntry = exportedZip.file('OEBPS/nav.xhtml');
  check('导出包内存在 OPF 与 nav', !!opfEntry && !!navEntry, '');
  if (opfEntry && navEntry) {
    const opfText = await opfEntry.async('string');
    const navText = await navEntry.async('string');
    check('导出 OPF 含修改后的书名', opfText.indexOf('<dc:title>' + EDITED_TITLE + '</dc:title>') >= 0, '');
    const navTitles = [];
    const navRegex = /<a\b[^>]*href="[^"]*chapter[^"]*"[^>]*>([^<]*)<\/a>/g;
    let navMatch;
    while ((navMatch = navRegex.exec(navText)) !== null) navTitles.push(navMatch[1].trim());
    check('导出 nav 目录顺序与编辑结果一致', navTitles.join('|') === FINAL_ORDER.join('|'), navTitles.join(' / '));
  }

  /* ---------- 8. 重新导入导出的 EPUB ---------- */
  console.log('\n--- 8. 重新导入导出的 EPUB ---');
  const exportedBase64 = exportedBytes.toString('base64');
  const reinject = await evalJs(win, importEpubSource(exportedBase64, 'epub-edited.epub'));
  check('导出 EPUB 可再次注入应用', reinject.ok === true, JSON.stringify(reinject));

  const reopened = await waitUntil(
    win,
    SNAPSHOT_SOURCE,
    function (state) {
      return state && state.ready === true && state.rowCount === 4 && state.metaTitle === EDITED_TITLE;
    },
    30000,
    '导出 EPUB 重新解析',
  );
  check('重新打开后书名保留', reopened.metaTitle === EDITED_TITLE, 'value=' + reopened.metaTitle);
  check('重新打开后作者保留', reopened.metaAuthor === BOOK_AUTHOR, 'value=' + reopened.metaAuthor);
  check('重新打开后章节顺序保留', reopened.titles.join('|') === FINAL_ORDER.join('|'), reopened.titles.join(' / '));
  check('重新打开后正文可读', reopened.qlText.indexOf('雾从山脚漫上来') >= 0, 'chars=' + reopened.qlText.length);

  /* ---------- 9. 控制台无错误 ---------- */
  console.log('\n--- 9. 控制台与未捕获错误 ---');
  const finalState = await evalJs(win, SNAPSHOT_SOURCE);
  pageErrors = pageErrors.concat(finalState.uncaughtErrors || []);
  check('控制台无未捕获错误', consoleErrors.length === 0 && pageErrors.length === 0, 'console=' + JSON.stringify(consoleErrors.slice(0, 5)) + ' page=' + JSON.stringify(pageErrors.slice(0, 5)));

  /* ---------- 汇总 ---------- */
  const failed = results.filter(function (item) { return item.ok !== true; });
  console.log('\n========== 汇总: ' + (results.length - failed.length) + '/' + results.length + ' 通过 ==========');
  if (failed.length > 0) console.log(JSON.stringify(failed, null, 2));
  if (consoleErrors.length > 0) console.log('控制台错误:', JSON.stringify(consoleErrors.slice(0, 10)));
  if (pageErrors.length > 0) console.log('页面未捕获错误:', JSON.stringify(pageErrors.slice(0, 10)));

  const report = {
    generatedAt: new Date().toISOString(),
    target: targetUrl,
    fixture: fixturePath,
    exported: exportedPath,
    exportedBytes: exportedStat.size,
    screenshots: { light: lightShot, dark: darkShot },
    results: results,
    passed: results.length - failed.length,
    total: results.length,
    consoleErrors: consoleErrors,
    pageErrors: pageErrors,
  };
  await fsp.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log('报告:', reportPath);

  win.destroy();
  app.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(run).catch(function (error) {
  console.error('E2E_FAILED', error);
  app.exit(1);
});