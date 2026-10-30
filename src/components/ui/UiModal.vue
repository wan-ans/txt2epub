<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import UiIcon from "../icons/UiIcon.vue";
import type { IconName } from "../icons";
import { useUiLanguage } from "../composables/useUiLanguage";

/**
 * 模态框：Esc 关闭、点击遮罩关闭、焦点陷阱、打开时锁定背景滚动、
 * 关闭后焦点还给触发元素。标题用 aria-labelledby 关联。
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    description?: string;
    icon?: IconName;
    /** sm 用于确认框，md 用于表单 */
    size?: "sm" | "md";
  }>(),
  { size: "md" },
);

const emit = defineEmits<{ close: [] }>();

const { t } = useUiLanguage();
const panelRef = ref<HTMLElement | null>(null);
const titleId = computed(() => `modal-title-${props.title.replace(/\s/g, "-")}`);

let previousFocus: HTMLElement | null = null;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(): HTMLElement[] {
  if (!panelRef.value) return [];
  return Array.from(panelRef.value.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/** 把焦点送进对话框。返回是否真的成功（部分环境会拒绝 focus）。 */
function focusIntoDialog(): boolean {
  const preferred = panelRef.value?.querySelector<HTMLElement>("[data-autofocus]");
  const target = preferred ?? focusables()[0] ?? panelRef.value;
  if (!target) return false;
  target.focus();
  return panelRef.value?.contains(document.activeElement) ?? false;
}

async function onOpen() {
  previousFocus = document.activeElement as HTMLElement | null;
  document.body.style.setProperty("overflow", "hidden");
  // 监听挂在 window 上：弹窗刚打开时焦点可能还在 body 或触发按钮上，
  // 只靠元素上的 keydown 会漏掉 Esc。capture 保证先于页面其它快捷键处理。
  window.addEventListener("keydown", onKeydown, true);
  await nextTick();
  // 等 Transition 把元素挂上再聚焦，否则 offsetParent 为 null 会被过滤掉
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  if (focusIntoDialog()) return;
  // 某些环境（窗口未激活、切换动画中）首次 focus 会被拒绝，重试几次即可
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    if (!props.open) return;
    if (focusIntoDialog()) return;
  }
  // 最后兜底：聚焦对话框容器本身，保证按键事件至少落在这个子树里
  panelRef.value?.focus();
}

function onClose() {
  window.removeEventListener("keydown", onKeydown, true);
  document.body.style.removeProperty("overflow");
  previousFocus?.focus?.();
  previousFocus = null;
}

watch(
  () => props.open,
  (open) => (open ? void onOpen() : onClose()),
);

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown, true);
  document.body.style.removeProperty("overflow");
});

function requestClose() {
  emit("close");
}

function onKeydown(event: KeyboardEvent) {
  if (!props.open) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    requestClose();
    return;
  }
  if (event.key !== "Tab") return;
  const list = focusables();
  if (!list.length) {
    event.preventDefault();
    return;
  }
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement as HTMLElement | null;
  const inside = Boolean(panelRef.value?.contains(active));
  if (event.shiftKey && (!inside || active === first)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (!inside || active === last)) {
    event.preventDefault();
    first.focus();
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="open" class="overlay" @mousedown.self="requestClose">
        <div
          ref="panelRef"
          class="modal"
          :class="`modal--${size}`"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
        >
          <header class="modal__head">
            <span v-if="icon" class="modal__icon">
              <UiIcon :name="icon" :size="18" />
            </span>
            <div class="modal__heading">
              <h2 :id="titleId" class="modal__title">{{ title }}</h2>
              <p v-if="description" class="modal__desc">{{ description }}</p>
            </div>
            <button type="button" class="modal__close" :aria-label="t('关闭对话框', 'Close dialog')" @click="requestClose">
              <UiIcon name="x-mark" :size="18" />
            </button>
          </header>

          <div class="modal__body">
            <slot />
          </div>

          <footer v-if="$slots.footer" class="modal__foot">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: grid;
  place-items: center;
  padding: var(--space-6);
  background-color: var(--color-overlay);
  animation: ink-fade var(--duration-base) var(--ease-out);
}

.modal {
  display: flex;
  flex-direction: column;
  width: min(100%, 520px);
  max-height: min(88vh, 760px);
  background-color: var(--color-bg-elevated);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  outline: none;
  animation: ink-rise var(--duration-base) var(--ease-out);
}

.modal--sm {
  width: min(100%, 420px);
}

.modal__head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-5) var(--space-5) var(--space-4);
  border-bottom: 1px solid var(--color-border-subtle);
}

.modal__icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 34px;
  height: 34px;
  color: var(--color-primary-text);
  background-color: var(--color-primary-soft);
  border-radius: var(--radius-sm);
}

.modal__heading {
  flex: 1 1 auto;
  min-width: 0;
  padding-top: 1px;
}

.modal__title {
  font-family: var(--font-serif);
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
  letter-spacing: 0.02em;
  color: var(--color-text);
}

.modal__desc {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
}

.modal__close {
  display: grid;
  place-items: center;
  flex: none;
  width: 30px;
  height: 30px;
  margin: -2px -4px 0 0;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  transition:
    color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.modal__close:hover {
  color: var(--color-text);
  background-color: var(--color-surface-active);
}

.modal__body {
  flex: 1 1 auto;
  padding: var(--space-5);
  overflow-y: auto;
}

.modal__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-5);
  border-top: 1px solid var(--color-border-subtle);
  background-color: var(--color-bg-sunken);
  border-radius: 0 0 var(--radius-lg) var(--radius-lg);
}
</style>
