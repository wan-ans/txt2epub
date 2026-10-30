<script setup lang="ts">
import { computed } from "vue";
import UiIcon from "../icons/UiIcon.vue";
import type { IconName } from "../icons";

/**
 * 单行输入。`modelValue` 双向绑定；错误态通过 aria-invalid 暴露。
 * 前缀图标用于搜索/编码等场景。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    id: string;
    type?: "text" | "number" | "search" | "email" | "url";
    placeholder?: string;
    disabled?: boolean;
    readonly?: boolean;
    invalid?: boolean;
    icon?: IconName;
    describedBy?: string;
    ariaLabel?: string;
    autofocus?: boolean;
    min?: number;
    max?: number;
    step?: number;
  }>(),
  { type: "text" },
);

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const hasIcon = computed(() => Boolean(props.icon));
</script>

<template>
  <div class="input-wrap" :class="{ 'input-wrap--icon': hasIcon }">
    <UiIcon v-if="icon" :name="icon" :size="16" class="input-wrap__icon" />
    <input
      :id="id"
      class="ctl input-wrap__ctl"
      :class="{ 'input-wrap__ctl--icon': hasIcon }"
      :type="type"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :aria-invalid="invalid || undefined"
      :aria-describedby="describedBy"
      :aria-label="ariaLabel"
      :autofocus="autofocus"
      :min="min"
      :max="max"
      :step="step"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <slot name="trailing" />
  </div>
</template>

<style scoped>
.input-wrap {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
}

.input-wrap__icon {
  position: absolute;
  left: var(--space-3);
  color: var(--color-text-muted);
  pointer-events: none;
  transition: color var(--duration-fast) var(--ease-out);
}

.input-wrap__ctl--icon {
  padding-left: calc(var(--space-3) * 2 + 16px);
}

.input-wrap__ctl:focus + .input-wrap__icon,
.input-wrap__icon:has(+ .input-wrap__ctl:focus) {
  color: var(--color-text-secondary);
}
</style>
