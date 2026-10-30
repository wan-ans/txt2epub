<script setup lang="ts">
import { computed, ref, shallowRef } from "vue";
import UiIcon from "../icons/UiIcon.vue";
import UiButton from "../ui/UiButton.vue";
import UiField from "../ui/UiField.vue";
import UiInput from "../ui/UiInput.vue";
import UiSwitch from "../ui/UiSwitch.vue";
import UiModal from "../ui/UiModal.vue";
import UiSegmented from "../ui/UiSegmented.vue";
import type { SegmentOption } from "../ui/UiSegmented.vue";
import {
  countRuleMatches,
  createRuleId,
  parseImportedRules,
  presetRules,
  serializeRules,
  validateRule,
  type ChapterRule,
  type KeywordTemplate,
} from "../engine/core";
import { useToast } from "../composables/useToast";
import { useUiLanguage } from "../composables/useUiLanguage";

/**
 * 章节规则面板。
 * 上半：预置规则（只读，展示正则源码与说明）
 * 下半：自定义规则列表（增删改、启用、上下移、命中行数、导入导出）
 */
const props = defineProps<{
  rules: ChapterRule[];
  /** 原始行，用于实时统计命中 */
  rawLines: string[];
  /** 是否已导入文件 */
  hasSource: boolean;
}>();

const emit = defineEmits<{
  "update:rules": [rules: ChapterRule[]];
  reparse: [];
}>();

const toast = useToast();
const { t } = useUiLanguage();
const presets = shallowRef<ChapterRule[]>(presetRules());
const importInput = ref<HTMLInputElement | null>(null);

/* ============================================================
   预置规则：只读展示；自定义规则：可编辑
   ============================================================ */

const customRules = computed(() => props.rules.filter((rule) => !rule.builtin));
const builtinRules = computed(() => props.rules.filter((rule) => rule.builtin));

/** 合并预置（core 提供）+ 用户规则里标记 builtin 的项 */
const presetList = computed(() => (builtinRules.value.length ? builtinRules.value : presets.value));

/** 预置规则名由 core 提供中文，英文界面按稳定 id 映射。 */
const PRESET_EN: Record<string, string> = {
  "preset-zhang": "Chapter N (Chinese)",
  "preset-jie": "Section N (Chinese)",
  "preset-hui": "Installment N (Chinese)",
  "preset-juan": "Volume N (Chinese)",
  "preset-chapter-en": "Chapter N (incl. 1.Chapter0---1)",
  "preset-special-exact": "Prologue / Preface / Afterword / Extra (own line)",
  "preset-special-prefixed": "Prologue / Preface / Afterword… (with title)",
  "preset-special-numbered": "Extra / Side story with number",
};

function displayRuleName(rule: ChapterRule): string {
  if (!rule.builtin) return rule.name;
  return t(rule.name, PRESET_EN[rule.id] ?? rule.name);
}

/** core 层的规则校验错误在英文界面下做一次显示层映射。 */
const RULE_ERROR_EN: Record<string, string> = {
  关键词不能为空: "Keywords cannot be empty",
  正则不能为空: "Regular expression cannot be empty",
  规则格式不正确: "Invalid rule format",
  "规则模式必须是 regex 或 keyword": "Rule mode must be regex or keyword",
  名称不能为空: "Name cannot be empty",
  关键词模板不正确: "Invalid keyword template",
  "捕获组编号必须是 0-99 的整数": "Capture group must be an integer from 0 to 99",
  "JSON 根节点必须是规则数组": "JSON root must be an array of rules",
};

function ruleErrorText(message: string): string {
  const direct = RULE_ERROR_EN[message];
  if (direct) return t(message, direct);
  const flags = message.match(/^不支持的标志位：(.*)$/);
  if (flags) return t(message, `Unsupported flags: ${flags[1]}`);
  return message;
}

/**
 * 命中行数：用 core 的 countRuleMatches 跑一遍，与真实解析口径一致。
 * 结果按「规则内容 + 文本长度」缓存，避免滚动时重复计算。
 */
const hitCache = new Map<string, number>();

