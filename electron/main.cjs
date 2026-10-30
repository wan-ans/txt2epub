'use strict';

/**
 * 墨匣 · Electron 主进程
 *
 * 职责：
 * - 单实例锁、创建窗口、恢复/持久化窗口状态（userData/window-state.json）
 * - 开发模式加载 VITE_DEV_SERVER_URL，生产模式加载 file://<app>/dist/index.html
 * - 中文菜单（文件 / 编辑 / 视图），只保留窗口与编辑/视图命令；文件导入统一走渲染进程入口
 * - 安全策略：contextIsolation / sandbox / nodeIntegration=false / 禁止导航与新窗口 /
 *   拒绝所有权限请求 / 不加载任何远程内容
 * - 深色标题栏：nativeTheme.themeSource 跟随系统，渲染进程可通过 IPC 覆盖
 */

const { app, BrowserWindow, Menu, nativeTheme, screen, shell, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const ipc = require('./ipc.cjs');

const isDev = !app.isPackaged;
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || '';
const WINDOW_STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');

// 纯本地工具用不到 Chromium 的投屏 / 媒体中心 / 系统媒体键等后台服务；
// 关掉它们可以少起几个常驻服务线程，也避免无谓的网络请求。
app.commandLine.appendSwitch('disable-features', 'MediaRouter,GlobalMediaControls,HardwareMediaKeyHandling');
app.commandLine.appendSwitch('disable-background-networking');

/**
 * 可选诊断日志：设置 INKBOX_DEBUG_LOG=<绝对路径> 后，把主进程的关键节点写进该文件。
 * Windows 上 Electron 是 GUI 子系统程序，stdout 常常拿不到，排障时这个文件很有用。
 */
const DEBUG_LOG_FILE = process.env.INKBOX_DEBUG_LOG || '';

function debugLog(message) {
  if (!DEBUG_LOG_FILE) return;
  try {
    fs.appendFileSync(DEBUG_LOG_FILE, `${new Date().toISOString()} [pid:${process.pid}] ${message}\n`);
  } catch {
    /* 日志失败不影响功能 */
  }
}

const DEFAULT_BOUNDS = { width: 1200, height: 800 };
const MIN_WIDTH = 940;
const MIN_HEIGHT = 640;

/** @type {BrowserWindow | null} */
let mainWindow = null;

// ---------------------------------------------------------------------------
// 主题：窗口底色与标题栏跟随 nativeTheme
// ---------------------------------------------------------------------------
const BACKGROUND = { light: '#faf6ee', dark: '#14120f' };

function currentBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light;
}

/** 把主题模式应用到 nativeTheme（system / light / dark）。 */
function applyThemeSource(source) {
  const allowed = new Set(['system', 'light', 'dark']);
  const next = allowed.has(source) ? source : 'system';
  nativeTheme.themeSource = next;
  syncWindowTheme();
  return next;
}

function syncWindowTheme() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setBackgroundColor(currentBackgroundColor());
  } catch (err) {
    console.warn('[main] 设置窗口底色失败:', err && err.message);
  }
}

