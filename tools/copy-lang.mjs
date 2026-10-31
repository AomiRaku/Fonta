// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

/**
 * 把根目录 langBuild/*.ini 复制到 target/<profile>/lang/。
 *
 * 用法：node tools/copy-lang.mjs debug|release|both
 * npm 钩子：`predev`（debug）、`prebuild`（both），因此 `npm run dev` 与
 * `npm run tauri:build:exe` 都会拿到最新的语言文件。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "langBuild");
const targetRoot = join(root, "src-tauri", "target");

if (!existsSync(source)) {
  console.error(`[lang] 找不到语言目录：${source}`);
  process.exit(1);
}

const arg = (process.argv[2] ?? "debug").toLowerCase();
const profiles = arg === "both" ? ["debug", "release"] : [arg];

const files = readdirSync(source).filter((name) => name.toLowerCase().endsWith(".ini"));
if (files.length === 0) {
  console.error("[lang] langBuild 里没有 .ini 文件");
  process.exit(1);
}

for (const profile of profiles) {
  const dest = join(targetRoot, profile, "lang");
  mkdirSync(dest, { recursive: true });
  for (const file of files) {
    cpSync(join(source, file), join(dest, file));
  }

  // 目标目录里存在、但 langBuild 已没有的语言文件要删掉，避免旧语言残留
  const sourceNames = new Set(files.map((name) => name.toLowerCase()));
  for (const file of readdirSync(dest)) {
    if (!file.toLowerCase().endsWith(".ini")) continue;
    if (sourceNames.has(file.toLowerCase())) continue;
    unlinkSync(join(dest, file));
  }

  console.log(`[lang] ${files.length} 个语言文件 → target/${profile}/lang`);
}
