// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

import { t } from "./i18n";

export type Scope = "system" | "user";

export type Protection =
  | "none"
  | "official"
  | "core"
  | "raster"
  | "shared-system-file";

/** 一个字体单：用户自定义的字体集合。 */
export interface Collection {
  /** 标记颜色（十六进制，不含 #）。 */
  color: string;
  id: string;
  name: string;
  /** 字体 id 列表 */
  fonts: string[];
}

/** 收藏 + 字体单，持久化在 `.FontFox/library.json`。 */
export interface Library {
  favorites: string[];
  collections: Collection[];
}

export const DEFAULT_LIBRARY: Library = { favorites: [], collections: [] };

/** 字体单数量上限。 */
export const MAX_COLLECTIONS = 20;

/** 侧栏当前视图。 */
export type SidebarView =
  | { kind: "all" }
  | { kind: "favorites" }
  | { kind: "hidden" }
  | { kind: "missing" }
  | { kind: "collection"; id: string };
export interface FontEntry {
  id: string;
  valueName: string;
  displayName: string;
  family: string;
  style: string;
  fullName: string;
  /** 主语言：中文 / 日文 / 英语 …（列表「语言」列显示这个）。 */
  language: string;
  /** 依据字形覆盖算出的全部语言，按常见度排序。 */
  languages: string[];
  /** 可变字体（含 fvar 表）。 */
  variable: boolean;
  /** 可变字体 `wght` 轴范围；非可变字体为 0。 */
  weightMin: number;
  weightMax: number;
  /** 等宽字体。 */
  monospace: boolean;
  /** 含连字特性（GSUB 的 liga / clig）。 */
  ligatures: boolean;
  scope: Scope;
  fileName: string;
  path: string;
  exists: boolean;
  size: number;
  /** 文件创建时间（Unix 秒），读不到时为 0。 */
  addedAt: number;
  format: string;
  families: string[];
  protected: boolean;
  protection: Protection;
  hidden: boolean;
  deletable: boolean;
  requiresElevation: boolean;
  version: string;
  copyright: string;
}

export interface FontListPayload {
  fonts: FontEntry[];
  scannedMs: number;
  lockedFiles: string[];
}

export interface HiddenReport {
  changed: number;
  errors: string[];
}

export interface DeleteItem {
  id: string;
  family: string;
  registryRemoved: boolean;
  fileRemoved: boolean;
  fileLocked: boolean;
  error: string | null;
}

export interface DeleteReport {
  items: DeleteItem[];
  elevationRequired: boolean;
  cancelled: boolean;
  removedCount: number;
  lockedCount: number;
  errors: string[];
}

export type ViewMode = "compact" | "preview";
/** system = 跟随系统；dark / light = 用户显式指定。 */
export type ThemeMode = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

/** 预览字号固定，不提供调节。 */
export const PREVIEW_FONT_SIZE = 24;

export interface Settings {
  /** 界面语言 id（对应 lang/<id>.ini）。 */
  language: string;
  viewMode: ViewMode;
  previewText: string;
  theme: ThemeMode;
  /** 右侧详情面板是否展开（持久化）。 */
  detailOpen: boolean;
  /** 字体禁用方式：windows（Inactive Fonts）或 dynamic（注销 + 隔离文件）。 */
  disableMode: DisableMode;
  /** 下次启动时应用的禁用方式；空串表示没有待应用变更。 */
  disableModeNext: DisableMode | "";
}

export type DisableMode = "windows" | "dynamic";


export interface AboutPayload {
  version: string;
  licenseName: string;
  licenseText: string;
  noticeText: string;
  configPath: string;
  pendingPath: string;
}

/** 预览文本为空时使用的默认文案（输入框留空 ≠ 没有预览文字）。 */
export function defaultPreviewText(): string {
  return t("preview.defaultText");
}

export const DEFAULT_SETTINGS: Settings = {
  viewMode: "compact",
  previewText: "",
  theme: "system",
  language: "schinese",
  detailOpen: true,
  disableMode: "dynamic",
  disableModeNext: "",
};

const PROTECTION_KEYS: Record<Protection, string> = {
  none: "",
  official: "protection.official",
  core: "protection.core",
  raster: "protection.raster",
  "shared-system-file": "protection.sharedSystemFile",
};

/** 受保护原因的可读文案（跟随界面语言）。 */
export function protectionLabel(kind: Protection): string {
  const key = PROTECTION_KEYS[kind];
  return key ? t(key) : "";
}