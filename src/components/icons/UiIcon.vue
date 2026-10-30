<script setup lang="ts">
import { computed } from "vue";
import { ICONS, type IconName } from "./index";

/**
 * 统一图标渲染：24×24 网格、currentColor、固定线宽。
 * 图标一律 aria-hidden —— 语义由按钮的 aria-label 或相邻文字承担。
 */
const props = withDefaults(
  defineProps<{
    name: IconName;
    /** 视觉尺寸（px），线宽按 24 网格等比缩放保持观感统一。 */
    size?: number;
    /** 覆写线宽，默认 1.5。 */
    strokeWidth?: number;
  }>(),
  { size: 20, strokeWidth: 1.5 },
);

const paths = computed<readonly string[]>(() => ICONS[props.name]);
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(d, index) in paths" :key="index" :d="d" />
  </svg>
</template>

<style scoped>
.icon {
  flex: none;
  display: block;
  overflow: visible;
}
</style>
