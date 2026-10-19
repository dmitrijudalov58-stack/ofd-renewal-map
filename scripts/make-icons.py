#!/usr/bin/env python3
"""Генерирует иконки PWA для BI OFD в icons/ (запуск из любой папки).

Мотив: кассовый чек (зубчатый низ) с мини-графиком из трёх столбцов на
сине-фиолетовом градиенте. Цвета из css/glass.css (--brand: #2a52e0).

    pip install pillow
    python3 scripts/make-icons.py
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

BLUE = (42, 82, 224)
VIOLET = (123, 79, 240)
PAPER = (255, 255, 255)
TEXT_LINE = (200, 208, 235)
BAR_COLORS = ((42, 82, 224), (80, 80, 232), (123, 79, 240))

SUPERSAMPLE = 4
OUT_DIR = Path(__file__).resolve().parent.parent / "icons"

# (имя файла, размер, прозрачные скруглённые углы, доля высоты чека)
# maskable: фон на всю площадь, чек целиком в безопасной зоне (круг d=80%).
# apple-touch: сплошной квадрат, скругление делает iOS сам.
ICONS = (
    ("icon-192.png", 192, True, 0.60),
    ("icon-512.png", 512, True, 0.60),
    ("icon-maskable-512.png", 512, False, 0.46),
    ("apple-touch-icon.png", 180, False, 0.60),
    ("favicon-32.png", 32, True, 0.66),
)


def gradient(size: int) -> Image.Image:
    """Диагональный градиент BLUE -> VIOLET; считаем на 256x256 и растягиваем."""
    base = Image.new("RGB", (256, 256))
    px = base.load()
    for y in range(256):
        for x in range(256):
            t = (x + y) / 510
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(BLUE, VIOLET))
    return base.resize((size, size), Image.BICUBIC)


def draw_receipt(draw: ImageDraw.ImageDraw, canvas: float, height_ratio: float) -> None:
    h = canvas * height_ratio
    w = h * 0.76
    left, right = (canvas - w) / 2, (canvas + w) / 2
    top, bottom = (canvas - h) / 2, (canvas + h) / 2
    tooth = h * 0.05
    teeth = 6

    # скруглены только верхние углы: низ продолжает зигзаг без «крылышек»
    draw.rounded_rectangle(
        (left, top, right, bottom - tooth),
        radius=w * 0.08,
        fill=PAPER,
        corners=(True, True, False, False),
    )
    zigzag = [(left, bottom - tooth - 2), (right, bottom - tooth - 2)]
    step = w / teeth
    for i in range(teeth + 1):
        zigzag.append((right - i * step, bottom if i % 2 else bottom - tooth))
    draw.polygon(zigzag, fill=PAPER)

    line_h = h * 0.035
    for offset, width_ratio in ((0.12, 0.70), (0.20, 0.45)):
        y = top + h * offset
        draw.rounded_rectangle(
            (left + w * 0.15, y, left + w * (0.15 + width_ratio * 0.7), y + line_h),
            radius=line_h / 2,
            fill=TEXT_LINE,
        )

    baseline = bottom - tooth - h * 0.12
    bar_w = w * 0.18
    area_left = left + w * 0.14
    gap = (w * 0.72 - 3 * bar_w) / 2
    for i, (bar_h, color) in enumerate(zip((0.18, 0.30, 0.44), BAR_COLORS)):
        x = area_left + i * (bar_w + gap)
        draw.rounded_rectangle(
            (x, baseline - h * bar_h, x + bar_w, baseline),
            radius=bar_w * 0.25,
            fill=color,
        )


def render(size: int, rounded: bool, height_ratio: float) -> Image.Image:
    big = size * SUPERSAMPLE
    icon = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    bg = gradient(big)
    if rounded:
        inset = big * 0.05
        mask = Image.new("L", (big, big), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            (inset, inset, big - inset, big - inset), radius=big * 0.2, fill=255
        )
        icon.paste(bg, (0, 0), mask)
    else:
        icon.paste(bg, (0, 0))
    draw_receipt(ImageDraw.Draw(icon), big, height_ratio)
    return icon.resize((size, size), Image.LANCZOS)


def main() -> int:
    OUT_DIR.mkdir(exist_ok=True)
    for name, size, rounded, ratio in ICONS:
        path = OUT_DIR / name
        render(size, rounded, ratio).save(path, optimize=True)
        print(f"{path.relative_to(OUT_DIR.parent)}  {size}x{size}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
