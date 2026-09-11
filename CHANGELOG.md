# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-09-11

首个公开版本。

### TXT → EPUB

- 批量转换：多文件 / 整个文件夹，支持合并成一本
- 编码自动识别：UTF-8 / GBK / GB18030 / BIG5 / UTF-16 / Shift-JIS，可手动指定
- 自动分章：`第一章` / `第1章` / `第十二回` / `卷三` / `楔子` / `序章` / `尾声` / `番外` / `后记` / `Chapter N` / `Part N`
- 分章方式：自动识别 / 按空行 / 按行数 / 按字数 / 整本一章 / 自定义正则
- 元数据：书名、作者、语言、出版社、简介、标识符
- 封面：jpg / png / webp / bmp / gif，自动压缩为 JPEG
- 输出标准 EPUB 3.0，含 nav.xhtml + toc.ncx 双目录，兼容 Kindle 等旧阅读器
- 通过官方 epubcheck 5.2.1 校验（0 错 0 警告）

### EPUB 编辑

- 打开任意标准 EPUB（含 EPUB 2 旧书、Calibre / Sigil 产物）
- 修改元数据、添加 / 替换 / 移除 / 导出封面
- 章节重命名（同步 nav / ncx / 正文标题）、删除章节
- 章节 XHTML 源码直接编辑
- 保存 / 另存为 / 导出为 TXT

### 其他

- 单文件实现，GUI 与命令行共用同一套逻辑
- 免安装、不联网、不写注册表、不生成配置文件
- 内置自检：`TXT2EPUB.exe --selftest`
- PyInstaller 打包脚本与 GitHub Actions 自动构建发布
