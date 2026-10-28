// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

//! 字体枚举：注册表双源 + 文件系统 + `name` 表解析。

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Instant;

use rayon::prelude::*;

use crate::inactive::InactiveSet;
use crate::model::{FontEntry, FontListPayload, Protection, Scope};
use crate::official;
use crate::ownership;
use crate::parse;
use crate::registry;

struct RawEntry {
    scope: Scope,
    value_name: String,
    path: PathBuf,
}

fn is_raster_ext(path: &std::path::Path) -> bool {
    matches!(
        path.extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .as_deref(),
        Some("fon") | Some("fnt")
    )
}

fn collect_scope(scope: Scope, out: &mut Vec<RawEntry>) -> Vec<String> {
    let mut errors = Vec::new();
    match registry::read_font_values(scope) {
        Ok(values) => {
            for value in values {
                let path = registry::resolve_font_path(scope, &value.data);
                out.push(RawEntry {
                    scope,
                    value_name: value.name,
                    path,
                });
            }
        }
        Err(err) => errors.push(format!("读取 {} 字体注册表失败：{}", scope.as_str(), err)),
    }
    errors
}

/// 全量扫描。
///
/// 性能目标：500+ 字体在 1–2 秒内完成（解析在 rayon 线程池上并行）。
pub fn scan() -> FontListPayload {
    let started = Instant::now();

    let mut raw: Vec<RawEntry> = Vec::new();
    let mut errors = collect_scope(Scope::System, &mut raw);
    let user_start = raw.len();
    errors.extend(collect_scope(Scope::User, &mut raw));

    // HKCU 里可能重复注册了同一份系统字体文件（同路径不同作用域），
    // 这种情况下保留系统作用域那条，避免同一字体出现两行。
    let system_paths: HashSet<String> = raw[..user_start]
        .iter()
        .map(|r| r.path.to_string_lossy().to_lowercase())
        .collect();
    raw = {
        let mut kept = Vec::with_capacity(raw.len());
        for (idx, entry) in raw.into_iter().enumerate() {
            if idx >= user_start {
                let key = entry.path.to_string_lossy().to_lowercase();
                if system_paths.contains(&key) {
                    continue;
                }
            }
            kept.push(entry);
        }
        kept
    };

    let inactive = InactiveSet::load();
    let system_dir = registry::system_font_dir()
        .as_os_str()
        .to_string_lossy()
        .to_lowercase();

    let mut fonts: Vec<FontEntry> = raw
        .par_iter()
        .map(|raw| {
            let display_name = registry::strip_type_suffix(&raw.value_name);
            let file_name = raw
                .path
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_default();
            let raster = is_raster_ext(&raw.path);
            let metadata = std::fs::metadata(&raw.path).ok();
            let exists = metadata.is_some();
            let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
            // 安装时间：优先创建时间，退而求其次用修改时间；都没有就是 0
            let added_at = metadata
                .as_ref()
                .and_then(|m| m.created().or_else(|_| m.modified()).ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs())
                .unwrap_or(0);

            let meta = if exists && !raster {
                parse::read_meta(&raw.path, &display_name)
            } else {
                None
            };

            let family = meta
                .as_ref()
                .map(|m| m.family.clone())
                .filter(|f| !f.is_empty())
                .unwrap_or_else(|| display_name.clone());
            let style = meta
                .as_ref()
                .map(|m| m.style.clone())
                .unwrap_or_default();
            let full_name = meta
                .as_ref()
                .map(|m| m.full_name.clone())
                .filter(|f| !f.is_empty())
                .unwrap_or_else(|| display_name.clone());
            let families = meta
                .as_ref()
                .map(|m| m.families.clone())
                .filter(|f| !f.is_empty())
                .unwrap_or_else(|| vec![family.clone()]);

            let path_key = raw.path.to_string_lossy().to_lowercase();
            let shared_system_file = raw.scope == Scope::User && path_key.starts_with(&system_dir);

            let mut family_names: Vec<String> = families.clone();
            family_names.push(full_name.clone());
            family_names.push(display_name.clone());

            let mut protection = if shared_system_file {
                Protection::SharedSystemFile
            } else {
                // 只有系统作用域才值得去查文件所有权（用户字体永远可删）
                let system_owned =
                    exists && raw.scope == Scope::System && ownership::is_system_owned(&raw.path);
                official::evaluate(raw.scope, system_owned, &file_name, &family_names, raster)
            };
            if !exists {
                // 文件都不在了，删除只剩清理注册表，不算危险操作。
                protection = Protection::None;
            }

            let language = meta
                .as_ref()
                .map(|m| m.language.clone())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "未知".to_string());

            let format = if raster {
                "Raster".to_string()
            } else {
                meta.as_ref()
                    .map(|m| m.format.clone())
                    .unwrap_or_else(|| "Unknown".to_string())
            };

            let mut entry = FontEntry {
                id: format!("{}:{}", raw.scope.as_str(), raw.value_name.to_lowercase()),
                value_name: raw.value_name.clone(),
                display_name,
                family,
                style,
                full_name,
                language,
                languages: meta
                    .as_ref()
                    .map(|m| m.languages.clone())
                    .unwrap_or_default(),
                variable: meta.as_ref().map(|m| m.variable).unwrap_or(false),
                monospace: meta.as_ref().map(|m| m.monospace).unwrap_or(false),
                ligatures: meta.as_ref().map(|m| m.ligatures).unwrap_or(false),
                scope: raw.scope,
                file_name,
                path: raw.path.as_os_str().to_string_lossy().to_string(),
                exists,
                size,
                added_at,
                format,
                families,
                protected: protection.is_protected(),
                protection,
                hidden: false,
                deletable: !protection.is_protected(),
                requires_elevation: raw.scope == Scope::System,
                version: meta.as_ref().map(|m| m.version.clone()).unwrap_or_default(),
                copyright: meta
                    .as_ref()
                    .map(|m| m.copyright.clone())
                    .unwrap_or_default(),
            };
            entry.hidden = inactive.contains(&entry);
            entry
        })
        .collect();

    fonts.sort_by(|a, b| {
        let ka = a.family.to_lowercase();
        let kb = b.family.to_lowercase();
        ka.cmp(&kb)
            .then_with(|| a.style.to_lowercase().cmp(&b.style.to_lowercase()))
            .then_with(|| a.value_name.cmp(&b.value_name))
    });

    FontListPayload {
        fonts,
        scanned_ms: started.elapsed().as_millis() as u64,
        locked_files: errors,
    }
}