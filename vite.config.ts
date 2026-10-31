// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

import { defineConfig } from "vite";

// Tauri 侧 devUrl 固定为 1420；build 输出到 dist 供 tauri bundle 读取。
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: [
        "**/src-tauri/**",
        // 编辑器的原子写入会留下 .tmpdir / .tmp，watcher 碰到会 EBUSY 崩溃
        "**/.*.tmpdir/**",
        "**/*.tmp",
      ],
    },
  },
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
    outDir: "dist",
    emptyOutDir: true,
  },
});