// ---------------------------------------------------------------------------
// 窗口状态持久化
// ---------------------------------------------------------------------------
function readWindowState() {
  try {
    const raw = fs.readFileSync(WINDOW_STATE_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const width = Number(parsed.width);
    const height = Number(parsed.height);
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return {
      width: Math.max(MIN_WIDTH, Math.round(width)),
      height: Math.max(MIN_HEIGHT, Math.round(height)),
      x: Number.isFinite(x) ? Math.round(x) : null,
      y: Number.isFinite(y) ? Math.round(y) : null,
      isMaximized: Boolean(parsed.isMaximized),
    };
  } catch {
    return null;
  }
}

/** 判断保存的位置是否仍落在某个显示器可见范围内（拔掉外接屏后会失效）。 */
function isVisibleOnSomeDisplay(bounds) {
  if (bounds.x === null || bounds.y === null) return false;
  const displays = screen.getAllDisplays();
  return displays.some((display) => {
    const area = display.workArea;
    // 至少要有 120x120 的可见交叠，否则视为不可见
    const overlapW = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapH = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return overlapW >= 120 && overlapH >= 120;
  });
}

function restoreWindowState() {
  const saved = readWindowState();
  if (!saved) {
    return { width: DEFAULT_BOUNDS.width, height: DEFAULT_BOUNDS.height, isMaximized: false };
  }
  const visible = isVisibleOnSomeDisplay(saved);
  return {
    width: saved.width,
    height: saved.height,
    x: visible ? saved.x : undefined,
    y: visible ? saved.y : undefined,
    isMaximized: saved.isMaximized,
  };
}

/**
 * 窗口几何的漂移防护。
 *
 * 在 150% 缩放的 Windows 上，Electron 45 的 getBounds() 相对 setBounds()/构造参数
 * 每次往返会多出 1px（1200→1201→1202…）。如果直接回写磁盘，窗口会随每次启动无限变大。
 * 这里以「本次启动实际使用的几何」为基线：只要新值在容差内（用户没真的拖拽窗边），
 * 就沿用基线的整数值，彻底切断累积漂移。
 */
const GEOMETRY_DRIFT_TOLERANCE = 8;
let geometryBaseline = null;

function resetGeometryBaseline(state) {
  geometryBaseline = {
    width: state.width,
    height: state.height,
    x: Number.isFinite(state.x) ? state.x : null,
    y: Number.isFinite(state.y) ? state.y : null,
  };
}

function stabilize(value, baselineValue) {
  if (baselineValue === null || baselineValue === undefined) return value;
  return Math.abs(value - baselineValue) <= GEOMETRY_DRIFT_TOLERANCE ? baselineValue : value;
}

/** 读取当前窗口几何并做过漂移防护，返回可落盘的状态对象。 */
function computeWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const isMaximized = mainWindow.isMaximized();
  // 最大化时 getBounds() 是最大化尺寸，要存 getNormalBounds() 才能正确还原
  const bounds = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();

  const base = geometryBaseline;
  const width = Math.max(MIN_WIDTH, Math.round(stabilize(bounds.width, base && base.width)));
  const height = Math.max(MIN_HEIGHT, Math.round(stabilize(bounds.height, base && base.height)));
  const x = Math.round(stabilize(bounds.x, base && base.x));
  const y = Math.round(stabilize(bounds.y, base && base.y));

  geometryBaseline = { width, height, x, y };
  return { width, height, x, y, isMaximized };
}

let saveStateTimer = null;

function scheduleSaveWindowState() {
  if (saveStateTimer) clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    saveStateTimer = null;
    void saveWindowState();
  }, 400);
}