function countHits(rule: ChapterRule): number {
  if (!props.rawLines.length) return 0;
  const key = [
    rule.mode,
    rule.pattern,
    rule.flags ?? "",
    rule.capture ?? 0,
    rule.keywordTemplate ?? "",
    props.rawLines.length,
  ].join("|");
  const cached = hitCache.get(key);
  if (cached !== undefined) return cached;

  let count = 0;
  try {
    count = countRuleMatches(props.rawLines, rule);
  } catch {
    count = -1; // 非法规则
  }
  hitCache.set(key, count);
  return count;
}

const enabledRuleCount = computed(() => props.rules.filter((rule) => rule.enabled).length);

/* ============================================================
   编辑弹窗
   ============================================================ */

const draftOpen = ref(false);
const draftIsNew = ref(false);
const draft = ref<ChapterRule>(emptyDraft());

function emptyDraft(): ChapterRule {
  return {
    id: createRuleId(),
    name: "",
    mode: "keyword",
    pattern: "",
    flags: "",
    capture: 0,
    keywordTemplate: "prefix",
    enabled: true,
  };
}

const modeOptions = computed<SegmentOption[]>(() => [
  { value: "keyword", label: t("关键词", "Keyword") },
  { value: "regex", label: t("正则", "Regex") },
]);

const templateOptions = computed<SegmentOption[]>(() => [
  { value: "prefix", label: t("行首匹配", "Start of line") },
  { value: "anywhere", label: t("任意位置", "Anywhere") },
]);

const draftValidation = computed(() => validateRule(draft.value));

const draftHits = computed(() => {
  if (!props.rawLines.length) return 0;
  if (!draftValidation.value.ok) return 0;
  return countHits(draft.value);
});

function openNew() {
  draft.value = emptyDraft();
  draftIsNew.value = true;
  draftOpen.value = true;
}

function openEdit(rule: ChapterRule) {
  draft.value = { ...rule };
  draftIsNew.value = false;
  draftOpen.value = true;
}

function closeDraft() {
  draftOpen.value = false;
}

function saveDraft() {
  if (!draftValidation.value.ok) return;
  const saved = { ...draft.value, name: draft.value.name.trim() };
  const next = draftIsNew.value
    ? [...props.rules, saved]
    : props.rules.map((rule) => (rule.id === saved.id ? saved : rule));
  emit("update:rules", next);
  draftOpen.value = false;
  toast.success(draftIsNew.value ? t("已新增规则", "Rule added") : t("已保存规则修改", "Rule changes saved"), {
    detail: props.hasSource ? t("点「重新分章」让它生效", "Click \"Re-split chapters\" to apply it") : undefined,
  });
}

function toggleRule(id: string) {
  emit(
    "update:rules",
    props.rules.map((rule) => (rule.id === id ? { ...rule, enabled: !rule.enabled } : rule)),
  );
}

function removeRule(rule: ChapterRule) {
  emit(
    "update:rules",
    props.rules.filter((item) => item.id !== rule.id),
  );
  toast.info(t(`已删除规则「${rule.name}」`, `Deleted rule "${rule.name}"`));
}

function moveRule(id: string, delta: number) {
  const index = props.rules.findIndex((rule) => rule.id === id);
  if (index < 0) return;
  const target = index + delta;
  if (target < 0 || target >= props.rules.length) return;
  const next = [...props.rules];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  emit("update:rules", next);
}

function moveIndex(id: string): number {
  return props.rules.findIndex((rule) => rule.id === id);
}

/* ============================================================
   导入 / 导出
   ============================================================ */

function exportRules() {
  const json = serializeRules(props.rules);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "inkbox-chapter-rules.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast.success(t("规则已导出", "Rules exported"), { detail: t(`共 ${props.rules.length} 条`, `${props.rules.length} total`) });
}

function triggerImport() {
  importInput.value?.click();
}

