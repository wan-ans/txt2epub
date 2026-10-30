#!/usr/bin/env node
/**
 * 墨匣 · 一键桌面开发
 *
 * 1. 用 Vite 的 JS API 起 dev server（拿到真实端口）
 * 2. 把地址写进 VITE_DEV_SERVER_URL，拉起 Electron
 * 3. Electron 退出 → 关掉 Vite → 以相同退出码结束
 *
 * 用法：npm run dev:desktop
 * 额外参数会透传给 Electron：npm run dev:desktop -- --inspect
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const log = (...args) => console.log('\x1b[36m[dev:desktop]\x1b[0m', ...args);
const warn = (...args) => console.warn('\x1b[33m[dev:desktop]\x1b[0m', ...args);

/** 解析 electron 可执行文件路径（npm 包在非 Electron 环境下导出路径字符串）。 */
function resolveElectronBinary() {
  try {
    const fromPkg = require('electron');
    if (typeof fromPkg === 'string' && fromPkg && fs.existsSync(fromPkg)) return fromPkg;
  } catch {
    /* 继续走兜底 */
  }
  const candidates = [
    path.join(rootDir, 'node_modules', 'electron', 'path.txt'),
    path.join(rootDir, 'node_modules', 'electron', 'dist', 'electron.exe'),
  ];
  try {
    const rel = fs.readFileSync(candidates[0], 'utf8').trim();
    const resolved = path.join(rootDir, 'node_modules', 'electron', 'dist', rel);
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    /* 继续 */
  }
  if (fs.existsSync(candidates[1])) return candidates[1];
  return null;
}

async function main() {
  // 只有 .mjs 脚本 + ESM 项目：这里用动态 import 拿 vite（避免顶层 await 的兼容问题）
  const { createServer } = await import('vite');

  const electronBinary = resolveElectronBinary();
  if (!electronBinary) {
    console.error(
      '[dev:desktop] 找不到 Electron 可执行文件。请确认 node_modules/electron/dist 已就绪（npm rebuild electron 或 node node_modules/electron/install.js）。',
    );
    process.exit(1);
  }

  log('启动 Vite dev server…');
  const server = await createServer({
    root: rootDir,
    configFile: path.join(rootDir, 'vite.config.ts'),
    clearScreen: false,
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: false,
    },
  });

  let exitCode = 0;
  let child = null;
  let shuttingDown = false;

  const shutdown = async (code = 0, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    exitCode = code;
    if (child && child.exitCode === null && !child.killed) {
      try {
        child.kill(signal || undefined);
      } catch {
        /* noop */
      }
    }
    try {
      await server.close();
    } catch (err) {
      warn('关闭 Vite 失败:', err && err.message);
    }
    process.exit(exitCode);
  };

  await server.listen();
  const urls = server.resolvedUrls;
  const devUrl = (urls && urls.local && urls.local[0]) || `http://127.0.0.1:${server.config.server.port}/`;
  log('Vite 就绪:', devUrl);

  const forwarded = process.argv.slice(2);
  log('启动 Electron…');

  // 宿主机（DSH / VS Code 扩展 / 部分 CI）会预设 ELECTRON_RUN_AS_NODE=1，
  // 那会让 electron.exe 退化成纯 Node 进程，require('electron') 拿不到 app。
  const childEnv = {
    ...process.env,
    VITE_DEV_SERVER_URL: devUrl,
    ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING ?? '1',
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  child = spawn(electronBinary, ['.', ...forwarded], {
    cwd: rootDir,
    stdio: 'inherit',
    env: childEnv,
  });

  child.on('error', (err) => {
    console.error('[dev:desktop] 启动 Electron 失败:', err && err.message);
    void shutdown(1);
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    log(`Electron 已退出（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}），关闭 Vite…`);
    void shutdown(code ?? 0);
  });

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      log(`收到 ${sig}，退出中…`);
      void shutdown(0, sig === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
    });
  }

  process.on('uncaughtException', (err) => {
    console.error('[dev:desktop] 未捕获异常:', err);
    void shutdown(1);
  });
}

main().catch((err) => {
  console.error('[dev:desktop] 启动失败:', err);
  process.exit(1);
});
