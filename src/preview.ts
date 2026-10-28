// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

/**
 * 预览字形的字体池。
 *
 * WebView2 对 `%LOCALAPPDATA%\Microsoft\Windows\Fonts` 里的用户字体不一定能通过
 * CSS `font-family` 命中，因此这里用 FontFace API + asset 协议直接指向字体文件，
 * 给每个字体文件一个内部别名，保证预览字形一定来自被预览的字体本体。
 *
 * 只对可见行按需加载，并限制同时保留的字体数量：500+ 字体全量注入会拖慢 WebView2。
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import type { FontEntry } from "./types";

const ALIAS_PREFIX = "fontfox-face-";
const MAX_RETAINED = 160;

function hash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export type FaceStatus = "pending" | "ready" | "failed";

export class PreviewPool {
  private readonly aliasByEntry = new Map<string, string>();
  private readonly faceByAlias = new Map<string, FontFace>();
  private readonly statusByAlias = new Map<string, FaceStatus>();
  private readonly errorByAlias = new Map<string, string>();
  private readonly order: string[] = [];
  private listener: (() => void) | null = null;

  setStatusListener(listener: () => void): void {
    this.listener = listener;
  }

  statusOf(entry: FontEntry): FaceStatus {
    const alias = this.aliasByEntry.get(entry.id);
    if (!alias) return "pending";
    return this.statusByAlias.get(alias) ?? "pending";
  }

  /** 加载失败时的原因（用于详情面板与行 tooltip）。 */
  errorOf(entry: FontEntry): string {
    const alias = this.aliasByEntry.get(entry.id);
    if (!alias) return "";
    return this.errorByAlias.get(alias) ?? "";
  }

  /**
   * 返回该字体可用的 CSS family 别名。
   * 光栅字体（.fon）与缺失文件返回 null，由调用方回退到界面字体。
   */
  ensure(entry: FontEntry): string | null {
    if (!entry.exists || entry.format === "Raster") {
      return null;
    }
    const known = this.aliasByEntry.get(entry.id);
    if (known) {
      this.touch(known);
      return known;
    }

    const alias = `${ALIAS_PREFIX}${hash(entry.path)}`;
    this.aliasByEntry.set(entry.id, alias);

    let face = this.faceByAlias.get(alias);
    if (!face) {
      face = new FontFace(alias, `url("${convertFileSrc(entry.path)}")`, {
        display: "swap",
      });
      this.faceByAlias.set(alias, face);
      this.statusByAlias.set(alias, "pending");
      this.order.push(alias);
      face
        .load()
        .then((loaded) => {
          document.fonts.add(loaded);
          this.statusByAlias.set(alias, "ready");
          this.listener?.();
        })
        .catch((err: unknown) => {
          this.statusByAlias.set(alias, "failed");
          this.errorByAlias.set(
            alias,
            (err as { message?: string } | null)?.message ?? String(err),
          );
          this.listener?.();
        });
      this.trim();
    } else {
      this.touch(alias);
    }
    return alias;
  }

  private touch(alias: string): void {
    const index = this.order.indexOf(alias);
    if (index >= 0) {
      this.order.splice(index, 1);
      this.order.push(alias);
    }
  }

  private trim(): void {
    while (this.order.length > MAX_RETAINED) {
      const alias = this.order.shift();
      if (!alias) break;
      const face = this.faceByAlias.get(alias);
      if (face) {
        document.fonts.delete(face);
        this.faceByAlias.delete(alias);
      }
      this.statusByAlias.delete(alias);
      this.errorByAlias.delete(alias);
      for (const [id, value] of this.aliasByEntry) {
        if (value === alias) this.aliasByEntry.delete(id);
      }
    }
  }
}
