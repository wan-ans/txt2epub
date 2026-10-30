# 墨匣 · 模块契约（唯一事实来源）

本文件定义模块边界与函数签名。**改动签名必须同时改这里和 `src/types.ts`，并在任务描述里说明。**

## 目录归属（写入边界，勿越界）

| 路径 | 归属 | 说明 |
| --- | --- | --- |
| `src/types.ts`, `docs/CONTRACT.md`, `src/styles/tokens.css` | Lead | 共享契约与设计令牌 |
| `src/core/**` | core-engine | 纯逻辑，无 Vue、无 electron 依赖；`epubPackage.ts` 允许标准 DOMParser |
| `src/App.vue`, `src/components/**`, `src/styles/app.css`, `index.html` | ui-craft | 界面与样式（含 `src/components/epub/**`） |
| `electron/**`, `scripts/**`, `build/**` | desktop-shell | 主进程、预加载、打包脚本、图标 |
| `src/main.ts`, `src/bridge.ts` | Lead | 应用入口与桌面桥接 |

## 1. 核心逻辑（`src/core/`，纯 TS，可在 Node 与浏览器运行）

全部为**纯函数或只依赖 Web/Node 公共 API**，不得引用 Vue、DOM、Electron。

```ts
// src/core/preprocess.ts
export function preprocessLines(text: string): string[];
export function hasMeaningfulContent(lines: string[]): boolean;
export function countWords(lines: string[]): number;   // 去掉空白后的字符数

// src/core/textReader.ts
export interface DecodeOptions { encoding?: EncodingChoice }
export function detectAndDecode(bytes: Uint8Array, encoding?: EncodingChoice): ReadResult;
/** 把 ReadResult 的编码标签归一成 TextDecoder 认识的标准标签 */
export function normalizeEncoding(label?: string): string;

// src/core/chapterParser.ts
export function parseChapters(
  lines: string[],
  language: Language,
  rules?: ChapterRule[],
): Chapter[];
/** 预置规则（第一章 / Chapter N / 第N节 / 序章 等），只读 */
export function presetRules(): ChapterRule[];

// src/core/customRules.ts
export type ChapterRuleMode = "regex" | "keyword";
export type KeywordTemplate = "prefix" | "anywhere";
export interface ChapterRule {
  id: string;
  name: string;
  mode: ChapterRuleMode;
  pattern: string;
  flags?: string;
  capture?: number;
  keywordTemplate?: KeywordTemplate;
  enabled: boolean;
  /** true 表示预置规则，不可删除（UI 只读展示） */
  builtin?: boolean;
}
export interface CompiledRule { regex: RegExp; capture?: number }
export function createRuleId(): string;
export function keywordToRegexSource(keywords: string, template?: KeywordTemplate): string;
export function compileRule(rule: ChapterRule): CompiledRule;
export function validateRule(rule: ChapterRule): { ok: true } | { ok: false; error: string };
export function serializeRules(rules: ChapterRule[]): string;
export function parseImportedRules(json: string): ChapterRule[];
export function loadRules(): ChapterRule[];     // localStorage，无 localStorage 时返回 []
export function saveRules(rules: ChapterRule[]): void;

// src/core/epubBuilder.ts
export function buildEpub(
  meta: BookMeta,
  chapters: Chapter[],
  options?: BuildEpubOptions,
): Promise<Uint8Array>;
/** 浏览器侧把 Uint8Array 包成 Blob 方便下载 */
export function toEpubBlob(bytes: Uint8Array): Blob;
/** 建议的下载文件名，已做非法字符清洗 */
export function suggestFileName(meta: BookMeta): string;

// src/core/convert.ts  ← 单文件/批量一站式的便捷封装
export interface ConvertInput {
  sourceName: string;
  bytes: Uint8Array;
}
export interface ConvertOptions {
  meta?: Partial<BookMeta>;
  encoding?: EncodingChoice;
  rules?: ChapterRule[];
  cover?: Cover | null;
  typesetting?: Partial<TypesettingOptions>;
  language?: Language;
}
/** 解析 + 生成 EPUB，返回完整结果（不落盘） */
export function convertTxt(input: ConvertInput, options?: ConvertOptions): Promise<ConvertResult>;
```

### 1.1 EPUB 编辑（`src/core/epubPackage.ts`）

> 该模块不依赖 Vue / Electron，但允许使用浏览器标准的 `DOMParser` / `XMLSerializer`（单元测试用 jsdom 环境）。

```ts
// src/core/epubPackage.ts
export function isEpubFileName(name: string): boolean;
export function countHtmlWords(html: string): number;
export async function readEpub(bytes: Uint8Array, sourceName: string): Promise<EpubProject>;
export async function createBlankEpub(meta: EpubBookMeta): Promise<EpubProject>;
export async function writeEpub(
  project: EpubProject,
  meta: EpubBookMeta,
  chapters: EpubChapter[],
  options?: WriteEpubOptions,
): Promise<Uint8Array>;
```

