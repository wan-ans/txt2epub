<script setup lang="ts">
/**
 * 左侧主导航：转换 / 批量 / 规则 / 设置。
 * 折叠态只显示图标，展开态显示文字与说明。用 nav + aria-current 表达当前位置。
 */
import { computed } from "vue";
import UiIcon from "../icons/UiIcon.vue";
import type { IconName } from "../icons";
import { useUiLanguage } from "../composables/useUiLanguage";

export type ViewKey = "convert" | "epub" | "batch" | "rules" | "settings";

const props = defineProps<{
  modelValue: ViewKey;
  collapsed: boolean;
  /** 有文件时转换入口显示章节数徽标 */
  chapterCount: number;
}>();

const emit = defineEmits<{ "update:modelValue": [value: ViewKey]; expand: [] }>();

interface NavItem {
  key: ViewKey;
  label: string;
  desc: string;
  icon: IconName;
}

const { t } = useUiLanguage();

const items = computed<NavItem[]>(() => [
  { key: "convert", label: t("单本转换", "Convert"), desc: t("导入一本 TXT，整理后生成", "Import and convert TXT"), icon: "book-open" },
  { key: "epub", label: t("EPUB 编辑", "EPUB editor"), desc: t("打开成书，改字改章", "Open a book and edit it"), icon: "pencil-square" },
  { key: "batch", label: t("批量转换", "Batch convert"), desc: t("一次处理多个文件", "Process multiple files"), icon: "squares-2x2" },
  { key: "rules", label: t("章节规则", "Chapter rules"), desc: t("定义怎么切分章节", "Define how chapters split"), icon: "list-bullet" },
  { key: "settings", label: t("偏好设置", "Preferences"), desc: t("外观与界面语言", "Appearance and language"), icon: "sliders" },
]);

function select(key: ViewKey) {
  emit("update:modelValue", key);
}

/** 折叠时用 title 提供悬浮说明；模板直接读 props 会触发未使用变量告警。 */
const collapsedHint = (item: NavItem): string | undefined =>
  props.collapsed ? `${item.label} · ${item.desc}` : undefined;
const navLabel = computed(() => t("主导航", "Main navigation"));
const expandLabel = computed(() => t("展开侧栏", "Expand sidebar"));
</script>

<template>
  <nav class="nav" :class="{ 'nav--collapsed': collapsed }" :aria-label="navLabel">
    <ul class="nav__list">
      <li v-for="item in items" :key="item.key">
        <button
          type="button"
          class="nav__item"
          :class="{ 'nav__item--active': modelValue === item.key }"
          :aria-current="modelValue === item.key ? 'page' : undefined"
          :title="collapsedHint(item)"
          @click="select(item.key)"
        >
          <span class="nav__rail" aria-hidden="true" />
          <span class="nav__icon">
            <UiIcon :name="item.icon" :size="18" />
          </span>
          <span v-if="!collapsed" class="nav__text">
            <span class="nav__label">{{ item.label }}</span>
            <span class="nav__desc">{{ item.desc }}</span>
          </span>
          <span
            v-if="item.key === 'convert' && chapterCount > 0"
            class="nav__badge tnum"
            :class="{ 'nav__badge--dot': collapsed }"
          >
            {{ collapsed ? "" : chapterCount }}
          </span>
        </button>
      </li>
    </ul>

    <div v-if="collapsed" class="nav__foot">
      <button type="button" class="nav__expand" :aria-label="expandLabel" @click="emit('expand')">
        <UiIcon name="chevron-double-right" :size="16" />
      </button>
    </div>
  </nav>
</template>

<style scoped>
.nav {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 208px;
  padding: var(--space-3) var(--space-2);
  background-color: var(--color-bg-elevated);
  border-right: 1px solid var(--color-border);
  transition: width var(--duration-base) var(--ease-out);
}

.nav--collapsed {
  width: 56px;
}

.nav__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav__item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 44px;
  padding: var(--space-2) var(--space-3);
  color: var(--color-text-secondary);
  text-align: left;
  border-radius: var(--radius-sm);
  transition:
    color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.nav--collapsed .nav__item {
  justify-content: center;
  padding: var(--space-2);
}

.nav__item:hover {
  color: var(--color-text);
  background-color: var(--color-surface-active);
}

.nav__item--active {
  color: var(--color-text);
  background-color: var(--color-primary-soft);
}

/* 选中态的朱砂竖线，替代纯色块堆砌 */
.nav__rail {
  position: absolute;
  left: -2px;
  top: 50%;
  width: 2px;
  height: 0;
  background-color: var(--color-primary);
  border-radius: var(--radius-full);
  transform: translateY(-50%);
  transition: height var(--duration-base) var(--ease-out);
}

.nav__item--active .nav__rail {
  height: 20px;
}

.nav__icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 20px;
  height: 20px;
}

.nav__item--active .nav__icon {
  color: var(--color-primary-text);
}

.nav__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.nav__label {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav__desc {
  font-size: var(--text-2xs);
  line-height: var(--leading-tight);
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav__badge {
  flex: none;
  margin-left: auto;
  min-width: 22px;
  height: 18px;
  padding: 0 6px;
  font-size: var(--text-2xs);
  line-height: 18px;
  text-align: center;
  color: var(--color-text-secondary);
  background-color: var(--color-bg-sunken);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
}

.nav__badge--dot {
  position: absolute;
  top: 8px;
  right: 8px;
  min-width: 7px;
  width: 7px;
  height: 7px;
  padding: 0;
  background-color: var(--color-primary);
  border: none;
}

.nav__foot {
  margin-top: auto;
  padding-top: var(--space-2);
}

.nav__expand {
  display: grid;
  place-items: center;
  width: 100%;
  height: 32px;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
}

.nav__expand:hover {
  color: var(--color-text);
  background-color: var(--color-surface-active);
}
</style>