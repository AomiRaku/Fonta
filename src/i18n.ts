// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

/** 界面文案：外挂语言包 + 静态标记替换。 */

export interface LanguagePack {
  id: string;
  name: string;
  code: string;
  translator: string;
  entries: Record<string, string>;
}

let entries: Record<string, string> = {};
let currentCode = "";

export function setLanguagePack(pack: LanguagePack): void {
  entries = pack.entries ?? {};
  currentCode = pack.code ?? "";
}

/** 当前实际加载语言包的 BCP 47 代码。 */
export function languageCode(): string {
  return currentCode;
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

const LANGUAGE_CODES: Record<string, string> = {
  中文: "zh",
  日文: "ja",
  韩文: "ko",
  英语: "en",
  德语: "de",
  法语: "fr",
  西班牙语: "es",
  葡萄牙语: "pt",
  意大利语: "it",
  荷兰语: "nl",
  瑞典语: "sv",
  挪威语: "no",
  丹麦语: "da",
  芬兰语: "fi",
  波兰语: "pl",
  捷克语: "cs",
  匈牙利语: "hu",
  罗马尼亚语: "ro",
  土耳其语: "tr",
  越南语: "vi",
  俄语: "ru",
  乌克兰语: "uk",
  希腊语: "el",
  希伯来语: "he",
  阿拉伯语: "ar",
  波斯语: "fa",
  印地语: "hi",
  泰语: "th",
};

const displayNameCache = new Map<string, Intl.DisplayNames>();

function displayNames(locale: string, type: "language" | "script"): Intl.DisplayNames {
  const key = `${locale}|${type}`;
  let formatter = displayNameCache.get(key);
  if (!formatter) {
    formatter = new Intl.DisplayNames([locale], { type });
    displayNameCache.set(key, formatter);
  }
  return formatter;
}

const SCRIPT_CODES: Record<string, string> = {
  拉丁文: "Latn",
  西里尔文: "Cyrl",
  阿拉伯文: "Arab",
  希伯来文: "Hebr",
  希腊文: "Grek",
  泰文: "Thai",
  天城文: "Deva",
};

/** 把 Rust 返回的语言标识翻译为当前界面语言。 */
export function languageLabel(name: string): string {
  if (!name) return t("language.unknown");
  if (name === "多语言") return t("language.multiple");
  if (name === "其他") return t("language.other");
  if (name === "未知") return t("language.unknown");
  const locale = currentCode || "zh-CN";
  const code = LANGUAGE_CODES[name];
  if (code) {
    try {
      return displayNames(locale, "language").of(code) ?? name;
    } catch {
      return name;
    }
  }
  const script = SCRIPT_CODES[name];
  if (script) {
    try {
      return displayNames(locale, "script").of(script) ?? name;
    } catch {
      return name;
    }
  }
  return name;
}

export function languageList(names: string[]): string {
  if (names.length === 0) return t("language.unknown");
  const labels = names.map(languageLabel);
  try {
    return new Intl.ListFormat(currentCode || "zh-CN", {
      type: "conjunction",
      style: "short",
    }).format(labels);
  } catch {
    return labels.join("、");
  }
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
