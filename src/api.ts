// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

import { invoke } from "@tauri-apps/api/core";

import type {
  AboutPayload,
  DeleteReport,
  FontListPayload,
  HiddenReport,
  Scope,
  Settings,
} from "./types";

export const api = {
  listFonts: () => invoke<FontListPayload>("list_fonts"),

  setFontsHidden: (ids: string[], hidden: boolean) =>
    invoke<HiddenReport>("set_fonts_hidden", { ids, hidden }),

  deleteFonts: (ids: string[]) => invoke<DeleteReport>("delete_fonts", { ids }),

  cleanMissing: (ids: string[]) => invoke<DeleteReport>("clean_missing", { ids }),

  retryPending: () => invoke<number>("retry_pending_deletes"),

  getSettings: () => invoke<Settings>("get_settings"),

  loadLibrary: () => invoke<import("./types").Library>("load_library"),

  saveLibrary: (library: import("./types").Library) =>
    invoke<void>("save_library", { library }),

  saveSettings: (settings: Settings) =>
    invoke<void>("save_settings", { settings }),


  about: () => invoke<AboutPayload>("about"),

  revealPath: (path: string) => invoke<void>("reveal_path", { path }),

  registryLocation: (scope: Scope) =>
    invoke<string>("registry_location", { scope }),

  /** Windows「应用模式」当前解析结果（读 AppsUseLightTheme）。 */
  systemTheme: () => invoke<string>("system_theme"),

  /** 读取外挂语言包（`lang/<id>.ini`）。 */
  loadLanguage: (id: string) =>
    invoke<import("./i18n").LanguagePack>("load_language", { id }),
};

/** 把 Rust 侧的错误统一压成可读字符串。 */
export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}
