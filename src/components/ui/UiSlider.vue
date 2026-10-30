<script setup lang="ts">
/**
 * 带数值显示的滑杆。原生 range 保证键盘（←→）与读屏支持；
 * 轨道用线性渐变绘制已填充部分，不引入额外 DOM。
 */
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: number;
    id: string;
    min: number;
    max: number;
    step?: number;
    /** 展示时的小数位 */
    precision?: number;
    unit?: string;
    describedBy?: string;
    ariaLabel?: string;
  }>(),
  { step: 1, precision: 0, unit: "" },
);

const emit = defineEmits<{ "update:modelValue": [value: number] }>();

const percent = computed(() => {
  const span = props.max - props.min;
  if (span <= 0) return 0;
  return ((props.modelValue - props.min) / span) * 100;
});

const display = computed(() => `${props.modelValue.toFixed(props.precision)}${props.unit}`);
</script>

<template>
  <div class="slider">
    <input
      :id="id"
      class="slider__input"
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="modelValue"
      :aria-describedby="describedBy"
      :aria-label="ariaLabel"
      :aria-valuetext="display"
      :style="{ '--slider-fill': `${percent}%` }"
      @input="emit('update:modelValue', Number(($event.target as HTMLInputElement).value))"
    />
    <output class="slider__value mono" :for="id">{{ display }}</output>
  </div>
</template>

<style scoped>
.slider {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.slider__input {
  flex: 1 1 auto;
  min-width: 0;
  height: 32px;
  margin: 0;
  appearance: none;
  background: transparent;
  cursor: pointer;
}

.slider__input::-webkit-slider-runnable-track {
  height: 4px;
  background-image: linear-gradient(
    to right,
    var(--color-primary) 0%,
    var(--color-primary) var(--slider-fill),
    var(--color-bg-sunken) var(--slider-fill),
    var(--color-bg-sunken) 100%
  );
  border-radius: var(--radius-full);
}

.slider__input::-moz-range-track {
  height: 4px;
  background-color: var(--color-bg-sunken);
  border-radius: var(--radius-full);
}

.slider__input::-moz-range-progress {
  height: 4px;
  background-color: var(--color-primary);
  border-radius: var(--radius-full);
}

.slider__input::-webkit-slider-thumb {
  appearance: none;
  width: 16px;
  height: 16px;
  margin-top: -6px;
  background-color: var(--color-surface);
  border: 2px solid var(--color-primary);
  border-radius: var(--radius-full);
  box-shadow: var(--shadow-xs);
  transition:
    transform var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out);
}

.slider__input::-moz-range-thumb {
  width: 12px;
  height: 12px;
  background-color: var(--color-surface);
  border: 2px solid var(--color-primary);
  border-radius: var(--radius-full);
}

.slider__input:hover::-webkit-slider-thumb {
  transform: scale(1.1);
}

.slider__input:focus-visible {
  outline: none;
}

.slider__input:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-focus) 35%, transparent);
}

.slider__value {
  flex: none;
  min-width: 46px;
  font-size: var(--text-xs);
  text-align: right;
  color: var(--color-text-secondary);
}
</style>
