<script setup lang="ts">
/**
 * 偏好设置面板：外观、动效、界面语言、关于。
 * 全部设置写入 localStorage（桌面端额外同步到 bridge.setPreferences）。
 */
import { computed, onMounted, ref } from "vue";
import UiIcon from "../icons/UiIcon.vue";
import UiSegmented from "../ui/UiSegmented.vue";
import type { SegmentOption } from "../ui/UiSegmented.vue";
import UiField from "../ui/UiField.vue";
import UiSwitch from "../ui/UiSwitch.vue";
import UiButton from "../ui/UiButton.vue";
import { useTheme, type ThemeMode } from "../composables/useTheme";
import { setUiLanguage, useUiLanguage, type UiLanguage } from "../composables/useUiLanguage";
import { desktop } from "../../bridge";

const { mode, resolved, setMode } = useTheme();
const { t } = useUiLanguage();

const themeOptions = computed<SegmentOption[]>(() => [
  { value: "system", label: t("跟随系统", "Follow system") },
  { value: "light", label: t("浅色", "Light") },
  { value: "dark", label: t("深色", "Dark") },
]);

const languageOptions: SegmentOption[] = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "English" },
];

const PREF_KEY = "inkbox:prefs";

interface Prefs {
  reduceMotion: boolean;
  uiLanguage: UiLanguage;
}

const prefs = ref<Prefs>({
  reduceMotion: false,
  uiLanguage: "zh-CN",
});

const appVersion = ref("0.1.0");

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw) Object.assign(prefs.value, JSON.parse(raw) as Partial<Prefs>);
  } catch {
    // 忽略损坏的偏好
  }
}

function persist() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs.value));
  } catch {
    // 忽略写入失败
  }
  const bridge = desktop();
  if (bridge) void bridge.setPreferences({ ...prefs.value });
}

function applyReduceMotion(value: boolean) {
  prefs.value.reduceMotion = value;
  document.documentElement.dataset.reduceMotion = String(value);
  persist();
}

function applyUiLanguage(value: UiLanguage) {
  prefs.value.uiLanguage = value;
  setUiLanguage(value);
  persist();
}

function syncUiLanguage() {
  if (prefs.value.uiLanguage !== "zh-CN" && prefs.value.uiLanguage !== "en") return;
  setUiLanguage(prefs.value.uiLanguage);
}

onMounted(async () => {
  loadPrefs();
  syncUiLanguage();
  document.documentElement.dataset.reduceMotion = String(prefs.value.reduceMotion);
  const bridge = desktop();
  if (bridge) {
    try {
      const remote = await bridge.getPreferences();
      appVersion.value = bridge.appVersion || appVersion.value;
      if (remote && typeof remote === "object" && Object.keys(remote).length) {
        // 主进程里的偏好优先（跨窗口持久化）
        Object.assign(prefs.value, remote);
      }
    } catch {
      // 桌面端偏好读取失败不应阻断 UI
    }
    syncUiLanguage();
  }
});

function resetPrefs() {
  prefs.value = {
    reduceMotion: false,
    uiLanguage: "zh-CN",
  };
  setMode("system");
  setUiLanguage("zh-CN");
  applyReduceMotion(false);
}
</script>

<template>
  <section class="settings" aria-labelledby="settings-title">
    <header class="settings__head">
      <h2 id="settings-title" class="settings__title serif">{{ t("偏好设置", "Preferences") }}</h2>
      <p class="settings__desc">
        {{ t("这些设置保存在本机，不会随 EPUB 一起导出。", "These settings are stored on this device and are not exported with your EPUB.") }}
      </p>
    </header>

    <div class="settings__grid">
      <div class="settings__block">
        <header class="settings__block-head">
          <h3 class="settings__block-title">
            <UiIcon name="half" :size="15" />
            {{ t("外观", "Appearance") }}
          </h3>
          <p class="hint">
            {{ t("当前实际生效：", "Currently active: ") }}{{ resolved === "dark" ? t("深色（墨夜）", "Dark (Ink Night)") : t("浅色（宣纸）", "Light (Rice Paper)") }}
          </p>
        </header>

        <UiField
          :label="t('主题', 'Theme')"
          input-id="settings-theme"
          :hint="t('跟随系统会随操作系统的深浅色自动切换', 'Follows your system light/dark appearance')"
        >
          <UiSegmented
            id="settings-theme"
            :model-value="mode"
            :options="themeOptions"
            :aria-label="t('主题', 'Theme')"
            size="md"
            @update:model-value="(value) => setMode(value as ThemeMode)"
          />
        </UiField>

        <UiField
          :label="t('界面语言', 'Interface language')"
          input-id="settings-language"
          :hint="t('切换应用界面文案，书籍内容不受影响', 'Changes the app interface language; book content is unaffected')"
        >
          <UiSegmented
            id="settings-language"
            :model-value="prefs.uiLanguage"
            :options="languageOptions"
            :aria-label="t('界面语言', 'Interface language')"
            size="md"
            @update:model-value="(value) => applyUiLanguage(value as UiLanguage)"
          />
        </UiField>

        <UiField
          :label="t('减少动效', 'Reduce motion')"
          input-id="settings-motion"
          :hint="t('关闭过渡与动画，或直接跟随系统的 prefers-reduced-motion', 'Turn off transitions and animations, or follow the system prefers-reduced-motion setting')"
        >
          <UiSwitch
            id="settings-motion"
            :model-value="prefs.reduceMotion"
            :label="t('减少界面动效', 'Reduce interface motion')"
            @update:model-value="applyReduceMotion"
          />
        </UiField>
      </div>

      <div class="settings__block">
        <header class="settings__block-head">
          <h3 class="settings__block-title">
            <UiIcon name="information-circle" :size="15" />
            {{ t("关于", "About") }}
          </h3>
        </header>

        <dl class="settings__about">
          <div>
            <dt>{{ t("应用", "App") }}</dt>
            <dd class="serif">{{ t("墨匣 Inkbox · TXT 转 EPUB", "Inkbox · TXT to EPUB") }}</dd>
          </div>
          <div>
            <dt>{{ t("版本", "Version") }}</dt>
            <dd class="mono">{{ appVersion }}</dd>
          </div>
        </dl>

        <UiButton size="sm" variant="ghost" icon="arrow-path" @click="resetPrefs">
          {{ t("恢复默认设置", "Restore defaults") }}
        </UiButton>
      </div>
    </div>
  </section>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  width: 100%;
  max-width: var(--content-max);
  margin: 0 auto;
  padding: var(--space-6) var(--space-8) var(--space-12);
  overflow-y: auto;
}

/* 卡片随可用宽度自动增减列数：窄窗单列，宽窗「外观 / 关于」并排 */
.settings__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr));
  gap: var(--space-5);
  align-items: start;
}

.settings__head {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.settings__title {
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.06em;
  color: var(--color-text);
}

.settings__desc {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.settings__block {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
  background-color: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}

.settings__block-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--color-border-subtle);
}

.settings__block-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-serif);
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.08em;
  color: var(--color-text);
}

.settings__block-title svg {
  color: var(--color-text-muted);
}

.settings__about {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--space-3) var(--space-6);
  margin: 0;
}

.settings__about div {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.settings__about dt {
  font-size: var(--text-2xs);
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.settings__about dd {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text);
}

/* 主题分段控件不要拉满整行，保持「被选中的一项」的观感 */
.settings__block :deep(.seg) {
  width: fit-content;
  max-width: 100%;
}
</style>