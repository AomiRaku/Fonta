// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

//! 保护判定。
//!
//! 判定完全离线，依赖两份独立维护的内置清单：
//!
//! 1. `data/system_fonts.json` —— Windows 系统字体兼容清单，仅包含字体
//!    家族名与文件名，按文件名 + 家族名匹配；
//! 2. `data/core_fonts.json` —— 手工维护的补充清单，覆盖主清单遗漏的
//!    随系统分发字体（光栅字体、语言包字体、Noto CJK 等）。
//!
//! 只有 HKLM 作用域的字体可能被判定为“受保护”；HKCU 字体永远可删除。

use std::collections::HashSet;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::model::{Protection, Scope};

const SYSTEM_JSON: &str = include_str!("data/system_fonts.json");
const CORE_JSON: &str = include_str!("data/core_fonts.json");

#[derive(Deserialize)]
struct SystemFontRow {
    family: String,
    file: String,
    #[serde(default)]
    names: Vec<String>,
}

#[derive(Deserialize)]
struct CoreList {
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    families: Vec<String>,
}

pub struct ProtectionIndex {
    system_files: HashSet<String>,
    system_families: HashSet<String>,
    core_files: HashSet<String>,
    core_families: HashSet<String>,
}

impl ProtectionIndex {
    fn load() -> Self {
        let rows: Vec<SystemFontRow> =
            serde_json::from_str(SYSTEM_JSON).expect("system_fonts.json 结构损坏");
        let core: CoreList = serde_json::from_str(CORE_JSON).expect("core_fonts.json 结构损坏");

        let mut system_files = HashSet::with_capacity(rows.len());
        let mut system_families = HashSet::with_capacity(rows.len() * 2);
        for row in &rows {
            system_files.insert(normalize(&row.file));
            system_families.insert(normalize(&row.family));
            for name in &row.names {
                system_families.insert(normalize(name));
            }
        }

        Self {
            system_files,
            system_families,
            core_files: core.files.iter().map(|f| normalize(f)).collect(),
            core_families: core.families.iter().map(|f| normalize(f)).collect(),
        }
    }

    pub fn counts(&self) -> (usize, usize) {
        (self.system_files.len(), self.core_files.len())
    }
}

pub fn index() -> &'static ProtectionIndex {
    static INDEX: OnceLock<ProtectionIndex> = OnceLock::new();
    INDEX.get_or_init(ProtectionIndex::load)
}

/// 归一化：小写、去多余空白、去 `(TrueType)` 类后缀。
pub fn normalize(input: &str) -> String {
    let mut s = input.trim().to_lowercase();
    for suffix in [
        " (truetype collection)",
        " (truetype)",
        " (opentype)",
        " (postscript)",
        " (all res)",
        " (bitmap)",
    ] {
        if s.ends_with(suffix) {
            let cut = s.len() - suffix.len();
            s.truncate(cut);
            break;
        }
    }
    let mut out = String::with_capacity(s.len());
    let mut last_space = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !last_space && !out.is_empty() {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(ch);
            last_space = false;
        }
    }
    out.trim_end().to_string()
}

/// 判定字体是否受保护：优先看文件所有权，无法判断时用系统字体清单兜底。
///
/// * `file_name` —— 注册表 Data 指向的文件名；
/// * `family_names` —— 字体文件内的全部家族名（TTC 可能有多个）以及完整名；
/// * `is_raster` —— 是否为 `.fon` / `.fnt` 光栅字体。
pub fn evaluate(
    scope: Scope,
    system_owned: bool,
    file_name: &str,
    family_names: &[String],
    is_raster: bool,
) -> Protection {
    if scope == Scope::User {
        return Protection::None;
    }

    // 文件所有权是最可靠的信号：随系统分发的字体属于 TrustedInstaller / SYSTEM，
    // 第三方字体（哪怕装进 C:\Windows\Fonts）不会。这个判断不依赖任何清单，
    // 所以系统升级新增的字体也能自动识别。
    if system_owned {
        return Protection::System;
    }

    let idx = index();
    let file_key = normalize(file_name);
    let family_keys: Vec<String> = family_names.iter().map(|f| normalize(f)).collect();

    if idx.system_files.contains(&file_key)
        || family_keys.iter().any(|f| idx.system_families.contains(f))
    {
        return Protection::System;
    }

    if is_raster || file_key.ends_with(".fon") || file_key.ends_with(".fnt") {
        return Protection::Raster;
    }

    if idx.core_files.contains(&file_key)
        || family_keys.iter().any(|f| idx.core_families.contains(f))
    {
        return Protection::Core;
    }

    Protection::None
}

/// 保护原因的英文键 → 中文说明（用于详情面板与 tooltip）。
pub fn describe(protection: Protection) -> &'static str {
    match protection {
        Protection::None => "",
        Protection::System => "系统自带字体",
        Protection::Core => "系统字体",
        Protection::Raster => "系统点阵字体",
        Protection::SharedSystemFile => "字体文件位于系统字体目录",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_registry_names() {
        assert_eq!(normalize("Arial (TrueType)"), "arial");
        assert_eq!(normalize("  Microsoft  YaHei "), "microsoft yahei");
    }

    #[test]
    fn system_list_is_loaded() {
        let (system, core) = index().counts();
        assert!(system > 100, "系统字体清单为空");
        assert!(core > 10, "补充清单为空");
    }

    #[test]
    fn protects_arial() {
        let p = evaluate(Scope::System, false, "Arial.ttf", &["Arial".to_string()], false);
        assert_eq!(p, Protection::System);
    }

    #[test]
    fn protects_supplementary_system_fonts() {
        // MT Extra 是随 Office / Windows 分发的数学符号字体，主清单未覆盖，
        // 只能靠内置补充清单保护。
        let extra = evaluate(
            Scope::System,
            false,
            "mtextra.ttf",
            &["MT Extra".to_string()],
            false,
        );
        assert_eq!(extra, Protection::Core);

        let nirmala = evaluate(
            Scope::System,
            false,
            "Nirmala.ttf",
            &["Nirmala UI".to_string()],
            false,
        );
        assert!(
            matches!(nirmala, Protection::System | Protection::Core),
            "Nirmala UI 必须被保护，实际为 {:?}",
            nirmala
        );
    }

    #[test]
    fn system_owned_file_is_protected_without_lists() {
        // 清单里没有、名字也不像系统字体，但文件归 TrustedInstaller 所有
        let p = evaluate(
            Scope::System,
            true,
            "SomeNewOsFont.ttf",
            &["Some New OS Font".to_string()],
            false,
        );
        assert_eq!(p, Protection::System);
    }

    #[test]
    fn user_scope_is_never_protected() {
        let p = evaluate(Scope::User, true, "Arial.ttf", &["Arial".to_string()], false);
        assert_eq!(p, Protection::None);
    }

    #[test]
    fn third_party_machine_font_is_deletable() {
        let p = evaluate(
            Scope::System,
            false,
            "MyCustomFont.ttf",
            &["My Custom Font".to_string()],
            false,
        );
        assert_eq!(p, Protection::None);
    }
}
