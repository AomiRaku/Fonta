# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Raku Inkyetta 羽梦千景
"""把 MasterGo / Figma 导出的 SVG 反解成「元素清单」，用于还原界面。

用法：
    python tools/parse_svg_design.py design/main.svg
    python tools/parse_svg_design.py design/main.svg --json design/main.elements.json

输出：
    · 元素表（类型 / 坐标 / 尺寸 / 颜色 / 文字 / 字号 / 字重），按 y 再 x 排序
    · 色板频次（候选 CSS 变量）
    · 字号 / 行高 / 顶部间距的频次（候选令牌）

只做“读”，不改任何设计文件。文本坐标给出的是基线（baseline），
与 CSS 的 top 差一个 ascent，换算时按 font-size 估约 0.78 倍。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict

NS = "{http://www.w3.org/2000/svg}"

TRANSLATE = re.compile(r"translate\(\s*([-\d.]+)[\s,]+([-\d.]+)\s*\)")
MATRIX = re.compile(r"matrix\(\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)\s*\)")


def tag_of(el: ET.Element) -> str:
    return el.tag.replace(NS, "")


def num(value: str | None, default: float = 0.0) -> float:
    if value is None:
        return default
    try:
        return float(re.sub(r"[a-z%]+$", "", value.strip()))
    except ValueError:
        return default


def local_transform(el: ET.Element) -> tuple[float, float]:
    raw = el.get("transform") or ""
    dx = dy = 0.0
    for match in TRANSLATE.finditer(raw):
        dx += float(match.group(1))
        dy += float(match.group(2))
    for match in MATRIX.finditer(raw):
        dx += float(match.group(5))
        dy += float(match.group(6))
    return dx, dy


def text_of(el: ET.Element) -> str:
    parts: list[str] = []

    def walk(node: ET.Element) -> None:
        if node.text:
            parts.append(node.text)
        for child in node:
            walk(child)
            if child.tail:
                parts.append(child.tail)

    walk(el)
    return re.sub(r"\s+", " ", "".join(parts)).strip()


def collect(el: ET.Element, ox: float, oy: float, out: list[dict]) -> None:
    dx, dy = local_transform(el)
    x, y = ox + dx, oy + dy
    kind = tag_of(el)

    if kind in ("rect", "image"):
        out.append(
            {
                "type": kind,
                "x": round(x + num(el.get("x")), 2),
                "y": round(y + num(el.get("y")), 2),
                "w": round(num(el.get("width")), 2),
                "h": round(num(el.get("height")), 2),
                "radius": round(num(el.get("rx")), 2),
                "fill": el.get("fill") or el.get("style", ""),
                "opacity": el.get("opacity"),
            }
        )
    elif kind in ("line",):
        out.append(
            {
                "type": "line",
                "x": round(x + num(el.get("x1")), 2),
                "y": round(y + num(el.get("y1")), 2),
                "w": round(abs(num(el.get("x2")) - num(el.get("x1"))), 2),
                "h": round(abs(num(el.get("y2")) - num(el.get("y1"))), 2),
                "radius": 0,
                "fill": el.get("stroke") or "",
                "opacity": el.get("opacity"),
            }
        )
    elif kind in ("text", "tspan"):
        content = text_of(el)
        if content:
            out.append(
                {
                    "type": "text",
                    "x": round(x + num(el.get("x")), 2),
                    "y": round(y + num(el.get("y")), 2),
                    "w": None,
                    "h": None,
                    "radius": 0,
                    "fill": el.get("fill") or "",
                    "opacity": el.get("opacity"),
                    "text": content,
                    "font-size": num(el.get("font-size"), 0) or None,
                    "font-weight": el.get("font-weight"),
                    "font-family": el.get("font-family"),
                    "letter-spacing": el.get("letter-spacing"),
                }
            )
        return  # tspan 已并入父文本
    elif kind in ("path", "circle", "ellipse", "polygon", "polyline"):
        if kind == "circle":
            r = num(el.get("r"))
            out.append(
                {
                    "type": "circle",
                    "x": round(x + num(el.get("cx")) - r, 2),
                    "y": round(y + num(el.get("cy")) - r, 2),
                    "w": round(r * 2, 2),
                    "h": round(r * 2, 2),
                    "radius": round(r, 2),
                    "fill": el.get("fill") or el.get("stroke") or "",
                    "opacity": el.get("opacity"),
                }
            )
        else:
            out.append(
                {
                    "type": kind,
                    "x": None,
                    "y": None,
                    "w": None,
                    "h": None,
                    "radius": 0,
                    "fill": el.get("fill") or el.get("stroke") or "",
                    "opacity": el.get("opacity"),
                    "note": el.get("id") or el.get("data-name") or "",
                }
            )

    for child in el:
        collect(child, x, y, out)


def summarize(elements: list[dict]) -> dict:
    fills = Counter(e["fill"] for e in elements if e.get("fill"))
    sizes = Counter(
        round(e["font-size"], 1)
        for e in elements
        if e.get("font-size")
    )
    weights = Counter(e["font-weight"] for e in elements if e.get("font-weight"))
    rows = Counter(
        round(e["h"], 1)
        for e in elements
        if e["type"] == "rect" and e.get("h") and 20 <= e["h"] <= 120
    )
    lefts = Counter(
        round(e["x"], 1) for e in elements if e.get("x") is not None and e["type"] in ("text", "rect")
    )
    return {
        "fills": fills.most_common(16),
        "font_sizes": sizes.most_common(12),
        "font_weights": weights.most_common(6),
        "row_heights": rows.most_common(8),
        "left_edges": lefts.most_common(12),
        "counts": Counter(e["type"] for e in elements).most_common(),
    }


def to_markdown(elements: list[dict], summary: dict) -> str:
    lines = ["# 设计稿元素清单", ""]
    lines.append("## 统计")
    for key in ("counts", "font_sizes", "font_weights", "row_heights", "left_edges", "fills"):
        pairs = ", ".join(f"`{k}`×{v}" for k, v in summary[key])
        lines.append(f"- **{key}**：{pairs}")
    lines += ["", "## 元素（按 y → x 排序）", ""]
    lines.append("| # | 类型 | x | y | w | h | 圆角 | 填充 | 文字 | 字号 | 字重 |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
    ordered = sorted(elements, key=lambda e: (e.get("y") or 1e9, e.get("x") or 1e9))
    for i, e in enumerate(ordered):
        lines.append(
            "| {i} | {type} | {x} | {y} | {w} | {h} | {r} | `{fill}` | {text} | {fs} | {fw} |".format(
                i=i,
                type=e["type"],
                x=_fmt(e.get("x")),
                y=_fmt(e.get("y")),
                w=_fmt(e.get("w")),
                h=_fmt(e.get("h")),
                r=_fmt(e.get("radius")),
                fill=(e.get("fill") or "")[:48],
                text=(e.get("text") or "")[:36],
                fs=_fmt(e.get("font-size")),
                fw=e.get("font-weight") or "",
            )
        )
    return "\n".join(lines)


def _fmt(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("svg")
    ap.add_argument("--json", dest="json_path", default=None)
    ap.add_argument("--md", dest="md_path", default=None)
    args = ap.parse_args()

    try:
        tree = ET.parse(args.svg)
    except ET.ParseError as err:
        print(f"SVG 解析失败：{err}", file=sys.stderr)
        return 1

    elements: list[dict] = []
    collect(tree.getroot(), 0.0, 0.0, elements)
    summary = summarize(elements)
    md = to_markdown(elements, summary)

    # Windows 控制台常是 GBK，正文只写文件，stdout 保持 ASCII，避免乱码
    target_md = args.md_path or (args.svg.rsplit(".", 1)[0] + ".elements.md")
    with open(target_md, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(md + "\n")
    print(f"elements: {len(elements)}")
    print(f"  rect/text/path: {dict(summary['counts'])}")
    print(f"  font sizes: {summary['font_sizes']}")
    print(f"  row heights: {summary['row_heights']}")
    print(f"  colors: {summary['fills'][:8]}")
    print(f"markdown -> {target_md}")
    if args.json_path:
        with open(args.json_path, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(
                {"elements": elements, "summary": {k: v for k, v in summary.items()}},
                fh,
                ensure_ascii=False,
                indent=1,
            )
        print(f"json -> {args.json_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
