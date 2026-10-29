// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

/**
 * 预览样字：由 Rust 栅格化成 PNG，前端只负责贴图。
 *
 * 为什么不让 WebView 自己加载字体：Chromium 把加载过的字体缓存在渲染进程里，
 * 删除 `FontFace`、重载页面、销毁 Worker 都不会释放，滚一遍全库能涨到 1GB。
 * 现在字体文件只在 Rust 里读一次、渲染成小位图，WebView 完全不碰字体文件。
 *
 * 这里维护一份 data URL 缓存（按路径 + 文本 + 字号 + 颜色），滚动时命中缓存直接贴图，
 * 不会再出现「一滚动整列变回默认字体」的情况。
 */

import { invoke } from "@tauri-apps/api/core";

import type { FontEntry } from "./types";

/** data URL 缓存条数上限 */
const MAX_CACHED = 400;

export interface PreviewRequest {
  entry: FontEntry;
  text: string;
  /** CSS 像素字号 */
  fontSize: number;
  /** `#rrggbb` */
  color: string;
  /** 折行宽度（CSS px）；0 / 缺省表示不折行 */
  maxWidth?: number;
}

function keyOf(request: PreviewRequest): string {
  const dpr = window.devicePixelRatio || 1;
  return `${request.entry.path}|${request.fontSize}|${request.color}|${dpr}|${request.maxWidth ?? 0}|${request.text}`;
}

/** 把 `rgb(r, g, b)` / `#rrggbb` 统一成 `#rrggbb`。 */
export function toHexColor(color: string): string {
  const text = color.trim();
  if (text.startsWith("#")) {
    return text.length >= 7 ? text.slice(0, 7) : text;
  }
  const match = text.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (!match) return "#000000";
  const hex = (value: string) =>
    Math.min(255, Number(value)).toString(16).padStart(2, "0");
  return `#${hex(match[1])}${hex(match[2])}${hex(match[3])}`;
}

export class PreviewPool {
  private readonly cache = new Map<string, string>();
  private readonly order: string[] = [];
  private readonly waiters = new Map<string, Array<(url: string | null) => void>>();
  private readonly retryAt = new Map<string, number>();

  /** 主题 / 缩放变化后清空缓存（颜色或像素密度变了，旧图作废）。 */
  resetBitmaps(): void {
    this.cache.clear();
    this.order.length = 0;
    this.retryAt.clear();
  }


  /**
   * 请求一张样字图。命中缓存时同步回调，否则异步回调；
   * 失败回调 `null`，5 秒内不重试，之后再次渲染会重新请求。
   */
  request(request: PreviewRequest, done: (url: string | null) => void): void {
    const key = keyOf(request);
    const cached = this.cache.get(key);
    if (cached) {
      this.touch(key);
      done(cached);
      return;
    }
    const retry = this.retryAt.get(key);
    if (retry && Date.now() < retry) {
      done(null);
      return;
    }

    const queue = this.waiters.get(key);
    if (queue) {
      queue.push(done);
      return;
    }
    this.waiters.set(key, [done]);

    const dpr = window.devicePixelRatio || 1;
    void invoke<string>("render_preview", {
      path: request.entry.path,
      text: request.text,
      size: request.fontSize,
      color: request.color,
      dpr,
      maxWidth: request.maxWidth && request.maxWidth > 0 ? request.maxWidth : null,
    })
      .then((url) => {
        const waiting = this.waiters.get(key) ?? [];
        this.waiters.delete(key);
        this.retryAt.delete(key);
        this.store(key, url);
        for (const callback of waiting) callback(url);
      })
      .catch(() => {
        const waiting = this.waiters.get(key) ?? [];
        this.waiters.delete(key);
        this.retryAt.set(key, Date.now() + 5000);
        for (const callback of waiting) callback(null);
      });
  }

  private store(key: string, url: string): void {
    this.cache.set(key, url);
    this.order.push(key);
    while (this.order.length > MAX_CACHED) {
      const oldest = this.order.shift();
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  private touch(key: string): void {
    const index = this.order.indexOf(key);
    if (index >= 0) {
      this.order.splice(index, 1);
      this.order.push(key);
    }
  }
}
