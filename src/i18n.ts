// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

/** 界面文案：外挂语言包 + 静态标记替换。 */

export interface LanguagePack {
  id: string;
  name: string;
  translator: string;
  entries: Record<string, string>;
}

let entries: Record<string, string> = {};

export function setLanguagePack(pack: LanguagePack): void {
  entries = pack.entries ?? {};
}


/** 取文案并做 `{name}` 占位替换；缺键时回退为键名，便于发现漏翻。 */
export function t(key: string, vars?: Record<string, string | number>): string {
  // 语言包里用字面 `\n` 表示换行；是否真的换行由目标元素的 white-space 决定
  const raw = (entries[key] ?? key).replace(/\\n/g, "\n");
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/** 把 `data-i18n*` 标记的静态文本换成当前语言。 */
export function applyStaticTranslations(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n ?? "");
  }
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    node.title = t(node.dataset.i18nTitle ?? "");
  }
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n-aria]")) {
    node.setAttribute("aria-label", t(node.dataset.i18nAria ?? ""));
  }
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]")) {
    node.setAttribute("placeholder", t(node.dataset.i18nPlaceholder ?? ""));
  }
}
