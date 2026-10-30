<script setup lang="ts">
import UiButton from "../ui/UiButton.vue";
import UiIcon from "../icons/UiIcon.vue";
import { useUiLanguage } from "../composables/useUiLanguage";

/**
 * EPUB 编辑空状态卡片。
 * 主入口是「打开 EPUB 精修」，次入口是「新建空白书」；
 * 文案说明原书资源会被保留、全程本地处理。
 */
const emit = defineEmits<{ open: []; create: [] }>();
const { t } = useUiLanguage();
</script>

<template>
  <section class="drop" aria-labelledby="epub-drop-title">
    <div class="drop__inner">
      <div class="drop__glyph" aria-hidden="true">
        <svg
          viewBox="0 0 88 88"
          fill="none"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M18 16h26l16 16v40a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4V20a4 4 0 0 1 4-4Z" opacity="0.55" />
          <path d="M44 16v16h16" opacity="0.55" />
          <path d="M44 16v16h16" opacity="0.3" />
          <path d="M25 48h16" opacity="0.3" />
          <path d="M25 58h20" opacity="0.3" />
          <path d="M25 68h12" opacity="0.3" />
          <path d="M54 42l14 14-4 4-14-14z" />
          <path d="M54 42l4-4 14 14-4 4" opacity="0.6" />
        </svg>
      </div>

      <div class="drop__copy">
        <h2 id="epub-drop-title" class="drop__title serif">
          {{ t("打开 EPUB", "Open EPUB") }}
        </h2>

        <p class="drop__desc">
          {{ t("把文件拖到窗口任意位置，或点下面的按钮选择。", "Drag a file anywhere into the window, or use the button below.") }}
        </p>

        <div class="drop__actions">
          <UiButton variant="primary" size="md" icon="arrow-up-tray" @click="emit('open')">
            {{ t("打开 EPUB", "Open EPUB") }}
          </UiButton>
          <UiButton variant="secondary" size="md" icon="document-plus" @click="emit('create')">
            {{ t("新建空白书", "New blank book") }}
          </UiButton>
        </div>

        <p class="drop__limit">
          <UiIcon name="information-circle" :size="13" />
          {{ t("支持 EPUB 2 / EPUB 3 · 最大 100 MB", "Supports EPUB 2 / EPUB 3 · Up to 100 MB") }}
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
  padding: var(--space-10);
  text-align: left;
  background-color: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
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
}

.drop__glyph::after {
  content: "";
  position: absolute;
  inset: 7px;
  pointer-events: none;
  border: 1px solid var(--color-border-subtle);
  border-radius: calc(var(--radius-md) - 5px);
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

.drop__title {
  font-size: var(--text-2xl);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
  letter-spacing: 0.07em;
  color: var(--color-text);
}

.drop__desc {
  max-width: 32em;
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  color: var(--color-text-secondary);
  text-wrap: pretty;
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

  .drop__desc {
    max-width: 34ch;
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