function windowStateFilePathReady() {
  const file = WINDOW_STATE_FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

async function saveWindowState() {
  const state = computeWindowState();
  if (!state) return;
  try {
    const file = windowStateFilePathReady();
    await fsp.writeFile(file, JSON.stringify(state, null, 2), 'utf8');
    debugLog(`window-state saved ${JSON.stringify(state)}`);
  } catch (err) {
    console.warn('[main] 保存窗口状态失败:', err && err.message);
  }
}

/** 退出前同步落盘（异步写可能来不及完成）。 */
function flushWindowStateSync() {
  const state = computeWindowState();
  if (!state) return;
  try {
    fs.writeFileSync(windowStateFilePathReady(), JSON.stringify(state, null, 2), 'utf8');
    debugLog(`window-state flushed ${JSON.stringify(state)}`);
  } catch (err) {
    console.warn('[main] 同步保存窗口状态失败:', err && err.message);
  }
}

// ---------------------------------------------------------------------------
// 加载页面
// ---------------------------------------------------------------------------
function distIndexPath() {
  // 打包后：resources/app.asar/dist/index.html；开发时：<repo>/dist/index.html
  return path.join(app.getAppPath(), 'dist', 'index.html');
}

const FALLBACK_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>墨匣</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.7 "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
    background: #faf6ee; color: #14110d; }
  @media (prefers-color-scheme: dark) { body { background: #14120f; color: #f2ece1; } }
  main { max-width: 520px; padding: 32px; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { margin: 0 0 8px; opacity: .8; }
  code { font-family: Consolas, monospace; font-size: 12px; opacity: .7; word-break: break-all; }
</style></head>
<body><main>
  <h1>界面资源未找到</h1>
  <p>请先运行 <code>npm run build:web</code> 生成 dist/ 后再启动桌面端。</p>
  <p><code id="p"></code></p>
</main>
<script>document.getElementById('p').textContent = location.href;</script>
</body></html>`;

async function loadRenderer(win) {
  if (DEV_SERVER_URL) {
    try {
      await win.loadURL(DEV_SERVER_URL);
      return;
    } catch (err) {
      console.error('[main] 加载开发服务器失败:', err && err.message, DEV_SERVER_URL);
    }
  } else if (!app.isPackaged && process.env.INKBOX_FORCE_DEV_URL) {
    await win.loadURL(process.env.INKBOX_FORCE_DEV_URL);
    return;
  }

  const indexPath = distIndexPath();
  try {
    await fsp.access(indexPath, fs.constants.R_OK);
  } catch {
    console.error('[main] dist/index.html 不存在:', indexPath);
    // 用内联页面兜底，避免白屏且不引入任何远程资源
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(FALLBACK_HTML)}`);
    return;
  }
  await win.loadFile(indexPath);
}

// ---------------------------------------------------------------------------
// 菜单
// ---------------------------------------------------------------------------
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    {
      label: '文件',
      submenu: [
        isMac ? { role: 'close', label: '关闭窗口' } : { label: '退出', accelerator: 'Alt+F4', click: () => app.quit() },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'delete', label: '删除' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        {
          label: '重新加载',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
          },
        },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ];

  if (isMac) {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: 'about', label: '关于 墨匣' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 墨匣' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出 墨匣' },
      ],
    });
  } else {
    // 「帮助」菜单刻意不提供：菜单栏只保留 文件 / 编辑 / 视图
  }
  return Menu.buildFromTemplate(template);
}

// ---------------------------------------------------------------------------
// 安全策略
// ---------------------------------------------------------------------------
/**
 * 内容安全策略：只允许本地资源。
 * Electron 的 file:// 页面默认没有 CSP（会触发 Security Warning，打包后也会提示），
 * 这里统一注入一条严格策略。开发模式需要放行 Vite 的 HMR（内联脚本 + ws 连接）。
 */
function contentSecurityPolicy() {
  const common = [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-src 'none'",
    "media-src 'self' data: blob:",
  ];
  if (DEV_SERVER_URL) {
    common.push("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    common.push("connect-src 'self' ws: wss: http://127.0.0.1:* http://localhost:*");
  } else {
    common.push("script-src 'self'");
    common.push("connect-src 'self'");
  }
  return common.join('; ');
}

let cspInstalled = false;

function installCsp(session) {
  if (cspInstalled) return;
  cspInstalled = true;
  try {
    const policy = contentSecurityPolicy();
    session.webRequest.onHeadersReceived((details, callback) => {
      // 只处理我们自己的本地页面，绝不改写外部响应
      if (!/^(file:|devtools:|http:\/\/127\.0\.0\.1|http:\/\/localhost)/.test(details.url)) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [policy],
        },
      });
    });
  } catch (err) {
    console.warn('[main] 注入 CSP 失败:', err && err.message);
  }
}

