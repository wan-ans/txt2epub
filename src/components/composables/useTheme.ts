import { computed, ref, watch } from "vue";

/**
 * 主题：跟随系统 / 浅色 / 深色。
 * 与 tokens.css 的约定保持一致：
 *  - 跟随系统：移除 data-theme，让 @media (prefers-color-scheme: dark) 生效
 *  - 浅色：data-theme="light"（排除深色媒体查询，回落到 :root 浅色）
 *  - 深色：data-theme="dark"（直接覆盖，优先于媒体查询）
 */
export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "inkbox:theme";
const VALID: ThemeMode[] = ["system", "light", "dark"];

function readStored(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && (VALID as string[]).includes(raw)) return raw as ThemeMode;
  } catch {
    // localStorage 不可用（隐私模式等）时静默回落
  }
  return "system";
}

const mode = ref<ThemeMode>(readStored());

/** 当前实际生效的是深色还是浅色（用于给 <html> 打标记、切换图标）。 */
const systemDark = ref(false);

function apply(next: ThemeMode) {
  const root = document.documentElement;
  if (next === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.dataset.theme = next;
  }
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 忽略写入失败
  }
}

const resolved = computed<"light" | "dark">(() => {
  if (mode.value === "light") return "light";
  if (mode.value === "dark") return "dark";
  return systemDark.value ? "dark" : "light";
});

let mediaQuery: MediaQueryList | null = null;

function initSystemWatcher() {
  if (typeof window === "undefined" || !window.matchMedia) return;
  mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  systemDark.value = mediaQuery.matches;
  mediaQuery.addEventListener("change", (event) => {
    systemDark.value = event.matches;
  });
}

/** 应用启动时调用一次：绑定系统监听并写入当前主题。 */
export function initTheme() {
  initSystemWatcher();
  apply(mode.value);
}

export function useTheme() {
  watch(mode, (next) => apply(next));

  function setMode(next: ThemeMode) {
    mode.value = next;
  }

  return { mode, resolved, setMode };
}
