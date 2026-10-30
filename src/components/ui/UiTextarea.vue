<script setup lang="ts">
withDefaults(
  defineProps<{
    modelValue: string;
    id: string;
    placeholder?: string;
    rows?: number;
    disabled?: boolean;
    invalid?: boolean;
    describedBy?: string;
    /** 使用等宽字体（正则、关键词等） */
    mono?: boolean;
  }>(),
  { rows: 4 },
);

const emit = defineEmits<{ "update:modelValue": [value: string] }>();
</script>

<template>
  <textarea
    :id="id"
    class="ctl"
    :class="{ mono }"
    :value="modelValue"
    :placeholder="placeholder"
    :rows="rows"
    :disabled="disabled"
    :aria-invalid="invalid || undefined"
    :aria-describedby="describedBy"
    @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  />
</template>
