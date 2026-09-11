#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TXT <-> EPUB 工具箱  (单文件 Windows 工具，无配置、无数据记录)

功能
    1) TXT -> EPUB : 批量转换、自动识别编码(UTF-8/GBK/BIG5/UTF-16...)、
       自动分章(第X章 / Chapter N / 空行 / 按行数 / 按字数)、封面、元数据。
    2) EPUB 编辑   : 查看/修改元数据、添加/替换/删除/导出封面、
       章节改名、章节源码编辑、删除章节、导出为 TXT。
    3) 只读写你指定的文件，不生成任何配置或缓存。

命令行(可选，双击运行则是图形界面)：
    TXT2EPUB.exe --txt a.txt --out D:\\books --author 某人 --cover c.jpg
    TXT2EPUB.exe --selftest --report report.txt
"""
from __future__ import annotations

import argparse
import codecs
import datetime
import html
import io
import os
import posixpath
import queue
import re
import sys
import threading
import traceback
import uuid
import zipfile

APP_NAME = "TXT ↔ EPUB 工具箱"
VERSION = "1.1.0"

NS_OPF = "http://www.idpf.org/2007/opf"
NS_DC = "http://purl.org/dc/elements/1.1/"
NS_XHTML = "http://www.w3.org/1999/xhtml"
NS_EPUB = "http://www.idpf.org/2007/ops"
NS_NCX = "http://www.daisy.org/z3986/2005/ncx/"
NS_CONTAINER = "urn:oasis:names:tc:opendocument:xmlns:container"

MIMETYPE = "application/epub+zip"
IMG_MEDIA = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
             "gif": "image/gif", "svg": "image/svg+xml", "webp": "image/webp",
             "bmp": "image/bmp"}

STYLE_CSS = """@charset "utf-8";
html, body { margin: 0; padding: 0; }
body { margin: 0 5%; line-height: 1.65; text-align: justify; }
h1.ctitle { font-size: 1.35em; font-weight: bold; text-align: center;
            margin: 1.4em 0 1.0em 0; line-height: 1.4; }
p { margin: 0.45em 0; text-indent: 2em; }
p.noindent { text-indent: 0; }
div.titlepage { text-align: center; margin-top: 22%; }
div.titlepage h1 { font-size: 1.8em; margin-bottom: 0.4em; }
div.titlepage p { text-indent: 0; font-size: 1.05em; color: #444; }
div.cover { text-align: center; margin: 0; padding: 0; }
div.cover img { max-width: 100%; max-height: 100%; }
"""


# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------
def app_dir() -> str:
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def xesc(text) -> str:
    """XML 文本转义"""
    return html.escape("" if text is None else str(text), quote=False)


def xattr(text) -> str:
    return html.escape("" if text is None else str(text), quote=True)


def strip_tags(s: str) -> str:
    s = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", s)
    s = re.sub(r"(?s)<[^>]+>", "", s)
    return html.unescape(s)


def safe_filename(name: str, fallback: str = "book") -> str:
    name = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", (name or "").strip())
    name = name.strip(" .")
    return name[:120] or fallback


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------
# 编码识别
# --------------------------------------------------------------------------
_COMMON_CJK = set(
    "的一是了我不人在他有這個上們來到時大地為子中你說生國年著就那和要她出也得裡後自以會家可下而"
    "過天去能對小多然於心學麼之都好看起發當沒成只如事把還用第樣道想作種開美總從無情己面最女但現"
    "前些所同日手又行意動方期它頭經長兒回位分愛老因很給名法間斯知世什兩次使身者被高已親其進此話"
    "常與活正感見明問力理爾點文幾定本公特做外孩相西果走將月十實向聲車全信重三機工物氣每並別真打"
    "太新比才便夫再書部水像眼等體卻加電主界門利海受聽表德少克代員許先口由死安寫性馬光白或住難望"
    "教命花結樂色更拉東神記處讓母父應直字場平報友關放至張認接告入笑內英軍候民歲往何度山覺路帶萬"
    "男邊風解叫任金快原吃媽變通師立象數四失滿戰遠格士音輕目條呢病始達深完今提求清王化空業思切怎"
    "非找片羅錢嗎語元喜曾離飛科言干流歡約各即指合反題必該論交終林請醫晚制球決傳畫保讀運及則房早"
    "院量苦火布品近坐產答星精視五連司巴奇管類未朋且婚台夜青北隊久乎越觀落盡形影紅爸百令周吧識步"
    "希亞術留市半熱送興造談容極隨演收首根講整式取照辦強石古華拿計您裝似足雙妻尼轉訴米稱麗客南領"
    "節衣站黑刻統斷福城故歷驚臉選包緊爭另建維絕樹系傷示願持千史誰準聯婦紀基買志靜阿詩獨復痛消社"
    "算義竟確酒需單治卡幸蘭念舉僅鐘怕共毛句息功官待究跟穿室易游程號居考突皮哪費倒價圖具剛腦永歌"
    "響商禮細專黃塊腳味靈改據般破引食仍存眾注筆甚某沉血備習校默務土微娘須試懷料調廣蘇顯賽查密議"
    "底列富夢錯座參八除跑亮假印設線溫雖掉京初養香停際致陽紙李納驗助激夠嚴證帝飯忘趣支春集丈木研"
    "班普導頓睡展跳獲藝六波察群皇段急庭創區奧器謝弟店否害草排背止組州朝封睛板角況曲館育忙質河續"
    "哥呼若推境遇雨標姐充圍案倫護冷警貝著雪索劇啊船險煙依鬥值幫漢慢佛肯聞唱沙局伯族低玩資屋擊速"
    "顧淚洲團聖旁堂兵七露園牛哭旅街勞型烈姑陳莫魚異抱寶權魯簡態級票怪尋殺律勝份汽右洋範床舞秘午"
    "登樓貴吸責例追較職屬漸左錄絲牙黨繼託趕章智衝葉胡吉賣堅喝肉遺救修鬆臨藏擔戲善衛藥悲敢靠伊村"
    "戴詞森耳差短祖雲規窗散迷油舊適鄉架恩投彈鐵博雷府壓超負勒雜醒洗採毫嘴畢九冰既狀亂景席珍童頂"
    "派素脫農疑練野按犯拍徵壞骨餘承置彩燈巨琴免環姆暗換技翻束增忍餐洛塞缺憶判歐層付陣瑪批島項狗"
    "休懂武革良惡戀委擁娜妙探呀贏雞丘舍慣"
)


def _text_score(text: str) -> float:
    """给解码结果打分：常见字/ASCII/中文标点加分，乱码减分。"""
    if not text:
        return -999.0
    sample = text[:6000]
    total = 0
    score = 0.0
    for ch in sample:
        if ch in "\r\n\t\ufeff":
            continue
        total += 1
        o = ord(ch)
        if o < 0x80:
            score += 1.0
        elif ch in _COMMON_CJK:
            score += 1.0
        elif 0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF:
            score += 0.15          # 罕见汉字（多半是乱码）
        elif 0x3000 <= o <= 0x303F or 0xFF00 <= o <= 0xFFEF or o in (0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026):
            score += 1.0
        elif 0x3040 <= o <= 0x30FF:
            score += 0.25          # 假名
        elif o == 0xFFFD:
            score -= 6.0
        elif o < 32:
            score -= 6.0
        elif 0xE000 <= o <= 0xF8FF:
            score -= 4.0
        elif 0x00A0 <= o <= 0x024F:
            score += 0.55          # 拉丁扩展（西欧文本）
        elif 0x0370 <= o <= 0x04FF:
            score += 0.40          # 希腊 / 西里尔
        else:
            score += 0.20
    return score / max(1, total)


ENCODING_CHOICES = [
    ("自动识别", "auto"),
    ("UTF-8", "utf-8"),
    ("UTF-8 (带BOM)", "utf-8-sig"),
    ("GBK / GB18030 (简体)", "gb18030"),
    ("BIG5 (繁体)", "big5"),
    ("UTF-16", "utf-16"),
    ("Shift-JIS (日文)", "cp932"),
    ("西欧 (cp1252)", "cp1252"),
]


def decode_bytes(raw: bytes, prefer: str = "auto"):
    """返回 (text, encoding_name)"""
    if prefer and prefer != "auto":
        try:
            return raw.decode(prefer), prefer
        except (UnicodeDecodeError, LookupError):
            pass
    if raw.startswith(codecs.BOM_UTF8):
        return raw.decode("utf-8-sig"), "utf-8-sig"
    if raw.startswith(codecs.BOM_UTF16_LE) or raw.startswith(codecs.BOM_UTF16_BE):
        return raw.decode("utf-16"), "utf-16"
    if raw.startswith(codecs.BOM_UTF32_LE) or raw.startswith(codecs.BOM_UTF32_BE):
        return raw.decode("utf-32"), "utf-32"

    bias = {"utf-8": 0.06, "gb18030": 0.03}
    best = None
    for enc in ("utf-8", "gb18030", "big5", "cp932"):
        try:
            text = raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
        sc = _text_score(text) + bias.get(enc, 0.0)
        if best is None or sc > best[0]:
            best = (sc, enc, text)
    # 西欧编码只在没有任何 CJK 编码说得通时才考虑
    if best is None or best[0] < 0.75:
        try:
            text = raw.decode("cp1252")
            sc = _text_score(text) + 0.04
            if best is None or sc > best[0]:
                best = (sc, "cp1252", text)
        except (UnicodeDecodeError, LookupError):
            pass
    if best is None:
        return raw.decode("utf-8", "replace"), "utf-8(替换非法字符)"
    return best[2], best[1]


def read_text_file(path: str, prefer: str = "auto"):
    with open(path, "rb") as f:
        raw = f.read()
    return decode_bytes(raw, prefer)


# --------------------------------------------------------------------------
# 文本 -> 段落 HTML
# --------------------------------------------------------------------------
def text_to_html(body: str, base_indent: bool = True) -> str:
    lines = body.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    non_empty = [ln for ln in lines if ln.strip()]
    blanks = len(lines) - len(non_empty)
    if not non_empty:
        return ""
    # 空行很少 => 认为每一行就是一个自然段（中文小说常见）
    line_mode = blanks < max(1, len(lines) // 40)
    paras = []
    if line_mode:
        paras = [ln.strip() for ln in lines if ln.strip()]
    else:
        buf = []
        for ln in lines:
            if ln.strip():
                buf.append(ln.strip())
            else:
                if buf:
                    paras.append(" ".join(buf))
                    buf = []
        if buf:
            paras.append(" ".join(buf))
    out = []
    for p in paras:
        cls = "" if base_indent else ' class="noindent"'
        out.append("<p%s>%s</p>" % (cls, xesc(p)))
    return "\n".join(out)


# --------------------------------------------------------------------------
# 分章
# --------------------------------------------------------------------------
CHAPTER_REGEXES = [
    r"^\s*第\s*[0-9０-９零一二三四五六七八九十百千万亿两〇]+\s*[章节節回卷篇部集話话幕折].*$",
    r"^\s*(?:序章|序言|序曲|序|楔子|引子|前言|引言|后记|後記|尾声|尾聲|终章|終章|番外|外传|外傳|附录|附錄|完本感言|作者的话|感言)\s*[:：、.．]?\s*.*$",
    r"^\s*(?:Chapter|CHAPTER|Chap\.?|CH\.?)\s*[0-9IVXLCivxlc]+.*$",
    r"^\s*(?:Part|PART)\s+[0-9IVXLCivxlc]+.*$",
    r"^\s*[【\[（(]\s*第?\s*[0-9０-９零一二三四五六七八九十百千万]+\s*[章节節回卷篇部集话話]\s*[】\]）)].*$",
    r"^\s*(?:卷|卷之)\s*[0-9０-９零一二三四五六七八九十百千万两]+\s*.*$",
]
# 逐条编译并匹配：避免某条写错时把后面的模式“吞并”进字符类
AUTO_CHAPTER_RES = []
for _p in CHAPTER_REGEXES:
    try:
        AUTO_CHAPTER_RES.append(re.compile(_p))
    except re.error:
        pass
NUM_CHAPTER_RE = re.compile(r"^\s*[0-9０-９]{1,4}\s*[、.．,，:：]\s*\S.*$")


def _is_heading(line: str, extra=None) -> bool:
    s = line.strip()
    if not s or len(s) > 46:
        return False
    if extra is not None:
        try:
            return bool(extra.match(s))
        except re.error:
            return False
    return any(r.match(s) for r in AUTO_CHAPTER_RES)


def split_chapters(text: str, mode: str = "auto", pattern: str = "",
                   n: int = 50, book_title: str = ""):
    """返回 [(章节标题, 正文文本), ...]"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    default_title = book_title or "正文"

    if mode == "none":
        return [(default_title, text)]

    if mode == "chars":
        size = max(500, int(n) * 100)
        chunks = []
        rest = text
        while rest:
            chunks.append(rest[:size])
            rest = rest[size:]
        return [("第%d章" % (i + 1), c) for i, c in enumerate(chunks)] or [(default_title, text)]

    if mode == "lines":
        per = max(1, int(n))
        lines = [ln for ln in text.split("\n")]
        chapters = []
        buf = []
        cnt = 0
        for ln in lines:
            buf.append(ln)
            if ln.strip():
                cnt += 1
            if cnt >= per:
                chapters.append(("\n".join(buf), cnt))
                buf, cnt = [], 0
        if buf and any(x.strip() for x in buf):
            chapters.append(("\n".join(buf), cnt))
        return [("第%d章" % (i + 1), body) for i, (body, _c) in enumerate(chapters)] or [(default_title, text)]

    if mode == "blank":
        blocks = re.split(r"\n\s*\n", text)
        chapters = []
        for b in blocks:
            b = b.strip("\n")
            if not b.strip():
                continue
            lines = [x for x in b.split("\n")]
            title = lines[0].strip()[:60] if len(lines) > 1 and len(lines[0].strip()) <= 40 else ""
            body = b if not title else "\n".join(lines[1:])
            chapters.append((title or "第%d章" % (len(chapters) + 1), body))
        return chapters or [(default_title, text)]

    # auto / regex
    extra = None
    if mode == "regex" and pattern.strip():
        try:
            extra = re.compile(pattern.strip())
        except re.error as exc:
            raise ValueError("自定义正则表达式有误：%s" % exc)
    lines = text.split("\n")
    idx = [i for i, ln in enumerate(lines) if _is_heading(ln, extra)]
    if mode == "regex" and extra is not None and not idx:
        return [(default_title, text)]
    if not idx:
        return [(default_title, text)]

    chapters = []
    head = "\n".join(lines[:idx[0]]).strip()
    if head:
        chapters.append(("前言", head))
    for k, start in enumerate(idx):
        end = idx[k + 1] if k + 1 < len(idx) else len(lines)
        title = lines[start].strip()
        title = re.sub(r"\s+", " ", title)[:80]
        body = "\n".join(lines[start + 1:end]).strip("\n")
        chapters.append((title, body))
    # 章节太碎（标题行过多）时合并回去更安全
    return chapters


# --------------------------------------------------------------------------
# 封面处理
# --------------------------------------------------------------------------
def prepare_cover(path: str, max_w: int = 1600, max_h: int = 2560):
    """返回 (bytes, ext, media_type)"""
    with open(path, "rb") as f:
        raw = f.read()
    try:
        from PIL import Image, ImageOps
    except Exception:
        ext = (os.path.splitext(path)[1].lstrip(".") or "jpg").lower()
        if ext not in IMG_MEDIA:
            raise ValueError("当前环境无法处理 %s 格式的图片（缺少 Pillow）" % ext)
        return raw, ext, IMG_MEDIA[ext]

    im = Image.open(io.BytesIO(raw))
    try:
        im = ImageOps.exif_transpose(im)
    except Exception:
        pass
    has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
    if has_alpha:
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[-1])
        im = bg
    else:
        im = im.convert("RGB")
    if im.width > max_w or im.height > max_h:
        scale = min(max_w / im.width, max_h / im.height)
        im = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=88, optimize=True, progressive=True)
    return buf.getvalue(), "jpg", "image/jpeg"


