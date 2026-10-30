import { ref } from "vue";

/**
 * 界面语言（与应用设置里的「界面语言」联动）。
 * 只负责 UI 文案；书籍语言仍由书籍元信息里的 language 控制。
 */
export type UiLanguage = "zh-CN" | "en";

const PREF_KEY = "inkbox:prefs";
const language = ref<UiLanguage>("zh-CN");

export function readStoredUiLanguage(): UiLanguage {
  if (typeof localStorage === "undefined") return "zh-CN";
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { uiLanguage?: unknown };
      if (parsed.uiLanguage === "en") return "en";
    }
  } catch {
    // 忽略损坏的偏好
  }
  return "zh-CN";
}

function applyDocumentLanguage(next: UiLanguage) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = next;
  document.title = next === "en" ? "Inkbox" : "墨匣";
}

export function initUiLanguage() {
  language.value = readStoredUiLanguage();
  applyDocumentLanguage(language.value);
}

export function setUiLanguage(next: UiLanguage) {
  language.value = next;
  applyDocumentLanguage(next);
}

export function useUiLanguage() {
  return { language, t };
}

/** 返回当前界面语言对应的文案；中文为源文，英文为译文。 */
export function t(zh: string, en: string): string {
  return language.value === "en" ? en : zh;
}
