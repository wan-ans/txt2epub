# TXT ↔ EPUB 工具箱

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6.svg)](#系统要求)
[![Python](https://img.shields.io/badge/python-3.10%2B-3776AB.svg)](https://www.python.org/)

一个**单文件、免安装、不联网**的 Windows 桌面小工具：把 TXT 小说批量转成标准 EPUB 3.0 电子书，也能打开已有 EPUB 改元数据、换封面、改章节。

## 功能特性

### 一、TXT → EPUB

| 能力 | 说明 |
| --- | --- |
| 批量转换 | 一次添加多个 `.txt`，或直接添加整个文件夹；可选合并成一本 |
| 编码自动识别 | UTF-8 / GBK / GB18030 / BIG5 / UTF-16 / Shift-JIS 等自动区分，也可手动指定 |
| 自动分章 | 识别 `第一章` / `第1章` / `第十二回` / `卷三` / `楔子` / `序章` / `尾声` / `番外` / `后记` / `Chapter 5` / `Chapter IV` / `Part 2` |
| 多种分章方式 | 自动识别 / 按空行 / 按行数 / 按字数 / 整本一章 / 自定义正则 |
| 元数据 | 书名、作者、语言、出版社、简介、标识符 |
| 封面 | jpg / png / webp / bmp / gif，自动压缩为合适的 JPEG |
| 输出 | 标准 EPUB 3.0（含 nav.xhtml + toc.ncx 双目录，兼容 Kindle 等旧阅读器） |

### 二、EPUB 编辑

- 打开任意标准 EPUB（含 Calibre / Sigil 生成的和 EPUB 2 的旧书）
- 修改书名、作者、语言、出版社、标识符、简介
- 添加 / 替换 / 移除 / 导出封面，并正确写入 `cover.xhtml`、spine 首位、OPF 的 `properties="cover-image"` 与 `<meta name="cover">`
- 章节列表：重命名章节（同步更新 `nav.xhtml`、`toc.ncx` 和正文标题）、删除章节
- 「章节源码」页直接编辑 XHTML 正文
- 「保存」覆盖原文件，「另存为…」写新文件
- 「导出为 TXT…」把整本书导成纯文本

---

## 下载

1. 打开 [Releases](../../releases) 页面，下载 `TXT2EPUB.exe`（约 19 MB）。

### 标签页 1：TXT → EPUB

1. 「添加文件…」选一个或多个 `.txt`；也可以「添加文件夹…」批量加入整个目录。
2. 填书名 / 作者 / 出版社（留空则自动用文件名当书名）。
3. 「分章方式」默认 **自动识别章节**，需要时改成按空行 / 按行数 / 按字数 / 整本一章 / 自定义正则（Python 正则，只匹配行首）。
4. 编码默认 **自动识别**，识别错了就在下拉框里手动指定。
5. 「封面图片」可选。
6. 点「开始转换」，日志会显示每个文件的编码、章数和结果。默认输出到源文件所在目录，也可以另指定输出目录。

### 标签页 2：EPUB 编辑

「打开 EPUB…」载入书籍 → 改元数据 / 换封面 / 改章节 → 「保存」或「另存为…」（建议先另存为，安全）。

---

## 命令行用法

```
TXT2EPUB.exe --txt "D:\书\a.txt" --out "D:\输出" --author 张三 --cover "D:\c.jpg"
TXT2EPUB.exe --txt "D:\书" --out "D:\输出" --merge --split auto
TXT2EPUB.exe --selftest --report "D:\report.txt"
```

| 参数 | 说明 |
| --- | --- |
| `--txt` | 输入 TXT 文件或目录（可多次指定） |
| `--out` | 输出目录 |
| `--title` | 书名 |
| `--author` | 作者 |
| `--lang` | 语言，默认 `zh-CN` |
| `--cover` | 封面图片路径 |
| `--split` | 分章方式：`auto` / `blank` / `lines` / `chars` / `none` |
| `--pattern` | 自定义分章正则 |
| `-n` | 按行数 / 按字数分章时的阈值，默认 50 |
| `--encoding` | 强制指定编码，默认 `auto` |
| `--merge` | 多文件合并为一本 |
| `--selftest` | 运行内置自检（出厂验证用） |
| `--report` | 自检报告输出路径 |
| `--version` | 显示版本 |

## 从源码运行

```bash
git clone https://github.com/wan-ans/txt2epub.git
cd txt2epub
python src/txt2epub.py

## 自行打包 exe

```powershell
pip install pyinstaller pillow
powershell -ExecutionPolicy Bypass -File src\build_exe.ps1
```

产物在 `src\dist\TXT2EPUB.exe`。

打包脚本会自动调用 `src/make_icon.py` 生成图标 `src/app.ico`，再以 `--onefile --windowed` 打成单文件 exe。

---

## 项目结构

```
txt2epub/
├── src/
│   ├── txt2epub.py        # 全部程序逻辑（GUI + CLI，单文件）
│   ├── make_icon.py       # 构建时生成 app.ico
│   ├── build_exe.ps1      # PyInstaller 打包脚本
│   ├── version_info.txt   # exe 版本资源
│   └── app.ico            # 程序图标
├── docs/
│   └── 使用说明.md         # 详细中文使用说明
├── .github/workflows/
│   └── release.yml        # 打 tag 自动构建 exe 并发布 Release
├── LICENSE
└── README.md
```

## 许可证

[MIT](LICENSE) © 2026 wan-ans
