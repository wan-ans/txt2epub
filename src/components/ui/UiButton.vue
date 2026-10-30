<script setup lang="ts">
import { computed } from "vue";
import UiIcon from "../icons/UiIcon.vue";
import type { IconName } from "../icons";

/**
 * 按钮。三种视觉层级（primary / secondary / ghost）+ 危险色 + 尺寸。
 * 所有变体最小高度 32px，保证点击区域；focus 走全局 focus-visible。
 */
const props = withDefaults(
  defineProps<{
    variant?: "primary" | "secondary" | "ghost" | "danger";
    size?: "sm" | "md";
    icon?: IconName;
    /** 加载中：显示旋转图标并禁用交互，同时通过 aria-busy 告知读屏。 */
    loading?: boolean;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
  }>(),
  { variant: "secondary", size: "md", type: "button" },
);

const isInert = computed(() => props.disabled || props.loading);
</script>

<template>
  <button
    :type="type"
    class="btn"
    :class="[`btn--${variant}`, `btn--${size}`]"
    :disabled="isInert"
    :aria-busy="loading || undefined"
  >
    <UiIcon v-if="loading" name="spinner" class="btn__spin" :size="size === 'sm' ? 14 : 16" />
    <UiIcon v-else-if="icon" :name="icon" :size="size === 'sm' ? 14 : 16" />
    <span v-if="$slots.default" class="btn__label"><slot /></span>
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 36px;
  padding: 0 var(--space-4);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  letter-spacing: 0.02em;
  line-height: 1;
  white-space: nowrap;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  transition:
    background-color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out);
}

.btn--sm {
  min-height: 32px;
  padding: 0 var(--space-3);
  font-size: var(--text-xs);
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.btn:not(:disabled):active {
  transform: translateY(0.5px);
}

/* —— primary：朱砂实底 —— */
.btn--primary {
  color: var(--color-primary-contrast);
  background-color: var(--color-primary);
  border-color: var(--color-primary);
  box-shadow: var(--shadow-xs);
}

.btn--primary:not(:disabled):hover {
  background-color: var(--color-primary-hover);
  border-color: var(--color-primary-hover);
}

/* —— secondary：纸面 + 描边 —— */
.btn--secondary {
  color: var(--color-text);
  background-color: var(--color-surface);
  border-color: var(--color-border-strong);
}

.btn--secondary:not(:disabled):hover {
  background-color: var(--color-surface-hover);
  border-color: var(--color-text-muted);
}

/* —— ghost：无底 —— */
.btn--ghost {
  color: var(--color-text-secondary);
  background-color: transparent;
}

.btn--ghost:not(:disabled):hover {
  color: var(--color-text);
  background-color: var(--color-surface-active);
}

/* —— danger —— */
.btn--danger {
  color: var(--color-danger);
  background-color: transparent;
  border-color: color-mix(in srgb, var(--color-danger) 40%, transparent);
}

.btn--danger:not(:disabled):hover {
  background-color: var(--color-danger-soft);
  border-color: var(--color-danger);
}

.btn__label {
  display: inline-block;
}

.btn__spin {
  animation: ink-spin 720ms linear infinite;
}
</style>
