'use strict';

/**
 * 墨匣 · 预加载脚本
 *
 * 通过 contextBridge 暴露 window.inkbox，严格实现 src/bridge.ts 里的 DesktopBridge：
 *
 *   isDesktop: true
 *   platform: process.platform
 *   appVersion: string
 *   openTxtFiles(): Promise<FilePayload[]>
 *   openTxtFolder(): Promise<FilePayload[]>
 *   saveEpub({ bytes, suggestedName }): Promise<{ path } | null>
 *   saveMany({ items, dir? }): Promise<{ written, dir } | null>
 *   chooseDirectory(): Promise<string | null>
 *   revealInExplorer(path): Promise<void>
 *   getPreferences(): Promise<Record<string, unknown>>
 *   setPreferences(patch): Promise<Record<string, unknown>>
 *
 * 安全要点：
 * - 本文件在 sandbox: true 下运行，只能 require('electron') 暴露的受限模块集合。
 * - 绝不暴露 ipcRenderer / require / process 本体给渲染进程，只暴露上面这些函数。
 * - 主进程返回的是 `{ ok, data } | { ok: false, error }`，这里解包成契约要求的形状；
 *   失败时降级为安全默认值，让 UI 不至于因为 reject 而卡死。
 */

const { contextBridge, ipcRenderer } = require('electron');

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

const appVersion = (() => {
  try {
    const version = ipcRenderer.sendSync(CH.appVersion);
    return typeof version === 'string' && version ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** 统一解包：成功返回 data，失败打日志并返回 fallback。 */
async function call(channel, payload, fallback) {
  try {
    const result = await ipcRenderer.invoke(channel, payload);
    if (result && result.ok === true) return result.data;
    if (result && result.ok === false) {
      console.error(`[inkbox] ${channel} 失败:`, result.error && result.error.message);
      return fallback;
    }
    return fallback;
  } catch (err) {
    console.error(`[inkbox] ${channel} 调用异常:`, err);
    return fallback;
  }
}

/** 把主进程返回的字节转成货真价实的 Uint8Array（structured clone 可能给到 ArrayBuffer 视图）。 */
function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return new Uint8Array(0);
}

/** 把渲染进程给的字节整理成可 structured clone 的 Uint8Array。 */
function payloadBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return new Uint8Array(0);
}

function normalizeFileList(list) {
  if (!Array.isArray(list)) return [];
  const files = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const filePath = typeof item.path === 'string' ? item.path : '';
    const name = typeof item.name === 'string' && item.name ? item.name : filePath.split(/[\\/]/).pop() || '';
    files.push({ path: filePath, name, bytes: asBytes(item.bytes) });
  }
  return files;
}

const bridge = {
  isDesktop: /** @type {const} */ (true),
  platform: process.platform,
  appVersion,

  openTxtFiles: () => call(CH.openTxtFiles, undefined, []).then(normalizeFileList),

  openTxtFolder: () => call(CH.openTxtFolder, undefined, []).then(normalizeFileList),

  saveEpub: async (payload) => {
    const source = payload && typeof payload === 'object' ? payload : {};
    const suggestedName =
      typeof source.suggestedName === 'string' && source.suggestedName ? source.suggestedName : 'book.epub';
    const result = await call(
      CH.saveEpub,
      { bytes: payloadBytes(source.bytes), suggestedName },
      null,
    );
    return result && typeof result.path === 'string' ? { path: result.path } : null;
  },

  saveMany: async (payload) => {
    const source = payload && typeof payload === 'object' ? payload : {};
    const rawItems = Array.isArray(source.items) ? source.items : [];
    const items = rawItems
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        bytes: payloadBytes(item.bytes),
        outputName: typeof item.outputName === 'string' ? item.outputName : 'book.epub',
      }));
    const dir = typeof source.dir === 'string' && source.dir ? source.dir : undefined;
    const result = await call(CH.saveMany, { items, dir }, null);
    if (!result || !Array.isArray(result.written)) return null;
    return {
      written: result.written.filter((p) => typeof p === 'string'),
      dir: typeof result.dir === 'string' ? result.dir : '',
    };
  },

  chooseDirectory: () => call(CH.chooseDirectory, undefined, null),

  revealInExplorer: async (targetPath) => {
    await call(CH.revealInExplorer, { path: targetPath }, undefined);
  },

  getPreferences: async () => {
    const prefs = await call(CH.prefsGet, undefined, {});
    return prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {};
  },

  setPreferences: async (patch) => {
    const safePatch = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const prefs = await call(CH.prefsSet, safePatch, {});
    return prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {};
  },
};

try {
  contextBridge.exposeInMainWorld('inkbox', bridge);
} catch (err) {
  console.error('[inkbox] 暴露桥接失败:', err);
}

// ---------------------------------------------------------------------------
// 主题同步：让原生标题栏跟随渲染进程的主题
//
// 渲染进程用 <html data-theme="light|dark"> 或「移除该属性 = 跟随系统」表达主题
// （见 src/styles/tokens.css 与 src/components/composables/useTheme.ts）。
// 这里在 preload（隔离世界）里观察该属性，换算成 nativeTheme.themeSource 通知主进程，
// 让 Windows 原生标题栏/菜单/滚动条一起变深浅。无需改动 src/**。
// ---------------------------------------------------------------------------
const THEME_STORAGE_KEY = 'inkbox:theme';

/** 当前生效深浅：优先 data-theme，其次跟随系统媒体查询。 */
function resolveTheme() {
  try {
    const explicit = document.documentElement.getAttribute('data-theme');
    if (explicit === 'dark') return 'dark';
    if (explicit === 'light') return 'light';
    if (typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

let lastTheme = null;

function pushTheme() {
  const theme = resolveTheme();
  if (!theme || theme === lastTheme) return;
  lastTheme = theme;
  ipcRenderer.invoke('inkbox:set-theme', { source: theme }).catch(() => {});
}

function watchTheme() {
  pushTheme();

  try {
    const observer = new MutationObserver(pushTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  } catch {
    /* MutationObserver 不可用时退化为只同步一次 */
  }

  try {
    if (typeof window.matchMedia === 'function') {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', pushTheme);
    }
  } catch {
    /* 老版本不支持 addEventListener 就跳过 */
  }

  // 设置面板改主题走 localStorage，监听它再补一次同步
  try {
    window.addEventListener('storage', (event) => {
      if (event.key === THEME_STORAGE_KEY) pushTheme();
    });
  } catch {
    /* 忽略 */
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', watchTheme, { once: true });
} else {
  watchTheme();
}
