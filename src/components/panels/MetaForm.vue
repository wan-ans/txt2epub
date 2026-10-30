<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import UiIcon from "../icons/UiIcon.vue";
import UiInput from "../ui/UiInput.vue";
import UiTextarea from "../ui/UiTextarea.vue";
import UiSelect from "../ui/UiSelect.vue";
import UiField from "../ui/UiField.vue";
import UiChipInput from "../ui/UiChipInput.vue";
import { LANGUAGE_OPTIONS } from "../composables/useWorkspace";
import { useUiLanguage } from "../composables/useUiLanguage";
import type { BookMeta, Language } from "../engine/core";

/**
 * 书籍元信息：书名 / 作者 / 语言 / 简介 / 标签。
 * 左侧两列放短字段，简介独占一行（textarea），标签用 chip。
 *
 * 所有字段都是「边输入边生效」——输入即写入 store，无需保存按钮。
 * 空书名不算错误：导出时自动回退到文件名，因此这里不做红框校验，
 * 只用一个短暂出现的「已保存」提示来确认输入已经生效。
 */
const props = defineProps<{
  meta: BookMeta;
}>();

const emit = defineEmits<{
  update: [patch: Partial<BookMeta>];
  setLanguage: [value: Language];
}>();

const { t } = useUiLanguage();

const languageOptions = LANGUAGE_OPTIONS;

const titleLength = computed(() => props.meta.title.length);
const descLength = computed(() => (props.meta.description ?? "").length);

/** 字段改动后短暂显示「已保存」，给即时保存一个可见的确认 */
const savedHint = ref(false);
let savedTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => [
    props.meta.title,
    props.meta.author,
    props.meta.publisher,
    props.meta.description,
    (props.meta.tags ?? []).join("\u0001"),
    props.meta.language,
  ],
  () => {
    savedHint.value = true;
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      savedHint.value = false;
    }, 1600);
  },
);

onBeforeUnmount(() => {
  if (savedTimer) clearTimeout(savedTimer);
});
</script>

<template>
  <div class="meta">
    <p class="meta__saved" :class="{ 'meta__saved--on': savedHint }" aria-live="polite">
      <UiIcon v-if="savedHint" name="check-circle" :size="12" />
      {{ savedHint ? t("改动已即时保存", "Changes saved automatically") : "" }}
    </p>

    <div class="meta__grid">
      <UiField :label="t('书名', 'Title')" input-id="meta-title" :meta="`${titleLength}/120`">
        <template #default="{ describedBy }">
          <UiInput
            id="meta-title"
            :model-value="meta.title"
            :placeholder="t('例如：山河故人', 'e.g. Mountains and Old Friends')"
            :described-by="describedBy"
            @update:model-value="(value) => emit('update', { title: value.slice(0, 120) })"
          />
        </template>
      </UiField>

      <UiField :label="t('作者', 'Author')" input-id="meta-author" :hint="t('留空则写入「佚名」', 'Leave empty to use “Anonymous”')">
        <template #default="{ describedBy }">
          <UiInput
            id="meta-author"
            :model-value="meta.author ?? ''"
            :placeholder="t('例如：佚名', 'e.g. Anonymous')"
            :described-by="describedBy"
            @update:model-value="(value) => emit('update', { author: value.slice(0, 80) })"
          />
        </template>
      </UiField>

      <UiField :label="t('语言', 'Language')" input-id="meta-language" :hint="t('影响分章规则与目录语言', 'Affects chapter splitting rules and table-of-contents language')">
        <template #default="{ describedBy }">
          <UiSelect
            id="meta-language"
            :model-value="meta.language"
            :options="languageOptions"
            :described-by="describedBy"
            @update:model-value="(value) => emit('setLanguage', value as Language)"
          />
        </template>
      </UiField>

      <UiField :label="t('出版方', 'Publisher')" input-id="meta-publisher" :hint="t('可选，多数阅读器会显示', 'Optional; shown by most readers')">
        <template #default="{ describedBy }">
          <UiInput
            id="meta-publisher"
            :model-value="meta.publisher ?? ''"
            :placeholder="t('例如：墨匣书坊', 'e.g. Inkbox Press')"
            :described-by="describedBy"
            @update:model-value="(value) => emit('update', { publisher: value.slice(0, 80) })"
          />
        </template>
      </UiField>
    </div>

    <UiField
      :label="t('简介', 'Description')"
      input-id="meta-description"
      :meta="`${descLength}/1000`"
      :hint="t('回车可换行，会写入 EPUB 的 dc:description', 'Press Enter for a new line; written to the EPUB dc:description')"
    >
      <template #default="{ describedBy }">
        <UiTextarea
          id="meta-description"
          :model-value="meta.description ?? ''"
          :rows="3"
          :placeholder="t('用一两句话介绍这本书…', 'Describe this book in a sentence or two…')"
          :described-by="describedBy"
          @update:model-value="(value) => emit('update', { description: value.slice(0, 1000) })"
        />
      </template>
    </UiField>

    <UiField
      :label="t('标签', 'Tags')"
      input-id="meta-tags"
      :hint="t('回车添加，最多 12 个；会写入 EPUB 的 dc:subject', 'Press Enter to add up to 12 tags; written to the EPUB dc:subject')"
    >
      <UiChipInput
        id="meta-tags"
        :model-value="meta.tags ?? []"
        :label="t('标签', 'Tags')"
        :max="12"
        :placeholder="t('例如：武侠、长篇、经典', 'e.g. wuxia, long-form, classic')"
        @update:model-value="(value) => emit('update', { tags: value })"
      />
    </UiField>

    <div v-if="meta.description" class="meta__preview">
      <span class="meta__preview-label">
        <UiIcon name="eye" :size="12" />
        {{ t("书架预览", "Shelf preview") }}
      </span>
      <div class="meta__preview-card">
        <p class="meta__preview-title serif">{{ meta.title || t("未命名", "Untitled") }}</p>
        <p class="meta__preview-author">{{ meta.author || t("佚名", "Anonymous") }}</p>
        <p class="meta__preview-desc">{{ meta.description }}</p>
        <div v-if="meta.tags?.length" class="row-wrap meta__preview-tags">
          <span v-for="tag in meta.tags" :key="tag" class="badge">{{ tag }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.meta {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* 即时保存的确认条：常驻占位（避免出现/消失时布局跳动），只在改动后短暂可见并带色 */
.meta__saved {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  height: 14px;
  margin-bottom: calc(var(--space-3) * -1);
  font-size: var(--text-2xs);
  color: var(--color-success);
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
}

.meta__saved--on {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .meta__saved {
    transition: none;
  }
}

.meta__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4) var(--space-5);
}

.meta__preview {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-4);
  border-top: 1px dashed var(--color-border);
}

.meta__preview-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--text-2xs);
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.meta__preview-card {
  padding: var(--space-4);
  background-color: var(--color-bg-sunken);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
}

.meta__preview-title {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.04em;
  color: var(--color-text);
}

.meta__preview-author {
  margin-top: 2px;
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.meta__preview-desc {
  margin-top: var(--space-2);
  font-size: var(--text-xs);
  line-height: var(--leading-relaxed);
  color: var(--color-text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.meta__preview-tags {
  margin-top: var(--space-3);
}

@media (max-width: 1100px) {
  .meta__grid {
    grid-template-columns: 1fr;
  }
}
</style>
