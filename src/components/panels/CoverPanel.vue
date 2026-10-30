<script setup lang="ts">
import { computed, ref } from "vue";
import UiIcon from "../icons/UiIcon.vue";
import UiButton from "../ui/UiButton.vue";
import type { Cover } from "../engine/core";
import { formatBytes } from "../composables/useWorkspace";
import { useUiLanguage } from "../composables/useUiLanguage";

/**
 * 封面：选择 / 预览 / 清除。
 * 校验类型（JPG/PNG/WEBP）与体积（≤5MB），失败时在控件下方就地报错。
 */
const props = defineProps<{
  cover: Cover | null;
  previewUrl: string | null;
}>();

const emit = defineEmits<{
  select: [payload: { cover: Cover; previewUrl: string }];
  clear: [];
}>();

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPTED = ["image/jpeg", "image/png", "image/webp"] as const;
const ACCEPT_ATTR = ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp";

const { t } = useUiLanguage();

const fileInput = ref<HTMLInputElement | null>(null);
const error = ref("");
const dragging = ref(false);

const sizeLabel = computed(() => (props.cover ? formatBytes(props.cover.data.byteLength) : ""));
const typeLabel = computed(() => (props.cover ? props.cover.mimeType.replace("image/", "").toUpperCase() : ""));

function pick() {
  fileInput.value?.click();
}

async function handleFile(file: File) {
  error.value = "";
  if (!ACCEPTED.includes(file.type as (typeof ACCEPTED)[number])) {
    const typeName = file.type || t("该类型", "this file type");
    error.value = t(`不支持 ${typeName}，请选择 JPG / PNG / WEBP`, `Unsupported ${typeName}; please choose JPG / PNG / WEBP`);
    return;
  }
  if (file.size > MAX_BYTES) {
    error.value = t(`图片 ${formatBytes(file.size)} 超出 5 MB 上限`, `Image ${formatBytes(file.size)} exceeds the 5 MB limit`);
    return;
  }

  try {
    const data = await file.arrayBuffer();
    const url = URL.createObjectURL(new Blob([data], { type: file.type }));
    emit("select", {
      cover: { data, mimeType: file.type, fileName: file.name },
      previewUrl: url,
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : t("读取图片失败", "Failed to read image");
  }
}

function onChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) void handleFile(file);
}

function onDrop(event: DragEvent) {
  dragging.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) void handleFile(file);
}

function onDragOver() {
  dragging.value = true;
}

function onDragLeave() {
  dragging.value = false;
}

function clear() {
  error.value = "";
  emit("clear");
}
</script>

<template>
  <div class="cover">
    <div v-if="cover && previewUrl" class="cover__filled">
      <figure class="cover__thumb">
        <img :src="previewUrl" :alt="t(`封面预览：${cover.fileName}`, `Cover preview: ${cover.fileName}`)" class="cover__img" />
      </figure>
      <div class="cover__info">
        <p class="cover__name" :title="cover.fileName">{{ cover.fileName }}</p>
        <p class="cover__meta tnum">{{ typeLabel }} · {{ sizeLabel }}</p>
        <div class="row-wrap cover__btns">
          <UiButton size="sm" variant="secondary" icon="photo-add" @click="pick">{{ t("更换", "Replace") }}</UiButton>
          <UiButton size="sm" variant="ghost" icon="trash" @click="clear">{{ t("清除", "Remove") }}</UiButton>
        </div>
      </div>
    </div>

    <button
      v-else
      type="button"
      class="cover__empty"
      :class="{ 'cover__empty--drag': dragging }"
      @click="pick"
      @dragover.prevent="onDragOver"
      @dragleave="onDragLeave"
      @drop.prevent="onDrop"
    >
      <span class="cover__empty-icon">
        <UiIcon name="photo" :size="20" />
      </span>
      <span class="cover__empty-title">{{ t("添加封面", "Add cover") }}</span>
      <span class="cover__empty-hint">{{ t("点击选择，或把图片拖到这里 · JPG / PNG / WEBP · ≤5 MB", "Click to choose, or drag an image here · JPG / PNG / WEBP · ≤5 MB") }}</span>
    </button>

    <p v-if="error" class="field__error" role="alert">
      <UiIcon name="exclamation-circle" :size="13" />
      {{ error }}
    </p>

    <p v-else-if="!cover" class="hint">
      {{ t("不设置封面也能导出，阅读器会用默认封面代替。", "You can export without a cover; readers will show a default cover.") }}
    </p>

    <input
      ref="fileInput"
      class="sr-only"
      type="file"
      :accept="ACCEPT_ATTR"
      tabindex="-1"
      aria-hidden="true"
      @change="onChange"
    />
  </div>
</template>

<style scoped>
.cover {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.cover__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-6) var(--space-4);
  text-align: center;
  background-color: var(--color-bg-sunken);
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
  transition:
    border-color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.cover__empty:hover {
  border-color: var(--color-text-muted);
  background-color: var(--color-surface-active);
}

.cover__empty--drag {
  border-color: var(--color-primary);
  background-color: var(--color-primary-soft);
}

.cover__empty-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  color: var(--color-text-muted);
  background-color: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.cover__empty-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}

.cover__empty-hint {
  font-size: var(--text-2xs);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
}

.cover__filled {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  padding: var(--space-3);
  background-color: var(--color-bg-sunken);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.cover__thumb {
  flex: none;
  width: 78px;
  aspect-ratio: 2 / 3;
  margin: 0;
  overflow: hidden;
  background-color: var(--color-surface);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-sm);
}

.cover__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover__info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  padding-top: 2px;
}

.cover__name {
  font-size: var(--text-xs);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 34ch;
}

.cover__meta {
  font-size: var(--text-2xs);
  color: var(--color-text-muted);
}

.cover__btns {
  margin-top: var(--space-2);
}
</style>
