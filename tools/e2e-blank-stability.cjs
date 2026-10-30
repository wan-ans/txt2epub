'use strict';

/**
 * 正文内联编辑的「行数/空行」稳定性验证（Lead 专用）。
 *
 * 关键风险：contenteditable 里块级 div 的 innerText 会多算换行，
 * 如果保存时按 innerText 取值，空白行会每保存一次翻倍。
 * 这里用一个已知结构的样本书做多次「编辑→保存→切走→切回」，
 * 检查界面上的行数是否稳定。
 *
 * 用法：npx electron tools/e2e-blank-stability.cjs
 */

const { app, BrowserWindow } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tools', 'e2e-output');
const target = `file://${path.join(root, 'dist', 'index.html').replace(/\\/g, '/')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 结构明确：第1章内 6 行（其中 3 行空白）、第2章 4 行（1 行空白）
const SAMPLE = [
  '第1章 开端',
  '　　第一段正文。',
  '',
  '',
  '　　第二段正文，前面有两个空行。',
  '',
  '　　第三段正文，前面有一个空行。',
  '第2章 继续',
  '　　第二章第一段。',
  '',
  '　　第二章第二段。',
].join('\n');

const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function readStrip(win) {
  return win.webContents.executeJavaScript(`(() => {
    const t = (document.querySelector('.viewer__strip')||{}).innerText || '';
    const m = t.match(/(\\d+)\\s*行/);
    return { lines: m ? Number(m[1]) : -1, text: t.replace(/\\s+/g,' ').slice(0, 90) };
  })()`);
}

async function run() {
  await fsp.mkdir(outDir, { recursive: true });
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL(target);
  await sleep(2300);

  const b64 = Buffer.from(SAMPLE, 'utf8').toString('base64');
  await win.webContents.executeJavaScript(`(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], '空行稳定性.txt', { type: 'text/plain' });
    const input = document.querySelector('input[type="file"]:not([accept*="json"])');
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(3500);

  // 选中第 1 章（第 0 项通常是「简介」，这里按标题找）
  await win.webContents.executeJavaScript(`(() => {
    const rows = Array.from(document.querySelectorAll('.chapter-row'));
    const target = rows.find(r => /第1章/.test(r.innerText)) ?? rows[1] ?? rows[0];
    target?.click();
  })()`);
  await sleep(600);

  const initial = await readStrip(win);
  log('初始:', JSON.stringify(initial));

  // 连续 3 轮：改一个字 → 等自动保存 → 切到第 2 章 → 切回第 1 章
  const rounds = [];
  for (let i = 0; i < 3; i += 1) {
    await win.webContents.executeJavaScript(`(async () => {
      const el = document.querySelector('.prose--editable');
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, '测试');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 950));
      // 删回去，保持内容与初始一致
      for (let k = 0; k < 2; k++) document.execCommand('delete');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 950));
      // 失焦
      el.blur();
      await new Promise(r => setTimeout(r, 400));
      // 切到第 2 章再切回
      const rows = Array.from(document.querySelectorAll('.chapter-row'));
      rows.find(r => /第2章/.test(r.innerText))?.click();
      await new Promise(r => setTimeout(r, 450));
      rows.find(r => /第1章/.test(r.innerText))?.click();
      await new Promise(r => setTimeout(r, 550));
    })()`);
    rounds.push(await readStrip(win));
    log(`第 ${i + 1} 轮后:`, JSON.stringify(rounds[i]));
  }

  check('行数在多轮保存后保持稳定', rounds.every((r) => r.lines === initial.lines),
    `initial=${initial.lines}, rounds=${rounds.map((r) => r.lines).join(',')}`);
  check('行数与原文一致（6 行）', initial.lines === 6, `lines=${initial.lines}`);

  const shot = await win.webContents.capturePage();
  await fsp.writeFile(path.join(outDir, 'blank-stability.png'), shot.toPNG());

  const failed = results.filter((r) => !r.ok);
  log(`\n========== 汇总: ${results.length - failed.length}/${results.length} 通过 ==========`);
  await fsp.writeFile(path.join(outDir, 'blank-stability.json'), JSON.stringify({ initial, rounds, results }, null, 2));
  win.destroy();
  app.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(run).catch((e) => {
  console.error('E2E_BLANK_FAILED', e);
  app.exit(1);
});
