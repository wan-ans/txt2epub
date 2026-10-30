<script setup lang="ts">
/**
 * 可增删标签 chip 组。输入框回车添加，退格在空输入时删除最后一项。
 * chips 使用 listbox 语义不合适（非选择），因此用普通列表 + 每项带 aria-label 的删除按钮。
 */
import { computed, ref } from "vue";
import UiIcon from "../icons/UiIcon.vue";
import { useUiLanguage } from "../composables/useUiLanguage";

const props = withDefaults(
  defineProps<{
    modelValue: string[];
    label: string;
    placeholder?: string;
    max?: number;
    id?: string;
  }>(),
  { placeholder: "输入标签后回车", max: 12 },
);

const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();

const { t } = useUiLanguage();
const draft = ref("");

const placeholderText = computed(() => {
  if (props.modelValue.length >= props.max) return t(`最多 ${props.max} 个标签`, `Up to ${props.max} tags`);
  return props.placeholder === "输入标签后回车" ? t("输入标签后回车", "Type a tag and press Enter") : props.placeholder;
});
const chipsLabel = computed(() => t(`${props.label}，共 ${props.modelValue.length} 项`, `${props.label}, ${props.modelValue.length} items`));
const removeLabel = (chip: string) => t(`移除标签 ${chip}`, `Remove tag ${chip}`);
const inputLabel = computed(() => t(`${props.label}：输入新标签后回车添加`, `${props.label}: type a new tag and press Enter`));

function add() {
  const value = draft.value.trim().replace(/,|，/g, "");
  draft.value = "";
  if (!value) return;
  if (props.modelValue.includes(value)) return;
  if (props.modelValue.length >= props.max) return;
  emit("update:modelValue", [...props.modelValue, value]);
}

function remove(index: number) {
  const next = [...props.modelValue];
  next.splice(index, 1);
  emit("update:modelValue", next);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" || event.key === "," || event.key === "，") {
    event.preventDefault();
    add();
  } else if (event.key === "Backspace" && !draft.value && props.modelValue.length) {
    remove(props.modelValue.length - 1);
  }
}
</script>

<template>
  <div class="chips-wrap" :class="{ 'chips-wrap--dim': modelValue.length >= max }">
    <ul v-if="modelValue.length" class="chips" :aria-label="chipsLabel">
      <li v-for="(chip, index) in modelValue" :key="chip" class="chip">
        <span class="chip__text">{{ chip }}</span>
        <button
          type="button"
          class="chip__x"
          :aria-label="removeLabel(chip)"
          @click="remove(index)"
        >
          <UiIcon name="x-mark" :size="12" :stroke-width="2" />
        </button>
      </li>
    </ul>

    <input
      :id="id"
      v-model="draft"
      class="ctl chips__input"
      type="text"
      :placeholder="placeholderText"
      :disabled="modelValue.length >= max"
      :aria-label="inputLabel"
      @keydown="onKeydown"
    />
  </div>
</template>

<style scoped>
.chips-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 26px;
  padding: 0 var(--space-1) 0 var(--space-3);
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  background-color: var(--color-bg-sunken);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.chip__text {
  max-width: 14ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip__x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--color-text-muted);
  border-radius: 4px;
  transition:
    color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.chip__x:hover {
  color: var(--color-danger);
  background-color: var(--color-danger-soft);
}

.chips__input {
  min-height: 32px;
  font-size: var(--text-sm);
}

.chips-wrap--dim .chips__input {
  background-color: var(--color-bg-sunken);
}
</style>
