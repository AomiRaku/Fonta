# SPDX-License-Identifier: Apache-2.0
# 生成 Fontade 应用图标。图标是位图，不包含任何字体文件；"字" 字形用系统字体即时栅格化。
import os
import struct

from PIL import Image, ImageDraw, ImageFont

BG = (8, 9, 10, 255)
INK = (247, 248, 248, 255)
ACCENT = (130, 143, 255, 255)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, "..", "src-tauri", "icons"))


def find_font() -> str:
    for candidate in (
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\msyhbd.ttc",
        r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\arial.ttf",
    ):
        if os.path.exists(candidate):
            return candidate
    raise SystemExit("no usable system font for icon rendering")


def master(size: int = 1024) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 冷峻的方角底板，留一点观感上的内缩。
    inset = int(size * 0.06)
    draw.rectangle([inset, inset, size - inset, size - inset], fill=BG)
    draw.rectangle(
        [inset, inset, size - inset, size - inset],
        outline=(255, 255, 255, 26),
        width=max(2, size // 256),
    )

    glyph_font = ImageFont.truetype(find_font(), int(size * 0.56))
    text = "字"
    box = draw.textbbox((0, 0), text, font=glyph_font)
    w = box[2] - box[0]
    h = box[3] - box[1]
    draw.text(
        ((size - w) / 2 - box[0], (size - h) / 2 - box[1] - size * 0.02),
        text,
        font=glyph_font,
        fill=INK,
    )

    # 底部一条极细的强调线，呼应界面里的 1px 分割线。
    line_w = int(size * 0.30)
    y = int(size * 0.805)
    draw.rectangle(
        [(size - line_w) // 2, y, (size + line_w) // 2, y + max(3, size // 170)],
        fill=ACCENT,
    )
    return img


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    base = master(1024)

    sizes = {"32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512}
    for name, px in sizes.items():
        base.resize((px, px), Image.LANCZOS).save(os.path.join(OUT, name), "PNG")

    # ICO 容器（PNG 压缩条目，Vista+ 支持）
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    images = []
    for px in ico_sizes:
        path = os.path.join(OUT, f".ico-{px}.png")
        base.resize((px, px), Image.LANCZOS).save(path, "PNG")
        with open(path, "rb") as fh:
            images.append((px, fh.read()))
        os.remove(path)

    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    for px, data in images:
        dim = 0 if px >= 256 else px
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    with open(os.path.join(OUT, "icon.ico"), "wb") as fh:
        fh.write(header + entries + b"".join(data for _, data in images))

    print("icons written to", OUT)


if __name__ == "__main__":
    main()
