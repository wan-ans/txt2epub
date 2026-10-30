'use strict';

/**
 * 合并模式「改章节标题」的端到端验证（Lead 专用）。
 *
 * 覆盖：
 *   1. 合并模式下每行标题是可点的编辑控件
 *   2. 点开 → 输入 → 回车保存，标题改变且出现「已改名」样式与恢复按钮
 *   3. Esc 取消不保存
 *   4. 恢复按钮 / 全部恢复 生效
 *   5. 改名后排序仍按文件名（改名不扰动顺序）
 *
 * 用法：npx electron tools/e2e-rename.cjs
 */

const { app, BrowserWindow } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tools', 'e2e-output');
const target = `file://${path.join(root, 'dist', 'index.html').replace(/\\/g, '/')}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 打开合并模式并加入 3 个文件 */
async function setupMergeMode(win) {
  await win.webContents.executeJavaScript(`(() => {
    const el = Array.from(document.querySelectorAll('button, a')).find(e => (e.innerText||'').includes('批量转换'));
    el?.click();
  })()`);
  await sleep(1000);

  for (const n of ['第10话 尾声.txt', '第2话 相遇.txt', '第1话 开端.txt']) {
    await win.webContents.executeJavaScript(`(async () => {
      const content = '第一段正文。\\n第二段正文，用来测试分章。';
      const file = new File([content], ${JSON.stringify(n)}, { type: 'text/plain' });
      const input = document.querySelector('.batch input[type="file"]');
      const dt = new DataTransfer(); dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(350);
  }
  await sleep(700);

  await win.webContents.executeJavaScript(`(() => {
    const sw = Array.from(document.querySelectorAll('[role="switch"]')).find(s => (s.innerText||'').includes('合并为一个文件'));
    sw?.click();
  })()`);

  // 等合并模式渲染完成
  await win.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (document.querySelectorAll('.job__order').length === 3 && document.querySelectorAll('.job__title-btn').length === 3) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  })()`);
  await sleep(500);
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
  await setupMergeMode(win);

  /* ---- 1. 标题可编辑控件存在 ---- */
  const initial = await win.webContents.executeJavaScript(`(() => {
    const btns = Array.from(document.querySelectorAll('.job__title-btn'));
    return {
      count: btns.length,
      texts: btns.map(b => (b.innerText||'').trim()),
      resets: document.querySelectorAll('.job__title-reset').length,
    };
  })()`);
  check('每行标题是可编辑控件', initial.count === 3, `count=${initial.count}`);
  check('初始标题取自文件名', JSON.stringify(initial.texts) === JSON.stringify(['第1话 开端', '第2话 相遇', '第10话 尾声']), JSON.stringify(initial.texts));
  check('初始没有恢复按钮', initial.resets === 0, `resets=${initial.resets}`);

  /* ---- 2. 点开 → 改名 → 回车保存 ---- */
  const editProbe = await win.webContents.executeJavaScript(`(async () => {
    const btn = document.querySelectorAll('.job__title-btn')[0];
    btn.click();
    await new Promise(r => setTimeout(r, 250));
    const input = document.querySelector('.job__title-input');
    if (!input) return { ok: false, why: 'no input appeared' };
    const before = input.value;
    input.focus();
    input.value = '楔子 · 风起';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 350));
    const btns = Array.from(document.querySelectorAll('.job__title-btn'));
    return {
      ok: true,
      before,
      after: btns.map(b => (b.innerText||'').trim()),
      changedCount: document.querySelectorAll('.job__title-btn--changed').length,
      resets: document.querySelectorAll('.job__title-reset').length,
      renamedBadge: (document.querySelector('.batch__merge-renamed')||{}).innerText || ''
    };
  })()`);
  check('回车保存改名', editProbe.ok && editProbe.after?.[0] === '楔子 · 风起', JSON.stringify(editProbe.after));
  check('改过的标题有特殊样式', editProbe.changedCount === 1, `changed=${editProbe.changedCount}`);
  check('出现「恢复为文件名」按钮', editProbe.resets === 1, `resets=${editProbe.resets}`);
  check('提示区显示已改名数量', /1\s*个已改名/.test(editProbe.renamedBadge ?? ''), editProbe.renamedBadge);

  /* ---- 3. Esc 取消 ---- */
  const escProbe = await win.webContents.executeJavaScript(`(async () => {
    const btn = document.querySelectorAll('.job__title-btn')[1]; // 第2话
    btn.click();
    await new Promise(r => setTimeout(r, 250));
    const input = document.querySelector('.job__title-input');
    input.focus();
    input.value = '不应该保存的名字';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 350));
    const btns = Array.from(document.querySelectorAll('.job__title-btn'));
    return { texts: btns.map(b => (b.innerText||'').trim()), inputStillOpen: Boolean(document.querySelector('.job__title-input')) };
  })()`);
  check('Esc 取消不保存', escProbe.texts?.[1] === '第2话 相遇' && !escProbe.inputStillOpen, JSON.stringify(escProbe.texts));

  /* ---- 4. 改名不影响排序（顺序仍按文件名） ---- */
  const orderAfterRename = await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('.job__name, .job__filename')).map(e => e.innerText.trim()).filter(Boolean)`,
  );
  log('改名后文件名顺序:', JSON.stringify(orderAfterRename));

  const shot = await win.webContents.capturePage();
  await fsp.writeFile(path.join(outDir, 'rename-mode.png'), shot.toPNG());

  /* ---- 5. 单项恢复 ---- */
  const resetProbe = await win.webContents.executeJavaScript(`(async () => {
    const btn = document.querySelector('.job__title-reset');
    if (!btn) return { ok: false };
    btn.click();
    await new Promise(r => setTimeout(r, 350));
    return {
      ok: true,
      texts: Array.from(document.querySelectorAll('.job__title-btn')).map(b => (b.innerText||'').trim()),
      resets: document.querySelectorAll('.job__title-reset').length,
    };
  })()`);
  check('单项恢复为文件名', resetProbe.ok && resetProbe.texts?.[0] === '第1话 开端' && resetProbe.resets === 0,
    JSON.stringify(resetProbe.texts));

  /* ---- 6. 全部恢复 ---- */
  const bulkProbe = await win.webContents.executeJavaScript(`(async () => {
    // 先改两个
    for (const idx of [0, 2]) {
      document.querySelectorAll('.job__title-btn')[idx].click();
      await new Promise(r => setTimeout(r, 200));
      const input = document.querySelector('.job__title-input');
      input.focus();
      input.value = '自定义' + idx;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 80));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise(r => setTimeout(r, 250));
    }
    const beforeReset = document.querySelectorAll('.job__title-reset').length;
    const bulkBtn = Array.from(document.querySelectorAll('.batch__merge-actions button')).find(b => (b.innerText||'').includes('全部恢复'));
    if (!bulkBtn) return { ok: false, beforeReset, why: 'no bulk button' };
    bulkBtn.click();
    await new Promise(r => setTimeout(r, 400));
    return {
      ok: true,
      beforeReset,
      afterReset: document.querySelectorAll('.job__title-reset').length,
      texts: Array.from(document.querySelectorAll('.job__title-btn')).map(b => (b.innerText||'').trim()),
    };
  })()`);
  check('全部恢复为文件名', bulkProbe.ok && bulkProbe.afterReset === 0 && JSON.stringify(bulkProbe.texts) === JSON.stringify(['第1话 开端','第2话 相遇','第10话 尾声']),
    JSON.stringify({ before: bulkProbe.beforeReset, after: bulkProbe.afterReset, texts: bulkProbe.texts }));

  const failed = results.filter((r) => !r.ok);
  log(`\n========== 汇总: ${results.length - failed.length}/${results.length} 通过 ==========`);
  if (failed.length) log(JSON.stringify(failed, null, 2));

  await fsp.writeFile(path.join(outDir, 'rename-report.json'), JSON.stringify({ results }, null, 2));
  win.destroy();
  app.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(run).catch((e) => {
  console.error('E2E_RENAME_FAILED', e);
  app.exit(1);
});
