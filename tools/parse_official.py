# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Raku Inkyetta 羽梦千景
"""从 Microsoft Learn 抓取 Windows 10 / 11 官方字体列表，生成内置保护清单快照。

用法：
    python tools/parse_official.py            # 必要时下载并重新生成
    python tools/parse_official.py --refresh  # 强制重新下载

输出：src-tauri/src/data/official_fonts.json（按文件名聚合，供 Rust 侧 include_str!）。

生成的快照只用于“保护判定”，不包含任何字体文件。Learn 的列表并不覆盖全部
随系统分发的字体（光栅字体、语言包字体、Noto CJK 等），这部分由手工维护的
src-tauri/src/data/core_fonts.json 补充。
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import urllib.request

PAGES = {
    "win10": "https://learn.microsoft.com/en-us/typography/fonts/windows_10_font_list",
    "win11": "https://learn.microsoft.com/en-us/typography/fonts/windows_11_font_list",
}

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".fontlist-cache")
OUTPUT = os.path.abspath(
    os.path.join(HERE, "..", "src-tauri", "src", "data", "official_fonts.json")
)

TAG = re.compile(r"<[^>]+>")


def clean(fragment: str) -> str:
    return html.unescape(TAG.sub("", fragment)).strip()


def fetch(key: str, url: str, refresh: bool) -> str:
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{key}.html")
    if os.path.exists(path) and not refresh:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    request = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0 fontfox-build"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        body = response.read().decode("utf-8", "replace")
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(body)
    print(f"downloaded {key}: {len(body)} chars")
    return body


def parse(src: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for table in re.findall(r"<table[^>]*>(.*?)</table>", src, re.S):
        family = ""
        for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", table, re.S):
            cells = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)
            if len(cells) < 3:
                continue
            family_cell = clean(cells[0])
            name = clean(cells[1])
            file_name = clean(cells[2])
            if family_cell:
                family = family_cell
            if not file_name or not family:
                continue
            rows.append({"family": family, "name": name, "file": file_name})
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="强制重新下载页面")
    args = parser.parse_args()

    merged: dict[str, dict] = {}
    for key, url in PAGES.items():
        for row in parse(fetch(key, url, args.refresh)):
            entry = merged.setdefault(
                row["file"].lower(),
                {"file": row["file"], "family": row["family"], "names": [], "os": []},
            )
            if row["name"] and row["name"] not in entry["names"]:
                entry["names"].append(row["name"])
            if key not in entry["os"]:
                entry["os"].append(key)
            if len(row["family"]) > len(entry["family"]):
                entry["family"] = row["family"]

    entries = sorted(
        merged.values(), key=lambda e: (e["family"].lower(), e["file"].lower())
    )
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(entries, fh, ensure_ascii=False, indent=1, sort_keys=True)
        fh.write("\n")

    families = {e["family"] for e in entries}
    print(f"files={len(entries)} families={len(families)} -> {OUTPUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
