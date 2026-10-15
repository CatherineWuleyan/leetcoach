#!/usr/bin/env python3
"""Generate the extension icons: blue rounded square with a white 'LC' monogram."""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1]

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/SFNSDisplay-Bold.otf",
    "/Library/Fonts/Arial Bold.ttf",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def rounded_gradient(size):
    """Blue rounded square with a soft vertical gradient."""
    ss = size * 4  # supersample for clean edges
    img = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    grad = Image.new("RGBA", (ss, ss))
    px = grad.load()
    top = (79, 140, 255)     # --accent
    bottom = (35, 74, 160)   # deeper blue
    for y in range(ss):
        t = y / max(1, ss - 1)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        for x in range(ss):
            px[x, y] = (r, g, b, 255)

    mask = Image.new("L", (ss, ss), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, ss - 1, ss - 1], radius=int(ss * 0.24), fill=255
    )
    img.paste(grad, (0, 0), mask)
    return img, ss


def make_icon(size):
    img, ss = rounded_gradient(size)
    draw = ImageDraw.Draw(img)

    font = load_font(int(ss * 0.46))
    text = "LC"

    # Centre the monogram using the actual glyph bbox.
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        tx = (ss - tw) / 2 - bbox[0]
        ty = (ss - th) / 2 - bbox[1]
    except Exception:
        tw, th = draw.textsize(text, font=font)
        tx, ty = (ss - tw) / 2, (ss - th) / 2

    # Slight drop shadow so the glyph survives downscaling.
    draw.text((tx + ss * 0.012, ty + ss * 0.012), text, font=font, fill=(12, 26, 58, 140))
    draw.text((tx, ty), text, font=font, fill=(255, 255, 255, 255))

    return img.resize((size, size), Image.LANCZOS)


for s in (16, 48, 128):
    path = os.path.join(OUT, f"icon{s}.png")
    make_icon(s).save(path, "PNG")
    print(f"wrote {path}")
