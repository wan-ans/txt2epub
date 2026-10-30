<script setup lang="ts">
import { computed } from "vue";
import { useUiLanguage } from "../composables/useUiLanguage";

/**
 * 表单字段外壳：可见 label + 可选的提示 / 错误 / 右侧元信息。
 * label 通过 for 关联到 inputId；错误信息用 role=alert 即时播报。
 */
const { t } = useUiLanguage();

const props = withDefaults(
  defineProps<{
    label: string;
    inputId: string;
    hint?: string;
    error?: string;
    required?: boolean;
    /** label 行右侧的次要信息（如字数、当前值） */
    meta?: string;
  }>(),
  { required: false },
);

/** 供子控件绑定：把 hint 与 error 的 id 串起来。 */
const describedBy = computed(() => {
  const ids: string[] = [];
  if (props.hint && !props.error) ids.push(`${props.inputId}-hint`);
  if (props.error) ids.push(`${props.inputId}-error`);
  return ids.length ? ids.join(" ") : undefined;
});
</script>

<template>
  <div class="field">
    <div class="field__label">
      <label :for="inputId">
        {{ label }}<span v-if="required" class="req" aria-hidden="true">*</span>
        <span v-if="required" class="sr-only">{{ t("（必填）", "(required)") }}</span>
      </label>
      <span v-if="meta" class="field__meta tnum">{{ meta }}</span>
      <span class="spacer" />
      <slot name="action" :described-by="describedBy" />
    </div>

    <slot :described-by="describedBy" />

    <p v-if="hint && !error" :id="`${inputId}-hint`" class="field__hint">{{ hint }}</p>
    <p v-if="error" :id="`${inputId}-error`" class="field__error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.field__meta {
  font-size: var(--text-2xs);
  font-weight: var(--weight-regular);
  letter-spacing: 0.02em;
  color: var(--color-text-muted);
}

.field__label label {
  cursor: pointer;
}

.req {
  margin-left: 3px;
}
</style>
