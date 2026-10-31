// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

//! 界面语言包：外挂 `.ini`，源文件在项目根目录 `langBuild/`，构建时复制到 exe 同级 `lang/`。
//!
//! 查找顺序：
//! 1. 可执行文件同级的 `lang/<name>.ini`（由 `build.rs` 从 `langBuild/` 复制，也可直接手改）；
//! 2. 安装资源目录 `lang/<name>.ini`（NSIS 安装后）；
//! 3. 编译期内置的简体中文（文件缺失或损坏时不至于界面空白）。
//!
//! 文件结构：
//! ```ini
//! [meta]
//! LanguageName=简体中文
//! LanguageCode=zh-CN
//! Translator=羽梦千景 Raku Inkyetta
//!
//! [ui]
//! app.name=FontFox
//! ```

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Serialize;

/// 内置回退语言包。
#[cfg(test)]
const EMBEDDED: &str = include_str!("../../langBuild/zh-cn.ini");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguagePack {
    /// 语言文件名（不含扩展名）。
    pub id: String,
    /// `LanguageName` 字段。
    pub name: String,
    /// BCP 47 语言代码，例如 `zh-CN`。
    pub code: String,
    /// `Translator` 字段。
    pub translator: String,
    /// 扁平化的 `section.key` → 文本。
    pub entries: BTreeMap<String, String>,
}

/// 语言选择项：只暴露 id 与显示名。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageInfo {
    pub id: String,
    pub name: String,
    /// BCP 47 语言代码，例如 `zh-CN`。
    pub code: String,
}

/// 扫描 exe 同级 `lang/*.ini`（以及旧版的 exe 同级 `*.ini`），返回可选语言。
pub fn available() -> Vec<LanguageInfo> {
    use std::collections::BTreeMap;

    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.join("lang"));
            dirs.push(dir.to_path_buf());
        }
    }

    let mut found: BTreeMap<String, LanguageInfo> = BTreeMap::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| !ext.eq_ignore_ascii_case("ini"))
                .unwrap_or(true)
            {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            if found.contains_key(id) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let (meta, _) = parse(&text);
            let name = meta
                .get("languagename")
                .cloned()
                .unwrap_or_else(|| id.to_string());
            let code = meta
                .get("languagecode")
                .cloned()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| id.to_string());
            found.insert(
                id.to_string(),
                LanguageInfo {
                    id: id.to_string(),
                    name,
                    code,
                },
            );
        }
    }
    found.into_values().collect()
}
/// 把 `[section]` + `key=value` 展平成 `section.key`。
fn parse(text: &str) -> (BTreeMap<String, String>, BTreeMap<String, String>) {
    let mut entries = BTreeMap::new();
    let mut meta = BTreeMap::new();
    let mut section = String::from("ui");

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix('[') {
            if let Some(name) = rest.strip_suffix(']') {
                section = name.trim().to_string();
            }
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let value = value.trim().to_string();
        if section.eq_ignore_ascii_case("meta") {
            meta.insert(key.to_ascii_lowercase(), value);
        } else {
            // 段名保留原始大小写，避免 `[deleteCollection]` 这类驼峰段查不到
            entries.insert(format!("{}.{}", section, key), value);
        }
    }
    (meta, entries)
}

fn candidates(name: &str) -> Vec<PathBuf> {
    let file = format!("{name}.ini");
    let mut paths = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            paths.push(dir.join("lang").join(&file));
            paths.push(dir.join(&file));
        }
    }
    paths
}

/// 读取语言包。
///
/// 不做任何回退：语言文件缺失或某个键缺失时，界面直接显示键名（例如
/// `ctx.removeFromCollection`），方便一眼看出漏翻的地方。
pub fn load(name: &str) -> LanguagePack {
    let trimmed = name.trim();
    let id = if trimmed.is_empty() {
        "zh-cn".to_string()
    } else {
        trimmed.to_string()
    };

    let text = candidates(&id)
        .into_iter()
        .find_map(|path| std::fs::read_to_string(path).ok());

    // 缺文件时用空内容，界面上所有文案都会退化成键名，而不是静默变回中文
    let source = text.unwrap_or_default();
    let (meta, entries) = parse(&source);
    let code = meta
        .get("languagecode")
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| id.clone());
    let name = meta
        .get("languagename")
        .cloned()
        .unwrap_or_else(|| "简体中文".to_string());

    LanguagePack {
        id,
        name,
        code,
        translator: meta
            .get("translator")
            .cloned()
            .unwrap_or_else(|| "羽梦千景 Raku Inkyetta".to_string()),
        entries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_pack_has_meta_and_entries() {
        // 内置包不再作为运行时回退，只用来校验仓库里的语言文件本身完整
        let (meta, entries) = parse(EMBEDDED);
        assert_eq!(meta.get("languagename").map(String::as_str), Some("简体中文"));
        assert_eq!(meta.get("languagecode").map(String::as_str), Some("zh-CN"));
        assert_eq!(entries.get("list.colName").map(String::as_str), Some("字体名称"));
        assert_eq!(entries.get("app.name").map(String::as_str), Some("FontFox"));
    }

    #[test]
    fn keeps_section_case() {
        let (_, entries) = parse("[deleteCollection]\nconfirm=确定吗？\n");
        assert_eq!(
            entries.get("deleteCollection.confirm").map(String::as_str),
            Some("确定吗？")
        );
    }

    #[test]
    fn missing_file_yields_empty_pack_instead_of_fallback() {
        // 不做回退：缺文件时条目为空，界面会显示键名
        let pack = load("does-not-exist");
        assert_eq!(pack.id, "does-not-exist");
        assert_eq!(pack.code, "does-not-exist");
        assert!(pack.entries.is_empty());
    }
}