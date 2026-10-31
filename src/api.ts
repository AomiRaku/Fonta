// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

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

  /** 重置流程：强制对账隔离目录与禁用清单（不受当前禁用模式限制）。 */
  reconcileDisabledForReset: () =>
    invoke<{
      extra: Array<{ path: string; fileName: string; family: string; style: string }>;
      missing: Array<{ id: string; family: string; style: string }>;
    }>("reconcile_disabled", { force: true }),

  /** 重置流程：恢复全部已停用字体。 */
  restoreAllFonts: () => invoke<number>("restore_all_fonts"),

  /** 把指定隔离字体文件移动到桌面 FontFox Uninstalled Fonts。 */
  moveDisabledToDesktop: (paths: string[]) =>
    invoke<number>("move_disabled_to_desktop", { paths }),

  /** 把隔离目录剩余字体全部移动到桌面。 */
  moveQuarantinedToDesktop: () =>
    invoke<number>("move_quarantined_to_desktop"),

  /** 删除 `%USERPROFILE%\.FontFox\` 下的全部内容。 */
  resetUserData: () => invoke<void>("reset_user_data"),

  /** 重启应用。 */
  restartApp: () => invoke<void>("restart_app"),

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

  /** 用系统默认浏览器打开 GitHub 链接。 */
  openUrl: (url: string) => invoke<void>("open_url", { url }),

  /** 打开 DevTools（设置里的开发者工具开关）。 */
  openDevTools: () => invoke<void>("open_devtools"),

  /** 可用语言包列表（exe 同级 `lang/*.ini`）。 */
  listLanguages: () =>
    invoke<Array<{ id: string; name: string; code: string }>>("list_languages"),

  /** 当前 Windows 用户区域设置（BCP 47，例如 `zh-CN`）。 */
  systemLocale: () => invoke<string>("system_locale"),

  /** 检查最新 Release；没有新版本时返回 null。 */
  checkUpdate: (source: string) =>
    invoke<import("./types").UpdateInfo | null>("check_update", { source }),

  /** 读取指定版本的 release 正文。 */
  releaseNotes: (source: string, version: string) =>
    invoke<string>("release_notes", { source, version }),

  /** 下载更新，返回临时安装包路径。 */
  downloadUpdate: (source: string, version: string) =>
    invoke<string>("download_update", { source, version }),

  /** 取消当前更新下载。 */
  cancelUpdateDownload: () => invoke<void>("cancel_update_download"),

  /** 启动下载完成的安装包并退出应用。 */
  installUpdate: (path: string) => invoke<void>("install_update", { path }),

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