**行为要求**
- `readEpub` 解压并解析 `META-INF/container.xml` → OPF；读取 dc 元信息、manifest、spine、nav / NCX；只把 spine 中 `linear="yes"` 的 XHTML 正文文档作为可编辑章节（跳过 nav、cover、titlepage）。
- 章节标题优先取 nav / NCX 文本，其次 `<title>`、首个 h1-h6；正文取 `<body>` 内 HTML，剔除 script / style。
- `writeEpub` 必须在原 zip 上增量写回：未编辑的章节、图片、字体、CSS 等资源原样保留；只重写被编辑/新增章节，删除被删除章节；同步更新 OPF 元信息、manifest、spine，以及 nav / NCX 目录。
- 导出的 XHTML 必须良构，EPUBCheck 无 error；章节正文只允许编辑器支持的语义标签与安全属性。
- 新建空白书通过 `buildEpub` 生成初始包后交给同一套模型。

**要求**
- `epubBuilder` 产物必须能通过 epubcheck 级别的基本校验：`mimetype` 为 STORE 且第一个写入、`META-INF/container.xml`、OPF 3.0、`nav.xhtml`（`properties="nav"`）、封面 `properties="cover-image"` + `<meta name="cover">`、章节 XHTML 合法且转义。
- 编码检测失败时回退 `utf-8`，并让 `usedEncoding` 反映真实使用的编码。
- 任何用户输入都不得抛出未捕获异常以外的行为：解析 0 章节时返回单章「正文」。

## 2. 桌面桥接（`src/bridge.ts`，Lead 维护）

渲染进程通过 `window.inkbox` 访问主进程能力；浏览器里该对象为 `undefined`，UI 必须优雅降级（走 `<input type=file>` + 浏览器下载）。

```ts
export interface DesktopBridge {
  readonly isDesktop: true;
  readonly platform: string;
  /** 打开 TXT 文件对话框，返回文件字节 */
  openTxtFiles(): Promise<{ path: string; name: string; bytes: Uint8Array }[]>;
  /** 打开文件夹，返回其中所有 .txt（递归一层） */
  openTxtFolder(): Promise<{ path: string; name: string; bytes: Uint8Array }[]>;
  /** 保存 EPUB 到指定路径；未给路径则弹保存对话框 */
  saveEpub(payload: { bytes: Uint8Array; suggestedName: string }): Promise<{ path: string } | null>;
  /** 把文件另存到目录（批量转换用），返回写成功的路径 */
  saveMany(payload: { items: { bytes: Uint8Array; outputName: string }[]; dir?: string }): Promise<
    { written: string[]; dir: string } | null
  >;
  /** 选择目录 */
  chooseDirectory(): Promise<string | null>;
  /** 用系统默认程序打开文件或所在目录 */
  revealInExplorer(path: string): Promise<void>;
  /** 读写应用偏好（主进程持久化到 userData） */
  getPreferences(): Promise<Record<string, unknown>>;
  setPreferences(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
}
```

## 3. UI 契约（`src/App.vue` + `src/components/`）

**视觉方向**：纸感 + 墨色的书斋气质，`src/styles/tokens.css` 是唯一配色/字号/间距来源，**组件内不得出现字面量颜色**（用 `var(--...)`）。必须同时支持浅色与深色（`prefers-color-scheme` 与手动切换）。

**必须实现的界面能力**
1. 拖拽 TXT 到窗口任意位置即导入（含文件选择按钮、桌面端「打开文件夹」）。
2. 编码选择 + 自动检测结果显示，切换编码即时重解析。
3. 章节规则面板：预置规则只读展示 + 自定义规则增删改、测命中行数、导入导出 JSON。
4. 书籍元信息：书名、作者、语言、简介、标签。
5. 封面：选择图片、预览、清除、体积/类型校验。
6. 排版设置：缩进、行高、字号、段间距（实时预览）。
7. 章节列表（虚拟滚动或分块渲染，600+ 章不卡）+ 单章预览。
8. 导出：浏览器下载 / 桌面端保存并「在资源管理器中显示」。
9. 批量：桌面端多文件转换，显示每个文件的进度与结果。
10. 空状态、加载态、错误态齐全；键盘可达（focus ring、Tab 顺序、Esc 关弹窗）。
11. **EPUB 编辑**：打开已有 EPUB / 新建空白书；书籍信息（书名、副标题、作者、语言、出版方、出版日期、简介、标签）编辑；章节增删、改名、拖拽与上下移动排序；正文富文本编辑（标题、粗斜体、引用、列表、链接、图片）；封面替换；导出写回原 EPUB，保留未编辑资源。**不提供打印 / 导出 PDF 功能。**

## 4. 构建与验证

- `npm run typecheck` 必须零错误。
- `npm run test:run` 必须全绿。
- `npm run build:web` 产出 `dist/`（`base: "./"`）。
- 桌面端 `npm run dist:dir` 产出免安装目录；`npm run dist` 产出 NSIS 安装包。