def image_size(data: bytes):
    try:
        from PIL import Image
        with Image.open(io.BytesIO(data)) as im:
            return im.size
    except Exception:
        return None


# --------------------------------------------------------------------------
# zip 写入（mimetype 必须第一个且不压缩）
# --------------------------------------------------------------------------
def write_epub_zip(out_path: str, entries, order=None):
    names = list(order) if order else list(entries.keys())
    seen = set()
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        if "mimetype" in entries:
            zi = zipfile.ZipInfo("mimetype", date_time=(1980, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_STORED
            zi.external_attr = 0o644 << 16
            z.writestr(zi, entries["mimetype"])
            seen.add("mimetype")
        for name in names:
            if name in seen or name not in entries:
                continue
            z.writestr(name, entries[name])
            seen.add(name)
        for name in sorted(entries):
            if name in seen:
                continue
            z.writestr(name, entries[name])
            seen.add(name)


# --------------------------------------------------------------------------
# 生成 EPUB
# --------------------------------------------------------------------------
NAV_TMPL = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="{lang}" lang="{lang}">
<head>
<meta charset="utf-8"/>
<title>{title}</title>
<link rel="stylesheet" type="text/css" href="{css_href}"/>
</head>
<body>
<nav epub:type="toc" id="toc">
<h1>目录</h1>
<ol>
{items}
</ol>
</nav>
<nav epub:type="landmarks" id="landmarks" hidden="hidden">
<h1>导航</h1>
<ol>
<li><a epub:type="bodymatter" href="{first_href}">正文</a></li>
</ol>
</nav>
</body>
</html>
"""

NCX_TMPL = """<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="{lang}">
<head>
<meta name="dtb:uid" content="{uid}"/>
<meta name="dtb:depth" content="1"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>{title}</text></docTitle>
<navMap>
{points}
</navMap>
</ncx>
"""

OPF_TMPL = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="{lang}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="bookid">{identifier}</dc:identifier>
    <dc:title>{title}</dc:title>
    <dc:language>{lang}</dc:language>
{creators}    <dc:date>{date}</dc:date>
    <meta property="dcterms:modified">{modified}</meta>
{extra}  </metadata>
  <manifest>
{manifest}  </manifest>
  <spine toc="ncx">
{spine}  </spine>
  <guide>
{guide}  </guide>
</package>
"""

CONTAINER_XML = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="{opf}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

XHTML_TMPL = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="{lang}" lang="{lang}">
<head>
<meta charset="utf-8"/>
<title>{title}</title>
<link rel="stylesheet" type="text/css" href="{css_href}"/>
</head>
<body>
<section epub:type="chapter">
<h1 class="ctitle">{title}</h1>
{body}
</section>
</body>
</html>
"""

TITLEPAGE_TMPL = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="{lang}" lang="{lang}">
<head>
<meta charset="utf-8"/>
<title>{title}</title>
<link rel="stylesheet" type="text/css" href="{css_href}"/>
</head>
<body>
<div class="titlepage">
<h1>{title}</h1>
<p>{author}</p>
<p>{publisher}</p>
</div>
</body>
</html>
"""

COVERPAGE_TMPL = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="{lang}" lang="{lang}">
<head>
<meta charset="utf-8"/>
<title>封面</title>
<link rel="stylesheet" type="text/css" href="{css_href}"/>
</head>
<body>
<div class="cover"><img src="{img_src}" alt="封面"/></div>
</body>
</html>
"""


def build_epub(out_path: str, title: str, chapters, author: str = "", language: str = "zh-CN",
               publisher: str = "", description: str = "", cover_path: str = None,
               cover_data=None, identifier: str = None, with_titlepage: bool = True) -> str:
    """生成 EPUB 文件，返回输出路径。"""
    title = (title or "未命名").strip()
    author = (author or "").strip()
    language = (language or "zh-CN").strip()
    publisher = (publisher or "").strip()
    description = (description or "").strip()
    identifier = identifier or ("urn:uuid:" + str(uuid.uuid4()))
    lang_root = language.split("-")[0] or "zh"

    entries = {"mimetype": MIMETYPE.encode("ascii")}
    manifest = []
    spine = []
    guide = []
    nav_items = []
    ncx_points = []

    def add_manifest(iid, href, mtype, props=None):
        p = ' properties="%s"' % props if props else ""
        manifest.append('    <item id="%s" href="%s" media-type="%s"%s/>' % (iid, href, mtype, p))

    # 样式
    add_manifest("css", "style.css", "text/css")
    entries["OEBPS/style.css"] = STYLE_CSS.encode("utf-8")

    # 封面
    cover_img_href = None
    if cover_data is None and cover_path:
        cover_data = prepare_cover(cover_path)
    if cover_data:
        cbytes, cext, cmedia = cover_data
        cover_img_href = "images/cover.%s" % cext
        add_manifest("cover-image", cover_img_href, cmedia, "cover-image")
        entries["OEBPS/" + cover_img_href] = cbytes
        entries["OEBPS/text/cover.xhtml"] = COVERPAGE_TMPL.format(
            lang=language, css_href="../style.css",
            img_src=posixpath.relpath("OEBPS/" + cover_img_href, "OEBPS/text")).encode("utf-8")
        add_manifest("cover-page", "text/cover.xhtml", "application/xhtml+xml")
        spine.append('    <itemref idref="cover-page" linear="yes"/>')
        guide.append('    <reference type="cover" title="封面" href="text/cover.xhtml"/>')

    # 扉页
    if with_titlepage and (author or publisher or title):
        entries["OEBPS/text/titlepage.xhtml"] = TITLEPAGE_TMPL.format(
            lang=language, css_href="../style.css", title=xesc(title),
            author=xesc(author), publisher=xesc(publisher)).encode("utf-8")
        add_manifest("titlepage", "text/titlepage.xhtml", "application/xhtml+xml")
        spine.append('    <itemref idref="titlepage"/>')

    # 正文
    first_text_href = None
    total = len(chapters)
    for i, (ctitle, body) in enumerate(chapters, 1):
        cid = "c%04d" % i
        href = "text/%s.xhtml" % cid
        ptitle = (ctitle or "第%d章" % i).strip()
        content = XHTML_TMPL.format(
            lang=language, css_href="../style.css", title=xesc(ptitle),
            body=text_to_html(body)).encode("utf-8")
        entries["OEBPS/" + href] = content
        add_manifest(cid, href, "application/xhtml+xml")
        spine.append('    <itemref idref="%s"/>' % cid)
        nav_items.append('    <li><a href="%s">%s</a></li>' % (href, xesc(ptitle)))
        ncx_points.append(
            '  <navPoint id="np%d" playOrder="%d">\n'
            '    <navLabel><text>%s</text></navLabel>\n'
            '    <content src="%s"/>\n'
            '  </navPoint>' % (i, i, xesc(ptitle), xesc(href)))
        if first_text_href is None:
            first_text_href = href

    if not chapters:
        raise ValueError("没有可写入的正文内容")

    # 目录 / 导航
    entries["OEBPS/nav.xhtml"] = NAV_TMPL.format(
        lang=language, title=xesc(title), css_href="style.css",
        items="\n".join(nav_items), first_href=first_text_href).encode("utf-8")
    add_manifest("nav", "nav.xhtml", "application/xhtml+xml", "nav")

    entries["OEBPS/toc.ncx"] = NCX_TMPL.format(
        lang=language, uid=xesc(identifier), title=xesc(title),
        points="\n".join(ncx_points)).encode("utf-8")
    add_manifest("ncx", "toc.ncx", "application/x-dtbncx+xml")

    guide.append('    <reference type="toc" title="目录" href="nav.xhtml"/>')
    guide.append('    <reference type="text" title="正文" href="%s"/>' % first_text_href)

    creators = ""
    if author:
        creators = "    <dc:creator>%s</dc:creator>\n" % xesc(author)
    extra = ""
    if publisher:
        extra += "    <dc:publisher>%s</dc:publisher>\n" % xesc(publisher)
    if description:
        extra += "    <dc:description>%s</dc:description>\n" % xesc(description)
    if cover_img_href:
        extra += '    <meta name="cover" content="cover-image"/>\n'
    extra += '    <meta property="rendition:layout">reflowable</meta>\n'

    opf = OPF_TMPL.format(
        lang=language, identifier=xesc(identifier), title=xesc(title),
        creators=creators, date=datetime.date.today().isoformat(), modified=now_iso(),
        extra=extra, manifest="\n".join(manifest) + "\n",
        spine="\n".join(spine) + "\n", guide="\n".join(guide) + "\n")
    entries["OEBPS/content.opf"] = opf.encode("utf-8")
    entries["META-INF/container.xml"] = CONTAINER_XML.format(opf="OEBPS/content.opf").encode("utf-8")

    order = ["mimetype", "META-INF/container.xml", "OEBPS/content.opf", "OEBPS/nav.xhtml",
             "OEBPS/toc.ncx", "OEBPS/style.css"]
    if cover_img_href:
        order.append("OEBPS/" + cover_img_href)
        order.append("OEBPS/text/cover.xhtml")
    order += ["OEBPS/text/%s.xhtml" % ("c%04d" % i) for i in range(1, total + 1)]
    if "OEBPS/text/titlepage.xhtml" in entries:
        order.insert(3, "OEBPS/text/titlepage.xhtml")

    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    tmp = out_path + ".tmp"
    write_epub_zip(tmp, entries, order)
    if os.path.exists(out_path):
        os.remove(out_path)
    os.replace(tmp, out_path)
    return out_path


# --------------------------------------------------------------------------
# EPUB 读写 / 编辑
# --------------------------------------------------------------------------
_TIDY_PREFIX = {NS_DC: "dc", NS_OPF: "opf", NS_XHTML: "xhtml",
                NS_EPUB: "epub", NS_NCX: "ncx", NS_CONTAINER: "container"}


def _tidy_ns(xml: str) -> str:
    """把 ElementTree 生成的 ns0/ns1 换回规范前缀，并让 OPF 元素回到默认命名空间。

    OPF 命名空间下的 *属性*（如 opf:role / opf:file-as）必须保留前缀，
    否则会改变语义，所以先把它们保护起来再处理元素前缀。
    """
    mapping = {}
    for m in re.finditer(r'xmlns:(ns\d+)="([^"]+)"', xml):
        want = _TIDY_PREFIX.get(m.group(2))
        if want:
            mapping[m.group(1)] = want
    for old, new in mapping.items():
        xml = xml.replace(old + ":", new + ":")

    if "opf:" not in xml:
        return xml
    mark = "__OPFQ__"
    xml = re.sub(r"\sopf:([A-Za-z_][\w.\-]*)\s*=", lambda m: " %s%s=" % (mark, m.group(1)), xml)
    xml = xml.replace('xmlns:opf="%s"' % NS_OPF, 'xmlns="%s"' % NS_OPF)
    xml = xml.replace("opf:", "")
    xml = re.sub(r"\s" + mark + r"([A-Za-z_][\w.\-]*)\s*=", lambda m: " opf:%s=" % m.group(1), xml)
    if mark in xml:
        xml = xml.replace(mark, "")
    if "<package" in xml and "xmlns:opf=" not in xml:
        xml = xml.replace("<package", '<package xmlns:opf="%s"' % NS_OPF, 1)
    return xml


class EpubFile:
    """读取并编辑已有 EPUB（纯文件操作，不落任何配置）。"""

    def __init__(self, path: str):
        self.path = path
        self.entries = {}
        self.order = []
        self.opf_path = ""
        self.opf_dir = ""
        self.opf_root = None
        self.chapters = []          # [{title, href, path, id}]
        self.cover_page_path = None
        self.nav_path = None
        self.ncx_path = None
        self._toc_dirty = False
        self.load(path)

    # ---------------- 读取 ----------------
    def load(self, path: str):
        if not zipfile.is_zipfile(path):
            raise ValueError("这不是有效的 EPUB / ZIP 文件：%s" % path)
        self.path = path
        self.entries, self.order = {}, []
        with zipfile.ZipFile(path) as z:
            for info in z.infolist():
                if info.is_dir():
                    continue
                name = info.filename.replace("\\", "/")
                self.entries[name] = z.read(info.filename)
                self.order.append(name)
        if "mimetype" not in self.entries:
            raise ValueError("不是有效的 EPUB：缺少 mimetype 文件")
        container = self.entries.get("META-INF/container.xml")
        if container is None:
            raise ValueError("不是有效的 EPUB：缺少 META-INF/container.xml")
        import xml.etree.ElementTree as ET
        try:
            root = ET.fromstring(container)
        except ET.ParseError as exc:
            raise ValueError("container.xml 解析失败：%s" % exc)
        rootfile = root.find(".//{%s}rootfile" % NS_CONTAINER)
        if rootfile is None or not rootfile.get("full-path"):
            raise ValueError("container.xml 中没有 rootfile")
        self.opf_path = rootfile.get("full-path").replace("\\", "/")
        self.opf_dir = posixpath.dirname(self.opf_path)
        if self.opf_path not in self.entries:
            raise ValueError("找不到 OPF 文件：%s" % self.opf_path)
        try:
            self.opf_root = ET.fromstring(self.entries[self.opf_path])
        except ET.ParseError as exc:
            raise ValueError("OPF 解析失败：%s" % exc)
        self._load_chapters()

    def _opf(self, tag):
        return "{%s}%s" % (NS_OPF, tag)

    def _dc(self, tag):
        return "{%s}%s" % (NS_DC, tag)

    def _resolve(self, href: str) -> str:
        href = (href or "").split("#")[0]
        if not href:
            return ""
        return posixpath.normpath(posixpath.join(self.opf_dir, href))

    def _rel(self, from_dir: str, target: str) -> str:
        return posixpath.relpath(target, from_dir or ".")

    # ---- metadata ----
    def metadata(self) -> dict:
        md = self.opf_root.find(self._opf("metadata"))
        out = {"title": "", "creator": "", "language": "", "publisher": "",
               "description": "", "identifier": "", "date": ""}
        if md is None:
            return out
        for key in ("title", "creator", "language", "publisher", "description", "identifier", "date"):
            el = md.find(self._dc(key))
            if el is not None and el.text:
                out[key] = el.text.strip()
        return out

    def set_metadata(self, values: dict):
        import xml.etree.ElementTree as ET
        md = self.opf_root.find(self._opf("metadata"))
        if md is None:
            md = ET.Element(self._opf("metadata"))
            self.opf_root.insert(0, md)
        for key in ("title", "creator", "language", "publisher", "description", "identifier"):
            if key not in values:
                continue
            val = (values.get(key) or "").strip()
            el = md.find(self._dc(key))
            if el is None:
                if not val:
                    continue
                el = ET.SubElement(md, self._dc(key))
                # 让 dc:* 排到 meta 之前，视觉上更规范
                meta_first = None
                for child in list(md):
                    if child.tag == self._opf("meta"):
                        meta_first = child
                        break
                if meta_first is not None:
                    md.remove(el)
                    md.insert(list(md).index(meta_first), el)
            el.text = val
            if key == "identifier" and not val:
                pass
        # 更新 meta name="cover" 等不受影响；dcterms:modified 刷新
        for meta in md.findall(self._opf("meta")):
            if meta.get("property") == "dcterms:modified":
                meta.text = now_iso()

    # ---- manifest / spine ----
    def _manifest(self):
        return self.opf_root.find(self._opf("manifest"))

    def _spine(self):
        return self.opf_root.find(self._opf("spine"))

    def _item_by_id(self, iid):
        m = self._manifest()
        if m is None:
            return None
        for it in m.findall(self._opf("item")):
            if it.get("id") == iid:
                return it
        return None

    def _items(self):
        m = self._manifest()
        return m.findall(self._opf("item")) if m is not None else []

    def _guess_title(self, entry_path: str) -> str:
        data = self.entries.get(entry_path)
        if not data:
            return posixpath.basename(entry_path)
        s = data.decode("utf-8", "replace")
        m = re.search(r"(?is)<h[1-6][^>]*>(.*?)</h[1-6]>", s)
        if m:
            t = strip_tags(m.group(1)).strip()
            if t:
                return t[:80]
        m = re.search(r"(?is)<title[^>]*>(.*?)</title>", s)
        if m:
            t = strip_tags(m.group(1)).strip()
            if t:
                return t[:80]
        return posixpath.basename(entry_path)

    def _toc_map(self) -> dict:
        """{entry_path: title} 来自 nav.xhtml / toc.ncx"""
        import xml.etree.ElementTree as ET
        result = {}
        # nav
        nav_item = None
        for it in self._items():
            if "nav" in (it.get("properties") or "").split():
                nav_item = it
                break
        if nav_item is not None:
            p = self._resolve(nav_item.get("href"))
            self.nav_path = p
            data = self.entries.get(p)
            if data:
                try:
                    root = ET.fromstring(data)
                    for a in root.iter("{%s}a" % NS_XHTML):
                        href = a.get("href") or ""
                        title = "".join(a.itertext()).strip()
                        if href and title:
                            result.setdefault(self._resolve(href), title[:80])
                except ET.ParseError:
                    pass
        # ncx
        ncx_item = None
        spine = self._spine()
        toc_id = spine.get("toc") if spine is not None else None
        if toc_id:
            ncx_item = self._item_by_id(toc_id)
        if ncx_item is None:
            for it in self._items():
                if it.get("media-type") == "application/x-dtbncx+xml":
                    ncx_item = it
                    break
        if ncx_item is not None:
            p = self._resolve(ncx_item.get("href"))
            self.ncx_path = p
            data = self.entries.get(p)
            if data:
                try:
                    root = ET.fromstring(data)
                    for np_ in root.iter("{%s}navPoint" % NS_NCX):
                        label = np_.find("{%s}navLabel/{%s}text" % (NS_NCX, NS_NCX))
                        content = np_.find("{%s}content" % NS_NCX)
                        if content is None:
                            continue
                        title = (label.text or "").strip() if label is not None else ""
                        href = content.get("src") or ""
                        if href and title:
                            result.setdefault(self._resolve(href), title[:80])
                except ET.ParseError:
                    pass
        return result

    def _is_front_matter(self, item, path) -> bool:
        """封面页 / 扉页 不算正文章节（但保留在 spine 中，不受目录重建影响）。"""
        if self.cover_page_path and path == self.cover_page_path:
            return True
        iid = (item.get("id") or "").lower()
        base = posixpath.splitext(posixpath.basename(path))[0].lower()
        return any(kw in iid or kw in base
                   for kw in ("titlepage", "title-page", "title_page", "扉页"))

    def _load_chapters(self):
        spine = self._spine()
        toc = self._toc_map()
        # 封面页（编辑列表里不显示）
        self.cover_page_path = None
        guide = self.opf_root.find(self._opf("guide"))
        if guide is not None:
            for ref in guide.findall(self._opf("reference")):
                if (ref.get("type") or "").lower() == "cover":
                    self.cover_page_path = self._resolve(ref.get("href"))
        self.chapters = []
        if spine is None:
            return
        for ir in spine.findall(self._opf("itemref")):
            if (ir.get("linear") or "").lower() == "no":
                continue
            item = self._item_by_id(ir.get("idref"))
            if item is None:
                continue
            if item.get("media-type") not in (None, "application/xhtml+xml", "text/html"):
                continue
            path = self._resolve(item.get("href"))
            if not path or path not in self.entries:
                continue
            if self._is_front_matter(item, path):
                continue
            self.chapters.append({
                "id": item.get("id"),
                "href": item.get("href"),
                "path": path,
                "title": toc.get(path) or self._guess_title(path),
            })

    # ---- 封面 ----
    def cover_bytes(self):
        """返回 (bytes, ext) 或 None"""
        item = None
        for it in self._items():
            if "cover-image" in (it.get("properties") or "").split():
                item = it
                break
        if item is None:
            md = self.opf_root.find(self._opf("metadata"))
            if md is not None:
                for meta in md.findall(self._opf("meta")):
                    if (meta.get("name") or "").lower() == "cover":
                        item = self._item_by_id(meta.get("content"))
                        if item is not None:
                            break
        if item is None:
            for it in self._items():
                href = (it.get("href") or "").lower()
                if (it.get("media-type") or "").startswith("image/") and "cover" in href:
                    item = it
                    break
        if item is None:
            return None
        path = self._resolve(item.get("href"))
        data = self.entries.get(path)
        if not data:
            return None
        ext = posixpath.splitext(path)[1].lstrip(".").lower() or "jpg"
        return data, ext

    def set_cover(self, data: bytes, ext: str, media_type: str, lang: str = "zh-CN"):
        import xml.etree.ElementTree as ET
        manifest = self._manifest()
        if manifest is None:
            manifest = ET.SubElement(self.opf_root, self._opf("manifest"))
        old = self.cover_bytes()
        old_item = None
        old_path = None
        for it in self._items():
            if "cover-image" in (it.get("properties") or "").split():
                old_item = it
                break
        if old_item is None:
            md = self.opf_root.find(self._opf("metadata"))
            if md is not None:
                for meta in md.findall(self._opf("meta")):
                    if (meta.get("name") or "").lower() == "cover":
                        old_item = self._item_by_id(meta.get("content"))
                        if old_item is not None:
                            break
        if old_item is not None:
            old_path = self._resolve(old_item.get("href"))
            manifest.remove(old_item)
            if old_path and old_path in self.entries:
                del self.entries[old_path]
                if old_path in self.order:
                    self.order.remove(old_path)

        href = "images/cover.%s" % ext
        entry_path = posixpath.normpath(posixpath.join(self.opf_dir, href))
        n = 1
        while entry_path in self.entries:
            href = "images/cover_%d.%s" % (n, ext)
            entry_path = posixpath.normpath(posixpath.join(self.opf_dir, href))
            n += 1
        item = ET.SubElement(manifest, self._opf("item"))
        item.set("id", "cover-image")
        item.set("href", href)
        item.set("media-type", media_type)
        item.set("properties", "cover-image")
        self.entries[entry_path] = data
        if entry_path not in self.order:
            self.order.append(entry_path)

        # meta name=cover
        md = self.opf_root.find(self._opf("metadata"))
        if md is None:
            md = ET.Element(self._opf("metadata"))
            self.opf_root.insert(0, md)
        found = False
        for meta in md.findall(self._opf("meta")):
            if (meta.get("name") or "").lower() == "cover":
                meta.set("content", "cover-image")
                found = True
        if not found:
            meta = ET.SubElement(md, self._opf("meta"))
            meta.set("name", "cover")
            meta.set("content", "cover-image")

        # 封面页
        self._ensure_cover_page(entry_path, lang)
        self._toc_dirty = True

    def _cover_page_item(self):
        if self.cover_page_path and self.cover_page_path in self.entries:
            for it in self._items():
                if self._resolve(it.get("href")) == self.cover_page_path:
                    return it, self.cover_page_path
        for it in self._items():
            if (it.get("id") or "").lower() in ("cover", "cover-page", "coverpage"):
                p = self._resolve(it.get("href"))
                if p in self.entries:
                    return it, p
        return None, None

    def _ensure_cover_page(self, image_entry: str, lang: str):
        import xml.etree.ElementTree as ET
        manifest = self._manifest()
        item, path = self._cover_page_item()
        if item is None:
            path = posixpath.normpath(posixpath.join(self.opf_dir, "text/cover.xhtml"))
            if path in self.entries:
                path = posixpath.normpath(posixpath.join(self.opf_dir, "cover.xhtml"))
            item = ET.SubElement(manifest, self._opf("item"))
            item.set("id", "cover-page")
            item.set("href", self._rel(self.opf_dir, path))
            item.set("media-type", "application/xhtml+xml")
        self.cover_page_path = path
        css_href = self._rel(posixpath.dirname(path), posixpath.join(self.opf_dir, "style.css"))
        if posixpath.join(self.opf_dir, "style.css") not in self.entries:
            css_href = ""
        img_src = self._rel(posixpath.dirname(path), image_entry)
        page = COVERPAGE_TMPL.format(lang=lang, css_href=css_href, img_src=img_src)
        if not css_href:
            page = page.replace('<link rel="stylesheet" type="text/css" href=""/>', "")
        self.entries[path] = page.encode("utf-8")
        if path not in self.order:
            self.order.append(path)

        # guide
        guide = self.opf_root.find(self._opf("guide"))
        if guide is None:
            guide = ET.SubElement(self.opf_root, self._opf("guide"))
        href = self._rel(self.opf_dir, path)
        if not any((r.get("type") or "").lower() == "cover" for r in guide.findall(self._opf("reference"))):
            ref = ET.SubElement(guide, self._opf("reference"))
            ref.set("type", "cover")
            ref.set("title", "封面")
            ref.set("href", href)
        # spine 第一位
        spine = self._spine()
        if spine is None:
            spine = ET.SubElement(self.opf_root, self._opf("spine"))
        refs = spine.findall(self._opf("itemref"))
        already = any(r.get("idref") == item.get("id") for r in refs)
        if already:
            for r in refs:
                if r.get("idref") == item.get("id"):
                    spine.remove(r)
                    break
        ir = ET.Element(self._opf("itemref"))
        ir.set("idref", item.get("id"))
        ir.set("linear", "yes")
        spine.insert(0, ir)

    def remove_cover(self):
        manifest = self._manifest()
        for it in list(self._items()):
            if "cover-image" in (it.get("properties") or "").split():
                p = self._resolve(it.get("href"))
                manifest.remove(it)
                if p in self.entries:
                    del self.entries[p]
                    if p in self.order:
                        self.order.remove(p)
        md = self.opf_root.find(self._opf("metadata"))
        if md is not None:
            for meta in list(md.findall(self._opf("meta"))):
                if (meta.get("name") or "").lower() == "cover":
                    md.remove(meta)
        item, path = self._cover_page_item()
        if item is not None:
            spine = self._spine()
            if spine is not None:
                for r in list(spine.findall(self._opf("itemref"))):
                    if r.get("idref") == item.get("id"):
                        spine.remove(r)
            guide = self.opf_root.find(self._opf("guide"))
            if guide is not None:
                for r in list(guide.findall(self._opf("reference"))):
                    if (r.get("type") or "").lower() == "cover":
                        guide.remove(r)
            if manifest is not None:
                manifest.remove(item)
            if path in self.entries:
                del self.entries[path]
                if path in self.order:
                    self.order.remove(path)
        self.cover_page_path = None
        self._toc_dirty = True

    # ---- 章节编辑 ----
    def chapter_source(self, index: int) -> str:
        ch = self.chapters[index]
        return self.entries.get(ch["path"], b"").decode("utf-8", "replace")

    def set_chapter_source(self, index: int, source: str):
        ch = self.chapters[index]
        self.entries[ch["path"]] = source.encode("utf-8")

    def rename_chapter(self, index: int, new_title: str):
        new_title = new_title.strip()
        if not new_title:
            return
        ch = self.chapters[index]
        ch["title"] = new_title
        data = self.entries.get(ch["path"])
        if data:
            s = data.decode("utf-8", "replace")
            s2 = re.sub(r"(?is)(<h[1-6][^>]*>)(.*?)(</h[1-6]>)",
                        lambda m: m.group(1) + xesc(new_title) + m.group(3), s, count=1)
            s2 = re.sub(r"(?is)(<title[^>]*>)(.*?)(</title>)",
                        lambda m: m.group(1) + xesc(new_title) + m.group(3), s2, count=1)
            self.entries[ch["path"]] = s2.encode("utf-8")
        self._toc_dirty = True

    def delete_chapter(self, index: int):
        ch = self.chapters[index]
        manifest = self._manifest()
        item = self._item_by_id(ch["id"])
        if item is not None and manifest is not None:
            manifest.remove(item)
        spine = self._spine()
        if spine is not None:
            for r in list(spine.findall(self._opf("itemref"))):
                if r.get("idref") == ch["id"]:
                    spine.remove(r)
        p = ch["path"]
        if p in self.entries:
            del self.entries[p]
        if p in self.order:
            self.order.remove(p)
        del self.chapters[index]
        self._toc_dirty = True

    # ---- 正文文本 / 新增章节 ----
    def chapter_text(self, index: int) -> str:
        """返回本章可直接编辑的正文纯文本（不含重复的章节标题行）。"""
        ch = self.chapters[index]
        src = self.entries.get(ch["path"], b"").decode("utf-8", "replace")
        return xhtml_body_text(src, ch["title"])

    def set_chapter_text(self, index: int, text: str) -> bool:
        """用纯文本替换本章正文。

        只替换 <body> 内部，保留原文件的 <head>、样式引用等，避免破坏第三方书的排版；
        正文会重建为「标题 + 段落」结构，行内格式（加粗/斜体/链接）不再保留。
        """
        ch = self.chapters[index]
        raw = self.entries.get(ch["path"])
        if raw is None:
            return False
        s = raw.decode("utf-8", "replace")
        body = text_to_html(text) or '<p class="noindent">（本章暂无内容）</p>'
        section = ('<section epub:type="chapter">\n'
                   '<h1 class="ctitle">%s</h1>\n%s\n</section>' % (xesc(ch["title"]), body))
        new_s, n = re.subn(r"(?is)(<body\b[^>]*>)(.*?)(</body\s*>)",
                           lambda m: m.group(1) + "\n" + section + "\n" + m.group(3), s, count=1)
        if n == 0:
            new_s = self._render_chapter(ch["path"], ch["title"], text)
        else:
            new_s = re.sub(r"(?is)(<title[^>]*>)(.*?)(</title>)",
                           lambda m: m.group(1) + xesc(ch["title"]) + m.group(3), new_s, count=1)
        self.entries[ch["path"]] = new_s.encode("utf-8")
        return True

    def _unique_id(self, prefix: str = "item") -> str:
        used = set(it.get("id") for it in self._items())
        n = 1
        while ("%s%d" % (prefix, n)) in used:
            n += 1
        return "%s%d" % (prefix, n)

    def _new_chapter_href(self) -> str:
        """在已有章节所在目录里找一个没被占用的章节文件名。"""
        base_dir = self.opf_dir
        if self.chapters:
            base_dir = posixpath.dirname(self.chapters[0]["path"]) or self.opf_dir
        n = 1
        while True:
            cand = posixpath.normpath(posixpath.join(base_dir, "chap_%03d.xhtml" % n))
            if cand not in self.entries:
                return cand
            n += 1

    def _chapter_css_href(self, path: str) -> str:
        css = posixpath.join(self.opf_dir, "style.css")
        if css in self.entries:
            return self._rel(posixpath.dirname(path), css)
        return ""

    def _render_chapter(self, path: str, title: str, text: str) -> str:
        """按本工具的标准模板渲染一个完整章节 XHTML。"""
        lang = self.metadata().get("language") or "zh-CN"
        body = text_to_html(text) or '<p class="noindent">（本章暂无内容）</p>'
        css_href = self._chapter_css_href(path)
        src = XHTML_TMPL.format(lang=lang, title=xesc(title),
                                css_href=xattr(css_href), body=body)
        if not css_href:
            src = src.replace('<link rel="stylesheet" type="text/css" href=""/>', "")
        return src

    def add_chapter(self, index, title: str, text: str = "") -> int:
        """插入新章节并返回其下标。

        index 为 None / 越界时追加到全书末尾；否则插到该位置（原该位置的章节后移）。
        目录（nav.xhtml / toc.ncx）在保存时统一重建。
        """
        import xml.etree.ElementTree as ET
        title = (title or "").strip() or "新章节"
        if index is None or index < 0 or index > len(self.chapters):
            index = len(self.chapters)
        manifest = self._manifest()
        if manifest is None:
            raise ValueError("EPUB 缺少 manifest，无法新增章节")
        spine = self._spine()

        path = self._new_chapter_href()
        href = self._rel(self.opf_dir, path)
        iid = self._unique_id("newchap")
        item = ET.SubElement(manifest, self._opf("item"))
        item.set("id", iid)
        item.set("href", href)
        item.set("media-type", "application/xhtml+xml")
        self.entries[path] = self._render_chapter(path, title, text).encode("utf-8")

        # 写入顺序：紧跟在前一章之后，保持 zip 内条目与阅读顺序一致
        pos = len(self.order)
        if index > 0:
            prev = self.chapters[index - 1]["path"]
            if prev in self.order:
                pos = self.order.index(prev) + 1
        self.order.insert(pos, path)

        # spine 位置：插到前一章之后；index=0 时插到原第一章之前
        if spine is not None:
            ref = ET.Element(self._opf("itemref"))
            ref.set("idref", iid)
            refs = list(spine.findall(self._opf("itemref")))
            anchor_id = self.chapters[index - 1]["id"] if index > 0 else None
            before_id = self.chapters[index]["id"] if index < len(self.chapters) else None
            placed = False
            if anchor_id is not None:
                for i, r in enumerate(refs):
                    if r.get("idref") == anchor_id:
                        spine.insert(i + 1, ref)
                        placed = True
                        break
            elif before_id is not None:
                for i, r in enumerate(refs):
                    if r.get("idref") == before_id:
                        spine.insert(i, ref)
                        placed = True
                        break
            if not placed:
                spine.append(ref)

        self.chapters.insert(index, {"id": iid, "href": href, "path": path, "title": title})
        self._toc_dirty = True
        return index

    # ---- 保存 ----
    def _serialize_opf(self) -> bytes:
        import xml.etree.ElementTree as ET
        ET.register_namespace("opf", NS_OPF)
        ET.register_namespace("dc", NS_DC)
        ET.register_namespace("ncx", NS_NCX)
        ET.register_namespace("xhtml", NS_XHTML)
        ET.register_namespace("epub", NS_EPUB)
        raw = ET.tostring(self.opf_root, encoding="utf-8")
        s = _tidy_ns(raw.decode("utf-8"))
        return ('<?xml version="1.0" encoding="utf-8"?>\n' + s).encode("utf-8")

    def _rebuild_toc(self):
        import xml.etree.ElementTree as ET
        md = self.metadata()
        lang = md.get("language") or "zh-CN"
        # nav
        nav_path = self.nav_path
        nav_item = None
        for it in self._items():
            if "nav" in (it.get("properties") or "").split():
                nav_item = it
                break
        manifest = self._manifest()
        if nav_item is None:
            nav_href = "nav.xhtml"
            nav_path = posixpath.normpath(posixpath.join(self.opf_dir, nav_href))
            nav_item = ET.SubElement(manifest, self._opf("item"))
            nav_item.set("id", "nav")
            nav_item.set("href", nav_href)
            nav_item.set("media-type", "application/xhtml+xml")
            nav_item.set("properties", "nav")
        else:
            nav_path = self._resolve(nav_item.get("href"))
        nav_dir = posixpath.dirname(nav_path)
        css_target = posixpath.join(self.opf_dir, "style.css")
        css_href = self._rel(nav_dir, css_target) if css_target in self.entries else ""
        items = []
        for ch in self.chapters:
            href = self._rel(nav_dir, ch["path"])
            items.append('    <li><a href="%s">%s</a></li>' % (xattr(href), xesc(ch["title"])))
        nav = NAV_TMPL.format(lang=lang, title=xesc(md.get("title") or "目录"),
                              css_href=css_href, items="\n".join(items),
                              first_href=self._rel(nav_dir, self.chapters[0]["path"]) if self.chapters else "")
        if not css_href:
            nav = nav.replace('<link rel="stylesheet" type="text/css" href=""/>', "")
        self.entries[nav_path] = nav.encode("utf-8")
        if nav_path not in self.order:
            self.order.append(nav_path)
        self.nav_path = nav_path

        # ncx
        ncx_item = None
        spine = self._spine()
        toc_id = spine.get("toc") if spine is not None else None
        if toc_id:
            ncx_item = self._item_by_id(toc_id)
        if ncx_item is None:
            for it in self._items():
                if it.get("media-type") == "application/x-dtbncx+xml":
                    ncx_item = it
                    break
        if ncx_item is None:
            ncx_href = "toc.ncx"
            ncx_path = posixpath.normpath(posixpath.join(self.opf_dir, ncx_href))
            ncx_item = ET.SubElement(manifest, self._opf("item"))
            ncx_item.set("id", "ncx")
            ncx_item.set("href", ncx_href)
            ncx_item.set("media-type", "application/x-dtbncx+xml")
            if spine is not None and not spine.get("toc"):
                spine.set("toc", "ncx")
        else:
            ncx_path = self._resolve(ncx_item.get("href"))
        ncx_dir = posixpath.dirname(ncx_path)
        points = []
        for i, ch in enumerate(self.chapters, 1):
            src = self._rel(ncx_dir, ch["path"])
            points.append(
                '  <navPoint id="np%d" playOrder="%d">\n'
                '    <navLabel><text>%s</text></navLabel>\n'
                '    <content src="%s"/>\n'
                '  </navPoint>' % (i, i, xesc(ch["title"]), xattr(src)))
        ncx = NCX_TMPL.format(lang=lang, uid=xesc(md.get("identifier") or "urn:uuid:unknown"),
                              title=xesc(md.get("title") or ""), points="\n".join(points))
        self.entries[ncx_path] = ncx.encode("utf-8")
        if ncx_path not in self.order:
            self.order.append(ncx_path)
        self.ncx_path = ncx_path

    def save(self, out_path: str = None):
        out_path = out_path or self.path
        if not self.chapters:
            raise ValueError("书籍没有任何章节，无法保存")
        if self._toc_dirty or self.nav_path is None or self.ncx_path is None:
            self._rebuild_toc()
        self.entries[self.opf_path] = self._serialize_opf()
        tmp = out_path + ".tmp"
        write_epub_zip(tmp, self.entries, self.order)
        if os.path.exists(out_path):
            os.remove(out_path)
        os.replace(tmp, out_path)
        self.path = out_path
        self._toc_dirty = False
        return out_path

    def to_text(self) -> str:
        parts = []
        for ch in self.chapters:
            data = self.entries.get(ch["path"])
            if not data:
                continue
            txt = xhtml_to_text(data.decode("utf-8", "replace"))
            parts.append("## %s\n\n%s" % (ch["title"], txt) if ch["title"] else txt)
        return "\n\n".join(parts)


def xhtml_to_text(s: str) -> str:
    s = re.sub(r"(?is)<(script|style|head)\b.*?</\1>", " ", s)
    s = re.sub(r"(?is)<br\s*/?>", "\n", s)
    s = re.sub(r"(?is)</(p|div|h[1-6]|li|tr|section|blockquote)\s*>", "\n", s)
    s = re.sub(r"(?is)<(p|div|h[1-6]|li|tr|section|blockquote)\b[^>]*>", "\n", s)
    s = re.sub(r"(?s)<[^>]+>", "", s)
    s = html.unescape(s)
    s = s.replace("\u00a0", " ").replace("\ufeff", "")
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r" *\n *", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def xhtml_body_text(source: str, title: str = "") -> str:
    """从章节 XHTML 里取出可编辑的正文纯文本（去掉与章节标题重复的那个标题行）。"""
    m = re.search(r"(?is)<body\b[^>]*>(.*?)</body\s*>", source)
    inner = m.group(1) if m else source
    t = (title or "").strip()
    if t:
        hm = re.search(r"(?is)<h[1-3][^>]*>(.*?)</h[1-3]>", inner)
        if hm is not None:
            head = strip_tags(hm.group(1)).strip()
            if head and (head == t or (len(head) >= 2 and (head in t or t in head))):
                inner = inner[:hm.start()] + inner[hm.end():]
    return xhtml_to_text(inner).strip()


def epub_to_text(path: str) -> str:
    return EpubFile(path).to_text()


# --------------------------------------------------------------------------
# 自检
# --------------------------------------------------------------------------
def run_selftest(report_path: str = None) -> int:
    import tempfile
    lines = []
    failures = []

    def log(msg):
        lines.append(msg)

    def check(cond, msg):
        log(("  [OK]   " if cond else "  [FAIL] ") + msg)
        if not cond:
            failures.append(msg)

    log("=== %s v%s 自检 ===" % (APP_NAME, VERSION))
    log("Python %s   frozen=%s" % (sys.version.split()[0], getattr(sys, "frozen", False)))

    token = uuid.uuid4().hex[:8]
    base = os.environ.get("TXT2EPUB_TMPDIR") or app_dir()
    tmpdir = base
    probe = os.path.join(base, "%s_probe" % token)
    try:
        with open(probe, "w", encoding="utf-8") as f:
            f.write("x")
        os.remove(probe)
    except OSError:
        base = None
        tmpdir = tempfile.mkdtemp(prefix="txt2epub_selftest_")

    def tp(name):
        return os.path.join(tmpdir, "%s_%s" % (token, name))

    log("临时目录: %s" % tmpdir)

    # 1. 编码识别
    log("\n[1] 编码识别")
    zh_simp = ("第一章 初入江湖\n\n他站在山巅，看着远处的云海翻涌，心里忽然安静下来。"
               "风从耳边掠过，带着松针与泥土的味道。这一路走来，他已经记不清是第几次回望。\n") * 25
    zh_trad = ("第一章 初入江湖\n\n他站在山巔，看著遠處的雲海翻湧，心裡忽然安靜下來。"
               "風從耳邊掠過，帶著松針與泥土的味道。這一路走來，他已經記不清是第幾次回望。\n") * 25
    en_text = ("Chapter One\n\nHe stood on the ridge and watched the clouds roll below him. "
               "The wind carried the smell of pine needles and wet earth.\n") * 25
    cases = [("utf-8", zh_simp), ("gb18030", zh_simp), ("big5", zh_trad),
             ("utf-16", zh_trad), ("utf-8", en_text)]
    for enc, text in cases:
        raw = text.encode(enc)
        got, name = decode_bytes(raw)
        ok = got.strip() == text.strip()
        check(ok, "%-8s -> %s%s" % (enc, name, "" if ok else "  （解码结果不一致）"))

    # 2. 分章
    log("\n[2] 分章")
    check(len(AUTO_CHAPTER_RES) == len(CHAPTER_REGEXES),
          "预置分章正则全部可用（%d/%d）" % (len(AUTO_CHAPTER_RES), len(CHAPTER_REGEXES)))
    for word in ("楔子", "尾声", "番外 山中的黄狗", "第一章 初入山门", "Chapter 5 Extra",
                 "第1章", "第十二回 大战", "序章", "后记"):
        check(_is_heading(word), "识别为章节标题：%s" % word)
    for word in ("他站在山门前，抬头看着那块被风雨磨得发亮的匾额。", "这是一句普通正文。",
                 "师父说，急不得。"):
        check(not _is_heading(word), "不误判为标题：%s" % word)
    txt = "第一章 起点\n内容甲\n内容乙\n\n第二章 出发\n内容丙\n\nChapter 3 The end\n内容丁\n"
    ch = split_chapters(txt, "auto")
    check(len(ch) == 3, "自动分章得到 %d 章（期望 3）" % len(ch))
    check(ch[0][0].startswith("第一章"), "首章标题：%s" % (ch[0][0] if ch else "无"))
    ch2 = split_chapters(txt, "regex", pattern=r"^第[一二三四五六七八九十]+章")
    check(len(ch2) == 2, "自定义正则分章得到 %d 章（期望 2）" % len(ch2))
    ch3 = split_chapters("a\nb\nc\n", "lines", n=1)
    check(len(ch3) == 3, "按行数分章得到 %d 章（期望 3）" % len(ch3))

    # 3. 生成 EPUB
    log("\n[3] 生成 EPUB")
    body = "\n".join("这是第 %d 段正文，用来测试段落与转义字符 <>&\"'。" % i for i in range(1, 60))
    chapters = [("第一章 测试", body), ("第二章 测试", body), ("第三章 测试", body)]
    cover_path = tp("cover.png")
    try:
        from PIL import Image
        Image.new("RGB", (900, 1400), (40, 90, 160)).save(cover_path)
        log("  已生成测试封面: %s" % cover_path)
    except Exception as exc:
        cover_path = None
        log("  [警告] 无法生成封面: %s" % exc)

    out = tp("测试书.epub")
    build_epub(out, "测试书名", chapters, author="测试作者", language="zh-CN",
               publisher="测试出版社", description="描述 <测试>", cover_path=cover_path)
    check(os.path.exists(out) and os.path.getsize(out) > 1000,
          "EPUB 已生成，大小 %d 字节" % (os.path.getsize(out) if os.path.exists(out) else 0))

    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        infos = z.infolist()
        check(infos[0].filename == "mimetype", "第一个 zip 条目是 mimetype")
        check(infos[0].compress_type == zipfile.ZIP_STORED, "mimetype 未压缩（STORED）")
        check(z.read("mimetype") == b"application/epub+zip", "mimetype 内容正确")
        check(z.testzip() is None, "zip CRC 校验通过")
        check("META-INF/container.xml" in names, "存在 META-INF/container.xml")
        check("OEBPS/content.opf" in names, "存在 OEBPS/content.opf")
        check("OEBPS/nav.xhtml" in names, "存在 OEBPS/nav.xhtml")
        check("OEBPS/toc.ncx" in names, "存在 OEBPS/toc.ncx")
        check(any(n.startswith("OEBPS/images/cover") for n in names), "封面图片已写入")
        import xml.etree.ElementTree as ET
        opf = ET.fromstring(z.read("OEBPS/content.opf"))
        manifest = opf.find("{%s}manifest" % NS_OPF)
        spine = opf.find("{%s}spine" % NS_OPF)
        items = {it.get("id"): it for it in manifest.findall("{%s}item" % NS_OPF)}
        check(len(items) >= 8, "manifest 条目数 %d" % len(items))
        missing = []
        for it in items.values():
            href = it.get("href")
            if not href:
                continue
            p = posixpath.normpath(posixpath.join("OEBPS", href))
            if p not in names:
                missing.append(p)
        check(not missing, "manifest 引用的文件都存在（缺失 %s）" % (missing or "无"))
        spine_ids = [r.get("idref") for r in spine.findall("{%s}itemref" % NS_OPF)]
        check(all(sid in items for sid in spine_ids), "spine 引用的 id 都存在")
        check("cover-image" in items and "cover-image" in (items["cover-image"].get("properties") or ""),
              "封面 item 带 properties=cover-image")
        check(opf.find("{%s}metadata/{%s}title" % (NS_OPF, NS_DC)).text == "测试书名", "OPF 标题正确")
        check(opf.find("{%s}metadata/{%s}creator" % (NS_OPF, NS_DC)).text == "测试作者", "OPF 作者正确")
        # XHTML 可解析
        bad = []
        for n in names:
            if n.endswith(".xhtml"):
                try:
                    ET.fromstring(z.read(n))
                except ET.ParseError as exc:
                    bad.append("%s: %s" % (n, exc))
        check(not bad, "所有 XHTML 均可解析（%s）" % (bad or "无"))

    # 4. 编辑 EPUB
    log("\n[4] 编辑 EPUB")
    book = EpubFile(out)
    md = book.metadata()
    check(md["title"] == "测试书名", "读取标题：%s" % md["title"])
    check(len(book.chapters) == 3, "读取到 %d 个章节" % len(book.chapters))
    check([c["title"] for c in book.chapters][:1] == ["第一章 测试"], "章节标题来自目录")
    book.set_metadata({"title": "新书名", "author": "", "creator": "新作者", "publisher": "新出版社"})
    book.rename_chapter(1, "第二章 改名后")
    cov = tp("cover2.jpg")
    try:
        from PIL import Image
        Image.new("RGB", (1200, 1800), (180, 40, 40)).save(cov)
    except Exception:
        cov = None
    if cov:
        data, ext, mtype = prepare_cover(cov)
        book.set_cover(data, ext, mtype)
    book.save()
    book2 = EpubFile(out)
    md2 = book2.metadata()
    check(md2["title"] == "新书名", "元数据已更新：%s" % md2["title"])
    check(md2["creator"] == "新作者", "作者已更新：%s" % md2["creator"])
    check(any(c["title"] == "第二章 改名后" for c in book2.chapters), "章节改名生效")
    check(book2.cover_bytes() is not None, "封面存在（重载后）")
    with zipfile.ZipFile(out) as z:
        infos = z.infolist()
        check(infos[0].filename == "mimetype" and infos[0].compress_type == zipfile.ZIP_STORED,
              "保存后 mimetype 仍在首位且未压缩")
        check(z.testzip() is None, "保存后 zip 完整")
        opf = ET.fromstring(z.read("OEBPS/content.opf"))
        root_tag = opf.tag
        check(root_tag == "{%s}package" % NS_OPF, "OPF 根节点命名空间正确")
        opf_text = z.read("OEBPS/content.opf").decode("utf-8")
        check('xmlns="http://www.idpf.org/2007/opf"' in opf_text, "OPF 使用默认命名空间（兼容性好）")
        check("ns0:" not in opf_text, "OPF 没有 ns0 前缀残留")
        xhtml_bad = []
        for n in z.namelist():
            if n.endswith(".xhtml"):
                try:
                    ET.fromstring(z.read(n))
                except ET.ParseError as exc:
                    xhtml_bad.append("%s: %s" % (n, exc))
        check(not xhtml_bad, "保存后 XHTML 均可解析（%s）" % (xhtml_bad or "无"))
        navtxt = z.read("OEBPS/nav.xhtml").decode("utf-8")
        check("第二章 改名后" in navtxt, "nav.xhtml 已同步改名")

    # 5. 删除章节 / 导出文本
    log("\n[5] 删除章节与导出")
    book2.delete_chapter(0)
    book2.save()
    book3 = EpubFile(out)
    check(len(book3.chapters) == 2, "删除后剩余 %d 章" % len(book3.chapters))
    txt_out = book3.to_text()
    check("第二章 改名后" in txt_out, "导出文本包含章节标题")
    check(len(txt_out) > 500, "导出文本长度 %d" % len(txt_out))

    # 6. 无封面 / 无作者 的最小情形
    log("\n[6] 最小参数")
    minimal = tp("minimal.epub")
    build_epub(minimal, "只有正文", [("第一章", "内容" * 200)], author="")
    b = EpubFile(minimal)
    check(len(b.chapters) == 1 and b.cover_bytes() is None, "最小 EPUB 可正常读取")
    b.save(tp("minimal2.epub"))
    check(os.path.exists(tp("minimal2.epub")), "另存为成功")

    # 7. 第三方 EPUB 兼容性（OPF 在子目录、带 opf:role 属性、嵌套目录、EPUB2）
    log("\n[7] 第三方 EPUB 兼容性（模拟 Calibre 导出的 EPUB2）")
    chap = ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>%s</title></head>'
            '<body><h1>%s</h1><p>正文内容。</p></body></html>')
    foreign = tp("foreign.epub")
    foreign_entries = {
        "mimetype": MIMETYPE.encode("ascii"),
        "META-INF/container.xml": CONTAINER_XML.format(opf="EPUB/content.opf").encode("utf-8"),
        "EPUB/content.opf": ('<?xml version="1.0" encoding="utf-8"?>\n'
                             '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" '
                             'unique-identifier="uuid_id">\n'
                             '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" '
                             'xmlns:opf="http://www.idpf.org/2007/opf">\n'
                             '    <dc:title>外来书籍</dc:title>\n'
                             '    <dc:creator opf:file-as="Someone" opf:role="aut">某作者</dc:creator>\n'
                             '    <dc:language>zh</dc:language>\n'
                             '    <dc:identifier id="uuid_id" opf:scheme="uuid">12345678-1234-1234-1234-123456789012</dc:identifier>\n'
                             '  </metadata>\n'
                             '  <manifest>\n'
                             '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n'
                             '    <item id="c1" href="Text/chap1.xhtml" media-type="application/xhtml+xml"/>\n'
                             '    <item id="c2" href="Text/chap2.xhtml" media-type="application/xhtml+xml"/>\n'
                             '    <item id="p1" href="Text/part1.xhtml" media-type="application/xhtml+xml"/>\n'
                             '  </manifest>\n'
                             '  <spine toc="ncx">\n'
                             '    <itemref idref="c1"/>\n'
                             '    <itemref idref="c2"/>\n'
                             '  </spine>\n'
                             '</package>\n').encode("utf-8"),
        "EPUB/toc.ncx": ('<?xml version="1.0" encoding="utf-8"?>\n'
                         '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n'
                         '  <head><meta name="dtb:uid" content="x"/></head>\n'
                         '  <docTitle><text>外来书籍</text></docTitle>\n'
                         '  <navMap>\n'
                         '    <navPoint id="n1" playOrder="1"><navLabel><text>卷一</text></navLabel>'
                         '<content src="Text/part1.xhtml"/>\n'
                         '      <navPoint id="n1a" playOrder="2"><navLabel><text>第一章</text></navLabel>'
                         '<content src="Text/chap1.xhtml"/></navPoint>\n'
                         '    </navPoint>\n'
                         '    <navPoint id="n2" playOrder="3"><navLabel><text>第二章</text></navLabel>'
                         '<content src="Text/chap2.xhtml"/></navPoint>\n'
                         '  </navMap>\n'
                         '</ncx>\n').encode("utf-8"),
        "EPUB/Text/chap1.xhtml": (chap % ("第一章", "第一章")).encode("utf-8"),
        "EPUB/Text/chap2.xhtml": (chap % ("第二章", "第二章")).encode("utf-8"),
        "EPUB/Text/part1.xhtml": (chap % ("卷一", "卷一")).encode("utf-8"),
    }
    write_epub_zip(foreign, foreign_entries)
    fb = EpubFile(foreign)
    check(fb.metadata()["title"] == "外来书籍", "读取第三方 EPUB 标题")
    check(len(fb.chapters) == 2, "读取第三方 EPUB 章节数 = %d" % len(fb.chapters))
    check(fb.chapters and fb.chapters[0]["title"] == "第一章",
          "嵌套目录标题解析：%s" % (fb.chapters[0]["title"] if fb.chapters else "无"))
    if cover_path and os.path.exists(cover_path):
        cdata, cext, cmtype = prepare_cover(cover_path)
        fb.set_cover(cdata, cext, cmtype)
    fb.set_metadata({"title": "外来书籍改名", "creator": "新作者"})
    fb.save()
    check(os.path.normpath(fb.cover_page_path or "") == os.path.normpath("EPUB/text/cover.xhtml"),
          "封面页写入子目录：%s" % fb.cover_page_path)
    fb2 = EpubFile(foreign)
    check(fb2.metadata()["title"] == "外来书籍改名", "第三方 EPUB 元数据改名成功")
    check(fb2.cover_bytes() is not None, "第三方 EPUB 成功添加封面")
    opf_text = fb2.entries[fb2.opf_path].decode("utf-8")
    check('opf:role="aut"' in opf_text or "opf:role" in opf_text, "保留了 opf:role 命名空间属性")
    check('xmlns="http://www.idpf.org/2007/opf"' in opf_text, "OPF 仍是默认命名空间")
    check("ns0:" not in opf_text, "第三方 OPF 无 ns0 残留")
    with zipfile.ZipFile(foreign) as z:
        names = set(z.namelist())
        infos = z.infolist()
        check(infos[0].filename == "mimetype" and infos[0].compress_type == zipfile.ZIP_STORED,
              "第三方 EPUB 保存后 mimetype 仍在首位")
        root = ET.fromstring(z.read("EPUB/content.opf"))
        miss = []
        for it in root.find("{%s}manifest" % NS_OPF).findall("{%s}item" % NS_OPF):
            p = posixpath.normpath(posixpath.join("EPUB", it.get("href")))
            if p not in names:
                miss.append(p)
        check(not miss, "第三方 EPUB 保存后 manifest 引用完整（缺失 %s）" % (miss or "无"))
        check(z.testzip() is None, "第三方 EPUB 保存后 zip 完整")
        bad = []
        for n in names:
            if n.endswith(".xhtml"):
                try:
                    ET.fromstring(z.read(n))
                except ET.ParseError as exc:
                    bad.append("%s: %s" % (n, exc))
        check(not bad, "第三方 EPUB 保存后 XHTML 均可解析（%s）" % (bad or "无"))

    # 8. 新增章节 / 正文文本编辑
    log("\n[8] 新增章节与正文文本编辑")
    eb = EpubFile(out)
    n_before = len(eb.chapters)
    idx_new = eb.add_chapter(1, "插入章 测试", "第一段。\n第二段。")
    check(len(eb.chapters) == n_before + 1, "新增后章节数 %d（原 %d）" % (len(eb.chapters), n_before))
    check(idx_new == 1 and eb.chapters[1]["title"] == "插入章 测试",
          "插入到指定位置：第 %d 章 = %s" % (idx_new + 1, eb.chapters[1]["title"]))
    check(eb.chapters[2]["title"] == "第三章 测试", "原第 2 章后移为：%s" % eb.chapters[2]["title"])
    got = re.sub(r"\s", "", eb.chapter_text(1))
    check(got == "第一段。第二段。", "新章正文读回不含标题行：%r" % got)
    eb.set_chapter_text(1, "改过的正文第一段。\n改过的第二段。")
    t_after = re.sub(r"\s", "", eb.chapter_text(1))
    check(t_after == "改过的正文第一段。改过的第二段。", "正文文本编辑生效：%r" % t_after)
    eb.add_chapter(None, "末尾新章", "末尾内容。")
    check(eb.chapters[-1]["title"] == "末尾新章", "index=None 时追加到末尾")
    eb.save()
    eb2 = EpubFile(out)
    titles = [c["title"] for c in eb2.chapters]
    check(titles == ["第二章 改名后", "插入章 测试", "第三章 测试", "末尾新章"],
          "保存后章节顺序正确：%s" % titles)
    check("改过的正文第一段。" in eb2.to_text(), "保存后正文改动可读回")
    with zipfile.ZipFile(out) as z:
        names = set(z.namelist())
        infos = z.infolist()
        check(infos[0].filename == "mimetype" and infos[0].compress_type == zipfile.ZIP_STORED,
              "新增章节后 mimetype 仍在首位且未压缩")
        root = ET.fromstring(z.read("OEBPS/content.opf"))
        items = root.find("{%s}manifest" % NS_OPF).findall("{%s}item" % NS_OPF)
        ids = [it.get("id") for it in items]
        check(len(ids) == len(set(ids)), "manifest 的 id 无重复")
        miss = []
        for it in items:
            p = posixpath.normpath(posixpath.join("OEBPS", it.get("href")))
            if p not in names:
                miss.append(p)
        check(not miss, "新增章节后 manifest 引用完整（缺失 %s）" % (miss or "无"))
        spine_ids = [r.get("idref") for r in root.find("{%s}spine" % NS_OPF).findall("{%s}itemref" % NS_OPF)]
        check(all(s in ids for s in spine_ids), "新增章节后 spine 引用完整")
        navtxt = z.read("OEBPS/nav.xhtml").decode("utf-8")
        check(all(t in navtxt for t in titles), "nav 目录已包含新增章节")
        ncx = z.read("OEBPS/toc.ncx").decode("utf-8")
        check(ncx.count("<navPoint") == len(titles),
              "ncx 条目数 = 章节数（%d/%d）" % (ncx.count("<navPoint"), len(titles)))
        bad = []
        for n in names:
            if n.endswith(".xhtml"):
                try:
                    ET.fromstring(z.read(n))
                except ET.ParseError as exc:
                    bad.append("%s: %s" % (n, exc))
        check(not bad, "新增章节后 XHTML 均可解析（%s）" % (bad or "无"))

    eb3 = EpubFile(out)
    eb3.add_chapter(0, "卷首新章", "卷首内容。")
    eb3.save()
    eb4 = EpubFile(out)
    check(eb4.chapters[0]["title"] == "卷首新章", "插入到全书最前面：%s" % eb4.chapters[0]["title"])
    check(len(eb4.chapters) == len(titles) + 1, "插入到开头后章节数 %d" % len(eb4.chapters))
    check(re.sub(r"\s", "", eb4.chapter_text(0)) == "卷首内容。", "新章正文（插到开头）可读回")

    log("\n=== 结果：%s ===" % ("全部通过" if not failures else "%d 项失败" % len(failures)))
    for f in failures:
        log("  - " + f)
    report = "\n".join(lines)
    try:
        for n in os.listdir(tmpdir):
            if n.startswith(token):
                os.remove(os.path.join(tmpdir, n))
        if base is None:
            os.rmdir(tmpdir)
    except OSError:
        pass

    if report_path:
        try:
            with open(report_path, "w", encoding="utf-8") as f:
                f.write(report + "\n")
            log("报告已写入: %s" % report_path)
        except OSError:
            pass
    try:
        print(report)
    except Exception:
        pass
    return 1 if failures else 0


# --------------------------------------------------------------------------
# 命令行
# --------------------------------------------------------------------------
def attach_console():
    if os.name != "nt":
        return
    try:
        import ctypes
        if ctypes.windll.kernel32.AttachConsole(-1):
            sys.stdout = open("CONOUT$", "w", encoding="utf-8", errors="replace", buffering=1)
            sys.stderr = sys.stdout
    except Exception:
        pass


def run_cli(args) -> int:
    try:
        return _run_cli(args)
    except Exception as exc:
        print("错误：%s" % exc)
        print("提示：路径中含有空格时请用引号包起来，例如 --out \"D:\\我的 电子书\"")
        return 2


def _run_cli(args) -> int:
    files = []
    for item in args.txt or []:
        if os.path.isdir(item):
            for n in sorted(os.listdir(item)):
                if n.lower().endswith(".txt"):
                    files.append(os.path.join(item, n))
        else:
            files.append(item)
    if not files:
        print("没有找到要转换的 TXT 文件")
        return 2
    out_dir = args.out or os.path.dirname(os.path.abspath(files[0]))
    os.makedirs(out_dir, exist_ok=True)
    mode = args.split or "auto"
    if args.merge:
        chapters = []
        for f in files:
            text, enc = read_text_file(f, args.encoding or "auto")
            base = os.path.splitext(os.path.basename(f))[0]
            print("读取 %s (%s, %d 字)" % (os.path.basename(f), enc, len(text)))
            chapters.append((base, ""))
            chapters.extend(split_chapters(text, mode, args.pattern or "", args.n or 50, base))
        title = args.title or os.path.splitext(os.path.basename(files[0]))[0]
        out = os.path.join(out_dir, safe_filename(title) + ".epub")
        build_epub(out, title, chapters, author=args.author or "",
                   language=args.lang or "zh-CN", cover_path=args.cover)
        print("已生成: %s (%d 章)" % (out, len(chapters)))
        return 0
    rc = 0
    for f in files:
        try:
            text, enc = read_text_file(f, args.encoding or "auto")
            base = os.path.splitext(os.path.basename(f))[0]
            title = args.title or base
            chapters = split_chapters(text, mode, args.pattern or "", args.n or 50, title)
            out = os.path.join(out_dir, safe_filename(title) + ".epub")
            build_epub(out, title, chapters, author=args.author or "",
                       language=args.lang or "zh-CN", cover_path=args.cover)
            print("已生成: %s  [%s, %d 章, %d 字]" % (out, enc, len(chapters), len(text)))
        except Exception as exc:
            rc = 1
            print("失败: %s -> %s" % (f, exc))
    return rc


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(prog="TXT2EPUB", add_help=True,
                                     description="TXT 转 EPUB / EPUB 编辑工具")
    parser.add_argument("--txt", action="append", help="输入 TXT 文件或目录（可多次）")
    parser.add_argument("--out", help="输出目录")
    parser.add_argument("--title", help="书名")
    parser.add_argument("--author", help="作者")
    parser.add_argument("--lang", default="zh-CN", help="语言，如 zh-CN")
    parser.add_argument("--cover", help="封面图片")
    parser.add_argument("--split", default="auto",
                        choices=["auto", "regex", "blank", "lines", "chars", "none"], help="分章方式")
    parser.add_argument("--pattern", help="自定义分章正则")
    parser.add_argument("-n", type=int, default=50, help="按行数/字数分章的参数")
    parser.add_argument("--encoding", default="auto", help="强制指定编码")
    parser.add_argument("--merge", action="store_true", help="多文件合并为一本")
    parser.add_argument("--selftest", action="store_true", help="运行内置自检")
    parser.add_argument("--report", help="自检报告输出路径")
    parser.add_argument("--version", action="version", version="%(prog)s " + VERSION)
    args, unknown = parser.parse_known_args(argv)

    if args.selftest:
        attach_console()
        report = args.report or os.path.join(app_dir(), "selftest_report.txt")
        return run_selftest(report)

    if args.txt:
        attach_console()
        return run_cli(args)

    return start_gui()


# --------------------------------------------------------------------------
# 图形界面
# --------------------------------------------------------------------------
SPLIT_MODES = [
    ("自动识别章节（第X章 / Chapter N）", "auto"),
    ("自定义正则表达式", "regex"),
    ("按空行分章", "blank"),
    ("按行数分章", "lines"),
    ("按字数分章", "chars"),
    ("整本作为一章", "none"),
]

LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru"]


def start_gui() -> int:
    import tkinter as tk
    from tkinter import ttk

    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass

    try:
        from PIL import Image, ImageTk  # noqa: F401
        has_pil = True
    except Exception:
        has_pil = False

    UI_FONT = ("Microsoft YaHei UI", 10)
    MONO_FONT = ("Consolas", 10)

    class ConvertTab(ttk.Frame):
        def __init__(self, master):
            super().__init__(master, padding=10)
            self.files = []
            self.stop_flag = False
            self.q = queue.Queue()
            self.var_title = tk.StringVar()
            self.var_author = tk.StringVar()
            self.var_lang = tk.StringVar(value="zh-CN")
            self.var_pub = tk.StringVar()
            self.var_split = tk.StringVar(value=SPLIT_MODES[0][0])
            self.var_pattern = tk.StringVar()
            self.var_n = tk.StringVar(value="50")
            self.var_cover = tk.StringVar()
            self.var_out = tk.StringVar()
            self.var_same = tk.BooleanVar(value=True)
            self.var_merge = tk.BooleanVar(value=False)
            self.var_enc = tk.StringVar(value=ENCODING_CHOICES[0][0])
            self._build()

        def _build(self):
            self.columnconfigure(0, weight=1)
            self.rowconfigure(1, weight=0)
            self.rowconfigure(4, weight=1)

            top = ttk.LabelFrame(self, text=" 待转换的 TXT 文件 ", padding=8)
            top.grid(row=0, column=0, sticky="nsew")
            top.columnconfigure(0, weight=1)
            cols = ("name", "size", "dir")
            self.tree = ttk.Treeview(top, columns=cols, show="headings", height=5, selectmode="extended")
            for c, t, w in (("name", "文件名", 260), ("size", "大小", 80), ("dir", "所在目录", 380)):
                self.tree.heading(c, text=t)
                self.tree.column(c, width=w, anchor="w")
            self.tree.grid(row=0, column=0, sticky="nsew")
            sb = ttk.Scrollbar(top, orient="vertical", command=self.tree.yview)
            sb.grid(row=0, column=1, sticky="ns")
            self.tree.configure(yscrollcommand=sb.set)
            btns = ttk.Frame(top)
            btns.grid(row=1, column=0, columnspan=2, sticky="w", pady=(6, 0))
            for text, cmd in (("添加文件…", self.add_files), ("添加文件夹…", self.add_dir),
                              ("移除选中", self.remove_sel), ("清空", self.clear_files)):
                ttk.Button(btns, text=text, command=cmd, width=12).pack(side="left", padx=(0, 6))
            self.lbl_count = ttk.Label(btns, text="共 0 个文件")
            self.lbl_count.pack(side="left", padx=10)

            opt = ttk.LabelFrame(self, text=" 转换设置 ", padding=8)
            opt.grid(row=1, column=0, sticky="ew", pady=8)
            opt.columnconfigure(1, weight=1)
            opt.columnconfigure(3, weight=1)

            def lab(r, c, text):
                ttk.Label(opt, text=text).grid(row=r, column=c, sticky="e", padx=(0, 6), pady=3)

            lab(0, 0, "书名：")
            ttk.Entry(opt, textvariable=self.var_title).grid(row=0, column=1, sticky="ew", pady=3, padx=(0, 12))
            lab(0, 2, "作者：")
            ttk.Entry(opt, textvariable=self.var_author).grid(row=0, column=3, sticky="ew", pady=3)

            lab(1, 0, "语言：")
            ttk.Combobox(opt, textvariable=self.var_lang, values=LANGS, width=10, state="normal").grid(
                row=1, column=1, sticky="w", pady=3, padx=(0, 12))
            lab(1, 2, "出版社：")
            ttk.Entry(opt, textvariable=self.var_pub).grid(row=1, column=3, sticky="ew", pady=3)

            lab(2, 0, "原文件编码：")
            ttk.Combobox(opt, textvariable=self.var_enc, values=[c[0] for c in ENCODING_CHOICES],
                         state="readonly", width=16).grid(row=2, column=1, sticky="w", pady=3, padx=(0, 12))
            lab(2, 2, "分章方式：")
            ttk.Combobox(opt, textvariable=self.var_split, values=[m[0] for m in SPLIT_MODES],
                         state="readonly", width=22).grid(row=2, column=3, sticky="ew", pady=3)

            lab(3, 0, "分章参数：")
            pf = ttk.Frame(opt)
            pf.grid(row=3, column=1, sticky="w", pady=3, padx=(0, 12))
            ttk.Entry(pf, textvariable=self.var_n, width=6).pack(side="left")
            ttk.Label(pf, text="行 / ×100 字", foreground="#666").pack(side="left", padx=6)
            lab(3, 2, "自定义正则：")
            ttk.Entry(opt, textvariable=self.var_pattern).grid(row=3, column=3, sticky="ew", pady=3)

            lab(4, 0, "封面图片：")
            ttk.Entry(opt, textvariable=self.var_cover).grid(row=4, column=1, sticky="ew", pady=3, padx=(0, 12))
            cf = ttk.Frame(opt)
            cf.grid(row=4, column=3, sticky="w", pady=3)
            ttk.Button(cf, text="浏览…", command=self.pick_cover, width=8).pack(side="left")
            ttk.Button(cf, text="清除", command=lambda: self.var_cover.set(""), width=8).pack(side="left", padx=6)

            lab(5, 0, "输出目录：")
            ttk.Entry(opt, textvariable=self.var_out).grid(row=5, column=1, sticky="ew", pady=3, padx=(0, 12))
            of = ttk.Frame(opt)
            of.grid(row=5, column=3, sticky="w", pady=3)
            ttk.Button(of, text="浏览…", command=self.pick_out, width=8).pack(side="left")
            ttk.Checkbutton(of, text="与源文件同目录", variable=self.var_same).pack(side="left", padx=6)

            ttk.Checkbutton(opt, text="多文件合并为同一本 EPUB（每个文件作为一章的开头）",
                            variable=self.var_merge).grid(row=6, column=0, columnspan=4, sticky="w", pady=(6, 0))
            ttk.Label(opt, text="分章参数说明：按行数 = 每 N 行一章；按字数 = 每 N×100 字一章；"
                                "其他分章方式忽略该值。",
                      foreground="#777").grid(row=7, column=0, columnspan=4, sticky="w", pady=(4, 0))

            act = ttk.Frame(self)
            act.grid(row=2, column=0, sticky="ew")
            act.columnconfigure(2, weight=1)
            self.btn_run = ttk.Button(act, text="开始转换", command=self.start, width=14)
            self.btn_run.grid(row=0, column=0)
            self.btn_stop = ttk.Button(act, text="停止", command=self.stop, width=8, state="disabled")
            self.btn_stop.grid(row=0, column=1, padx=6)
            self.pbar = ttk.Progressbar(act, mode="determinate")
            self.pbar.grid(row=0, column=2, sticky="ew", padx=6)

            logf = ttk.LabelFrame(self, text=" 运行日志 ", padding=6)
            logf.grid(row=4, column=0, sticky="nsew", pady=(8, 0))
            logf.columnconfigure(0, weight=1)
            logf.rowconfigure(0, weight=1)
            self.log = tk.Text(logf, height=4, width=40, wrap="word", font=UI_FONT, state="disabled",
                               background="#fbfbfb")
            self.log.grid(row=0, column=0, sticky="nsew")
            lsb = ttk.Scrollbar(logf, orient="vertical", command=self.log.yview)
            lsb.grid(row=0, column=1, sticky="ns")
            self.log.configure(yscrollcommand=lsb.set)

        # ---- 文件列表 ----
        def _refresh(self):
            self.tree.delete(*self.tree.get_children())
            for p in self.files:
                try:
                    size = os.path.getsize(p)
                    st = "%.1f KB" % (size / 1024) if size < 1024 * 1024 else "%.1f MB" % (size / 1048576)
                except OSError:
                    st = "?"
                self.tree.insert("", "end", values=(os.path.basename(p), st, os.path.dirname(p)))
            self.lbl_count.configure(text="共 %d 个文件" % len(self.files))

        def add_files(self):
            from tkinter import filedialog
            paths = filedialog.askopenfilenames(title="选择 TXT 文件",
                                                filetypes=[("文本文件", "*.txt"), ("所有文件", "*.*")])
            for p in paths:
                if p not in self.files:
                    self.files.append(p)
            self._refresh()

        def add_dir(self):
            from tkinter import filedialog
            d = filedialog.askdirectory(title="选择包含 TXT 的文件夹")
            if not d:
                return
            for n in sorted(os.listdir(d)):
                if n.lower().endswith(".txt"):
                    p = os.path.join(d, n)
                    if p not in self.files:
                        self.files.append(p)
            self._refresh()

        def remove_sel(self):
            for i in sorted([self.tree.index(x) for x in self.tree.selection()], reverse=True):
                del self.files[i]
            self._refresh()

        def clear_files(self):
            self.files = []
            self._refresh()

        def pick_cover(self):
            from tkinter import filedialog
            p = filedialog.askopenfilename(
                title="选择封面图片",
                filetypes=[("图片", "*.jpg *.jpeg *.png *.webp *.bmp *.gif"), ("所有文件", "*.*")])
            if p:
                self.var_cover.set(p)

        def pick_out(self):
            from tkinter import filedialog
            d = filedialog.askdirectory(title="选择输出目录")
            if d:
                self.var_out.set(d)
                self.var_same.set(False)

        # ---- 日志 ----
        def say(self, msg):
            self.q.put(("log", msg))

        def _poll(self):
            try:
                while True:
                    kind, payload = self.q.get_nowait()
                    if kind == "log":
                        self.log.configure(state="normal")
                        self.log.insert("end", payload + "\n")
                        self.log.see("end")
                        self.log.configure(state="disabled")
                    elif kind == "progress":
                        done, total = payload
                        self.pbar.configure(maximum=max(1, total), value=done)
                    elif kind == "done":
                        self.btn_run.configure(state="normal")
                        self.btn_stop.configure(state="disabled")
                        self.pbar.configure(value=self.pbar["maximum"])
            except queue.Empty:
                pass
            if self._running:
                self.after(120, self._poll)

        def stop(self):
            self.stop_flag = True
            self.say("已请求停止，正在结束当前文件…")

        def start(self):
            if self._running:
                return
            if not self.files:
                from tkinter import messagebox
                messagebox.showwarning("提示", "请先添加要转换的 TXT 文件")
                return
            mode = dict(SPLIT_MODES)[self.var_split.get()]
            if mode == "regex" and not self.var_pattern.get().strip():
                from tkinter import messagebox
                messagebox.showwarning("提示", "选择了自定义正则，请填写正则表达式")
                return
            jobs = list(self.files)
            cfg = dict(
                title=self.var_title.get().strip(), author=self.var_author.get().strip(),
                lang=self.var_lang.get().strip() or "zh-CN", pub=self.var_pub.get().strip(),
                mode=mode, pattern=self.var_pattern.get().strip(),
                n=int(self.var_n.get() or 50), cover=self.var_cover.get().strip(),
                out=self.var_out.get().strip(), same=self.var_same.get(),
                merge=self.var_merge.get(),
                enc=dict(ENCODING_CHOICES)[self.var_enc.get()])
            if cfg["merge"] and len(jobs) < 2 and not self.var_title.get().strip():
                pass
            self.stop_flag = False
            self._running = True
            self.btn_run.configure(state="disabled")
            self.btn_stop.configure(state="normal")
            self.pbar.configure(value=0)
            threading.Thread(target=self._work, args=(jobs, cfg), daemon=True).start()
            self.after(100, self._poll)

        def _work(self, jobs, cfg):
            ok = 0
            fail = 0
            try:
                cover_data = None
                if cfg["cover"]:
                    try:
                        cover_data = prepare_cover(cfg["cover"])
                        self.say("封面已处理：%s" % os.path.basename(cfg["cover"]))
                    except Exception as exc:
                        self.say("封面处理失败，将忽略封面：%s" % exc)
                        cover_data = None
                total = len(jobs)
                if cfg["merge"]:
                    chapters = []
                    for i, p in enumerate(jobs, 1):
                        if self.stop_flag:
                            break
                        self.say("读取 [%d/%d] %s" % (i, total, os.path.basename(p)))
                        text, enc = read_text_file(p, cfg["enc"])
                        base = os.path.splitext(os.path.basename(p))[0]
                        self.say("   编码=%s，%d 字" % (enc, len(text)))
                        chapters.append((base, ""))
                        chapters += split_chapters(text, cfg["mode"], cfg["pattern"], cfg["n"], base)
                        self.q.put(("progress", (i, total + 1)))
                    if not self.stop_flag:
                        title = cfg["title"] or os.path.splitext(os.path.basename(jobs[0]))[0]
                        outdir = cfg["out"] or (os.path.dirname(jobs[0]) if cfg["same"] else app_dir())
                        os.makedirs(outdir, exist_ok=True)
                        out = os.path.join(outdir, safe_filename(title) + ".epub")
                        build_epub(out, title, chapters, author=cfg["author"], language=cfg["lang"],
                                   publisher=cfg["pub"], cover_data=cover_data)
                        self.say("完成：%s（%d 章）" % (out, len(chapters)))
                        ok += 1
                        self.q.put(("progress", (total + 1, total + 1)))
                else:
                    for i, p in enumerate(jobs, 1):
                        if self.stop_flag:
                            break
                        base = os.path.splitext(os.path.basename(p))[0]
                        try:
                            self.say("读取 [%d/%d] %s" % (i, total, os.path.basename(p)))
                            text, enc = read_text_file(p, cfg["enc"])
                            title = cfg["title"] or base
                            chapters = split_chapters(text, cfg["mode"], cfg["pattern"], cfg["n"], title)
                            outdir = cfg["out"] or (os.path.dirname(p) if cfg["same"] else app_dir())
                            os.makedirs(outdir, exist_ok=True)
                            out = os.path.join(outdir, safe_filename(title) + ".epub")
                            build_epub(out, title, chapters, author=cfg["author"], language=cfg["lang"],
                                       publisher=cfg["pub"], cover_data=cover_data)
                            self.say("   完成：%s.epub  [%s, %d 章, %d 字]"
                                     % (safe_filename(title), enc, len(chapters), len(text)))
                            ok += 1
                        except Exception as exc:
                            fail += 1
                            self.say("   失败：%s（%s）" % (os.path.basename(p), exc))
                            traceback.print_exc()
                        self.q.put(("progress", (i, total)))
                if self.stop_flag:
                    self.say("已停止。成功 %d 个，失败 %d 个。" % (ok, fail))
                else:
                    self.say("全部结束：成功 %d 个，失败 %d 个。" % (ok, fail))
            except Exception as exc:
                self.say("发生错误：%s" % exc)
                self.say(traceback.format_exc())
            finally:
                self.q.put(("done", None))
                self._running = False

        _running = False

    class EditTab(ttk.Frame):
        def __init__(self, master):
            super().__init__(master, padding=10)
            self.book = None
            self.cover_data = None
            self._preview = None
            self.dirty = False
            self.var_path = tk.StringVar(value="（尚未打开文件）")
            self.var_title = tk.StringVar()
            self.var_author = tk.StringVar()
            self.var_lang = tk.StringVar()
            self.var_pub = tk.StringVar()
            self.var_id = tk.StringVar()
            self.var_status = tk.StringVar(value="就绪")
            self._build()

        def _build(self):
            self.columnconfigure(0, weight=1)
            self.rowconfigure(1, weight=1)

            top = ttk.Frame(self)
            top.grid(row=0, column=0, sticky="ew")
            ttk.Button(top, text="打开 EPUB…", command=self.open_file, width=14).pack(side="left")
            ttk.Label(top, textvariable=self.var_path, foreground="#555").pack(side="left", padx=10)
            self.btn_save = ttk.Button(top, text="保存", command=self.save, width=10, state="disabled")
            self.btn_save.pack(side="right")
            self.btn_saveas = ttk.Button(top, text="另存为…", command=self.save_as, width=10, state="disabled")
            self.btn_saveas.pack(side="right", padx=6)
            self.btn_txt = ttk.Button(top, text="导出为 TXT…", command=self.export_txt, width=12, state="disabled")
            self.btn_txt.pack(side="right", padx=6)

            paned = ttk.Panedwindow(self, orient="horizontal")
            paned.grid(row=1, column=0, sticky="nsew", pady=8)

            left = ttk.LabelFrame(paned, text=" 章节列表 ", padding=6, width=300)
            left.grid_propagate(False)
            left.columnconfigure(0, weight=1)
            left.rowconfigure(0, weight=1)
            self.chap_list = ttk.Treeview(left, columns=("no", "title"), show="headings",
                                          selectmode="browse")
            self.chap_list.heading("no", text="#")
            self.chap_list.heading("title", text="章节标题")
            self.chap_list.column("no", width=40, anchor="center", stretch=False)
            self.chap_list.column("title", width=190, anchor="w")
            self.chap_list.grid(row=0, column=0, sticky="nsew")
            csb = ttk.Scrollbar(left, orient="vertical", command=self.chap_list.yview)
            csb.grid(row=0, column=1, sticky="ns")
            self.chap_list.configure(yscrollcommand=csb.set)
            self.chap_list.bind("<<TreeviewSelect>>", self.on_select)
            lb = ttk.Frame(left)
            lb.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(6, 0))
            ttk.Button(lb, text="新增章节", command=self.add_chapter, width=8).pack(side="left")
            ttk.Button(lb, text="重命名", command=self.rename_chapter, width=8).pack(side="left", padx=4)
            ttk.Button(lb, text="删除章节", command=self.delete_chapter, width=8).pack(side="left")
            paned.add(left, weight=1)

            right = ttk.Notebook(paned)
            self.nb = right
            paned.add(right, weight=3)

            # --- 元数据页 ---
            meta = ttk.Frame(right, padding=10)
            right.add(meta, text=" 书籍信息与封面 ")
            meta.columnconfigure(1, weight=1)
            meta.columnconfigure(3, weight=1)
            for r, (label, var) in enumerate((("书名：", self.var_title), ("作者：", self.var_author),
                                              ("语言：", self.var_lang), ("出版社：", self.var_pub),
                                              ("标识符：", self.var_id))):
                ttk.Label(meta, text=label).grid(row=r, column=0, sticky="e", padx=(0, 6), pady=3)
                ttk.Entry(meta, textvariable=var).grid(row=r, column=1, columnspan=3, sticky="ew", pady=3)
            ttk.Label(meta, text="简介：").grid(row=5, column=0, sticky="ne", padx=(0, 6), pady=3)
            self.txt_desc = tk.Text(meta, height=4, width=40, wrap="word", font=UI_FONT)
            self.txt_desc.grid(row=5, column=1, columnspan=3, sticky="nsew", pady=3)

            cov = ttk.LabelFrame(meta, text=" 封面 ", padding=8)
            cov.grid(row=6, column=0, columnspan=4, sticky="nsew", pady=(10, 0))
            cov.columnconfigure(0, weight=0)
            cov.columnconfigure(1, weight=1)
            self.cover_label = tk.Label(cov, text="（无封面）", width=20, height=11,
                                        background="#f0f0f0", foreground="#888", relief="groove")
            self.cover_label.grid(row=0, column=0, rowspan=5, padx=(0, 10))
            ttk.Button(cov, text="选择图片并设为封面…", command=self.choose_cover, width=22).grid(
                row=0, column=1, sticky="w", pady=2)
            ttk.Button(cov, text="移除封面", command=self.drop_cover, width=22).grid(
                row=1, column=1, sticky="w", pady=2)
            ttk.Button(cov, text="导出封面图片…", command=self.export_cover, width=22).grid(
                row=2, column=1, sticky="w", pady=2)
            ttk.Label(cov, text="封面会自动缩放为最长边 1600×2560 内的 JPEG。",
                      foreground="#666", justify="left", wraplength=260).grid(
                row=3, column=1, sticky="w", pady=(6, 0))

            # --- 正文编辑页 ---
            body_tab = ttk.Frame(right, padding=10)
            self.tab_body = body_tab
            right.add(body_tab, text=" 正文编辑 ")
            body_tab.columnconfigure(0, weight=1)
            body_tab.rowconfigure(2, weight=1)

            bar2 = ttk.Frame(body_tab)
            bar2.grid(row=0, column=0, sticky="ew", pady=(0, 6))
            ttk.Button(bar2, text="保存本章修改", command=self.save_chapter_text, width=12).pack(side="left")
            ttk.Button(bar2, text="放弃修改并重新载入", command=self.reload_chapter_text,
                       width=17).pack(side="left", padx=6)
            self.var_wc = tk.StringVar(value="")
            ttk.Label(bar2, textvariable=self.var_wc, foreground="#666").pack(side="right")

            fr = ttk.Frame(body_tab)
            fr.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(0, 6))
            ttk.Label(fr, text="查找：").pack(side="left")
            self.var_find = tk.StringVar()
            ttk.Entry(fr, textvariable=self.var_find, width=14).pack(side="left")
            ttk.Label(fr, text="替换为：").pack(side="left", padx=(8, 0))
            self.var_repl = tk.StringVar()
            ttk.Entry(fr, textvariable=self.var_repl, width=14).pack(side="left")
            ttk.Button(fr, text="替换", command=lambda: self.do_replace(False), width=7).pack(
                side="left", padx=(8, 4))
            ttk.Button(fr, text="全部替换", command=lambda: self.do_replace(True), width=9).pack(side="left")

            self.txt_body = tk.Text(body_tab, wrap="word", width=50, font=UI_FONT, undo=True)
            self.txt_body.grid(row=2, column=0, sticky="nsew")
            ysb2 = ttk.Scrollbar(body_tab, orient="vertical", command=self.txt_body.yview)
            ysb2.grid(row=2, column=1, sticky="ns")
            self.txt_body.configure(yscrollcommand=ysb2.set)
            self.txt_body.bind("<<Modified>>", self.on_body_modified)
            ttk.Label(body_tab, text="正文按「一行一段」编辑，空行分段。保存后本章会重建为「标题 + 段落」结构，"
                                     "行内格式（加粗/斜体/链接）不再保留；要精确保留请用「章节源码」页。",
                      foreground="#888", wraplength=620, justify="left").grid(
                row=3, column=0, columnspan=2, sticky="w", pady=(6, 0))

            # --- 章节源码页 ---
            src = ttk.Frame(right, padding=10)
            right.add(src, text=" 章节源码 ")
            src.columnconfigure(0, weight=1)
            src.rowconfigure(1, weight=1)
            bar = ttk.Frame(src)
            bar.grid(row=0, column=0, sticky="ew", pady=(0, 6))
            ttk.Button(bar, text="保存本章修改", command=self.save_chapter, width=12).pack(side="left")
            ttk.Button(bar, text="放弃修改并重新载入", command=self.reload_chapter, width=17).pack(side="left", padx=6)
            ttk.Label(bar, text="直接编辑 XHTML 源码", foreground="#666").pack(side="left", padx=6)
            self.txt_src = tk.Text(src, wrap="none", width=50, font=MONO_FONT, undo=True)
            self.txt_src.grid(row=1, column=0, sticky="nsew")
            xsb = ttk.Scrollbar(src, orient="horizontal", command=self.txt_src.xview)
            xsb.grid(row=2, column=0, sticky="ew")
            ysb = ttk.Scrollbar(src, orient="vertical", command=self.txt_src.yview)
            ysb.grid(row=1, column=1, sticky="ns")
            self.txt_src.configure(xscrollcommand=xsb.set, yscrollcommand=ysb.set)

            ttk.Label(self, textvariable=self.var_status, foreground="#0a6").grid(
                row=2, column=0, sticky="w", pady=(4, 0))

        # ---- 打开 ----
        def open_file(self):
            from tkinter import filedialog, messagebox
            p = filedialog.askopenfilename(title="打开 EPUB",
                                           filetypes=[("EPUB 电子书", "*.epub"), ("所有文件", "*.*")])
            if not p:
                return
            try:
                self.book = EpubFile(p)
            except Exception as exc:
                messagebox.showerror("无法打开", str(exc))
                return
            self.var_path.set(p)
            md = self.book.metadata()
            self.var_title.set(md["title"])
            self.var_author.set(md["creator"])
            self.var_lang.set(md["language"] or "zh-CN")
            self.var_pub.set(md["publisher"])
            self.var_id.set(md["identifier"])
            self.txt_desc.delete("1.0", "end")
            self.txt_desc.insert("1.0", md["description"])
            self.refresh_chapters()
            self.refresh_cover()
            self.btn_save.configure(state="normal")
            self.btn_saveas.configure(state="normal")
            self.btn_txt.configure(state="normal")
            self.txt_src.delete("1.0", "end")
            self.txt_body.delete("1.0", "end")
            self.txt_body.edit_modified(False)
            self.var_wc.set("")
            self.var_status.set("已打开：%d 章" % len(self.book.chapters))

        def refresh_chapters(self):
            self.chap_list.delete(*self.chap_list.get_children())
            for i, ch in enumerate(self.book.chapters, 1):
                self.chap_list.insert("", "end", iid=str(i - 1), values=(i, ch["title"]))

        def refresh_cover(self):
            data = self.book.cover_bytes()
            self.cover_data = data
            if not data:
                self.cover_label.configure(image="", text="（无封面）")
                self._preview = None
                return
            raw, ext = data
            if has_pil:
                try:
                    from PIL import Image, ImageTk
                    im = Image.open(io.BytesIO(raw))
                    im.thumbnail((170, 240))
                    self._preview = ImageTk.PhotoImage(im)
                    self.cover_label.configure(image=self._preview, text="")
                    return
                except Exception:
                    pass
            if ext in ("png", "gif"):
                try:
                    self._preview = tk.PhotoImage(data=raw)
                    self.cover_label.configure(image=self._preview, text="")
                    return
                except Exception:
                    pass
            self._preview = None
            self.cover_label.configure(image="", text="(已内嵌封面 %.1f KB)" % (len(raw) / 1024))

        def _sel_index(self):
            sel = self.chap_list.selection()
            if not sel:
                return None
            return int(sel[0])

        def on_select(self, _evt=None):
            i = self._sel_index()
            if i is None or self.book is None:
                return
            self.txt_src.delete("1.0", "end")
            self.txt_src.insert("1.0", self.book.chapter_source(i))
            self.txt_body.delete("1.0", "end")
            self.txt_body.insert("1.0", self.book.chapter_text(i))
            self.txt_body.edit_modified(False)
            self.txt_body.edit_reset()
            self.update_wordcount()
            self.var_status.set("第 %d 章：%s" % (i + 1, self.book.chapters[i]["title"]))

        # ---- 正文文本编辑 ----
        def on_body_modified(self, _evt=None):
            if self.txt_body.edit_modified():
                self.txt_body.edit_modified(False)
                self.update_wordcount()

        def update_wordcount(self):
            if self.book is None:
                self.var_wc.set("")
                return
            t = self.txt_body.get("1.0", "end-1c")
            self.var_wc.set("本章 %d 字（不含空白）" % len(re.sub(r"\s", "", t)))

        def save_chapter_text(self):
            from tkinter import messagebox
            i = self._sel_index()
            if i is None or self.book is None:
                messagebox.showinfo("提示", "请先在左侧章节列表里选一章")
                return
            self.book.set_chapter_text(i, self.txt_body.get("1.0", "end-1c"))
            self.txt_src.delete("1.0", "end")
            self.txt_src.insert("1.0", self.book.chapter_source(i))
            self.var_status.set("第 %d 章正文已更新，记得点右上角「保存」写入文件" % (i + 1))

        def reload_chapter_text(self):
            i = self._sel_index()
            if i is None or self.book is None:
                return
            self.txt_body.delete("1.0", "end")
            self.txt_body.insert("1.0", self.book.chapter_text(i))
            self.txt_body.edit_modified(False)
            self.update_wordcount()
            self.var_status.set("已重新载入第 %d 章正文" % (i + 1))

        def do_replace(self, replace_all: bool):
            if self.book is None:
                return
            find = self.var_find.get()
            if not find:
                self.var_status.set("请先在「查找」框里填写内容")
                return
            repl = self.var_repl.get()
            if replace_all:
                text = self.txt_body.get("1.0", "end-1c")
                cnt = text.count(find)
                if not cnt:
                    self.var_status.set("没有找到「%s」" % find)
                    return
                self.txt_body.delete("1.0", "end")
                self.txt_body.insert("1.0", text.replace(find, repl))
                self.update_wordcount()
                self.var_status.set("已替换 %d 处（记得点「保存本章修改」）" % cnt)
                return
            pos = self.txt_body.search(find, "insert", stopindex="end")
            if not pos:
                pos = self.txt_body.search(find, "1.0", stopindex="end")
            if not pos:
                self.var_status.set("没有找到「%s」" % find)
                return
            end = "%s+%dc" % (pos, len(find))
            self.txt_body.delete(pos, end)
            self.txt_body.insert(pos, repl)
            self.txt_body.mark_set("insert", "%s+%dc" % (pos, len(repl)))
            self.txt_body.see(pos)
            self.update_wordcount()
            self.var_status.set("已替换 1 处（继续点「替换」往下找）")

        # ---- 新增章节 ----
        def add_chapter(self):
            from tkinter import simpledialog, messagebox
            if self.book is None:
                messagebox.showinfo("提示", "请先打开一个 EPUB 文件")
                return
            i = self._sel_index()
            if i is None:
                prompt = "新章节标题（将追加到全书末尾）："
                pos = len(self.book.chapters)
            else:
                prompt = "新章节标题（将插入到第 %d 章之后）：" % (i + 1)
                pos = i + 1
            title = simpledialog.askstring("新增章节", prompt, parent=self)
            if not title or not title.strip():
                return
            title = title.strip()
            idx = self.book.add_chapter(pos, title, "")
            self.refresh_chapters()
            self.chap_list.selection_set(str(idx))
            self.chap_list.see(str(idx))
            self.on_select()
            try:
                self.nb.select(self.tab_body)
                self.txt_body.focus_set()
            except Exception:
                pass
            self.var_status.set("已新增《%s》（第 %d 章）：写完正文点「保存本章修改」，再点右上角「保存」"
                                % (title, idx + 1))

        def rename_chapter(self):
            from tkinter import simpledialog
            i = self._sel_index()
            if i is None or self.book is None:
                return
            old = self.book.chapters[i]["title"]
            new = simpledialog.askstring("重命名章节", "新的章节标题：", initialvalue=old, parent=self)
            if not new or new.strip() == old:
                return
            self.book.rename_chapter(i, new)
            self.refresh_chapters()
            self.chap_list.selection_set(str(i))
            self.var_status.set("章节已改名，保存后写入目录（nav/ncx）")

        def delete_chapter(self):
            from tkinter import messagebox
            i = self._sel_index()
            if i is None or self.book is None:
                return
            if len(self.book.chapters) <= 1:
                messagebox.showwarning("提示", "至少要保留一章")
                return
            if not messagebox.askyesno("确认", "确定删除《%s》？" % self.book.chapters[i]["title"]):
                return
            self.book.delete_chapter(i)
            self.refresh_chapters()
            self.var_status.set("章节已删除，记得点“保存”")

        # ---- 封面 ----
        def choose_cover(self):
            from tkinter import filedialog, messagebox
            if self.book is None:
                return
            p = filedialog.askopenfilename(
                title="选择封面图片",
                filetypes=[("图片", "*.jpg *.jpeg *.png *.webp *.bmp *.gif"), ("所有文件", "*.*")])
            if not p:
                return
            try:
                data, ext, mtype = prepare_cover(p)
            except Exception as exc:
                messagebox.showerror("封面处理失败", str(exc))
                return
            self.book.set_cover(data, ext, mtype, self.var_lang.get() or "zh-CN")
            self.refresh_cover()
            self.var_status.set("封面已更新（%s），保存后生效" % os.path.basename(p))

        def drop_cover(self):
            from tkinter import messagebox
            if self.book is None or self.book.cover_bytes() is None:
                return
            if not messagebox.askyesno("确认", "确定移除当前封面？"):
                return
            self.book.remove_cover()
            self.refresh_cover()
            self.var_status.set("封面已移除，保存后生效")

        def export_cover(self):
            from tkinter import filedialog, messagebox
            data = self.book.cover_bytes() if self.book else None
            if not data:
                messagebox.showinfo("提示", "这本书没有封面")
                return
            raw, ext = data
            p = filedialog.asksaveasfilename(title="导出封面", defaultextension="." + ext,
                                             initialfile="cover." + ext)
            if not p:
                return
            with open(p, "wb") as f:
                f.write(raw)
            self.var_status.set("封面已导出：%s" % p)

        def _collect_metadata(self):
            return {
                "title": self.var_title.get(),
                "creator": self.var_author.get(),
                "language": self.var_lang.get(),
                "publisher": self.var_pub.get(),
                "description": self.txt_desc.get("1.0", "end").strip(),
                "identifier": self.var_id.get(),
            }

        def save_chapter(self):
            i = self._sel_index()
            if i is None or self.book is None:
                return
            self.book.set_chapter_source(i, self.txt_src.get("1.0", "end-1c"))
            self.var_status.set("第 %d 章源码已更新，记得点右上角“保存”" % (i + 1))

        def reload_chapter(self):
            self.on_select()

        # ---- 保存 ----
        def _do_save(self, target=None):
            from tkinter import messagebox
            if self.book is None:
                return
            try:
                self.book.set_metadata(self._collect_metadata())
                out = self.book.save(target)
            except Exception as exc:
                messagebox.showerror("保存失败", str(exc))
                return
            self.var_path.set(out)
            self.refresh_chapters()
            self.var_status.set("已保存：%s" % out)

        def save(self):
            self._do_save(None)

        def save_as(self):
            from tkinter import filedialog
            if self.book is None:
                return
            p = filedialog.asksaveasfilename(title="另存为", defaultextension=".epub",
                                             initialfile=os.path.basename(self.book.path),
                                             filetypes=[("EPUB 电子书", "*.epub")])
            if p:
                self._do_save(p)

        def export_txt(self):
            from tkinter import filedialog, messagebox
            if self.book is None:
                return
            base = os.path.splitext(os.path.basename(self.book.path))[0] + ".txt"
            p = filedialog.asksaveasfilename(title="导出为 TXT", defaultextension=".txt",
                                             initialfile=base, filetypes=[("文本文件", "*.txt")])
            if not p:
                return
            try:
                text = self.book.to_text()
                with open(p, "w", encoding="utf-8") as f:
                    f.write(text)
            except Exception as exc:
                messagebox.showerror("导出失败", str(exc))
                return
            self.var_status.set("已导出：%s（%d 字）" % (p, len(text)))

    root = tk.Tk()
    root.title("%s  v%s" % (APP_NAME, VERSION))
    root.geometry("1020x880")
    root.minsize(940, 700)

    try:
        style = ttk.Style()
        if "vista" in style.theme_names():
            style.theme_use("vista")
        style.configure(".", font=UI_FONT)
        style.configure("Treeview", rowheight=24)
        style.configure("TButton", padding=(8, 4))
    except Exception:
        pass

    nb = ttk.Notebook(root)
    nb.pack(fill="both", expand=True, padx=8, pady=8)
    tab1 = ConvertTab(nb)
    tab2 = EditTab(nb)
    nb.add(tab1, text="  TXT → EPUB  ")
    nb.add(tab2, text="  EPUB 编辑  ")

    def on_close():
        if getattr(tab1, "_running", False):
            from tkinter import messagebox
            if not messagebox.askyesno("确认", "正在转换中，确定要退出吗？"):
                return
            tab1.stop_flag = True
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
