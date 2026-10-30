<script setup lang="ts">
/**
 * 分段控制器：用于少量互斥选项（主题、视图切换）。
 * 语义为 role=radiogroup + roving tabindex，方向键可切换。
 * 选项可只显示图标，此时 label 仍作为无障碍名称。
 */
import { computed, nextTick, ref, useAttrs } from "vue";
import UiIcon from "../icons/UiIcon.vue";
import type { IconName } from "../icons";

export interface SegmentOption {
  value: string;
  label: string;
  icon?: IconName;
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: SegmentOption[];
    /** 分组名称。也可以直接在标签上写 aria-label。 */
    ariaLabel?: string;
    size?: "sm" | "md";
    full?: boolean;
  }>(),
  { size: "md", full: false, ariaLabel: undefined },
);

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

/** aria-label 既可用 prop 传，也可作为普通 attribute 落在根节点上。 */
defineOptions({ inheritAttrs: false });

const attrs = useAttrs();

const rootRef = ref<HTMLElement | null>(null);
const currentIndex = computed(() => props.options.findIndex((o) => o.value === props.modelValue));

async function move(step: number) {
  const len = props.options.length;
  if (!len) return;
  const next = (currentIndex.value + step + len) % len;
  emit("update:modelValue", props.options[next].value);
  await nextTick();
  const buttons = rootRef.value?.querySelectorAll<HTMLButtonElement>("[role=radio]");
  buttons?.[next]?.focus();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    event.preventDefault();
    void move(1);
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    event.preventDefault();
    void move(-1);
  }
}
</script>

<template>
  <div
    ref="rootRef"
    class="seg"
    :class="[`seg--${size}`, { 'seg--full': full }]"
    role="radiogroup"
    :aria-label="ariaLabel ?? (attrs['aria-label'] as string | undefined)"
    v-bind="attrs"
    @keydown="onKeydown"
  >
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      role="radio"
      class="seg__btn"
      :class="{ 'seg__btn--on': option.value === modelValue, 'seg__btn--icon': option.icon && !option.label }"
      :aria-checked="option.value === modelValue"
      :aria-label="option.label"
      :title="option.label"
      :tabindex="option.value === modelValue ? 0 : -1"
      @click="emit('update:modelValue', option.value)"
    >
      <UiIcon v-if="option.icon" :name="option.icon" :size="size === 'sm' ? 15 : 16" />
      <template v-else>{{ option.label }}</template>
    </button>
  </div>
</template>

<style scoped>
.seg {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background-color: var(--color-bg-sunken);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.seg--full {
  display: flex;
  width: 100%;
}

.seg--full .seg__btn {
  flex: 1 1 0;
}

.seg__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  min-height: 30px;
  padding: 0 var(--space-3);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  letter-spacing: 0.02em;
  color: var(--color-text-secondary);
  white-space: nowrap;
  border-radius: 4px;
  transition:
    color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out);
}

.seg__btn--icon {
  width: 30px;
  padding: 0;
}

.seg--md .seg__btn {
  min-height: 32px;
  font-size: var(--text-sm);
}

.seg__btn:hover:not(.seg__btn--on) {
  color: var(--color-text);
  background-color: var(--color-surface-hover);
}

.seg__btn--on {
  color: var(--color-text);
  background-color: var(--color-surface);
  box-shadow: var(--shadow-xs);
}

.seg__btn:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: -1px;
}
</style>
