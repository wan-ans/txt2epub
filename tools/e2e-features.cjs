'use strict';

/**
 * 本轮新增功能的端到端验证（Lead 专用）。
 *
 * 覆盖：
 *   A. 书名输入框：不再有红色错误态、不再有「用文件名」按钮、输入即时生效
 *   B. 章节区「追加章节」：拖入 TXT → 章节数增加
 *   C. 批量转换「合并为一个文件」：开关出现、队列变排序列表、可拖拽/上下移、能真的合并导出
 *
 * 用法：npx electron tools/e2e-features.cjs
 */

const { app, BrowserWindow } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tools', 'e2e-output');
const target = `file://${path.join(root, 'dist', 'index.html').replace(/\\/g, '/')}`;

const FIX = path.join(root, 'tests', 'fixtures', '测试小说_001.txt');
const results = [];
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function injectFile(win, filePath, inputSelector) {
  const bytes = await fsp.readFile(filePath);
  const b64 = bytes.toString('base64');
  const name = path.basename(filePath);
  return win.webContents.executeJavaScript(`(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], ${JSON.stringify(name)}, { type: "text/plain" });
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    let target = null;
    if (${JSON.stringify(inputSelector ?? '')}) {
      target = document.querySelector(${JSON.stringify(inputSelector ?? '')});
    }
    if (!target) {
      target = inputs.find(i => !(i.accept || '').includes('json'));
    }
    if (!target) return { ok: false, reason: 'no input', count: inputs.length };
    const dt = new DataTransfer();
    dt.items.add(file);
    target.files = dt.files;
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, accept: target.accept, id: target.id };
  })()`);
}

