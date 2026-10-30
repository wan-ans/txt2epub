/**
 * 批量转换 / 追加章节用到的排序与命名工具。
 *
 * 抽成独立模块的原因：这些是「多 TXT 合并」正确性的核心，
 * 必须能被单元测试直接覆盖，而不是埋在组件里靠手点验证。
 * 本文件不依赖 Vue，可在 Node 下运行。
 */

/** 去掉文件扩展名，作为书名/章节名的默认值。 */
export function stripExtension(name: string): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const withoutExt = base.replace(/\.[^./\\]+$/, "");
  return (withoutExt.trim() || base.trim() || "未命名").slice(0, 120);
}

/**
 * 文件名 → 章节标题。
 *
 * 常见的小说分卷文件长这样：
 *   「01.txt」「2-第3章.txt」「03、楔子.txt」「10 番外.txt」
 * 用户希望合并后看到的是有意义的标题，而不是一串文件序号，
 * 所以这里剥掉开头的纯序号前缀；剥完为空则退回原名。
 */
export function chapterTitleFromFile(fileName: string): string {
  const base = stripExtension(fileName);
  const stripped = base.replace(/^[\s\d０-９]*[.、,，_\-—–)）\]】]*\s*/, "").trim();
  return (stripped || base).slice(0, 120);
}

/**
 * 自然排序比较器：数字按大小比较，而不是按字符。
 *
 *   「第1话 第10话 第2话」→ 「第1话 第2话 第10话」
 *
 * 这正是用户说的「名字带 1 的放前面，带 2 的排第二」，
 * 也是最容易被 `Array.sort()` 默认字典序搞错的地方。
 */
export function compareNaturally(a: string, b: string): number {
  return String(a).localeCompare(String(b), "zh-CN", {
    numeric: true,
    sensitivity: "base",
  });
}

/** 按文件名自然排序（返回新数组，不改原数组）。 */
export function sortFilesByNaturalName<T extends { name: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => compareNaturally(a.name, b.name));
}

/** 数组内元素移动（用于拖拽 / 上下移按钮的统一实现）。 */
export function moveItem<T>(list: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return [...list];
  if (fromIndex < 0 || fromIndex >= list.length) return [...list];
  if (toIndex < 0 || toIndex >= list.length) return [...list];
  const next = [...list];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}
