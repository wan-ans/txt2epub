<script setup lang="ts">
import { computed } from "vue";
import UiIcon from "../icons/UiIcon.vue";
import UiField from "../ui/UiField.vue";
import UiSwitch from "../ui/UiSwitch.vue";
import UiSlider from "../ui/UiSlider.vue";
import UiButton from "../ui/UiButton.vue";
import type { TypesettingOptions } from "../engine/core";
import { DEFAULT_TYPESETTING } from "../composables/useWorkspace";
import { useUiLanguage } from "../composables/useUiLanguage";

/**
 * 排版设置 + 实时预览。
 * 左列四个控件，右列一张「样张」，用与导出 CSS 相同的规则渲染，所见即所得。
 */
const props = defineProps<{
  options: TypesettingOptions;
  /** 取当前章节前几行作为预览样张 */
  sampleLines: string[];
  /** 章节标题，样张顶部显示 */
  sampleTitle: string;
}>();

const emit = defineEmits<{
  update: [patch: Partial<TypesettingOptions>];
  reset: [];
}>();

const { t } = useUiLanguage();

const isDefault = computed(
  () =>
    props.options.indent === DEFAULT_TYPESETTING.indent &&
    props.options.lineHeight === DEFAULT_TYPESETTING.lineHeight &&
    props.options.fontSize === DEFAULT_TYPESETTING.fontSize &&
    props.options.paragraphSpacing === DEFAULT_TYPESETTING.paragraphSpacing,
);

const previewLines = computed(() => {
  const source = props.sampleLines.filter((line) => line.trim()).slice(0, 14);
  if (source.length) return source;
  return [
    t("夜色沉下去的时候，檐角的铜铃忽然响了一声。", "As night deepened, the bronze bell under the eaves rang once."),
    t("他抬起头，看见半轮月亮正从瓦当之间挪出来，把院子照得像铺了一层薄霜。", "He looked up and saw a half moon emerge from between the roof tiles, covering the courtyard in what looked like a thin layer of frost."),
    t("「你来晚了。」屋里的人说。", "\"You're late,\" said the person inside."),
    t("「路上耽搁了。」他答，把手里的匣子放在门槛上，没有再往里走一步。", "\"I was delayed on the way,\" he answered, setting the box in his hands on the threshold without taking another step inside."),
    t("风从巷口穿过来，带着一点旧纸和松烟墨的气味。", "Wind swept in from the alley mouth, carrying a faint smell of old paper and pine-soot ink."),
    t("两个人都没有说话。远处有人收摊，竹竿磕在石板上，一声一声，慢慢远了。", "Neither of them spoke. Somewhere in the distance someone was packing up a stall; a bamboo pole knocked against the flagstones, sound by sound, slowly fading away."),
  ];
});

const previewStyle = computed(() => ({
  "--preview-font-size": `${props.options.fontSize}em`,
  "--preview-line-height": String(props.options.lineHeight),
  "--preview-indent": props.options.indent ? "2em" : "0",
  "--preview-para-gap": props.options.paragraphSpacing ? "0.9em" : "0",
}));
</script>

<template>
  <div class="typeset">
    <div class="typeset__controls">
      <UiField
        :label="t('段首缩进', 'First-line indent')"
        input-id="typeset-indent"
        :hint="t('中文书籍惯例：段首空两格', 'Chinese book convention: indent the first line by two characters')"
      >
        <UiSwitch
          id="typeset-indent"
          :model-value="options.indent"
          :label="t('段首缩进两个汉字', 'Indent the first line by two characters')"
          @update:model-value="(value) => emit('update', { indent: value })"
        />
      </UiField>

      <UiField
        :label="t('段间留白', 'Paragraph spacing')"
        input-id="typeset-spacing"
        :hint="t('关闭后段落紧排，更接近纸质书', 'Turn off to tighten paragraphs, closer to a printed book')"
      >
        <UiSwitch
          id="typeset-spacing"
          :model-value="options.paragraphSpacing"
          :label="t('段落之间额外留白', 'Extra space between paragraphs')"
          @update:model-value="(value) => emit('update', { paragraphSpacing: value })"
        />
      </UiField>

      <UiField :label="t('行高', 'Line height')" input-id="typeset-line-height" :hint="t('1.2 紧凑 ~ 2.4 疏朗', '1.2 compact ~ 2.4 airy')">
        <UiSlider
          id="typeset-line-height"
          :model-value="options.lineHeight"
          :min="1.2"
          :max="2.4"
          :step="0.05"
          :precision="2"
          @update:model-value="(value) => emit('update', { lineHeight: value })"
        />
      </UiField>

      <UiField :label="t('字号', 'Font size')" input-id="typeset-font-size" :hint="t('相对阅读器默认字号的比例', 'Ratio relative to the reader’s default font size')">
        <UiSlider
          id="typeset-font-size"
          :model-value="options.fontSize"
          :min="0.8"
          :max="1.6"
          :step="0.05"
          :precision="2"
          unit="em"
          @update:model-value="(value) => emit('update', { fontSize: value })"
        />
      </UiField>

      <div class="typeset__foot">
        <p class="hint">
          <UiIcon name="information-circle" :size="12" />
          {{ t("部分阅读器会忽略书籍自带字号", "Some readers ignore the font size embedded in the book") }}
        </p>
        <UiButton size="sm" variant="ghost" icon="arrow-path" :disabled="isDefault" @click="emit('reset')">
          {{ t("恢复默认", "Restore defaults") }}
        </UiButton>
      </div>
    </div>

    <div class="typeset__preview">
      <div class="typeset__paper" :style="previewStyle">
        <p class="typeset__paper-title serif">{{ sampleTitle || t("章节标题", "Chapter title") }}</p>
        <div class="typeset__paper-body serif">
          <p v-for="(line, index) in previewLines" :key="index" class="typeset__paper-line">
            {{ line }}
          </p>
        </div>
      </div>
      <p class="typeset__caption">{{ t("实时预览 · 导出时写入 EPUB 样式表", "Live preview · written to the EPUB stylesheet on export") }}</p>
    </div>
  </div>
</template>

<style scoped>
.typeset {
  display: grid;
  /* 这个面板固定放在右侧窄栏里，双列会挤成两行字。
     统一单列堆叠：控件在上、样张在下，读数与预览都清楚。 */
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-5);
  align-items: start;
}

.typeset__controls {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.typeset__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px dashed var(--color-border);
}

.typeset__foot .hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.typeset__preview {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* 样张：宣纸质感用底色 + 细边框表达，不用渐变 */
.typeset__paper {
  max-height: 280px;
  padding: var(--space-5);
  overflow: hidden;
  background-color: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
}

.typeset__paper-title {
  margin-bottom: 1em;
  font-size: calc(var(--preview-font-size) * 1.05);
  font-weight: var(--weight-semibold);
  line-height: 1.4;
  letter-spacing: 0.06em;
  text-align: center;
  color: var(--color-text);
}

.typeset__paper-body {
  font-size: var(--preview-font-size);
  line-height: var(--preview-line-height);
  color: var(--color-text);
  text-align: justify;
  transition:
    font-size var(--duration-fast) var(--ease-out),
    line-height var(--duration-fast) var(--ease-out);
}

.typeset__paper-line {
  text-indent: var(--preview-indent);
  margin-bottom: var(--preview-para-gap);
  word-break: break-word;
}

.typeset__paper-line:last-child {
  margin-bottom: 0;
}

.typeset__caption {
  font-size: var(--text-2xs);
  text-align: center;
  color: var(--color-text-muted);
}

@media (max-width: 1200px) {
  .typeset__preview {
    position: static;
  }
}
</style>