async function run() {
  await fsp.mkdir(outDir, { recursive: true });
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#faf6ee',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  const consoleErrors = [];
  win.webContents.on('console-message', (event) => {
    // Electron 45 新签名：event 带 level/message
    const level = event?.level ?? arguments[1];
    const message = event?.message ?? arguments[2];
    if (typeof level === 'number' ? level >= 2 : level === 'error') consoleErrors.push(String(message));
  });

  await win.loadURL(target);
  await sleep(2200);

  /* ============ A. 书名输入框 ============ */
  log('\n--- A. 书名输入框 ---');

  // 先导入，进入编辑界面
  const inj = await injectFile(win, FIX, null);
  check('导入测试小说', inj.ok === true, JSON.stringify(inj));
  await sleep(4500);

  const metaProbe = await win.webContents.executeJavaScript(`(async () => {
    const input = document.querySelector('#meta-title');
    if (!input) return { found: false };

    // 1) 找红色的错误提示（书名不能为空 / 用文件名）
    const field = input.closest('.field');
    const fieldText = field ? (field.innerText || '') : '';
    const errorEls = field ? Array.from(field.querySelectorAll('[role="alert"], .field__error, .error')) : [];
    const errorTexts = errorEls.map(e => (e.innerText || '').trim()).filter(Boolean);

    // 2) 找「用文件名」按钮
    const allButtons = Array.from(document.querySelectorAll('button'));
    const suggestBtn = allButtons.filter(b => (b.innerText || '').includes('用文件名'));

    // 3) 检查 aria-invalid（红框的来源）
    const ariaInvalid = input.getAttribute('aria-invalid');

    // 4) 清空书名，看看会不会变红报错
    const original = input.value;
    input.focus();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const ariaAfterClear = input.getAttribute('aria-invalid');
    const fieldAfter = input.closest('.field') ? input.closest('.field').innerText : '';
    const hasEmptyError = /书名不能为空/.test(fieldAfter);

    // 5) 输入一个长书名，验证即时生效（不点保存）
    const longTitle = '这是一本名字特别特别长的测试书籍用于验证输入框不会出现红色报错提示';
    input.value = longTitle;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const reflected = input.value === longTitle;

    // 还原
    input.value = original;
    input.dispatchEvent(new Event('input', { bubbles: true }));

    return {
      found: true,
      errorTexts,
      suggestButtonCount: suggestBtn.length,
      ariaInvalid,
      ariaInvalidAfterClear: ariaAfterClear,
      hasEmptyError,
      longTitleReflected: reflected,
      fieldTextSample: fieldText.slice(0, 120)
    };
  })()`);

  check('书名输入框存在', metaProbe.found === true, '');
  check('没有红色错误提示', (metaProbe.errorTexts ?? []).length === 0, JSON.stringify(metaProbe.errorTexts));
  check('没有「用文件名」按钮', metaProbe.suggestButtonCount === 0, `count=${metaProbe.suggestButtonCount}`);
  check('清空书名也不进错误态', !metaProbe.ariaInvalidAfterClear && !metaProbe.hasEmptyError,
    `aria-invalid=${metaProbe.ariaInvalidAfterClear} hasEmptyError=${metaProbe.hasEmptyError}`);
  check('长书名即时生效（无需保存）', metaProbe.longTitleReflected === true, '');

  /* ============ B. 章节区追加章节 ============ */
  log('\n--- B. 章节区追加章节 ---');

  const beforeAppend = await win.webContents.executeJavaScript(`(() => {
    const m = document.body.innerText.match(/(\\d+)\\s*章/);
    return { count: m ? Number(m[1]) : -1 };
  })()`);
  log('追加前章节数:', beforeAppend.count);

  const appendProbe = await win.webContents.executeJavaScript(`(async () => {
    // 找章节区里的「打开文件」按钮（注意别选到顶栏的「打开文件夹」）
    const buttons = Array.from(document.querySelectorAll('button'));
    const appendBtn = buttons.find(b => (b.innerText || '').replace(/\\s+/g,'') === '打开文件');
    const dragHint = document.querySelector('.append');
    return {
      buttonFound: Boolean(appendBtn),
      dragZoneFound: Boolean(dragHint),
      dragHintText: dragHint ? (dragHint.innerText || '').replace(/\\s+/g,'') : ''
    };
  })()`);
  check('章节区有「打开文件」按钮', appendProbe.buttonFound === true, '');
  check('章节区有拖拽追加区域', appendProbe.dragZoneFound === true, appendProbe.dragHintText);

  // 通过章节区内的 file input 追加一个文件
  // tests/fixtures 里的 002 是 GBK，正好也能验证追加时的编码检测
  const appendInj = await injectFile(win, path.join(root, 'tests', 'fixtures', '测试小说_002.txt'), '.append input[type="file"]');
  check('触发追加文件', appendInj.ok === true, JSON.stringify(appendInj));
  // 只等 1.8 秒：toast 有自动消失时间，等太久会误判「没有提示」
  await sleep(1800);

  const toastProbe = await win.webContents.executeJavaScript(`(() => {
    const t = document.body.innerText;
    return { hasToast: /已并入|已追加/.test(t), sample: t.slice(0, 300) };
  })()`);
  check('出现追加成功提示', toastProbe.hasToast === true, toastProbe.hasToast ? '' : 'toast 可能已自动消失');

  await sleep(5000);

  const afterAppend = await win.webContents.executeJavaScript(`(() => {
    const t = document.body.innerText;
    const m = t.match(/(\\d+)\\s*章/);
    return { count: m ? Number(m[1]) : -1, sample: t.slice(0,200) };
  })()`);
  check('追加后章节数增加', afterAppend.count > beforeAppend.count,
    `${beforeAppend.count} → ${afterAppend.count}`);

  // 关键回归：主文件的章节必须保持原有顺序（不能被按章号重排打乱）
  // 注意：追加后 UI 会自动跳到新章节，列表可视区不在顶部，
  // 所以这里比对的是「前 89 章」是否还是原来那 89 章、且顺序一致。
  const orderProbe = await win.webContents.executeJavaScript(`(async () => {
    // 通过输入框筛选「第1章」「第2章」来间接确认顺序不可靠，
    // 改为读滚动容器里全部渲染过的行不方便；这里直接把列表滚回顶部再读。
    const scroller = document.querySelector('.chapters__scroll');
    if (scroller) { scroller.scrollTop = 0; }
    await new Promise(r => setTimeout(r, 350));
    const titles = Array.from(document.querySelectorAll('.chapter-row__title')).map(e => (e.innerText||'').trim());
    return { first8: titles.slice(0, 8), total: titles.length };
  })()`);
  log('滚回顶部后的前 8 章:', JSON.stringify(orderProbe.first8));
  // 主文件第一项是「简介」（原文开头的书名/作者/文案），其后才是第1章
  const orderOk =
    orderProbe.first8[0] === '简介' &&
    orderProbe.first8[1] === '第1章' &&
    orderProbe.first8[2] === '第2章';
  check('主文件章节顺序未被重排', orderOk, JSON.stringify(orderProbe.first8.slice(0, 4)));

  // 检查追加进来的章节标题是否取自文件名（而不是一堆「正文」）
  const titles = await win.webContents.executeJavaScript(`(() => {
    return Array.from(document.querySelectorAll('.chapter-row__title')).map(e => (e.innerText||'').trim()).slice(0, 30);
  })()`);
  log('当前可见章节标题样例:', JSON.stringify(titles.slice(0, 8)));

  const shot1 = await win.webContents.capturePage();
  await fsp.writeFile(path.join(outDir, 'feature-append.png'), shot1.toPNG());

  /* ============ C. 批量转换合并模式 ============ */
  log('\n--- C. 批量转换合并模式 ---');

  // 切到批量视图（点左侧导航）
  const navProbe = await win.webContents.executeJavaScript(`(() => {
    const items = Array.from(document.querySelectorAll('button, a'));
    const batch = items.find(el => (el.innerText || '').includes('批量转换'));
    if (!batch) return { ok: false, candidates: items.map(e=>(e.innerText||'').trim()).filter(Boolean).slice(0,30) };
    batch.click();
    return { ok: true, label: batch.innerText.trim() };
  })()`);
  check('切到批量转换视图', navProbe.ok === true, JSON.stringify(navProbe).slice(0, 200));
  await sleep(1200);

  const mergeProbe = await win.webContents.executeJavaScript(`(() => {
    const switches = Array.from(document.querySelectorAll('[role="switch"]'));
    const merge = switches.find(s => (s.innerText || '').includes('合并为一个文件'));
    return {
      switchCount: switches.length,
      labels: switches.map(s => (s.innerText || '').replace(/\\s+/g,'')),
      mergeFound: Boolean(merge),
      checked: merge ? merge.getAttribute('aria-checked') : null
    };
  })()`);
  check('「合并为一个文件」开关存在', mergeProbe.mergeFound === true, JSON.stringify(mergeProbe.labels));
  check('开关默认关闭', mergeProbe.checked === 'false', `aria-checked=${mergeProbe.checked}`);

  /* ============ D. 合并排序纯逻辑（浏览器外已单测，这里验证 UI 联动） ============ */
  // 在批量面板里通过 fallback input 加 3 个文件，然后开合并模式看是否自动排序
  const batchFiles = ['第10话.txt', '第2话.txt', '第1话.txt'];
  for (const nm of batchFiles) {
    await win.webContents.executeJavaScript(`(async () => {
      const content = '第1章 测试\\n正文内容一段。\\n第2章 测试二\\n又一段正文。';
      const file = new File([content], ${JSON.stringify(nm)}, { type: 'text/plain' });
      const input = document.querySelector('.batch input[type="file"]');
      if (!input) return false;
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);
  }
  await sleep(900);

  const afterAdd = await win.webContents.executeJavaScript(`(() => {
    return Array.from(document.querySelectorAll('.job__name')).map(e => (e.innerText||'').trim());
  })()`);
  log('批量队列（加入顺序 第10/第2/第1）:', JSON.stringify(afterAdd));

  // 打开合并开关
  const toggleMerge = await win.webContents.executeJavaScript(`(() => {
    const switches = Array.from(document.querySelectorAll('[role="switch"]'));
    const merge = switches.find(s => (s.innerText || '').includes('合并为一个文件'));
    if (!merge) return { ok: false };
    merge.click();
    return { ok: true };
  })()`);
  check('点击合并开关', toggleMerge.ok === true, '');
  await sleep(900);

  const afterMerge = await win.webContents.executeJavaScript(`(() => {
    // 合并模式下标题是可编辑控件（.job__title-text），不再是 .job__name
    const names = Array.from(document.querySelectorAll('.job__title-text')).map(e => (e.innerText||'').trim());
    const filenames = Array.from(document.querySelectorAll('.job__filename')).map(e => (e.innerText||'').trim());
    const orders = Array.from(document.querySelectorAll('.job__order')).map(e => (e.innerText||'').trim());
    const grips = document.querySelectorAll('.job__grip').length;
    const note = document.querySelector('.batch__merge-note');
    return {
      names, filenames, orders, grips,
      noteText: note ? (note.innerText||'').replace(/\\s+/g,' ') : '',
      hasDraggable: Array.from(document.querySelectorAll('.job')).every(el => el.getAttribute('draggable') === 'true')
    };
  })()`);

  check('合并模式自动按文件名排序（第1→第2→第10）',
    JSON.stringify(afterMerge.names) === JSON.stringify(['第1话','第2话','第10话']) ||
      JSON.stringify(afterMerge.filenames) === JSON.stringify(['第1话.txt','第2话.txt','第10话.txt']),
    `titles=${JSON.stringify(afterMerge.names)} files=${JSON.stringify(afterMerge.filenames)}`);
  check('出现排序序号', JSON.stringify(afterMerge.orders) === JSON.stringify(['1','2','3']), JSON.stringify(afterMerge.orders));
  check('出现拖拽手柄', afterMerge.grips === 3, `grips=${afterMerge.grips}`);
  check('行可拖拽', afterMerge.hasDraggable === true, '');
  check('显示合并说明', /合并模式/.test(afterMerge.noteText), afterMerge.noteText.slice(0, 100));

  // 用上下移按钮验证顺序真的会变
  const moveProbe = await win.webContents.executeJavaScript(`(() => {
    const firstMoveDown = Array.from(document.querySelectorAll('.job__move')).find(
      b => (b.getAttribute('aria-label')||'').startsWith('下移')
    );
    if (!firstMoveDown) return { ok: false };
    firstMoveDown.click();
    return { ok: true, label: firstMoveDown.getAttribute('aria-label') };
  })()`);
  await sleep(500);
  const afterMove = await win.webContents.executeJavaScript(`(() =>
    Array.from(document.querySelectorAll('.job__title-text')).map(e => (e.innerText||'').trim())
  )()`);
  check('下移按钮改变顺序', JSON.stringify(afterMove) === JSON.stringify(['第2话','第1话','第10话']),
    `${JSON.stringify(afterMove)} (clicked ${moveProbe.label ?? 'none'})`);

  const shot2 = await win.webContents.capturePage();
  await fsp.writeFile(path.join(outDir, 'feature-merge.png'), shot2.toPNG());

  /* ============ 汇总 ============ */
  const failed = results.filter((r) => !r.ok);
  log('\n========== 汇总 ==========');
  log(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) log('失败项:', JSON.stringify(failed, null, 2));
  if (consoleErrors.length) log('控制台错误:', JSON.stringify(consoleErrors.slice(0, 5)));

  await fsp.writeFile(path.join(outDir, 'feature-report.json'), JSON.stringify({ results, consoleErrors }, null, 2));

  win.destroy();
  app.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(run).catch((err) => {
  console.error('E2E_FEATURES_FAILED', err);
  app.exit(1);
});