/** 判断某个 URL 是否是「我们自己的页面」（开发服务器或本地打包产物）。 */
function isTrustedAppUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (DEV_SERVER_URL) {
    try {
      // Vite 的 HMR / 客户端会重定向到同一 origin，必须放行，否则开发模式直接白屏
      if (url.origin === new URL(DEV_SERVER_URL).origin) return true;
    } catch {
      /* 忽略 */
    }
  }
  if (url.protocol === 'file:') {
    // 只允许应用自己的 dist 目录下的文件
    const distDir = path.resolve(path.join(app.getAppPath(), 'dist'));
    const target = path.resolve(decodeURIComponent(url.pathname.replace(/^\//, '')));
    return target === distDir || target.startsWith(distDir + path.sep);
  }
  return false;
}

function hardenWebContents(win) {
  const { webContents } = win;

  // 只允许停留在应用自己的页面上；任何外部导航一律拦下。
  // 注意必须放行开发服务器的同源导航（Vite 客户端会自行处理路由/HMR），
  // 否则 npm run dev:desktop 打开就是白屏。
  webContents.on('will-navigate', (event, url) => {
    if (isTrustedAppUrl(url)) return;
    event.preventDefault();
    console.warn('[main] 已拦截页面导航:', url);
  });

  webContents.on('will-redirect', (event, url) => {
    if (isTrustedAppUrl(url)) return;
    event.preventDefault();
    console.warn('[main] 已拦截重定向:', url);
  });

  // 禁止 window.open / target=_blank；外链交给系统浏览器
  webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 禁止 renderer 附加 <webview>
  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  // 权限请求一律拒绝（不需要摄像头/麦克风/定位/通知等）
  try {
    win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
      console.warn('[main] 拒绝权限请求:', permission);
      callback(false);
    });
    win.webContents.session.setPermissionCheckHandler(() => false);
  } catch (err) {
    console.warn('[main] 无法设置权限处理器:', err && err.message);
  }

  // 不加载远程内容：渲染进程只应停留在本地页面
  webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return; // ERR_ABORTED：重载/跳转时的正常中断
    console.error('[main] 页面加载失败:', errorCode, errorDescription, validatedURL);
  });

  webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] 渲染进程异常退出:', details && details.reason);
  });

  webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[main] preload 出错:', preloadPath, error && error.message);
  });
}

