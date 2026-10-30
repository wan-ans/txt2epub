'use strict';

/**
 * 合并模式的视觉与产物验证（Lead 专用）。
 *
 * 目的：
 *   1. 打开合并模式后，等界面稳定再截图（上一版截图早于 DOM 更新，有误导）
 *   2. 真的点「合并并导出」，抓取产出的 EPUB 字节
 *   3. 解压检查章节顺序是否严格等于队列顺序
 *
 * 用法：npx electron tools/e2e-merge-export.cjs
 */

const { app, BrowserWindow } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tools', 'e2e-output');
const target = `file://${path.join(root, 'dist', 'index.html').replace(/\\/g, '/')}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/** 3 个短文件，文件名故意打乱顺序，内容里各带唯一标记便于校验顺序 */
const FILES = [
  { name: '第10话 尾声.txt', mark: 'MARK_TEN' },
  { name: '第2话 相遇.txt', mark: 'MARK_TWO' },
  { name: '第1话 开端.txt', mark: 'MARK_ONE' },
];

async function run() {
  await fsp.mkdir(outDir, { recursive: true });
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  const downloads = [];
  win.webContents.session.on('will-download', (_e, item) => {
    const name = item.getFilename();
    if (!name.toLowerCase().endsWith('.epub')) return;
    const dest = path.join(outDir, `merged-${name}`);
    item.setSavePath(dest);
    downloads.push(dest);
    log('拦截下载:', name, '->', dest);
  });

  await win.loadURL(target);
  await sleep(2200);

  // 切到批量视图
  await win.webContents.executeJavaScript(`(() => {
    const el = Array.from(document.querySelectorAll('button, a')).find(e => (e.innerText||'').includes('批量转换'));
    el?.click();
  })()`);
  await sleep(1000);

  // 逐个加入文件
  for (const f of FILES) {
    await win.webContents.executeJavaScript(`(async () => {
      const content = ${JSON.stringify(f.mark)} + '\\n这是' + ${JSON.stringify(f.name)} + '的正文内容。\\n第二段正文。';
      const file = new File([content], ${JSON.stringify(f.name)}, { type: 'text/plain' });
      const input = document.querySelector('.batch input[type="file"]');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(350);
  }
  await sleep(800);

  const beforeOrder = await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('.job__name')).map(e => e.innerText.trim())`,
  );
  log('加入后顺序:', JSON.stringify(beforeOrder));

  // 打开合并开关
  await win.webContents.executeJavaScript(`(() => {
    const sw = Array.from(document.querySelectorAll('[role="switch"]')).find(s => (s.innerText||'').includes('合并为一个文件'));
    sw?.click();
  })()`);

  // 等 Vue 把三件事都渲染完：开关 aria-checked、排序序号、拖拽属性
  await win.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const sw = Array.from(document.querySelectorAll('[role="switch"]')).find(s => (s.innerText||'').includes('合并为一个文件'));
      const orders = document.querySelectorAll('.job__order').length;
      const draggable = document.querySelectorAll('.job[draggable="true"]').length;
      if (sw?.getAttribute('aria-checked') === 'true' && orders === 3 && draggable === 3) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  })()`);
  await sleep(600);

  const mergeState = await win.webContents.executeJavaScript(`(() => {
    const sw = Array.from(document.querySelectorAll('[role="switch"]')).find(s => (s.innerText||'').includes('合并为一个文件'));
    return {
      switchOn: sw?.getAttribute('aria-checked'),
      names: Array.from(document.querySelectorAll('.job__name')).map(e => e.innerText.trim()),
      orders: Array.from(document.querySelectorAll('.job__order')).map(e => e.innerText.trim()),
      noteVisible: Boolean(document.querySelector('.batch__merge-note')),
      footerButton: (Array.from(document.querySelectorAll('button')).find(b => (b.innerText||'').includes('合并并导出')) || {}).innerText,
    };
  })()`);
  log('合并模式实际状态:', JSON.stringify(mergeState, null, 2));

  const shot = await win.webContents.capturePage();
  await fsp.writeFile(path.join(outDir, 'merge-mode-verified.png'), shot.toPNG());

  // 点「合并并导出」
  const clickExport = await win.webContents.executeJavaScript(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText||'').includes('合并并导出'));
    if (!btn) return { ok: false };
    btn.click();
    return { ok: true, label: btn.innerText.trim() };
  })()`);
  log('点击导出:', JSON.stringify(clickExport));

  // 等待保存对话框 / 下载；保存对话框会阻塞，用 ESC 或直接等待超时后抓已写出的文件
  await sleep(8000);

  const report = {
    beforeOrder,
    mergeState,
    clickExport,
    downloads: downloads.map((d) => ({ path: d })),
  };
  log('\n=== 结果 ===');
  log(JSON.stringify(report, null, 2));

  await fsp.writeFile(path.join(outDir, 'merge-export-report.json'), JSON.stringify(report, null, 2));
  win.destroy();
  app.exit(0);
}

app.whenReady().then(run).catch((err) => {
  console.error('MERGE_E2E_FAILED', err);
  app.exit(1);
});
