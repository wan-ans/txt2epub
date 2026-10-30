/**
 * 桌面桥接（渲染进程侧）。
 * 浏览器环境下 window.inkbox 不存在，所有调用方必须用 `isDesktop` 判断后降级。
 */

export interface FilePayload {
  path: string;
  name: string;
  bytes: Uint8Array;
}

export interface DesktopBridge {
  readonly isDesktop: true;
  readonly platform: string;
  readonly appVersion: string;
  openTxtFiles(): Promise<FilePayload[]>;
  openTxtFolder(): Promise<FilePayload[]>;
  saveEpub(payload: {
    bytes: Uint8Array;
    suggestedName: string;
  }): Promise<{ path: string } | null>;
  saveMany(payload: {
    items: { bytes: Uint8Array; outputName: string }[];
    dir?: string;
  }): Promise<{ written: string[]; dir: string } | null>;
  chooseDirectory(): Promise<string | null>;
  revealInExplorer(path: string): Promise<void>;
  getPreferences(): Promise<Record<string, unknown>>;
  setPreferences(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
}

declare global {
  interface Window {
    inkbox?: DesktopBridge;
  }
}

export const isDesktop = (): boolean =>
  typeof window !== "undefined" && Boolean(window.inkbox?.isDesktop);

/** 桌面端返回桥接对象；浏览器端返回 null。 */
export function desktop(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  return window.inkbox?.isDesktop ? window.inkbox : null;
}

/** 浏览器兜底：触发一次本地下载。 */
export function downloadBytes(bytes: Uint8Array, fileName: string, mime = "application/epub+zip"): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 给浏览器留出读取 blob 的时间再回收
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}