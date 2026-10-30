<script setup lang="ts">
import { computed } from "vue";
import UiIcon from "../icons/UiIcon.vue";
import { formatBytes } from "../composables/useEpubWorkspace";
import { useUiLanguage } from "../composables/useUiLanguage";

/**
 * EPUB 编辑底部状态条：只保留一行极小的书籍信息，不再放大按钮。
 * 保存操作改为右下角悬浮按钮（EpubView 内实现）。
 */
const props = defineProps<{
  chapterCount: number;
  wordCount: number;
  sourceBytes: number;
  hasCover: boolean;
  resourceCount: number;
  lastExportPath: string | null;
}>();

const emit = defineEmits<{ reveal: [] }>();
const { t } = useUiLanguage();

const wordLabel = computed(() => {
  const value = Number(props.wordCount) || 0;
  if (value >= 10000) return t(`${(value / 10000).toFixed(1)} 万`, `${(value / 1000).toFixed(1)}k`);
  return value.toLocaleString(t("zh-CN", "en-US"));
});
</script>

<template>
  <footer class="statusbar" :aria-label="t('书籍信息', 'Book info')">
    <span class="statusbar__item">{{ t("章节", "Chapters") }} <b class="mono tnum">{{ chapterCount }}</b></span>
    <span class="statusbar__sep" aria-hidden="true">·</span>
    <span class="statusbar__item">{{ t("字数", "Characters") }} <b class="mono tnum">{{ wordLabel }}</b></span>
    <span class="statusbar__sep" aria-hidden="true">·</span>
    <span class="statusbar__item">{{ t("原文件", "Source file") }} <b class="mono tnum">{{ formatBytes(sourceBytes) }}</b></span>
    <span class="statusbar__sep" aria-hidden="true">·</span>
    <span class="statusbar__item">{{ t("封面", "Cover") }} <b>{{ hasCover ? t("已设置", "Set") : t("无", "None") }}</b></span>
    <span class="statusbar__sep" aria-hidden="true">·</span>
    <span class="statusbar__item">{{ t("资源", "Resources") }} <b class="mono tnum">{{ resourceCount }}</b></span>
    <span class="spacer" />
    <span v-if="lastExportPath" class="statusbar__saved" :title="lastExportPath">
      <UiIcon name="check-circle" :size="11" />
      {{ t("已保存", "Saved") }}
      <button type="button" class="statusbar__reveal" @click="emit('reveal')">{{ t("打开位置", "Open location") }}</button>
    </span>
  </footer>
</template>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 28px;
  padding: 0 var(--space-3);
  overflow: hidden;
  font-size: var(--text-2xs);
  color: var(--color-text-muted);
  background-color: var(--color-bg-elevated);
  border-top: 1px solid var(--color-border-subtle);
  white-space: nowrap;
}

.statusbar__item b {
  margin-left: 2px;
  font-weight: var(--weight-medium);
  color: var(--color-text-secondary);
}

.statusbar__sep {
  opacity: 0.55;
}

.statusbar__saved {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  color: var(--color-success);
}

.statusbar__reveal {
  color: var(--color-primary-text);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.statusbar__reveal:hover {
  color: var(--color-primary-hover);
}

@media (max-width: 1180px) {
  .statusbar {
    gap: 4px;
    padding: 0 var(--space-2);
  }

  .statusbar__item:nth-of-type(n + 7),
  .statusbar__sep:nth-of-type(n + 7) {
    display: none;
  }
}
</style>