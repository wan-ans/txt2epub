'use strict';

/**
 * 墨匣 · 主进程 IPC 层
 *
 * 设计约定：
 * - 每个 handler 都被 try/catch 包住，**永远**返回结构化结果 `{ ok, data?, error? }`，
 *   绝不把异常 throw 到渲染进程（否则 renderer 里的 promise reject 会打断 UI 流程）。
 * - 渲染进程侧（electron/preload.cjs）负责把 `{ ok: true, data }` 解包成契约里的
 *   直接返回值，把 `{ ok: false }` 降级成安全默认值（[] / null / {}），并 console.error。
 * - 写入前一律校验：文件名只取 basename、目录必须由用户通过对话框选择过（approvedDirs），
 *   最终路径必须落在批准的目录之内（防路径穿越）。
 *
 * 通道名与 electron/preload.cjs 中的 CHANNELS 必须保持一致。
 */

const { app, dialog, shell, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// ---------------------------------------------------------------------------
// 限制
// ---------------------------------------------------------------------------
const MAX_SINGLE_FILE = 100 * 1024 * 1024; // 单个 TXT / EPUB 上限 100MB
const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 一次导入/批量导出的总量上限 500MB
const MAX_OPEN_FILES = 200; // 一次最多打开 200 个文件
const MAX_SAVE_ITEMS = 500; // 一次最多保存 500 个文件
const MAX_PREFS_BYTES = 2 * 1024 * 1024; // preferences.json 上限 2MB
const MAX_DIR_DEPTH = 1; // 打开文件夹时只扫描一层子目录

const CH = {
  openTxtFiles: 'inkbox:open-txt-files',
  openTxtFolder: 'inkbox:open-txt-folder',
  saveEpub: 'inkbox:save-epub',
  saveMany: 'inkbox:save-many',
  chooseDirectory: 'inkbox:choose-directory',
  revealInExplorer: 'inkbox:reveal-in-explorer',
  prefsGet: 'inkbox:prefs-get',
  prefsSet: 'inkbox:prefs-set',
  appVersion: 'inkbox:app-version',
};

// ---------------------------------------------------------------------------
// 结构化结果
// ---------------------------------------------------------------------------
const okResult = (data) => ({ ok: true, data });const errResult = (code, message, extra) => ({
  ok: false,
  error: { code, message, ...(extra && typeof extra === 'object' ? { detail: extra } : {}) },
});

const messageOf = (err) =>
  err && typeof err === 'object' && typeof err.message === 'string' ? err.message : String(err);

/** 注册一个 handler：自动 try/catch，永远返回结构化结果。 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender) || null;
    try {
      return await fn(payload, senderWin);
    } catch (err) {
      console.error(`[ipc] ${channel} 失败:`, err);
      return errResult('internal', messageOf(err) || '主进程处理失败');
    }
  });
}

// ---------------------------------------------------------------------------
// 路径与字节工具
// ---------------------------------------------------------------------------
/** 用户通过系统对话框选择过的目录（规范化后的绝对路径，小写比较）。 */
const approvedDirs = new Set();

const normalizeDirKey = (dir) => {
  const resolved = path.resolve(dir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

function approveDir(dir) {
  if (typeof dir !== 'string' || !dir) return null;
  const resolved = path.resolve(dir);
  approvedDirs.add(normalizeDirKey(resolved));
  return resolved;
}

function isApprovedDir(dir) {
  return typeof dir === 'string' && dir.length > 0 && approvedDirs.has(normalizeDirKey(dir));
}

/** target 是否严格位于 dir 之内（或等于 dir）。 */
function isInsideDir(dir, target) {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 把 IPC 传来的字节统一成 Buffer；非法类型返回 null。 */
function toBuffer(value) {
  try {
    if (value == null) return null;
    if (value instanceof Uint8Array) {
      // Buffer.from(arrayBuffer, offset, length) 是零拷贝视图，写文件不会修改源数据
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (ArrayBuffer.isView(value)) {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    if (Array.isArray(value)) return Buffer.from(Uint8Array.from(value));
    return null;
  } catch {
    return null;
  }
}

/** 转成可结构化克隆的 Uint8Array（副本，避免共享 Buffer 内存池）。 */
function toUint8Array(buffer) {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy;
}

const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * 把任意字符串清洗成安全的文件名：
 * 去控制字符、去掉路径分隔符、去 Windows 非法字符、去首尾点号空格、防保留名、限定长度。
 * @param {unknown} input 用户/渲染进程给的文件名
 * @param {string} [fallback] 清洗后为空时的兜底名（含扩展名）
 * @param {string} [forceExt] 强制扩展名（如 '.epub'），给定时忽略原扩展名
 */
function sanitizeFileName(input, fallback = 'book.epub', forceExt = '') {
  let name = typeof input === 'string' ? input : '';
  // 只取最后一段，杜绝 "..\\..\\x.epub" / "/etc/passwd" 这类输入
  name = name.split(/[\\/]/).pop() || '';
  name = name.replace(/[\u0000-\u001f\u007f]/g, '');
  name = name.replace(/[<>:"|?*\\/]/g, '_');
  name = name.replace(/\s+/g, ' ').trim();
  name = name.replace(/^[.\s]+/, '');
  name = name.replace(/[.\s]+$/, '');

  const rawExt = path.extname(name);
  let stem = rawExt ? name.slice(0, -rawExt.length) : name;
  if (stem.replace(/[.\s]/g, '') === '') stem = '';

  if (stem && WINDOWS_RESERVED.has(stem.toLowerCase())) stem = `_${stem}`;
  if (!stem) return sanitizeFileName(fallback, 'book.epub', forceExt);

  if (stem.length > 150) stem = stem.slice(0, 150);

  const ext = forceExt || (rawExt && rawExt.length <= 12 ? rawExt.toLowerCase() : path.extname(fallback) || '.epub');
  return `${stem}${ext}`;
}

/** 在 dir 下找一个不冲突的路径：name.epub → name (1).epub → name (2).epub … */
async function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, -ext.length) || 'book';
  let candidate = path.join(dir, fileName);
  let index = 1;
  // 上限 1000 次，防止病态目录导致死循环
  while (index <= 1000) {
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
    candidate = path.join(dir, `${stem} (${index})${ext}`);
    index += 1;
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultDocumentsDir() {
  try {
    return app.getPath('documents');
  } catch {
    try {
      return app.getPath('home');
    } catch {
      return os.tmpdir();
    }
  }
}

// ---------------------------------------------------------------------------
// TXT 读取
// ---------------------------------------------------------------------------
async function readTxtFile(filePath, budget) {
  const resolved = path.resolve(filePath);
  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) return { skipped: { path: resolved, reason: 'not-a-file' } };
  if (stat.size > MAX_SINGLE_FILE) {
    return { skipped: { path: resolved, reason: 'too-large', size: stat.size } };
  }
  if (budget.used + stat.size > MAX_TOTAL_BYTES) {
    return { skipped: { path: resolved, reason: 'total-limit', size: stat.size } };
  }
  const buffer = await fsp.readFile(resolved);
  budget.used += buffer.byteLength;
  return {
    file: { path: resolved, name: path.basename(resolved), bytes: toUint8Array(buffer) },
  };
}

async function collectTxtPaths(dir) {
  const root = path.resolve(dir);
  const direct = [];
  const nested = [];

  const readDir = async (target) => {
    try {
      return await fsp.readdir(target, { withFileTypes: true });
    } catch (err) {
      console.warn('[ipc] 无法读取目录:', target, messageOf(err));
      return [];
    }
  };

  const rootEntries = await readDir(root);
  const subdirs = [];
  for (const entry of rootEntries) {
    // isFile() 对符号链接返回 false，避免顺着链接跑出用户选的目录
    if (entry.isFile() && /\.txt$/i.test(entry.name)) direct.push(path.join(root, entry.name));
    else if (entry.isDirectory() && !entry.name.startsWith('.')) subdirs.push(path.join(root, entry.name));
  }

  if (MAX_DIR_DEPTH >= 1) {
    for (const sub of subdirs.sort()) {
      const subEntries = await readDir(sub);
      for (const entry of subEntries) {
        if (entry.isFile() && /\.txt$/i.test(entry.name)) nested.push(path.join(sub, entry.name));
      }
    }
  }

  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  return [...direct, ...nested].sort((a, b) => {
    const byName = collator.compare(path.basename(a), path.basename(b));
    return byName !== 0 ? byName : collator.compare(a, b);
  });
}

// ---------------------------------------------------------------------------
// 具体能力
// ---------------------------------------------------------------------------
async function openTxtFiles(win) {
  const result = await dialog.showOpenDialog(win || undefined, {
    title: '打开 TXT 文件',
    buttonLabel: '打开',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '文本文件', extensions: ['txt'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return okResult([]);

  const budget = { used: 0 };
  const files = [];
  const skipped = [];
  for (const filePath of result.filePaths.slice(0, MAX_OPEN_FILES)) {
    try {
      const outcome = await readTxtFile(filePath, budget);
      if (outcome.file) files.push(outcome.file);
      else if (outcome.skipped) skipped.push(outcome.skipped);
    } catch (err) {
      skipped.push({ path: filePath, reason: 'read-failed', message: messageOf(err) });
    }
  }
  if (skipped.length) console.warn('[ipc] 打开文件时跳过:', skipped);
  return okResult(files);
}

async function openTxtFolder(win) {
  const result = await dialog.showOpenDialog(win || undefined, {
    title: '打开文件夹（读取其中的 .txt）',
    buttonLabel: '选择文件夹',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return okResult([]);

  const dir = approveDir(result.filePaths[0]);
  const paths = await collectTxtPaths(dir);

  const budget = { used: 0 };
  const files = [];
  const skipped = [];
  for (const filePath of paths.slice(0, MAX_OPEN_FILES)) {
    try {
      const outcome = await readTxtFile(filePath, budget);
      if (outcome.file) files.push(outcome.file);
      else if (outcome.skipped) skipped.push(outcome.skipped);
    } catch (err) {
      skipped.push({ path: filePath, reason: 'read-failed', message: messageOf(err) });
    }
  }
  if (skipped.length) console.warn('[ipc] 扫描文件夹时跳过:', skipped);
  return okResult(files);
}

async function saveEpub(payload, win) {
  const buffer = toBuffer(payload && payload.bytes);
  if (!buffer || buffer.byteLength === 0) return errResult('invalid-bytes', '没有可保存的 EPUB 数据');
  if (buffer.byteLength > MAX_TOTAL_BYTES) return errResult('too-large', 'EPUB 体积超过上限');

  const suggested = sanitizeFileName(payload && payload.suggestedName, 'book.epub', '.epub');
  const result = await dialog.showSaveDialog(win || undefined, {
    title: '保存 EPUB',
    buttonLabel: '保存',
    defaultPath: path.join(defaultDocumentsDir(), suggested),
    filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (result.canceled || !result.filePath) return okResult(null);

  let target = path.resolve(result.filePath);
  if (!/\.epub$/i.test(target)) target += '.epub';

  // 路径来自系统保存对话框 = 用户自己选定，登记为目标目录（供后续 save-many 使用）
  approveDir(path.dirname(target));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, buffer);
  return okResult({ path: target });
}

async function chooseDirectory(win) {
  const result = await dialog.showOpenDialog(win || undefined, {
    title: '选择输出文件夹',
    buttonLabel: '选择',
    defaultPath: defaultDocumentsDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return okResult(null);
  return okResult(approveDir(result.filePaths[0]));
}

async function saveMany(payload, win) {
  const items = payload && Array.isArray(payload.items) ? payload.items : null;
  if (!items || items.length === 0) return errResult('invalid-items', '没有待保存的文件');
  if (items.length > MAX_SAVE_ITEMS) {
    return errResult('too-many-items', `一次最多保存 ${MAX_SAVE_ITEMS} 个文件`);
  }

  let dir = null;
  const rawDir = payload && typeof payload.dir === 'string' ? payload.dir.trim() : '';
  if (rawDir) {
    const resolved = path.resolve(rawDir);
    // 渲染进程传入的目录必须来自用户选择（chooseDirectory / 保存对话框），否则拒绝
    if (!isApprovedDir(resolved)) return errResult('unapproved-dir', '该目录未经用户选择，已拒绝写入');
    const stat = await fsp.stat(resolved).catch(() => null);
    if (!stat || !stat.isDirectory()) return errResult('invalid-dir', '输出目录不存在');
    dir = resolved;
  } else {
    const picked = await chooseDirectory(win);
    if (!picked.ok || !picked.data) return okResult(null);
    dir = picked.data;
  }

  const written = [];
  const skipped = [];
  let total = 0;

  for (const item of items) {
    const outputName = item && typeof item.outputName === 'string' ? item.outputName : '';
    const buffer = toBuffer(item && item.bytes);
    if (!buffer || buffer.byteLength === 0) {
      skipped.push({ name: outputName, reason: 'invalid-bytes' });
      continue;
    }
    total += buffer.byteLength;
    if (total > MAX_TOTAL_BYTES) {
      skipped.push({ name: outputName, reason: 'total-limit' });
      break;
    }

    const safeName = sanitizeFileName(outputName, `book-${written.length + 1}.epub`, '.epub');
    const target = await uniquePath(dir, safeName);
    // 二次校验：清洗后的文件名 + uniquePath 也绝不能跑出 dir
    if (!isInsideDir(dir, target)) {
      skipped.push({ name: safeName, reason: 'path-outside-dir' });
      continue;
    }

    try {
      await fsp.writeFile(target, buffer);
      written.push(target);
    } catch (err) {
      skipped.push({ name: safeName, reason: 'write-failed', message: messageOf(err) });
    }
  }

  if (written.length === 0) {
    return errResult('write-failed', '没有任何文件写入成功', { skipped });
  }
  return okResult({ written, dir, skipped });
}

async function revealInExplorer(targetPath) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    return errResult('invalid-path', '路径为空');
  }
  const resolved = path.resolve(targetPath.trim());
  if (!path.isAbsolute(resolved)) return errResult('invalid-path', '需要绝对路径');

  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat) return errResult('not-found', '路径不存在');
  if (stat.isDirectory()) {
    const message = await shell.openPath(resolved);
    if (message) return errResult('open-failed', message);
    return okResult(undefined);
  }
  shell.showItemInFolder(resolved);
  return okResult(undefined);
}

// ---------------------------------------------------------------------------
// 偏好设置（userData/preferences.json）
// ---------------------------------------------------------------------------
let prefsCache = null;

function prefsFilePath() {
  return path.join(app.getPath('userData'), 'preferences.json');
}

async function loadPrefs() {
  if (prefsCache) return prefsCache;
  try {
    const raw = await fsp.readFile(prefsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    prefsCache = isPlainObject(parsed) ? parsed : {};
  } catch {
    prefsCache = {};
  }
  return prefsCache;
}

async function writePrefs(next) {
  const file = prefsFilePath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await fsp.rename(tmp, file);
  prefsCache = next;
}

async function getPreferences() {
  const prefs = await loadPrefs();
  return okResult({ ...prefs });
}

async function setPreferences(patch) {
  if (!isPlainObject(patch)) return errResult('invalid-patch', '偏好设置必须是对象');
  const prefs = await loadPrefs();
  const next = { ...prefs, ...patch };
  let serialized;
  try {
    serialized = JSON.stringify(next);
  } catch (err) {
    return errResult('not-serializable', `偏好设置无法序列化: ${messageOf(err)}`);
  }
  if (serialized.length > MAX_PREFS_BYTES) return errResult('too-large', '偏好设置体积超过上限');
  await writePrefs(next);
  return okResult({ ...next });
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------
function registerIpcHandlers() {
  // 同步通道：preload 需要同步拿到 appVersion（DesktopBridge.appVersion 是同步字符串）
  try {
    ipcMain.removeAllListeners(CH.appVersion);
  } catch {
    /* noop */
  }
  ipcMain.on(CH.appVersion, (event) => {
    event.returnValue = app.getVersion();
  });

  handle(CH.openTxtFiles, (_payload, win) => openTxtFiles(win));
  handle(CH.openTxtFolder, (_payload, win) => openTxtFolder(win));
  handle(CH.saveEpub, (payload, win) => saveEpub(payload, win));
  handle(CH.saveMany, (payload, win) => saveMany(payload, win));
  handle(CH.chooseDirectory, (_payload, win) => chooseDirectory(win));
  handle(CH.revealInExplorer, (payload) => revealInExplorer(payload && payload.path));
  handle(CH.prefsGet, () => getPreferences());
  handle(CH.prefsSet, (payload) => setPreferences(payload));
}

module.exports = {
  CH,
  registerIpcHandlers,
  sanitizeFileName,
  isInsideDir,
  approveDir,
};
