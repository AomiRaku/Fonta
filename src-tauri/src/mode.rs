// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

//! 动态安装 / 卸载模式：把字体从系统字体表里真正摘掉。
//!
//! 与 `inactive` 的区别：这里的「禁用」会删除 `HKCU\...\Fonts` 下的注册表值，
//! 并把字体文件移到 `%USERPROFILE%\.FontFox\disabled\`。应用重启后（Adobe 系尤其）
//! 就看不到这些字体了；启用时再把文件移回、注册表值写回。
//!
//! 只处理用户作用域（HKCU）的字体：系统作用域的注册与文件都在 `C:\Windows\Fonts`，
//! 需要提权才能改动，风险也更大，因此动态模式下直接拒绝，由调用方提示用户。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config;
use crate::model::{FontEntry, Scope};
use crate::registry;

/// 一条被隔离的字体记录（`disabled.json`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisabledRecord {
    pub id: String,
    pub value_name: String,
    pub family: String,
    pub style: String,
    pub display_name: String,
    /// 原来的字体文件路径（启用时移回这里）。
    pub source_path: String,
    /// 当前所在隔离文件的路径。
    pub quarantine_path: String,
    pub size: u64,
}

/// 隔离目录：`%USERPROFILE%\.FontFox\disabled\`
pub fn quarantine_dir() -> PathBuf {
    config::app_dir().join("disabled")
}

/// 清单与字体文件放在同一个目录里，便于整体搬运或删除。
fn index_file() -> PathBuf {
    quarantine_dir().join("disabled.json")
}

pub fn records() -> Vec<DisabledRecord> {
    let Ok(text) = std::fs::read_to_string(index_file()) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save(records: &[DisabledRecord]) {
    let dir = quarantine_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(text) = serde_json::to_string_pretty(records) {
        let _ = std::fs::write(dir.join("disabled.json"), text);
    }
}

fn unique_target(file_name: &str) -> PathBuf {
    let dir = quarantine_dir();
    let stem = Path::new(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "font".to_string());
    let ext = Path::new(file_name)
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    let mut candidate = dir.join(format!("{stem}{ext}"));
    let mut index = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}-{index}{ext}"));
        index += 1;
    }
    candidate
}

/// 同盘移动；跨盘时退回「复制 + 删除」。
fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::copy(from, to)?;
            std::fs::remove_file(from)
        }
    }
}

/// 禁用：移文件 → 删注册表值。任何一步失败都会回滚已做的部分。
pub fn disable(entries: &[FontEntry]) -> Result<usize, String> {
    let mut records = records();
    let mut done = 0usize;
    let mut errors: Vec<String> = Vec::new();

    for entry in entries {
        if entry.scope != Scope::User {
            errors.push(format!(
                "“{}”位于系统作用域，动态模式暂不支持",
                entry.family
            ));
            continue;
        }
        let source = PathBuf::from(&entry.path);
        if !source.is_file() {
            errors.push(format!("“{}”的字体文件不存在", entry.family));
            continue;
        }
        let target = unique_target(&entry.file_name);
        if let Err(err) = move_file(&source, &target) {
            errors.push(format!("移动 “{}” 失败：{}", entry.family, err));
            continue;
        }
        if let Err(err) = registry::delete_font_value(entry.scope, &entry.value_name) {
            let _ = move_file(&target, &source);
            errors.push(err);
            continue;
        }
        records.push(DisabledRecord {
            id: entry.id.clone(),
            value_name: entry.value_name.clone(),
            family: entry.family.clone(),
            style: entry.style.clone(),
            display_name: entry.display_name.clone(),
            source_path: entry.path.clone(),
            quarantine_path: target.to_string_lossy().to_string(),
            size: entry.size,
        });
        done += 1;
    }

    save(&records);
    if done == 0 && !errors.is_empty() {
        return Err(errors.join("；"));
    }
    Ok(done)
}

/// 启用：文件移回原位 → 写回注册表值。
pub fn enable(ids: &[String]) -> Result<usize, String> {
    let mut records = records();
    let mut done = 0usize;
    let mut errors: Vec<String> = Vec::new();

    for id in ids {
        let Some(position) = records.iter().position(|record| &record.id == id) else {
            continue;
        };
        let record = records[position].clone();
        let source = PathBuf::from(&record.source_path);
        let quarantine = PathBuf::from(&record.quarantine_path);

        if let Err(err) = move_file(&quarantine, &source) {
            errors.push(format!("恢复 “{}” 失败：{}", record.family, err));
            continue;
        }
        if let Err(err) =
            registry::write_font_value(Scope::User, &record.value_name, &record.source_path)
        {
            let _ = move_file(&source, &quarantine);
            errors.push(err);
            continue;
        }
        records.remove(position);
        done += 1;
    }

    save(&records);
    if done == 0 && !errors.is_empty() {
        return Err(errors.join("；"));
    }
    Ok(done)
}