async function handleImport(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;

  try {
    const text = await file.text();
    const imported = parseImportedRules(text);
    if (!imported.length) {
      toast.warning(t("文件里没有可用的规则", "No usable rules in this file"));
      return;
    }
    const existing = new Set(props.rules.map((rule) => `${rule.name}::${rule.pattern}`));
    const fresh = imported.filter((rule) => !existing.has(`${rule.name}::${rule.pattern}`));
    emit("update:rules", [...props.rules, ...fresh]);
    toast.success(t(`已导入 ${fresh.length} 条规则`, `Imported ${fresh.length} rules`), {
      detail: imported.length !== fresh.length ? t(`${imported.length - fresh.length} 条重复已跳过`, `${imported.length - fresh.length} duplicates skipped`) : undefined,
    });
  } catch (error) {
    toast.error(t("导入失败", "Import failed"), {
      detail: error instanceof Error ? ruleErrorText(error.message) : t("JSON 格式不正确", "Invalid JSON format"),
    });
  }
}

/* ============================================================
   展示辅助
   ============================================================ */

function patternPreview(rule: ChapterRule): string {
  if (rule.mode === "keyword") {
    const scope = rule.keywordTemplate === "anywhere" ? t("任意位置", "Anywhere") : t("行首", "Start of line");
    return `[${scope}] ${rule.pattern.replace(/\n/g, " | ")}`;
  }
  return `/${rule.pattern}/${rule.flags ?? ""}`;
}

