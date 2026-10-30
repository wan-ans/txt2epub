<script setup lang="ts">
/**
 * 轻量 toast。由 useToast() 组合式函数驱动，容器固定右下。
 * aria-live=polite，成功/信息用 polite，错误用 assertive 单独播报。
 */
import UiIcon from "../icons/UiIcon.vue";
import type { ToastItem } from "../composables/useToast";
import { useUiLanguage } from "../composables/useUiLanguage";

defineProps<{
  items: ToastItem[];
  /** 抬到页面底部固定操作条之上，避免遮挡主操作按钮 */
  raised?: boolean;
}>();
const emit = defineEmits<{ dismiss: [id: number] }>();
const { t } = useUiLanguage();

const ICON_BY_KIND = {
  success: "check-circle",
  error: "exclamation-circle",
  info: "information-circle",
  warning: "exclamation-triangle",
} as const;
</script>

<template>
  <Teleport to="body">
    <div class="toasts" :class="{ 'toasts--raised': raised }" role="region" :aria-label="t('通知', 'Notifications')">
      <TransitionGroup name="pop">
        <div
          v-for="item in items"
          :key="item.id"
          class="toast"
          :class="`toast--${item.kind}`"
          :role="item.kind === 'error' ? 'alert' : 'status'"
          :aria-live="item.kind === 'error' ? 'assertive' : 'polite'"
        >
          <span class="toast__icon">
            <UiIcon :name="ICON_BY_KIND[item.kind]" :size="16" />
          </span>
          <div class="toast__body">
            <p class="toast__title">{{ item.title }}</p>
            <p v-if="item.detail" class="toast__detail">{{ item.detail }}</p>
          </div>
          <button
            v-if="item.detail && item.action"
            type="button"
            class="toast__action"
            @click="item.action.handler()"
          >
            {{ item.action.label }}
          </button>
          <button type="button" class="toast__close" :aria-label="t('关闭通知', 'Dismiss notification')" @click="emit('dismiss', item.id)">
            <UiIcon name="x-mark" :size="14" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: var(--space-5);
  bottom: var(--space-5);
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: min(380px, calc(100vw - var(--space-10)));
  pointer-events: none;
  /* 容器本身不吃焦点顺序，内部按钮仍可 Tab 到 */
}

/* 应用里有底部导出操作条时，把 toasts 抬到它上面去，
   否则「生成 EPUB」这个最关键的主操作会被通知压住。
   --app-bottom-bar 由 App.vue 根据当前视图设置。 */
.toasts--raised {
  bottom: calc(var(--app-bottom-bar, 64px) + var(--space-4));
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
  pointer-events: auto;
  background-color: var(--color-bg-elevated);
  border: 1px solid var(--color-border-strong);
  border-left-width: 3px;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
}

.toast--success {
  border-left-color: var(--color-success);
}

.toast--error {
  border-left-color: var(--color-danger);
}

.toast--info {
  border-left-color: var(--color-accent);
}

.toast--warning {
  border-left-color: var(--color-warning);
}

.toast__icon {
  display: grid;
  place-items: center;
  flex: none;
  margin-top: 1px;
}

.toast--success .toast__icon {
  color: var(--color-success);
}

.toast--error .toast__icon {
  color: var(--color-danger);
}

.toast--info .toast__icon {
  color: var(--color-accent);
}

.toast--warning .toast__icon {
  color: var(--color-warning);
}

.toast__body {
  flex: 1 1 auto;
  min-width: 0;
}

.toast__title {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  line-height: var(--leading-normal);
  color: var(--color-text);
  word-break: break-word;
}

.toast__detail {
  margin-top: 2px;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
  word-break: break-word;
}

.toast__action {
  flex: none;
  align-self: center;
  padding: 2px var(--space-2);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--color-primary-text);
  border-radius: 4px;
}

.toast__action:hover {
  background-color: var(--color-primary-soft);
}

.toast__close {
  display: grid;
  place-items: center;
  flex: none;
  /* 命中区域 32×32（WCAG 2.5.8），视觉图标仍保持 14px 不显笨重 */
  width: 32px;
  height: 32px;
  margin: -5px -5px -5px 0;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  transition:
    color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.toast__close:hover {
  color: var(--color-text);
  background-color: var(--color-surface-active);
}
</style>
