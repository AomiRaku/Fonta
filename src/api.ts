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

  /** 切换字体禁用方式（会迁移当前已禁用的字体）。 */
  setDisableMode: (mode: "windows" | "dynamic") =>
    invoke<{ mode: string; migrated: number; failed: number; errors: string[] }>(
      "set_disable_mode",
      { mode },
    ),

  /** 启动时对账隔离目录与禁用清单。 */
  reconcileDisabled: () =>
    invoke<{
      extra: Array<{ path: string; fileName: string; family: string; style: string }>;
      missing: Array<{ id: string; family: string; style: string }>;
    }>("reconcile_disabled"),

  /** 把多出来的隔离文件加入禁用清单。 */
  adoptDisabledFiles: (paths: string[]) => invoke<number>("adopt_disabled_files", { paths }),

  /** 删除文件已丢失的禁用清单记录。 */
  dropMissingDisabled: (ids: string[]) => invoke<number>("drop_missing_disabled", { ids }),

  /** 详情面板需要的附加字段（列表接口不再携带）。 */
  fontExtras: (ids: string[]) =>
    invoke<Array<{ id: string; families: string[]; version: string; copyright: string }>>(
      "font_extras",
      { ids },
    ),


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