function captureField(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  draft.value.capture = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
</script>

<template>
  <div class="rules">
    <div class="rules__stats">
      <div class="rules__stat">
        <span class="rules__stat-value mono tnum">{{ rules.length }}</span>
        <span class="rules__stat-label">{{ t("规则总数", "Total rules") }}</span>
      </div>
      <div class="rules__stat">
        <span class="rules__stat-value mono tnum">{{ enabledRuleCount }}</span>
        <span class="rules__stat-label">{{ t("已启用", "Enabled") }}</span>
      </div>
      <div class="rules__stat">
        <span class="rules__stat-value mono tnum">{{ hasSource ? customRules.length : "—" }}</span>
        <span class="rules__stat-label">{{ t("自定义", "Custom") }}</span>
      </div>
      <div class="spacer" />
      <div class="row-wrap">
        <UiButton size="sm" variant="secondary" icon="arrow-up-tray" @click="triggerImport">
          {{ t("导入 JSON", "Import JSON") }}
        </UiButton>
        <UiButton
          size="sm"
          variant="secondary"
          icon="arrow-down-tray"
          :disabled="!rules.length"
          @click="exportRules"
        >
          {{ t("导出", "Export") }}
        </UiButton>
        <UiButton size="sm" variant="primary" icon="plus" @click="openNew">{{ t("新增规则", "Add rule") }}</UiButton>
      </div>
    </div>

    <!-- 预置规则 -->
    <section class="rules__section" aria-labelledby="preset-heading">
      <header class="rules__section-head">
        <h3 id="preset-heading" class="rules__section-title">
          <UiIcon name="bookmark" :size="14" />
          {{ t("预置规则", "Preset rules") }}
          <span class="badge">{{ presetList.length }}</span>
        </h3>
        <p class="hint">{{ t("内置规则不可修改，与自定义规则按顺序一起生效", "Built-in rules can't be edited; they apply in order together with custom rules") }}</p>
      </header>

      <ul class="preset-list">
        <li v-for="rule in presetList" :key="rule.id" class="preset">
          <span class="preset__dot" aria-hidden="true" />
          <span class="preset__name" :title="displayRuleName(rule)">{{ displayRuleName(rule) }}</span>
          <code class="preset__pattern mono">{{ patternPreview(rule) }}</code>
        </li>
      </ul>
    </section>

    <!-- 自定义规则 -->
    <section class="rules__section" aria-labelledby="custom-heading">
      <header class="rules__section-head">
        <h3 id="custom-heading" class="rules__section-title">
          <UiIcon name="pencil" :size="14" />
          {{ t("自定义规则", "Custom rules") }}
          <span class="badge">{{ customRules.length }}</span>
        </h3>
        <p class="hint">
          {{ hasSource ? t("命中行数为当前文本实时统计", "Match counts are computed live for the current text") : t("导入 TXT 后显示命中行数", "Import a TXT file to see match counts") }}
        </p>
      </header>

      <p v-if="!customRules.length" class="rules__blank">
        {{ t("还没有自定义规则。用「新增规则」补充预置规则覆盖不到的标题格式，例如", "No custom rules yet. Use \"Add rule\" to cover title formats the presets miss, e.g.") }}
        <code class="mono">第X卷</code>{{ t("、", ", ") }}<code class="mono">【第X话】</code>{{ t("。", ".") }}
      </p>

      <ul v-else class="custom-list">
        <li v-for="(rule, index) in customRules" :key="rule.id" class="custom" :class="{ 'custom--off': !rule.enabled }">
          <div class="custom__main">
            <UiSwitch
              :model-value="rule.enabled"
              :label="t(`启用规则 ${rule.name}`, `Enable rule ${rule.name}`)"
              hide-label
              @update:model-value="toggleRule(rule.id)"
            />
            <div class="custom__text">
              <p class="custom__name">
                {{ rule.name || t("未命名规则", "Untitled rule") }}
                <span class="badge">{{ rule.mode === "regex" ? t("正则", "Regex") : t("关键词", "Keyword") }}</span>
              </p>
              <code class="custom__pattern mono">{{ patternPreview(rule) }}</code>
            </div>
            <span class="custom__hits tnum" :class="{ 'custom__hits--zero': hasSource && countHits(rule) === 0 }">
              <template v-if="!hasSource">—</template>
              <template v-else-if="countHits(rule) < 0">{{ t("非法", "Invalid") }}</template>
              <template v-else>{{ t(`${countHits(rule)} 行`, `${countHits(rule)} lines`) }}</template>
            </span>
          </div>

          <div class="custom__actions">
            <button
              type="button"
              class="custom__icon-btn"
              :aria-label="t(`上移规则 ${rule.name}`, `Move rule up: ${rule.name}`)"
              :disabled="moveIndex(rule.id) <= 0"
              @click="moveRule(rule.id, -1)"
            >
              <UiIcon name="arrow-up" :size="14" />
            </button>
            <button
              type="button"
              class="custom__icon-btn"
              :aria-label="t(`下移规则 ${rule.name}`, `Move rule down: ${rule.name}`)"
              :disabled="moveIndex(rule.id) >= rules.length - 1"
              @click="moveRule(rule.id, 1)"
            >
              <UiIcon name="arrow-down" :size="14" />
            </button>
            <button type="button" class="custom__text-btn" @click="openEdit(rule)">{{ t("编辑", "Edit") }}</button>
            <button type="button" class="custom__text-btn custom__text-btn--danger" @click="removeRule(rule)">
              {{ t("删除", "Delete") }}
            </button>
            <span class="custom__order mono tnum">#{{ index + 1 }}</span>
          </div>
        </li>
      </ul>

      <div class="rules__footer">
        <p class="hint">
          {{ t("规则从上到下依次尝试，先匹配到的标题格式优先生效。", "Rules are tried from top to bottom; the first matching title format wins.") }}
        </p>
        <UiButton
          size="sm"
          variant="primary"
          icon="arrow-path"
          :disabled="!hasSource"
          @click="emit('reparse')"
        >
          {{ t("按当前规则重新分章", "Re-split chapters with current rules") }}
        </UiButton>
      </div>
    </section>

    <input
      ref="importInput"
      class="sr-only"
      type="file"
      accept=".json,application/json"
      tabindex="-1"
      aria-hidden="true"
      @change="handleImport"
    />

    <!-- 规则编辑弹窗 -->
    <UiModal
      :open="draftOpen"
      :title="draftIsNew ? t('新增章节规则', 'Add chapter rule') : t('编辑章节规则', 'Edit chapter rule')"
      :description="draftIsNew ? t('定义一条识别章节标题的规则', 'Define a rule that recognizes chapter titles') : t('修改后需要重新分章才会生效', 'Changes apply after re-splitting chapters')"
      icon="pencil"
      @close="closeDraft"
    >
      <div class="draft">
        <UiField :label="t('规则名称', 'Rule name')" input-id="rule-name" required>
          <template #default="{ describedBy }">
            <UiInput
              id="rule-name"
              :model-value="draft.name"
              :placeholder="t('例如：卷标题', 'e.g. Volume title')"
              :described-by="describedBy"
              @update:model-value="(value) => (draft.name = value)"
            />
          </template>
        </UiField>

        <UiField :label="t('匹配方式', 'Match type')" input-id="rule-mode">
          <UiSegmented
            id="rule-mode"
            :model-value="draft.mode"
            :options="modeOptions"
            :aria-label="t('匹配方式', 'Match type')"
            full
            @update:model-value="(value) => (draft.mode = value as 'keyword' | 'regex')"
          />
        </UiField>

        <UiField
          v-if="draft.mode === 'keyword'"
          :label="t('关键词', 'Keywords')"
          input-id="rule-keywords"
          :hint="t('多个关键词用换行或 | 分隔，命中任意一个即可', 'Separate keywords with new lines or |; any match counts')"
        >
          <template #default="{ describedBy }">
            <textarea
              id="rule-keywords"
              class="ctl mono"
              rows="3"
              :value="draft.pattern"
              placeholder="卷三&#10;第X卷"
              :aria-describedby="describedBy"
              @input="draft.pattern = ($event.target as HTMLTextAreaElement).value"
            />
          </template>
        </UiField>

        <UiField
          v-else
          :label="t('正则表达式', 'Regular expression')"
          input-id="rule-regex"
          :hint="t('不含首尾斜杠，例如 ^第[0-9]+卷', 'No leading/trailing slashes, e.g. ^第[0-9]+卷')"
          :error="!draftValidation.ok ? ruleErrorText(draftValidation.error) : undefined"
        >
          <template #default="{ describedBy }">
            <UiInput
              id="rule-regex"
              :model-value="draft.pattern"
              placeholder="^第[0-9]+卷"
              :invalid="!draftValidation.ok"
              :described-by="describedBy"
              @update:model-value="(value) => (draft.pattern = value)"
            />
          </template>
        </UiField>

        <div v-if="draft.mode === 'keyword'" class="draft__row">
          <UiField :label="t('匹配范围', 'Match scope')" input-id="rule-template">
            <UiSegmented
              id="rule-template"
              :model-value="draft.keywordTemplate ?? 'prefix'"
              :options="templateOptions"
              :aria-label="t('关键词匹配范围', 'Keyword match scope')"
              full
              @update:model-value="(value) => (draft.keywordTemplate = value as KeywordTemplate)"
            />
          </UiField>
        </div>

        <div v-else class="draft__row draft__row--two">
          <UiField label="Flags" input-id="rule-flags" :hint="t('如 i（忽略大小写）', 'e.g. i (case-insensitive)')">
            <template #default="{ describedBy }">
              <UiInput
                id="rule-flags"
                :model-value="draft.flags ?? ''"
                placeholder="i"
                :described-by="describedBy"
                @update:model-value="(value) => (draft.flags = value)"
              />
            </template>
          </UiField>

          <UiField :label="t('捕获组', 'Capture group')" input-id="rule-capture" :hint="t('0 表示整行匹配结果', '0 means the whole matched line')">
            <template #default="{ describedBy }">
              <input
                id="rule-capture"
                class="ctl mono"
                type="number"
                min="0"
                :value="draft.capture ?? 0"
                :aria-describedby="describedBy"
                @input="captureField"
              />
            </template>
          </UiField>
        </div>

        <div class="draft__result" :class="{ 'draft__result--bad': !draftValidation.ok }">
          <UiIcon
            :name="draftValidation.ok ? 'check-circle' : 'exclamation-circle'"
            :size="14"
          />
          <template v-if="!draftValidation.ok">{{ draftValidation.error }}</template>
          <template v-else-if="!hasSource">{{ t("导入 TXT 后可统计命中行数", "Import a TXT file to count matching lines") }}</template>
          <template v-else>
            {{ t("在当前文本中命中", "Matches in the current text:") }} <b class="tnum">{{ draftHits }}</b> {{ t("行", "lines") }}
            <span v-if="draftHits === 0" class="draft__warn">{{ t("— 试试放宽关键词", "— try broadening the keywords") }}</span>
          </template>
        </div>
      </div>

      <template #footer>
        <UiButton variant="ghost" @click="closeDraft">{{ t("取消", "Cancel") }}</UiButton>
        <UiButton variant="primary" :disabled="!draftValidation.ok" data-autofocus @click="saveDraft">
          {{ draftIsNew ? t("新增", "Add") : t("保存", "Save") }}
        </UiButton>
      </template>
    </UiModal>
  </div>
</template>

<style scoped>
.rules {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  /* 规则视图整页滚动，内容要有自己的左右留白与最大宽度，
     否则 1440 宽下会贴满两侧、长正则也难读。 */
  width: 100%;
  max-width: 1100px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-8) var(--space-12);
}

