// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

//! 前后端共享的数据模型。

use serde::{Deserialize, Serialize};

/// 字体注册表所在的作用域。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// `HKEY_LOCAL_MACHINE\...\Fonts`，随系统分发或安装到系统字体目录。
    System,
    /// `HKEY_CURRENT_USER\...\Fonts`，仅当前用户可见。
    User,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::System => "system",
            Scope::User => "user",
        }
    }
}

/// 保护原因，前端据此渲染不同的标记与 tooltip 文案。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Protection {
    /// 未受保护，可以删除。
    None,
    /// 命中微软官方 Windows 10 / 11 字体列表。
    Official,
    /// 命中内置的“Windows 内置字体补充清单”。
    Core,
    /// `.fon` / `.fnt` 光栅字体，删除会破坏系统界面。
    Raster,
    /// 注册在 HKCU，但文件位于 `%WINDIR%\Fonts`，实际是共享的系统文件。
    SharedSystemFile,
}

impl Protection {
    pub fn as_str(self) -> &'static str {
        match self {
            Protection::None => "none",
            Protection::Official => "official",
            Protection::Core => "core",
            Protection::Raster => "raster",
            Protection::SharedSystemFile => "shared-system-file",
        }
    }

    pub fn is_protected(self) -> bool {
        !matches!(self, Protection::None)
    }
}

/// 一条字体记录 = 一个注册表值 + 它指向的字体文件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontEntry {
    /// 稳定 id：`{scope}:{valueName 小写}`。
    pub id: String,
    /// 注册表值名原文，例如 `Microsoft YaHei & Microsoft YaHei UI (TrueType)`。
    pub value_name: String,
    /// 去掉 `(TrueType)` 等后缀的注册表展示名。
    pub display_name: String,
    /// 字体家族名（来自 `name` 表，缺失时回退到注册表名）。
    pub family: String,
    /// 样式 / 子家族名。
    pub style: String,
    /// 完整名称。
    pub full_name: String,
    /// 主语言：中文 / 日文 / 英语 …（列表「语言」列显示这个）。
    pub language: String,
    /// 依据字形覆盖算出的全部语言，按常见度排序。
    pub languages: Vec<String>,
    /// 可变字体（含 fvar 表）。
    pub variable: bool,
    /// 可变字体 `wght` 轴下限（非可变字体为 0）。
    pub weight_min: u16,
    /// 可变字体 `wght` 轴上限（非可变字体为 0）。
    pub weight_max: u16,
    /// 等宽字体。
    pub monospace: bool,
    /// 含连字特性（GSUB 的 liga / clig）。
    pub ligatures: bool,
    pub scope: Scope,
    pub file_name: String,
    /// 解析后的绝对路径（`\` 分隔）。
    pub path: String,
    /// 字体文件是否仍然存在；false 表示注册表残留。
    pub exists: bool,
    /// 文件字节数，文件不存在时为 0。
    pub size: u64,
    /// 文件创建时间（Unix 秒）；读不到时回退修改时间，仍失败为 0。
    pub added_at: u64,
    /// `TrueType` / `OpenType` / `TrueType Collection` / `Raster` / `Unknown`。
    pub format: String,
    /// 该文件内所有 face 的家族名（TTC 会有多个）。
    pub families: Vec<String>,
    pub protected: bool,
    pub protection: Protection,
    /// 是否被列在 `Font Management\Inactive Fonts` 中。
    pub hidden: bool,
    /// 是否允许删除（受保护 / 系统作用域 / 共享系统文件都不允许）。
    pub deletable: bool,
    /// 删除是否需要管理员权限。
    pub requires_elevation: bool,
    /// 字体 `name` 表中的版本号。
    pub version: String,
    /// 字体 `name` 表中的版权信息。
    pub copyright: String,
}

/// `list_fonts` 的返回体，附带一次扫描的耗时用于状态栏展示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontListPayload {
    pub fonts: Vec<FontEntry>,
    pub scanned_ms: u64,
    pub locked_files: Vec<String>,
}

/// 隐藏 / 显示操作的结果。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HiddenReport {
    pub changed: usize,
    pub errors: Vec<String>,
}

/// 单条删除结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteItem {
    pub id: String,
    pub family: String,
    /// 注册表值是否被移除。
    pub registry_removed: bool,
    /// 字体文件是否被删除。
    pub file_removed: bool,
    /// 文件被 GDI / 其它进程锁定，已登记到待清理清单。
    pub file_locked: bool,
    pub error: Option<String>,
}

/// `delete_fonts` 的返回体。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteReport {
    pub items: Vec<DeleteItem>,
    /// 是否因为缺少管理员权限而没有执行任何删除。
    pub elevation_required: bool,
    /// 用户在 UAC 提示处取消。
    pub cancelled: bool,
    pub removed_count: usize,
    pub locked_count: usize,
    pub errors: Vec<String>,
}

/// 用户偏好，对应 `%USERPROFILE%\.FontFox\config.ini`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub view_mode: String,
    /// 预览文字：只存在于本次会话，不持久化（启动时为空）。
    pub preview_text: String,
    pub theme: String,
    /// 界面语言文件名（不含扩展名），例如 `schinese`。
    pub language: String,
    /// 右侧详情面板是否展开。
    #[serde(default = "default_true")]
    pub detail_open: bool,
    /// 字体禁用方式：`windows`（Inactive Fonts）或 `dynamic`（注销 + 隔离文件）。
    #[serde(default = "default_disable_mode")]
    pub disable_mode: String,
}

fn default_disable_mode() -> String {
    "windows".to_string()
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            view_mode: "compact".to_string(),
            preview_text: String::new(),
            theme: "system".to_string(),
            disable_mode: default_disable_mode(),
            language: "schinese".to_string(),
            detail_open: true,
        }
    }
}

/// 删除时文件被锁定、等待下次启动重试的条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDelete {
    pub path: String,
    pub label: String,
}
