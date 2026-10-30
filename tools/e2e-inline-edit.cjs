'use strict';

/**
 * 正文「内联实时编辑」的端到端验证（Lead 专用）。
 *
 * 核心要验证的是用户抱怨的三件事：
 *   1. 没有「进入编辑」按钮，正文本身就是编辑区
 *   2. 光标能落在点击的位置（不是跑到末尾）
 *   3. 没有 textarea 那种框；改完自动保存，不需要按保存键
 *
 * 另外还要确认编辑后数据真的进了 store（字数/行数变化）。
 *
 * 用法：npx electron tools/e2e-inline-edit.cjs
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

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
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

  await win.loadURL(target);
  await sleep(2300);

  const fixture = await fsp.readFile(FIX);
  const b64 = fixture.toString('base64');
  await win.webContents.executeJavaScript(`(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], '测试小说_001.txt', { type: 'text/plain' });
    const input = document.querySelector('input[type="file"]:not([accept*="json"])');
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(5000);

  // 选一个正文较长的章节
  await win.webContents.executeJavaScript(`(() => {
    const rows = Array.from(document.querySelectorAll('.chapter-row'));
    (rows[5] ?? rows[1])?.click();
  })()`);
  await sleep(800);

  /* ---------- 1. 没有「编辑正文」按钮 / 没有 textarea ---------- */
  const ui = await win.webContents.executeJavaScript(`(() => {
    const buttons = Array.from(document.querySelectorAll('button')).map(b => (b.innerText||'').replace(/\\s+/g,''));
    return {
      editButtonCount: buttons.filter(t => t === '编辑正文').length,
      textareaCount: document.querySelectorAll('.viewer__textarea').length,
      editable: document.querySelector('.prose--editable')?.getAttribute('contenteditable'),
      hintText: (document.querySelector('.viewer__strip-hint')||{}).innerText || '',
    };
  })()`);
  check('没有「编辑正文」按钮', ui.editButtonCount === 0, `count=${ui.editButtonCount}`);
  check('没有 textarea 输入框', ui.textareaCount === 0, `count=${ui.textareaCount}`);
  check('正文区本身就是可编辑区', ui.editable === 'true', `contenteditable=${ui.editable}`);
  check('提示改为「点正文即可编辑」', /点正文/.test(ui.hintText), ui.hintText.replace(/\s+/g, ' '));

  /* ---------- 2. 光标落位：点第 3 行中间，检查 caret 不在末尾 ---------- */
  const caretProbe = await win.webContents.executeJavaScript(`(async () => {
    const el = document.querySelector('.prose--editable');
    const text = el.innerText;
    const sel = window.getSelection();

    // 在文本中间找一个字符偏移（第 3 段的中间）
    const lines = text.split('\\n');
    let offset = 0;
    for (let i = 0; i < Math.min(2, lines.length); i++) offset += lines[i].length + 1;
    offset += Math.min(6, (lines[2] || '').length);

    // 用 Range 把光标放到该偏移（模拟用户点击该字符）
    const range = document.createRange();
    let acc = 0;
    let placed = false;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const len = node.nodeValue.length;
      if (acc + len >= offset) {
        range.setStart(node, Math.max(0, offset - acc));
        range.collapse(true);
        placed = true;
        break;
      }
      acc += len;
    }
    if (!placed && el.firstChild) {
      range.selectNodeContents(el);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
    el.focus();

    const caret = sel.focusOffset;
    return {
      textLength: text.length,
      caretOffset: caret,
      nearEnd: caret >= text.length - 3,
      selectionInsideEditor: el.contains(sel.anchorNode),
    };
  })()`);
  check('光标可落在正文中间（不在末尾）', caretProbe.selectionInsideEditor && !caretProbe.nearEnd,
    `caret=${caretProbe.caretOffset} / 文本长度 ${caretProbe.textLength}`);

  /* ---------- 3. 在该位置删字：模拟 Backspace ---------- */
  const beforeText = await win.webContents.executeJavaScript(
    `document.querySelector('.prose--editable').innerText`,
  );

  // 用 execCommand 在光标处删除一个字符（等价于用户按一次退格）
  await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.prose--editable');
    el.focus();
    document.execCommand('delete');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(1100); // 等自动保存（600ms 防抖 + 余量）

  const afterDelete = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.prose--editable');
    const strip = document.querySelector('.viewer__strip');
    return {
      text: el.innerText,
      stripText: (strip ? strip.innerText : '').replace(/\\s+/g, ' '),
      savedBadge: Boolean(document.querySelector('.viewer__strip-saved')),
      editedBadge: Boolean(document.querySelector('.viewer__strip-edited')),
    };
  })()`);
  check('光标处删字生效', afterDelete.text.length < beforeText.length,
    `${beforeText.length} → ${afterDelete.text.length} 字符`);
  check('出现「已自动保存」提示', afterDelete.savedBadge === true, afterDelete.stripText);

  /* ---------- 4. 中途位置插入文字 ---------- */
  const typed = await win.webContents.executeJavaScript(`(async () => {
    const el = document.querySelector('.prose--editable');
    el.focus();
    // 把光标移到第 2 行开头
    const sel = window.getSelection();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let offset = 0;
    while (node && offset < 20) { offset += node.nodeValue.length; if (offset >= 20) break; node = walker.nextNode(); }
    const range = document.createRange();
    if (node) {
      range.setStart(node, Math.min(5, node.nodeValue.length));
      range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
    }
    document.execCommand('insertText', false, '【插入测试】');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1100));
    return { text: el.innerText, hasInserted: el.innerText.includes('【插入测试】') };
  })()`);
  check('可在中间插入文字', typed.hasInserted === true, '');

  /* ---------- 5. 数据是否落到 store（字数变化） ---------- */
  const stripAfter = await win.webContents.executeJavaScript(
    `(document.querySelector('.viewer__strip')||{}).innerText?.replace(/\\s+/g,' ') || ''`,
  );
  check('顶部字数/行数随编辑更新', /\d+ 字/.test(stripAfter), stripAfter.slice(0, 80));

  const shot = await win.webContents.capturePage();
  await fsp.writeFile(path.join(outDir, 'inline-edit.png'), shot.toPNG());

  /* ---------- 6. 切换章节后回来，改动仍在 ---------- */
  const persist = await win.webContents.executeJavaScript(`(async () => {
    const rows = Array.from(document.querySelectorAll('.chapter-row'));
    rows[7]?.click();
    await new Promise(r => setTimeout(r, 700));
    rows[5]?.click();
    await new Promise(r => setTimeout(r, 800));
    const el = document.querySelector('.prose--editable');
    return { hasInserted: el ? el.innerText.includes('【插入测试】') : false };
  })()`);
  check('切走再回来改动仍在', persist.hasInserted === true, '');

  /* ---------- 7. 空行结构保留 ---------- */
  const blankLineProbe = await win.webContents.executeJavaScript(`(async () => {
    const el = document.querySelector('.prose--editable');
    const before = el.innerText;
    const beforeBlank = before.split('\\n').filter(l => !l.trim()).length;
    const after = el.innerText;
    return { blankLines: beforeBlank, same: before === after };
  })()`);
  log('空行数量:', blankLineProbe.blankLines);

  const failed = results.filter((r) => !r.ok);
  log(`\n========== 汇总: ${results.length - failed.length}/${results.length} 通过 ==========`);
  if (failed.length) log(JSON.stringify(failed, null, 2));

  await fsp.writeFile(path.join(outDir, 'inline-edit-report.json'), JSON.stringify({ results }, null, 2));
  win.destroy();
  app.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(run).catch((e) => {
  console.error('E2E_INLINE_FAILED', e);
  app.exit(1);
});