/* —— 统计条 —— */
.rules__stats {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  flex-wrap: wrap;
  padding: var(--space-4) var(--space-5);
  background-color: var(--color-bg-sunken);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
}

.rules__stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rules__stat-value {
  font-size: var(--text-lg);
  font-weight: var(--weight-medium);
  line-height: 1;
  color: var(--color-text);
}

.rules__stat-label {
  font-size: var(--text-2xs);
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

/* —— 分节 —— */
.rules__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.rules__section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.rules__section-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-serif);
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.06em;
  color: var(--color-text);
}

.rules__section-title svg {
  color: var(--color-text-muted);
}

/* —— 预置规则 —— */
.preset-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.preset {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  min-height: 38px;
  background-color: var(--color-bg-elevated);
}

.preset + .preset {
  border-top: 1px solid var(--color-border-subtle);
}

.preset__dot {
  flex: none;
  width: 4px;
  height: 4px;
  background-color: var(--color-border-strong);
  border-radius: var(--radius-full);
}

.preset__name {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 30ch;
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preset__pattern {
  flex: 1 1 auto;
  /* flex 子项默认 min-width:auto，长正则会把整行顶出去 —— 必须显式归零 */
  min-width: 0;
  font-size: var(--text-2xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* —— 自定义规则 —— */
.rules__blank {
  padding: var(--space-5);
  font-size: var(--text-xs);
  line-height: var(--leading-relaxed);
  text-align: center;
  color: var(--color-text-muted);
  background-color: var(--color-bg-sunken);
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
}

.rules__blank code {
  padding: 1px 4px;
  font-size: var(--text-2xs);
  color: var(--color-text-secondary);
  background-color: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 3px;
}

.custom-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.custom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding: var(--space-2) var(--space-3);
  background-color: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  transition: border-color var(--duration-fast) var(--ease-out);
}

.custom:hover {
  border-color: var(--color-border-strong);
}

.custom--off {
  opacity: 0.62;
}

.custom__main {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1 1 320px;
  min-width: 0;
}

.custom__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.custom__name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}

.custom__pattern {
  font-size: var(--text-2xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40ch;
}

.custom__hits {
  flex: none;
  min-width: 48px;
  font-size: var(--text-2xs);
  text-align: right;
  color: var(--color-text-secondary);
}

.custom__hits--zero {
  color: var(--color-warning);
}

.custom__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}

.custom__icon-btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  color: var(--color-text-muted);
  border-radius: 4px;
}

