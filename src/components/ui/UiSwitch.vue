<script setup lang="ts">
/**
 * 开关（角色为 switch）。点击区域 40×22，外层 label 保证 >= 32px 行高。
 * 键盘：Space / Enter 原生 button 已支持。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    label: string;
    /** 使用 aria-label 而非可见文字时传入（此时 label 仅供读屏） */
    hideLabel?: boolean;
    disabled?: boolean;
    id?: string;
  }>(),
  { hideLabel: false, disabled: false },
);

const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();

function toggle() {
  if (props.disabled) return;
  emit("update:modelValue", !props.modelValue);
}
</script>

<template>
  <button
    :id="id"
    type="button"
    role="switch"
    class="switch"
    :class="{ 'switch--on': modelValue, 'switch--with-label': !hideLabel }"
    :aria-checked="modelValue"
    :aria-label="hideLabel ? label : undefined"
    :disabled="disabled"
    @click="toggle"
  >
    <span class="switch__track" aria-hidden="true"><span class="switch__thumb" /></span>
    <span v-if="!hideLabel" class="switch__text">{{ label }}</span>
  </button>
</template>

<style scoped>
.switch {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 32px;
  color: var(--color-text-secondary);
  text-align: left;
  border-radius: var(--radius-sm);
  transition: color var(--duration-fast) var(--ease-out);
}

.switch--with-label {
  padding-right: var(--space-1);
}

.switch:not(:disabled):hover {
  color: var(--color-text);
}

.switch:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.switch__track {
  position: relative;
  flex: none;
  width: 38px;
  height: 22px;
  background-color: var(--color-bg-sunken);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-full);
  transition:
    background-color var(--duration-base) var(--ease-out),
    border-color var(--duration-base) var(--ease-out);
}

.switch__thumb {
  position: absolute;
  top: 50%;
  left: 2px;
  width: 16px;
  height: 16px;
  background-color: var(--color-surface);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-full);
  box-shadow: var(--shadow-xs);
  transform: translateY(-50%);
  transition:
    left var(--duration-base) var(--ease-out),
    background-color var(--duration-base) var(--ease-out),
    border-color var(--duration-base) var(--ease-out);
}

.switch--on .switch__track {
  background-color: var(--color-primary);
  border-color: var(--color-primary);
}

.switch--on .switch__thumb {
  left: 18px;
  background-color: var(--color-primary-contrast);
  border-color: var(--color-primary-contrast);
}

.switch__text {
  font-size: var(--text-sm);
  line-height: var(--leading-tight);
}
</style>
