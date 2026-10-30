// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

//! 删除：注册表 Value + 字体文件，处理 GDI 文件锁定。
//!
//! 顺序固定为「先注册表、后文件」：即使文件被会话锁定，注册表已经清干净，
//! 重启后系统不会再加载该字体；被锁定的文件进入待清理清单，下次启动重试。

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::inactive;
use crate::model::{DeleteItem, DeleteReport, FontEntry, PendingDelete, Protection, Scope};
use crate::registry;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileDeleteOutcome {
    Removed,
    Missing,
    Locked,
    Denied,
}

/// 待清理清单文件：`%USERPROFILE%\.FontFox\pending-delete.json`
pub fn pending_file() -> std::path::PathBuf {
    registry::app_data_dir().join("pending-delete.json")
}

fn load_pending() -> Vec<PendingDelete> {
    let path = pending_file();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_pending(items: &[PendingDelete]) {
    let path = pending_file();
    if items.is_empty() {
        let _ = std::fs::remove_file(&path);
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(items) {
        let _ = std::fs::write(&path, text);
    }
}

fn register_pending(path: &Path, label: &str) {
    let mut items = load_pending();
    let key = path.to_string_lossy().to_lowercase();
    if items
        .iter()
        .any(|i| i.path.to_lowercase() == key)
    {
        return;
    }
    items.push(PendingDelete {
        path: path.to_string_lossy().to_string(),
        label: label.to_string(),
    });
    save_pending(&items);
}

/// 待清理清单（供 UI 展示）。
pub fn pending_items() -> Vec<PendingDelete> {
    load_pending()
}

fn try_remove_file(path: &Path) -> FileDeleteOutcome {
    if !path.exists() {
        return FileDeleteOutcome::Missing;
    }
    match std::fs::remove_file(path) {
        Ok(()) => FileDeleteOutcome::Removed,
        Err(err) => {
            // 只读属性也常导致失败，清除后再试一次。
            if let Ok(metadata) = std::fs::metadata(path) {
                let mut perms = metadata.permissions();
                if perms.readonly() {
                    #[allow(clippy::permissions_set_readonly_false)]
                    perms.set_readonly(false);
                    let _ = std::fs::set_permissions(path, perms);
                    if std::fs::remove_file(path).is_ok() {
                        return FileDeleteOutcome::Removed;
                    }
                }
            }
            const ERROR_SHARING_VIOLATION: i32 = 32;
            const ERROR_LOCK_VIOLATION: i32 = 33;
            const ERROR_ACCESS_DENIED: i32 = 5;
            // 预览 mmap / 其它进程仍映射着文件；按锁定处理，交给待清理清单
            const ERROR_USER_MAPPED_FILE: i32 = 1224;
            match err.raw_os_error() {
                Some(ERROR_SHARING_VIOLATION)
                | Some(ERROR_LOCK_VIOLATION)
                | Some(ERROR_USER_MAPPED_FILE) => FileDeleteOutcome::Locked,
                Some(ERROR_ACCESS_DENIED) => FileDeleteOutcome::Denied,
                _ => FileDeleteOutcome::Denied,
            }
        }
    }
}

/// 删除一批字体。
///
/// `elevated` 表示当前进程是否已提权；删除 HKLM 字体必须提权。
/// 受保护字体与「HKCU 但文件在系统字体目录」的条目一律拒绝。
pub fn delete_entries(entries: &[FontEntry], elevated: bool) -> DeleteReport {
    let mut report = DeleteReport::default();
    let mut to_purge: Vec<FontEntry> = Vec::new();

    for entry in entries {
        let mut item = DeleteItem {
            id: entry.id.clone(),
            family: entry.family.clone(),
            registry_removed: false,
            file_removed: false,
            file_locked: false,
            error: None,
        };

        if entry.protection != Protection::None {
            item.error = Some(format!(
                "“{}”是受保护字体（{}），已跳过。",
                entry.family,
                crate::official::describe(entry.protection)
            ));
            report.errors.push(item.error.clone().unwrap_or_default());
            report.items.push(item);
            continue;
        }

        if entry.scope == Scope::System && !elevated {
            report.elevation_required = true;
            item.error = Some("删除系统作用域字体需要管理员权限。".to_string());
            report.items.push(item);
            continue;
        }

        let path = Path::new(&entry.path);

        // 1. 注册表
        match registry::delete_font_value(entry.scope, &entry.value_name) {
            Ok(removed) => item.registry_removed = removed,
            Err(err) => {
                item.error = Some(err.clone());
                report.errors.push(err);
                report.items.push(item);
                continue;
            }
        }

        // 2. 文件
        if entry.exists {
            match try_remove_file(path) {
                FileDeleteOutcome::Removed | FileDeleteOutcome::Missing => item.file_removed = true,
                FileDeleteOutcome::Locked | FileDeleteOutcome::Denied => {
                    item.file_locked = true;
                    register_pending(path, &entry.family);
                }
            }
        }

        // 3. 隐藏状态
        to_purge.push(entry.clone());

        if item.registry_removed || item.file_removed {
            report.removed_count += 1;
        }
        if item.file_locked {
            report.locked_count += 1;
        }
        report.items.push(item);
    }

    if !to_purge.is_empty() {
        inactive::purge(&to_purge);
        std::thread::spawn(crate::fontchange::broadcast);
    }

    report
}

/// 只清理注册表残留（文件已经不存在的条目）。
pub fn clean_missing(entries: &[FontEntry]) -> DeleteReport {
    let mut report = DeleteReport::default();
    let mut to_purge: Vec<FontEntry> = Vec::new();

    for entry in entries {
        if entry.exists {
            continue;
        }
        let mut item = DeleteItem {
            id: entry.id.clone(),
            family: entry.family.clone(),
            registry_removed: false,
            file_removed: false,
            file_locked: false,
            error: None,
        };
        match registry::delete_font_value(entry.scope, &entry.value_name) {
            Ok(removed) => {
                item.registry_removed = removed;
                if removed {
                    report.removed_count += 1;
                }
                to_purge.push(entry.clone());
            }
            Err(err) => {
                item.error = Some(err.clone());
                report.errors.push(err);
            }
        }
        report.items.push(item);
    }

    if !to_purge.is_empty() {
        inactive::purge(&to_purge);
    }
    report
}

/// 启动时重试待清理清单，返回成功删除的数量。
pub fn retry_pending() -> usize {
    let items = load_pending();
    if items.is_empty() {
        return 0;
    }
    let mut remaining = Vec::new();
    let mut removed = 0usize;
    for item in items {
        let path = Path::new(&item.path);
        match try_remove_file(path) {
            FileDeleteOutcome::Removed => removed += 1,
            FileDeleteOutcome::Missing => {}
            _ => remaining.push(item),
        }
    }
    save_pending(&remaining);
    if removed > 0 {
        std::thread::spawn(crate::fontchange::broadcast);
    }
    removed
}

/// 提权删除的请求体（由主进程写入临时文件，提权子进程读取）。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevationRequest {
    pub ids: Vec<String>,
}

/// 提权删除的结果体。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevationResponse {
    pub report: Option<DeleteReport>,
    pub error: Option<String>,
}