.custom__icon-btn:hover:not(:disabled) {
  color: var(--color-text);
  background-color: var(--color-surface-active);
}

.custom__icon-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.custom__text-btn {
  padding: 2px var(--space-2);
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  border-radius: 4px;
}

.custom__text-btn:hover {
  color: var(--color-text);
  background-color: var(--color-surface-active);
}

.custom__text-btn--danger:hover {
  color: var(--color-danger);
  background-color: var(--color-danger-soft);
}

.custom__order {
  margin-left: var(--space-1);
  font-size: var(--text-2xs);
  color: var(--color-text-muted);
}

.rules__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
  padding-top: var(--space-3);
  border-top: 1px dashed var(--color-border);
}

/* —— 弹窗表单 —— */
.draft {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.draft__row--two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-4);
}

.draft__result {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-xs);
  color: var(--color-success);
  background-color: var(--color-success-soft);
  border-radius: var(--radius-sm);
}

.draft__result--bad {
  color: var(--color-danger);
  background-color: var(--color-danger-soft);
}

.draft__warn {
  color: var(--color-warning);
}

@media (max-width: 1100px) {
  .rules__stats {
    gap: var(--space-4);
  }

  .custom {
    align-items: flex-start;
  }

  .custom__actions {
    margin-left: auto;
  }

  .draft__row--two {
    grid-template-columns: 1fr;
  }
}
</style>
