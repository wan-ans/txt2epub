<script setup lang="ts">
/**
 * 顶部一条 60px 的细标题栏：左侧 logo「墨匣」+ 当前文件名，右侧主题切换 + 设置。
 * 桌面应用观感：细分割线、紧凑高度、面包屑式文件名。
 */
import { computed } from "vue";
import UiIcon from "../icons/UiIcon.vue";
import UiSegmented from "../ui/UiSegmented.vue";
import type { SegmentOption } from "../ui/UiSegmented.vue";
import { useTheme, type ThemeMode } from "../composables/useTheme";
import { useUiLanguage } from "../composables/useUiLanguage";

const props = defineProps<{
  fileName: string;
  chapterCount: number;
  /** 有文件时显示「退出本书」按钮 */
  hasFile: boolean;
  /** 左侧主导航是否折叠 */
  navCollapsed: boolean;
  /** 批量视图里不显示章节数 */
  showChapterCount?: boolean;
}>();

const emit = defineEmits<{
  toggleNav: [];
  exitBook: [];
}>();

const { mode, setMode } = useTheme();
const { t } = useUiLanguage();

const themeOptions = computed<SegmentOption[]>(() => [
  { value: "system", label: t("跟随系统", "Follow system"), icon: "computer-desktop" },
  { value: "light", label: t("浅色", "Light"), icon: "sun" },
  { value: "dark", label: t("深色", "Dark"), icon: "moon" },
]);

const navToggleLabel = computed(() => (props.navCollapsed ? t("展开主导航", "Expand navigation") : t("收起主导航", "Collapse navigation")));
const navToggleTitle = computed(() => t("收起/展开主导航（Ctrl+B）", "Collapse/expand navigation (Ctrl+B)"));
const exitTitle = computed(() => t("退出当前这本书的转换（回到开始）", "Leave this book and return to start"));
</script>

<template>
  <header class="titlebar">
    <div class="titlebar__left">
      <!-- 只控制左侧主导航，与章节列表收起互不影响 -->
      <button
        type="button"
        class="titlebar__toggle"
        :aria-label="navToggleLabel"
        :aria-expanded="!navCollapsed"
        :title="navToggleTitle"
        @click="emit('toggleNav')"
      >
        <UiIcon :name="navCollapsed ? 'chevron-double-right' : 'chevron-double-left'" :size="16" />
      </button>

      <span class="brand" aria-hidden="true">
        <span class="brand__seal">匣</span>
      </span>

      <div class="titlebar__names">
        <p class="titlebar__product serif">{{ t("墨匣", "Inkbox") }}</p>
        <p v-if="fileName" class="titlebar__file" :title="fileName">
          {{ fileName }}
          <span v-if="showChapterCount !== false && chapterCount" class="titlebar__count tnum">
            · {{ chapterCount }} {{ t("章", "ch.") }}
          </span>
        </p>
      </div>
    </div>

    <div class="titlebar__right">
      <!-- 退出当前这本书：回到空状态，不必重启程序 -->
      <button
        v-if="hasFile"
        type="button"
        class="titlebar__exit"
        :title="exitTitle"
        @click="emit('exitBook')"
      >
        <UiIcon name="arrow-uturn-left" :size="14" />
        <span class="titlebar__exit-text">{{ t("退出本书", "Leave book") }}</span>
      </button>

      <UiSegmented
        :model-value="mode"
        :options="themeOptions"
        :aria-label="t('外观主题', 'Appearance theme')"
        size="sm"
        @update:model-value="(value) => setMode(value as ThemeMode)"
      />

    </div>
  </header>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex: none;
  height: var(--header-height);
  padding: 0 var(--space-4);
  background-color: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}

.titlebar__left {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.titlebar__toggle {
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 28px;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  transition:
    color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.titlebar__toggle:hover {
  color: var(--color-text);
  background-color: var(--color-surface-active);
}

/* 退出本书：低调但明确，避免用户只能强关程序 */
.titlebar__exit {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 var(--space-3);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background-color: transparent;
  transition:
    color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}

.titlebar__exit:hover {
  color: var(--color-danger);
  background-color: var(--color-danger-soft);
  border-color: color-mix(in srgb, var(--color-danger) 40%, transparent);
}

@media (max-width: 1200px) {
  .titlebar__exit-text {
    display: none;
  }

  .titlebar__exit {
    padding: 0 var(--space-2);
  }
}

/* 印章式 logo：朱砂方块 + 反白字 */
.brand {
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  background-color: var(--color-primary);
  border-radius: 5px;
}

.brand__seal {
  font-family: var(--font-serif);
  font-size: 14px;
  font-weight: var(--weight-bold);
  line-height: 1;
  color: var(--color-primary-contrast);
}

.titlebar__names {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  min-width: 0;
}

.titlebar__product {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  line-height: 1.2;
  letter-spacing: 0.14em;
  color: var(--color-text);
}

.titlebar__file {
  display: flex;
  align-items: center;
  gap: 3px;
  max-width: 44ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-2xs);
  line-height: 1.2;
  color: var(--color-text-secondary);
}

.titlebar__count {
  flex: none;
  color: var(--color-text-muted);
}

.titlebar__right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}

@media (max-width: 1100px) {
  .titlebar__file {
    max-width: 26ch;
  }
}
</style>