/// 恢复全部隔离字体（切换模式前调用）。
pub fn restore_all() -> usize {
    let ids: Vec<String> = records().into_iter().map(|record| record.id).collect();
    enable(&ids).unwrap_or_default()
}

/// 把隔离中的字体拼成 `FontEntry`，让列表里仍能看到并重新启用它们。
pub fn merged_entries(fonts: &mut Vec<FontEntry>) {
    for record in records() {
        if fonts.iter().any(|font| font.id == record.id) {
            continue;
        }
        let path = PathBuf::from(&record.quarantine_path);
        let exists = path.is_file();
        let size = if record.size > 0 {
            record.size
        } else {
            std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0)
        };
        fonts.push(FontEntry {
            id: record.id.clone(),
            value_name: record.value_name.clone(),
            display_name: record.display_name.clone(),
            family: record.family.clone(),
            style: record.style.clone(),
            full_name: record.display_name.clone(),
            language: String::new(),
            languages: Vec::new(),
            variable: false,
            monospace: false,
            ligatures: false,
            scope: Scope::User,
            file_name: path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default(),
            path: record.quarantine_path.clone(),
            exists,
            size,
            added_at: 0,
            format: "Unknown".to_string(),
            families: Vec::new(),
            protected: false,
            protection: crate::model::Protection::None,
            hidden: true,
            deletable: true,
            requires_elevation: false,
            version: String::new(),
            copyright: String::new(),
        });
    }
}
/// 隔离目录里多出来的文件（不在 `disabled.json` 里）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraFile {
    pub path: String,
    pub file_name: String,
    pub family: String,
    pub style: String,
}

/// 对账结果：目录里多出来的文件 / 清单里少掉的文件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    pub extra: Vec<ExtraFile>,
    pub missing: Vec<DisabledRecord>,
}

/// 用清单与隔离目录对账（启动时调用）。
pub fn reconcile() -> ReconcileReport {
    let records = records();
    let dir = quarantine_dir();
    let mut extra: Vec<ExtraFile> = Vec::new();

    let known: Vec<String> = records
        .iter()
        .filter_map(|record| {
            Path::new(&record.quarantine_path)
                .file_name()
                .map(|name| name.to_string_lossy().to_lowercase())
        })
        .collect();

    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            // 清单文件自身不算字体
            if path
                .file_name()
                .map(|name| name.to_string_lossy() == "disabled.json")
                .unwrap_or(false)
            {
                continue;
            }
            let file_name = path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            if known.contains(&file_name.to_lowercase()) {
                continue;
            }
            let stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let meta = crate::parse::read_meta(&path, &stem);
            extra.push(ExtraFile {
                path: path.to_string_lossy().to_string(),
                file_name,
                family: meta
                    .as_ref()
                    .map(|m| m.family.clone())
                    .filter(|f| !f.is_empty())
                    .unwrap_or(stem),
                style: meta.map(|m| m.style).unwrap_or_default(),
            });
        }
    }

    let missing: Vec<DisabledRecord> = records
        .into_iter()
        .filter(|record| !Path::new(&record.quarantine_path).is_file())
        .collect();

    ReconcileReport { extra, missing }
}

/// 把多出来的文件收编成禁用记录（原路径按用户字体目录 + 文件名推断）。
pub fn adopt(paths: &[String]) -> usize {
    let mut records = records();
    let mut added = 0usize;
    for raw in paths {
        let path = PathBuf::from(raw);
        if !path.is_file() {
            continue;
        }
        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let meta = crate::parse::read_meta(&path, &stem);
        let family = meta
            .as_ref()
            .map(|m| m.family.clone())
            .filter(|f| !f.is_empty())
            .unwrap_or_else(|| stem.clone());
        let style = meta.as_ref().map(|m| m.style.clone()).unwrap_or_default();
        let value_name = if style.is_empty() {
            format!("{} (TrueType)", family)
        } else {
            format!("{} {} (TrueType)", family, style)
        };
        let id = format!("user:{}", value_name.to_lowercase());
        if records.iter().any(|record| record.id == id) {
            continue;
        }
        let source_path = crate::registry::user_font_dir().join(&file_name);
        records.push(DisabledRecord {
            id,
            value_name,
            family,
            style,
            display_name: stem,
            source_path: source_path.to_string_lossy().to_string(),
            quarantine_path: raw.clone(),
            size: std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0),
        });
        added += 1;
    }
    save(&records);
    added
}

/// 删除文件已丢失的记录（用户确认后调用）。
pub fn drop_missing(ids: &[String]) -> usize {
    let mut records = records();
    let before = records.len();
    records.retain(|record| !ids.iter().any(|id| id == &record.id));
    let removed = before - records.len();
    save(&records);
    removed
}