/// 提权子进程入口：读取请求文件、执行删除、把结果写回同名 `.report.json`。
pub fn run_elevated_request(request_path: &Path) -> i32 {
    let response_path = elevation_response_path(request_path);
    let result = (|| -> Result<DeleteReport, String> {
        let text =
            std::fs::read_to_string(request_path).map_err(|e| format!("读取提权请求失败：{}", e))?;
        let request: ElevationRequest =
            serde_json::from_str(&text).map_err(|e| format!("提权请求格式错误：{}", e))?;
        let payload = crate::enumerate::scan();
        let wanted: std::collections::HashSet<String> = request.ids.into_iter().collect();
        let entries: Vec<FontEntry> = payload
            .fonts
            .into_iter()
            .filter(|f| wanted.contains(&f.id))
            .collect();
        if entries.is_empty() {
            return Err("未找到待删除的字体条目。".to_string());
        }
        Ok(delete_entries(&entries, true))
    })();

    let payload = match result {
        Ok(report) => ElevationResponse {
            report: Some(report),
            error: None,
        },
        Err(err) => ElevationResponse {
            report: None,
            error: Some(err),
        },
    };
    let _ = std::fs::write(
        &response_path,
        serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string()),
    );
    0
}

pub fn elevation_response_path(request_path: &Path) -> std::path::PathBuf {
    request_path.with_extension("report.json")
}

pub fn read_elevation_response(path: &Path) -> Result<DeleteReport, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("提权进程未返回结果：{}", e))?;
    let parsed: ElevationResponse =
        serde_json::from_str(&text).map_err(|e| format!("提权结果格式错误：{}", e))?;
    match (parsed.report, parsed.error) {
        (Some(report), _) => Ok(report),
        (None, Some(err)) => Err(err),
        _ => Err("提权进程返回了空结果。".to_string()),
    }
}
