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
import type { EpubBookMeta, Language } from "../engine/core";

/**
 * EPUB 书籍信息：在 MetaForm 的字段基础上增加「副标题」「出版日期」。
 * 所有字段边输入边生效，无需保存按钮；不修改现有 MetaForm，避免影响 TXT 流程。
 */
const props = defineProps<{
  meta: EpubBookMeta;
}>();

const emit = defineEmits<{
  update: [patch: Partial<EpubBookMeta>];
  setLanguage: [value: Language];
}>();

const languageOptions = LANGUAGE_OPTIONS;
const { t } = useUiLanguage();

const titleLength = computed(() => props.meta.title.length);
const subtitleLength = computed(() => (props.meta.subtitle ?? "").length);
const descLength = computed(() => (props.meta.description ?? "").length);

/** 字段改动后短暂显示「已保存」，给即时保存一个可见的确认 */
const savedHint = ref(false);
let savedTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => [
    props.meta.title,
    props.meta.subtitle,
    props.meta.author,
    props.meta.publisher,
    props.meta.publishedAt,
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
      <UiField :label="t('书名', 'Title')" input-id="epub-meta-title" :meta="`${titleLength}/120`">
        <template #default="{ describedBy }">
          <UiInput
            id="epub-meta-title"
            :model-value="meta.title"
            :placeholder="t('例如：山河故人', 'e.g. Mountains and Old Friends')"
            :described-by="describedBy"
            @update:model-value="(value) => emit('update', { title: value.slice(0, 120) })"
          />
        </template>
      </UiField>

      <UiField
        :label="t('副标题', 'Subtitle')"
        input-id="epub-meta-subtitle"
        :meta="`${subtitleLength}/120`"
        :hint="t('可留空，会写入 EPUB 的 title-type=subtitle', 'Optional; written as EPUB title-type=subtitle')"
      >
        <template #default="{ describedBy }">
          <UiInput
            id="epub-meta-subtitle"
            :model-value="meta.subtitle ?? ''"
            :placeholder="t('例如：修订版', 'e.g. Revised Edition')"
            :described-by="describedBy"
            @update:model-value="(value) => emit('update', { subtitle: value.slice(0, 120) })"
          />
        </template>
      </UiField>

      <UiField :label="t('作者', 'Author')" input-id="epub-meta-author" :hint="t('留空则写入「佚名」', 'Leave empty to use “Anonymous”')">
        <template #default="{ describedBy }">
          <UiInput
            id="epub-meta-author"
            :model-value="meta.author ?? ''"
            :placeholder="t('例如：佚名', 'e.g. Anonymous')"
            :described-by="describedBy"
            @update:model-value="(value) => emit('update', { author: value.slice(0, 80) })"
          />
        </template>
      </UiField>

      <UiField :label="t('语言', 'Language')" input-id="epub-meta-language" :hint="t('写入 dc:language，影响阅读器断字', 'Written to dc:language; affects hyphenation in readers')">
        <template #default="{ describedBy }">
          <UiSelect
            id="epub-meta-language"
            :model-value="meta.language"
            :options="languageOptions"
            :described-by="describedBy"
            @update:model-value="(value) => emit('setLanguage', value as Language)"
          />
        </template>
      </UiField>

      <UiField :label="t('出版方', 'Publisher')" input-id="epub-meta-publisher" :hint="t('可选，多数阅读器会显示', 'Optional; shown by most readers')">
        <template #default="{ describedBy }">
          <UiInput
            id="epub-meta-publisher"
            :model-value="meta.publisher ?? ''"
            :placeholder="t('例如：墨匣书坊', 'e.g. Inkbox Press')"
            :described-by="describedBy"
            @update:model-value="(value) => emit('update', { publisher: value.slice(0, 80) })"
          />
        </template>
      </UiField>

      <UiField
        :label="t('出版日期', 'Publication date')"
        input-id="epub-meta-published"
        :hint="t('原文格式即可，写入 dc:date', 'Any format is fine; written to dc:date')"
      >
        <template #default="{ describedBy }">
          <UiInput
            id="epub-meta-published"
            :model-value="meta.publishedAt ?? ''"
            :placeholder="t('例如：2024-05-01', 'e.g. 2024-05-01')"
            :described-by="describedBy"
            @update:model-value="(value) => emit('update', { publishedAt: value.slice(0, 40) })"
          />
        </template>
      </UiField>
    </div>

    <UiField
      :label="t('简介', 'Description')"
      input-id="epub-meta-description"
      :meta="`${descLength}/1000`"
      :hint="t('回车可换行，会写入 EPUB 的 dc:description', 'Press Enter for a new line; written to the EPUB dc:description')"
    >
      <template #default="{ describedBy }">
        <UiTextarea
          id="epub-meta-description"
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
      input-id="epub-meta-tags"
      :hint="t('回车添加，最多 12 个；会写入 EPUB 的 dc:subject', 'Press Enter to add up to 12 tags; written to the EPUB dc:subject')"
    >
      <UiChipInput
        id="epub-meta-tags"
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
        <p v-if="meta.subtitle" class="meta__preview-subtitle serif">{{ meta.subtitle }}</p>
        <p class="meta__preview-author">{{ meta.author || t("佚名", "Anonymous") }}</p>
        <p class="meta__preview-desc">{{ meta.description }}</p>
        <div v-if="meta.tags?.length" class="row-wrap meta__preview-tags">
          <span v-for="tag in meta.tags" :key="tag" class="badge">{{ tag }}</span>
        </div>
      </div>
    </div>

    <p v-if="meta.identifier" class="meta__identifier mono" :title="meta.identifier">
      dc:identifier · {{ meta.identifier }}
    </p>
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

.meta__preview-subtitle {
  margin-top: 2px;
  font-size: var(--text-sm);
  letter-spacing: 0.03em;
  color: var(--color-text-secondary);
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

.meta__identifier {
  padding-top: var(--space-3);
  font-size: var(--text-2xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-top: 1px dashed var(--color-border-subtle);
}

@media (max-width: 1100px) {
  .meta__grid {
    grid-template-columns: 1fr;
  }
}
</style>
