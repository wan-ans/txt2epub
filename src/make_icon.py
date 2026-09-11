#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成程序图标 app.ico（构建时使用，不参与运行时）。"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app.ico")
SIZES = [16, 24, 32, 48, 64, 128, 256]


def rounded(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def make(size):
    s = 1024
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 背景：深蓝渐变感（用两层圆角矩形模拟）
    rounded(d, (40, 40, s - 40, s - 40), 170, (28, 78, 156, 255))
    rounded(d, (40, 40, s - 40, 560), 170, (44, 108, 200, 255))
    rounded(d, (40, 40, s - 40, 300), 170, (58, 126, 220, 255))

    # 书本主体
    book = (200, 250, s - 200, s - 220)
    rounded(d, book, 46, (255, 255, 255, 255))
    # 书脊
    d.rectangle((200, 250, 268, s - 220), fill=(210, 222, 240, 255))
    # 文字行
    y = 360
    for i, w in enumerate((0.62, 0.72, 0.55, 0.68, 0.45)):
        x2 = int(330 + (s - 200 - 330) * w)
        d.rounded_rectangle((330, y, x2, y + 34), radius=17, fill=(190, 205, 226, 255))
        y += 92

    # 左下角 TXT 标签
    rounded(d, (120, s - 430, 470, s - 250), 40, (255, 214, 102, 255))
    try:
        font = ImageFont.truetype("arialbd.ttf", 130)
    except Exception:
        font = ImageFont.load_default()
    d.text((295, s - 340), "TXT", font=font, fill=(60, 48, 10, 255), anchor="mm")

    # 右下角 EPUB 标签
    rounded(d, (s - 500, s - 430, s - 120, s - 250), 40, (120, 224, 160, 255))
    try:
        font2 = ImageFont.truetype("arialbd.ttf", 104)
    except Exception:
        font2 = ImageFont.load_default()
    d.text((s - 310, s - 340), "EPUB", font=font2, fill=(10, 60, 30, 255), anchor="mm")

    return img.resize((size, size), Image.LANCZOS)


def main():
    # 必须以最大的图作为源，PIL 会据此生成各个尺寸
    base = make(256)
    base.save(OUT, format="ICO", sizes=[(n, n) for n in SIZES])
    with Image.open(OUT) as chk:
        got = sorted(chk.info.get("sizes", []))
    print("已生成图标:", OUT, os.path.getsize(OUT), "字节", got)


if __name__ == "__main__":
    sys.exit(main())