// ---------------------------------------------------------------------------
// 创建窗口
// ---------------------------------------------------------------------------
async function createWindow() {
  const restored = restoreWindowState();
  // 以本次启动请求的几何为基线，后续保存时用它抵消 DPI 取整漂移
  resetGeometryBaseline(restored);

  debugLog(`restored geometry ${JSON.stringify(restored)}`);

  mainWindow = new BrowserWindow({
    width: restored.width,
    height: restored.height,
    ...(restored.x !== undefined && restored.y !== undefined ? { x: restored.x, y: restored.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: currentBackgroundColor(),
    title: '墨匣',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      devTools: true,
    },
  });

  hardenWebContents(mainWindow);
  installCsp(mainWindow.webContents.session);

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (restored.isMaximized) mainWindow.maximize();
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('resize', scheduleSaveWindowState);
  mainWindow.on('move', scheduleSaveWindowState);
  mainWindow.on('maximize', scheduleSaveWindowState);
  mainWindow.on('unmaximize', scheduleSaveWindowState);
  mainWindow.on('close', () => {
    flushWindowStateSync();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await loadRenderer(mainWindow);

  if (isDev && !DEV_SERVER_URL) {
    // 生产构建产物模式下不自动开 DevTools，避免干扰验证截图
    console.log('[main] 开发模式未设置 VITE_DEV_SERVER_URL，已回退加载 dist/index.html');
  }

  if (process.env.INKBOX_SELF_CHECK === '1') {
    // 等 Vue 挂载完成（首帧之后再探一次）
    setTimeout(() => runSelfCheck(mainWindow), 2000);
  }
  return mainWindow;
}

/**
 * 自检探针（仅 INKBOX_SELF_CHECK=1 时启用）：在渲染进程里核对 preload 桥接与首屏状态，
 * 把结果写入 debugLog / stdout，便于无头验证「不是白屏、window.inkbox 可用」。
 */
function runSelfCheck(win) {
  const SCRIPT = `(() => {
    const bridge = window.inkbox;
    const root = document.getElementById('app');
    return JSON.stringify({
      bridgeType: typeof bridge,
      isDesktop: bridge ? bridge.isDesktop : null,
      platform: bridge ? bridge.platform : null,
      appVersion: bridge ? bridge.appVersion : null,
      methods: bridge
        ? ['openTxtFiles', 'openTxtFolder', 'saveEpub', 'saveMany', 'chooseDirectory',
           'revealInExplorer', 'getPreferences', 'setPreferences']
            .filter((key) => typeof bridge[key] === 'function')
        : [],
      appMounted: Boolean(root && root.children.length > 0),
      appHtmlLength: root ? root.innerHTML.length : 0,
      title: document.title,
      theme: document.documentElement.getAttribute('data-theme'),
    });
  })()`;

  win.webContents
    .executeJavaScript(SCRIPT, true)
    .then((json) => {
      debugLog(`self-check ${json}`);
      console.log('[main] self-check:', json);
    })
    .catch((err) => {
      const message = `self-check 失败: ${(err && err.message) || err}`;
      debugLog(message);
      console.error('[main]', message);
    });
}

// ---------------------------------------------------------------------------
// IPC：主题
// ---------------------------------------------------------------------------
function registerMainIpc() {
  ipcMain.handle('inkbox:set-theme', (_event, payload) => {
    try {
      const source = payload && typeof payload === 'object' ? payload.source : payload;
      const applied = applyThemeSource(typeof source === 'string' ? source : 'system');
      return { ok: true, data: { source: applied, dark: nativeTheme.shouldUseDarkColors } };
    } catch (err) {
      return { ok: false, error: { code: 'internal', message: String(err && err.message) } };
    }
  });

  ipcMain.handle('inkbox:get-theme', () => {
    try {
      return {
        ok: true,
        data: { source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors },
      };
    } catch (err) {
      return { ok: false, error: { code: 'internal', message: String(err && err.message) } };
    }
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
let started = false;

function start() {
  if (started) return;
  started = true;

  debugLog(`start() isDev=${isDev} devServerUrl=${DEV_SERVER_URL || '(none)'}`);

  // 单实例锁：第二个实例直接聚焦已有窗口
  const gotLock = app.requestSingleInstanceLock();
  debugLog(`single-instance-lock=${gotLock}`);
  if (!gotLock) {
    app.quit();
    return;
  }

  app.setAppUserModelId('xyz.inkbox.txt2epub');
  nativeTheme.themeSource = 'system';

  nativeTheme.on('updated', () => {
    syncWindowTheme();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('inkbox:theme-changed', {
        dark: nativeTheme.shouldUseDarkColors,
        source: nativeTheme.themeSource,
      });
    }
  });

  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    flushWindowStateSync();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });

  app.whenReady().then(async () => {
    debugLog('app ready');
    ipc.registerIpcHandlers();
    registerMainIpc();
    Menu.setApplicationMenu(buildMenu());
    await createWindow();
    debugLog(`window created: ${mainWindow ? JSON.stringify(mainWindow.getBounds()) : 'null'}`);
    if (isDev && process.env.INKBOX_OPEN_DEVTOOLS === '1' && mainWindow) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  }).catch((err) => {
    debugLog(`启动失败: ${(err && err.stack) || err}`);
    console.error('[main] 启动失败:', err);
    dialog.showErrorBox('墨匣启动失败', String((err && err.message) || err));
    app.quit();
  });

  // 兜底：任何未捕获异常都记录日志而不是静默崩溃
  process.on('uncaughtException', (err) => {
    debugLog(`uncaughtException: ${(err && err.stack) || err}`);
    console.error('[main] 未捕获异常:', err);
  });
  process.on('unhandledRejection', (reason) => {
    debugLog(`unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
    console.error('[main] 未处理的 Promise 拒绝:', reason);
  });
}

function getMainWindow() {
  return mainWindow;
}

// 作为 package.json 的 main 入口时直接启动。
// 注意：不能用 `require.main === module` 判断 —— Electron 加载主进程模块时
// require.main 并不指向本文件，那个判断会让窗口永远不出现。
if (!process.env.INKBOX_NO_AUTOSTART) {
  start();
}

module.exports = { start, getMainWindow, applyThemeSource, buildMenu, distIndexPath };