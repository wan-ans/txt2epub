<script setup lang="ts">
import { computed } from "vue";
import UiIcon from "../icons/UiIcon.vue";
import type { ReadResult, EncodingChoice } from "../engine/core";
import { encodingOptions } from "../composables/useWorkspace";
import { useUiLanguage } from "../composables/useUiLanguage";

/**
 * 编码条：一行展示「检测到 X → 实际使用 Y」，右侧下拉可手动切换并立即重解析。
 * 置信度用一枚细进度条表达，避免数字噪音。
 */
const props = defineProps<{
  read: ReadResult | null;
  choice: EncodingChoice;
  busy: boolean;
  fileName: string;
  fileSize: string;
}>();

const emit = defineEmits<{ change: [value: EncodingChoice] }>();

const { t } = useUiLanguage();

const detected = computed(() => props.read?.detectedEncoding?.toUpperCase() ?? t("未知", "Unknown"));
const used = computed(() => props.read?.usedEncoding?.toUpperCase() ?? "—");
const confidence = computed(() => {
  const value = props.read?.confidence;
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
});

/** 检测结果与用户选择不一致时提示「手动指定」 */
const overridden = computed(() => props.choice !== "auto" && detected.value !== used.value);
</script>

<template>
  <div class="enc">
    <span class="enc__file">
      <UiIcon name="document-text" :size="15" />
      <span class="enc__file-name" :title="fileName">{{ fileName }}</span>
      <span class="enc__file-size tnum">{{ fileSize }}</span>
    </span>

    <span class="enc__arrow" aria-hidden="true">
      <UiIcon name="arrow-right" :size="14" />
    </span>

    <dl class="enc__stats">
      <div class="enc__stat">
        <dt>{{ t("检测", "Detected") }}</dt>
        <dd class="mono">{{ detected }}</dd>
      </div>
      <div class="enc__stat">
        <dt>{{ t("使用", "Using") }}</dt>
        <dd class="mono enc__stat--strong">{{ used }}</dd>
      </div>
      <div v-if="confidence !== null" class="enc__stat">
        <dt>{{ t("置信", "Confidence") }}</dt>
        <dd class="mono">{{ confidence }}%</dd>
      </div>
    </dl>

    <span v-if="overridden" class="badge badge--warning">{{ t("已手动指定", "Manual override") }}</span>

    <span class="spacer" />

    <label class="enc__picker">
      <span class="enc__picker-label">{{ t("编码", "Encoding") }}</span>
      <select
        class="ctl enc__select"
        :value="choice"
        :disabled="busy"
        :aria-label="t('文件编码', 'File encoding')"
        @change="emit('change', ($event.target as HTMLSelectElement).value as EncodingChoice)"
      >
        <option v-for="option in encodingOptions()" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
    </label>
  </div>
</template>

<style scoped>
.enc {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  padding: var(--space-2) var(--space-4);
  background-color: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}

.enc__file {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.enc__file-name {
  max-width: 22ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
}

.enc__file-size {
  color: var(--color-text-muted);
}

.enc__arrow {
  display: grid;
  place-items: center;
  color: var(--color-text-muted);
}

.enc__stats {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin: 0;
}

.enc__stat {
  display: flex;
  align-items: baseline;
  gap: 5px;
}

.enc__stat dt {
  font-size: var(--text-2xs);
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}

.enc__stat dd {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.enc__stat--strong {
  color: var(--color-primary-text);
  font-weight: var(--weight-medium);
}

.enc__picker {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.enc__picker-label {
  font-size: var(--text-2xs);
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}

.enc__select {
  width: auto;
  min-width: 132px;
  min-height: 30px;
  padding-top: 0;
  padding-bottom: 0;
  font-size: var(--text-xs);
}
</style>
