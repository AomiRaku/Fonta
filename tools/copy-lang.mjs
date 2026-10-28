// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Fontade Contributors

/**
 * 把根目录 langBuild/*.ini 复制到 target/<profile>/lang/。
 *
 * 用法：node tools/copy-lang.mjs debug|release|both
 * npm 钩子：`predev`（debug）、`prebuild`（both），因此 `npm run dev` 与
 * `npm run tauri:build:exe` 都会拿到最新的语言文件。
 */

import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "langBuild");
const targetRoot = join(root, "src-tauri", "target");

if (!existsSync(source)) {
  console.error(`[lang] 找不到语言目录：${source}`);
  process.exit(0);
}

const arg = (process.argv[2] ?? "debug").toLowerCase();
const profiles = arg === "both" ? ["debug", "release"] : [arg];

const files = readdirSync(source).filter((name) => name.toLowerCase().endsWith(".ini"));
if (files.length === 0) {
  console.warn("[lang] langBuild 里没有 .ini 文件");
}

for (const profile of profiles) {
  const dest = join(targetRoot, profile, "lang");
  mkdirSync(dest, { recursive: true });
  for (const file of files) {
    cpSync(join(source, file), join(dest, file));
  }
  console.log(`[lang] ${files.length} 个语言文件 → target/${profile}/lang`);
}
