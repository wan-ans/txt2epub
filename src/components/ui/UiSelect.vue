<script setup lang="ts">
/**
 * 下拉选择。使用原生 <select> 以获得系统级无障碍与键盘行为，
 * 仅用 CSS 重绘外观（原生箭头由 app.css 的 select.ctl 绘制）。
 */
defineProps<{
  modelValue: string;
  id: string;
  options: { value: string; label: string }[];
  disabled?: boolean;
  describedBy?: string;
  ariaLabel?: string;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string] }>();
</script>

<template>
  <select
    :id="id"
    class="ctl"
    :value="modelValue"
    :disabled="disabled"
    :aria-describedby="describedBy"
    :aria-label="ariaLabel"
    @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option v-for="option in options" :key="option.value" :value="option.value">
      {{ option.label }}
    </option>
  </select>
</template>
