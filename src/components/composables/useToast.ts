import { readonly, ref } from "vue";

/**
 * Toast 队列。任意组件通过 useToast() 弹出通知；
 * UiToast 容器在 App.vue 里只放一次。
 */
export type ToastKind = "success" | "error" | "info" | "warning";

export interface ToastAction {
  label: string;
  handler: () => void;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  action?: ToastAction;
}

const items = ref<ToastItem[]>([]);
let seed = 0;
const timers = new Map<number, number>();

function dismiss(id: number) {
  const timer = timers.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timers.delete(id);
  }
  items.value = items.value.filter((item) => item.id !== id);
}

function push(
  kind: ToastKind,
  title: string,
  options: { detail?: string; timeout?: number; action?: ToastAction } = {},
): number {
  // 同一时刻最多保留 4 条，避免刷屏遮挡界面
  if (items.value.length >= 4) dismiss(items.value[0].id);

  const id = ++seed;
  items.value = [...items.value, { id, kind, title, detail: options.detail, action: options.action }];

  const timeout = options.timeout ?? (kind === "error" ? 7000 : 3600);
  if (timeout > 0) {
    timers.set(
      id,
      window.setTimeout(() => dismiss(id), timeout),
    );
  }
  return id;
}

export function useToast() {
  return {
    items: readonly(items),
    dismiss,
    success: (title: string, options?: { detail?: string; timeout?: number; action?: ToastAction }) =>
      push("success", title, options),
    error: (title: string, options?: { detail?: string; timeout?: number; action?: ToastAction }) =>
      push("error", title, options),
    info: (title: string, options?: { detail?: string; timeout?: number; action?: ToastAction }) =>
      push("info", title, options),
    warning: (title: string, options?: { detail?: string; timeout?: number; action?: ToastAction }) =>
      push("warning", title, options),
  };
}
