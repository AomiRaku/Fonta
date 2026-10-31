// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

//! 动态卸载模式：注销用户字体并把文件移入隔离目录。
//! 只处理 HKCU 用户字体。

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

fn save(records: &[DisabledRecord]) -> Result<(), String> {
    let dir = quarantine_dir();
    std::fs::create_dir_all(&dir).map_err(|err| format!("Unable to create disabled directory: {err}"))?;
    let text = serde_json::to_string_pretty(records)
        .map_err(|err| format!("Unable to serialize disabled list: {err}"))?;
    std::fs::write(dir.join("disabled.json"), text)
        .map_err(|err| format!("Unable to write disabled list: {err}"))
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

/// 禁用：移文件 → 删注册表值。先做预检；执行中任何一步失败，回滚本次已做的全部改动并返回错误。
pub fn disable(entries: &[FontEntry]) -> Result<usize, String> {
    // 预检：作用域与文件存在性，避免做到一半才发现必然失败
    let mut preflight: Vec<String> = Vec::new();
    for entry in entries {
        if entry.scope != Scope::User {
            preflight.push(format!("“{}” is in system scope; dynamic mode does not support it", entry.family));
            continue;
        }
        if !PathBuf::from(&entry.path).is_file() {
            preflight.push(format!("Font file for “{}” does not exist", entry.family));
        }
    }
    if !preflight.is_empty() {
        return Err(preflight.join("；"));
    }

    let mut records = records();
    let mut applied: Vec<DisabledRecord> = Vec::new();

    for entry in entries {
        let source = PathBuf::from(&entry.path);
        let target = unique_target(&entry.file_name);
        if let Err(err) = move_file(&source, &target) {
            rollback_disable(&applied);
            return Err(format!(
                "Failed to move “{}”: {}; changes were rolled back",
                entry.family, err
            ));
        }
        if let Err(err) = registry::delete_font_value(entry.scope, &entry.value_name) {
            let _ = move_file(&target, &source);
            rollback_disable(&applied);
            return Err(format!("{}; changes were rolled back", err));
        }
        applied.push(DisabledRecord {
            id: entry.id.clone(),
            value_name: entry.value_name.clone(),
            family: entry.family.clone(),
            style: entry.style.clone(),
            display_name: entry.display_name.clone(),
            source_path: entry.path.clone(),
            quarantine_path: target.to_string_lossy().to_string(),
            size: entry.size,
        });
    }

    records.extend(applied.iter().cloned());
    if let Err(err) = save(&records) {
        rollback_disable(&applied);
        return Err(err);
    }
    Ok(applied.len())
}

/// 回滚本次已禁用的字体：文件移回原路径，并写回注册表值。
fn rollback_disable(applied: &[DisabledRecord]) {
    for record in applied.iter().rev() {
        let source = PathBuf::from(&record.source_path);
        let quarantine = PathBuf::from(&record.quarantine_path);
        let _ = move_file(&quarantine, &source);
        let _ = registry::write_font_value(Scope::User, &record.value_name, &record.source_path);
    }
}

/// 启用：文件移回原位 → 写回注册表值。任一失败时回滚本次已恢复的条目并返回错误。
pub fn enable(ids: &[String]) -> Result<usize, String> {
    let mut records = records();
    let missing: Vec<String> = ids
        .iter()
        .filter(|id| !records.iter().any(|record| &record.id == *id))
        .cloned()
        .collect();
    if !missing.is_empty() {
        return Err(format!("The following fonts are not in the isolation list: {}", missing.join("、")));
    }

    let mut applied: Vec<DisabledRecord> = Vec::new();
    for id in ids {
        let Some(position) = records.iter().position(|record| &record.id == id) else {
            continue;
        };
        let record = records[position].clone();
        let source = PathBuf::from(&record.source_path);
        let quarantine = PathBuf::from(&record.quarantine_path);

        if let Err(err) = move_file(&quarantine, &source) {
            rollback_enable(&applied);
            return Err(format!(
                "Failed to restore “{}”: {}; changes were rolled back",
                record.family, err
            ));
        }
        if let Err(err) =
            registry::write_font_value(Scope::User, &record.value_name, &record.source_path)
        {
            let _ = move_file(&source, &quarantine);
            rollback_enable(&applied);
            return Err(format!("{}; changes were rolled back", err));
        }
        applied.push(record);
        records.remove(position);
    }

    if let Err(err) = save(&records) {
        rollback_enable(&applied);
        return Err(err);
    }
    Ok(applied.len())
}

/// 回滚本次已恢复的字体：删掉刚写回的注册表值，并把文件放回隔离目录。
fn rollback_enable(applied: &[DisabledRecord]) {
    for record in applied.iter().rev() {
        let source = PathBuf::from(&record.source_path);
        let quarantine = PathBuf::from(&record.quarantine_path);
        let _ = registry::delete_font_value(Scope::User, &record.value_name);
        let _ = move_file(&source, &quarantine);
    }
}
/// 查询若干 id 对应的隔离文件路径（删除隔离中的字体时使用真实路径）。
pub fn quarantine_paths(ids: &[String]) -> std::collections::HashMap<String, String> {
    records()
        .into_iter()
        .filter(|record| ids.iter().any(|id| id == &record.id))
        .map(|record| (record.id, record.quarantine_path))
        .collect()
}

/// 恢复全部隔离字体（切换模式前调用）。任何失败都会返回错误，由调用方决定是否继续。
pub fn restore_all() -> Result<usize, String> {
    let ids: Vec<String> = records().into_iter().map(|record| record.id).collect();
    if ids.is_empty() {
        return Ok(0);
    }
    enable(&ids)
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
            weight_min: 0,
            weight_max: 0,
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
    let _ = save(&records);
    added
}

/// 删除文件已丢失的记录（用户确认后调用）。
pub fn drop_missing(ids: &[String]) -> usize {
    let mut records = records();
    let before = records.len();
    records.retain(|record| !ids.iter().any(|id| id == &record.id));
    let removed = before - records.len();
    let _ = save(&records);
    removed
}
