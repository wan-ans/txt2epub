<script setup lang="ts">
import { computed } from "vue";
import UiIcon from "../icons/UiIcon.vue";
import UiButton from "../ui/UiButton.vue";
import { isDesktop } from "../../bridge";
import { useUiLanguage } from "../composables/useUiLanguage";

/**
 * 空状态：整窗拖拽的引导区。
 * 中间一块「宣纸信笺」造型的投放区，四周用极淡的墨格纹做质感。
 */
defineProps<{
  /** 拖拽进行中：高亮边框与文案 */
  dragging: boolean;
}>();

const emit = defineEmits<{ pickFiles: []; pickFolder: [] }>();

const { t } = useUiLanguage();

const desktopMode = computed(() => isDesktop());
</script>

<template>
  <section class="drop" :class="{ 'drop--active': dragging }" aria-labelledby="drop-title">
    <div class="drop__inner">
      <div class="drop__glyph" aria-hidden="true">
        <svg viewBox="0 0 88 88" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 14h30l18 18v42a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4V18a4 4 0 0 1 4-4Z" opacity="0.55" />
          <path d="M50 14v18h18" opacity="0.55" />
          <path d="M30 44h26" opacity="0.3" />
          <path d="M30 54h26" opacity="0.3" />
          <path d="M30 64h16" opacity="0.3" />
          <path d="M44 38v20" />
          <path d="M36 46l8-8 8 8" />
        </svg>
      </div>

      <div class="drop__copy">
        <p class="drop__eyebrow">TXT → EPUB 3</p>

        <p id="drop-title" class="drop__title drop__title--lead serif">
          {{ dragging ? t("松手，装进匣子", "Release to drop it in") : t("把文件拖到窗口任意位置，或点下面的按钮选择", "Drag files anywhere into the window, or choose with the buttons below") }}
        </p>

        <div class="drop__actions">
          <UiButton variant="primary" size="md" icon="arrow-up-tray" @click="emit('pickFiles')">
            {{ t("选择 TXT 文件", "Choose TXT file") }}
          </UiButton>
          <UiButton
            v-if="desktopMode"
            variant="secondary"
            size="md"
            icon="folder-plus"
            @click="emit('pickFolder')"
          >
            {{ t("打开文件夹", "Open folder") }}
          </UiButton>
        </div>

        <p class="drop__limit">
          <UiIcon name="information-circle" :size="13" />
           {{ t("支持 UTF-8 / GBK / GB18030 / Big5 / UTF-16，最大 100 MB", "Supports UTF-8 / GBK / GB18030 / Big5 / UTF-16, up to 100 MB") }}
        </p>
      </div>
    </div>

  </section>
</template>

<style scoped>
.drop {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-8);
  height: 100%;
  padding: var(--space-10) var(--space-6);
  overflow-y: auto;
}

/* 底纹：用极淡的线性网格模拟稿纸，不用渐变光斑 */
.drop::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(to right, var(--color-border-subtle) 1px, transparent 1px),
    linear-gradient(to bottom, var(--color-border-subtle) 1px, transparent 1px);
  background-size: 32px 32px;
  opacity: 0.5;
  mask-image: radial-gradient(ellipse 62% 58% at 50% 44%, transparent 35%, currentColor 100%);
  mask-mode: luminance;
  color: var(--color-bg);
}

.drop__inner {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-8);
  width: min(100%, 760px);
  padding: var(--space-10) var(--space-10);
  text-align: left;
  background-color: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  transition:
    border-color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}

/* 用「角标」传达纸张感：内缩一圈虚线 */
.drop__inner::after {
  content: "";
  position: absolute;
  inset: var(--space-2);
  pointer-events: none;
  border: 1px dashed var(--color-border);
  border-radius: calc(var(--radius-lg) - 6px);
  opacity: 0.7;
}

.drop--active .drop__inner {
  border-color: var(--color-primary);
  box-shadow:
    var(--shadow-md),
    0 0 0 4px color-mix(in srgb, var(--color-primary) 12%, transparent);
  transform: translateY(-1px);
}

.drop--active .drop__inner::after {
  border-color: color-mix(in srgb, var(--color-primary) 45%, transparent);
}

.drop__glyph {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  width: 132px;
  height: 132px;
  color: var(--color-text-muted);
  background-color: var(--color-bg-sunken);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  transition:
    color var(--duration-base) var(--ease-out),
    border-color var(--duration-base) var(--ease-out),
    background-color var(--duration-base) var(--ease-out);
}

/* 内层再收一圈细线，呼应纸张的装帧边 */
.drop__glyph::after {
  content: "";
  position: absolute;
  inset: 7px;
  pointer-events: none;
  border: 1px solid var(--color-border-subtle);
  border-radius: calc(var(--radius-md) - 5px);
}

.drop--active .drop__glyph {
  color: var(--color-primary);
  background-color: var(--color-primary-soft);
  border-color: color-mix(in srgb, var(--color-primary) 40%, transparent);
}

.drop--active .drop__glyph::after {
  border-color: color-mix(in srgb, var(--color-primary) 26%, transparent);
}

.drop__glyph svg {
  width: 66px;
  height: 66px;
}

.drop__copy {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  min-width: 0;
}

.drop__eyebrow {
  margin-bottom: var(--space-1);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--color-primary-text);
  opacity: 0.9;
}

.drop__title {
  font-size: var(--text-2xl);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
  letter-spacing: 0.07em;
  color: var(--color-text);
}

.drop__title--lead {
  max-width: 26em;
  font-size: var(--text-xl);
  font-weight: var(--weight-medium);
  line-height: var(--leading-normal);
  letter-spacing: 0.04em;
}

.drop__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.drop__limit {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-top: var(--space-1);
  font-size: var(--text-2xs);
  color: var(--color-text-muted);
}

@media (max-width: 1180px) {
  .drop__inner {
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: var(--space-5);
    width: min(100%, 540px);
    padding: var(--space-8) var(--space-6);
  }

  .drop__copy {
    align-items: center;
  }

  .drop__actions {
    justify-content: center;
  }
}

@media (max-width: 1000px) {
  .drop {
    gap: var(--space-6);
    padding: var(--space-8) var(--space-5);
  }

  .drop__glyph svg {
    width: 64px;
    height: 64px;
  }
}

@media (max-height: 760px) {
  .drop {
    gap: var(--space-5);
    padding-top: var(--space-6);
    padding-bottom: var(--space-6);
  }

  .drop__glyph {
    display: none;
  }
}
</style>