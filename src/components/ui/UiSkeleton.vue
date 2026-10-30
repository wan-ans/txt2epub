<script setup lang="ts">
/**
 * 骨架屏：加载态占位。用静态色块 + 极弱的流光，避免布局跳动。
 */
withDefaults(
  defineProps<{
    /** 行数 */
    lines?: number;
    /** 每条的高度 */
    height?: number;
    /** 最后一行宽度比例 */
    lastWidth?: string;
  }>(),
  { lines: 3, height: 12, lastWidth: "60%" },
);
</script>

<template>
  <div class="skel" aria-hidden="true">
    <div class="skel__lines">
      <span
        v-for="n in lines"
        :key="n"
        class="skel__bar"
        :style="{
          height: `${height}px`,
          width: n === lines ? lastWidth : '100%',
        }"
      />
    </div>
  </div>
</template>

<style scoped>
.skel {
  display: flex;
  gap: var(--space-3);
}

.skel__lines {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.skel__bar {
  display: block;
  background-color: var(--color-bg-sunken);
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--color-border) 55%, transparent) 50%,
    transparent 100%
  );
  background-size: 220% 100%;
  background-repeat: no-repeat;
  border-radius: var(--radius-full);
  animation: ink-shimmer 1400ms var(--ease-in-out) infinite;
}

@media (prefers-reduced-motion: reduce) {
  .skel__bar {
    animation: none;
    background-image: none;
  }
}
</style>
