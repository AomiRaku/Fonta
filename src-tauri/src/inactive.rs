// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

//! `Inactive Fonts` 的读写与匹配。
//!
//! 该值位于 `HKCU\Software\Microsoft\Windows NT\CurrentVersion\Font Management`，
//! 类型为 `REG_MULTI_SZ`，每行一个字体标识。Windows 没有公开 API，只能直接
//! 读写注册表；因为键在 HKCU 下，天然只影响当前用户，不会波及系统字体。
//!
//! 写入口径：使用**字体家族名**（与 Windows 字体设置页的粒度一致）。
//! 读取口径：家族名 / 完整名 / 注册表值名 / 文件名 任一命中即视为隐藏，
//! 这样即使某个 Windows 版本写入的是别的标识形式，UI 状态也不会失真。

use std::collections::HashSet;

use crate::model::{FontEntry, HiddenReport};
use crate::official::normalize;
use crate::registry::{read_inactive_fonts, write_inactive_fonts};

/// `Inactive Fonts` 的当前内容 + 归一化后的查找集合。
#[derive(Debug, Clone, Default)]
pub struct InactiveSet {
    raw: Vec<String>,
    keys: HashSet<String>,
}

impl InactiveSet {
    pub fn load() -> Self {
        let raw = read_inactive_fonts().unwrap_or_default();
        let keys = raw
            .iter()
            .map(|s| normalize(s))
            .filter(|s| !s.is_empty())
            .collect();
        Self { raw, keys }
    }

    pub fn raw(&self) -> &[String] {
        &self.raw
    }

    pub fn is_empty(&self) -> bool {
        self.raw.is_empty()
    }

    /// 用于比对的候选键：家族名、完整名、注册表值名、文件名。
    fn candidate_keys(entry: &FontEntry) -> Vec<String> {
        let mut out = Vec::with_capacity(4);
        for value in [
            &entry.family,
            &entry.full_name,
            &entry.display_name,
            &entry.file_name,
        ] {
            let key = normalize(value);
            if !key.is_empty() && !out.contains(&key) {
                out.push(key);
            }
        }
        out
    }

    pub fn contains(&self, entry: &FontEntry) -> bool {
        if self.keys.is_empty() {
            return false;
        }
        Self::candidate_keys(entry)
            .iter()
            .any(|k| self.keys.contains(k))
    }

    /// 隐藏时应写入的标识：优先家族名，其次注册表展示名，最后文件名。
    fn identifier_for(entry: &FontEntry) -> String {
        for value in [&entry.family, &entry.display_name, &entry.file_name] {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        entry.id.clone()
    }
}

/// 计算隐藏 / 显示后的新列表，并与当前值比较后写回。
fn apply<F>(mutate: F) -> Result<usize, String>
where
    F: FnOnce(&mut Vec<String>) -> usize,
{
    let mut items = read_inactive_fonts()?;
    let before = items.len();
    let changed = mutate(&mut items);
    if changed == 0 && items.len() == before {
        return Ok(0);
    }
    items.retain(|s| !s.trim().is_empty());
    write_inactive_fonts(&items)?;
    Ok(changed)
}

/// 把给定字体标记为隐藏。返回实际新增的条目数。
pub fn hide(entries: &[FontEntry]) -> Result<usize, String> {
    let mut wanted: Vec<String> = Vec::new();
    for entry in entries {
        let id = InactiveSet::identifier_for(entry);
        if !wanted.iter().any(|w| normalize(w) == normalize(&id)) {
            wanted.push(id);
        }
    }

    apply(|items| {
        let existing: HashSet<String> = items.iter().map(|s| normalize(s)).collect();
        let mut added = 0;
        for id in &wanted {
            if !existing.contains(&normalize(id)) {
                items.push(id.clone());
                added += 1;
            }
        }
        added
    })
}

/// 把给定字体从隐藏列表移除。返回实际移除的条目数。
pub fn show(entries: &[FontEntry]) -> Result<usize, String> {
    let keys: Vec<Vec<String>> = entries
        .iter()
        .map(InactiveSet::candidate_keys)
        .map(|keys| {
            // 去掉文件名键，避免误删恰好同名的其它条目？文件名同样唯一，保留。
            keys
        })
        .collect();

    apply(|items| {
        let before = items.len();
        items.retain(|item| {
            let key = normalize(item);
            !keys.iter().any(|candidates| candidates.contains(&key))
        });
        before - items.len()
    })
}

/// 批量设置隐藏状态。
pub fn set_hidden(entries: &[FontEntry], hidden: bool) -> HiddenReport {
    let mut report = HiddenReport::default();
    if entries.is_empty() {
        return report;
    }
    match if hidden { hide(entries) } else { show(entries) } {
        Ok(n) => report.changed = n,
        Err(err) => report.errors.push(err),
    }
    report
}

/// 删除字体时同步清理隐藏状态，避免留下指向已删字体的标识。
pub fn purge(entries: &[FontEntry]) {
    if entries.is_empty() {
        return;
    }
    let _ = show(entries);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Protection, Scope};

    fn entry(family: &str, full: &str, file: &str) -> FontEntry {
        FontEntry {
            id: format!("user:{}", family),
            value_name: format!("{} (TrueType)", family),
            display_name: family.to_string(),
            family: family.to_string(),
            style: "Regular".to_string(),
            full_name: full.to_string(),
            language: "英语".to_string(),
            languages: vec!["英语".to_string()],
            variable: false,
            monospace: false,
            ligatures: true,
            scope: Scope::User,
            file_name: file.to_string(),
            path: format!("C:\\fonts\\{}", file),
            exists: true,
            size: 1,
            added_at: 0,
            format: "TrueType".to_string(),
            families: vec![family.to_string()],
            protected: false,
            protection: Protection::None,
            hidden: false,
            deletable: true,
            requires_elevation: false,
            version: String::new(),
            copyright: String::new(),
        }
    }

    #[test]
    fn matches_on_any_identifier() {
        let set = InactiveSet {
            raw: vec!["Arial Unicode MS".to_string()],
            keys: ["arial unicode ms".to_string()].into_iter().collect(),
        };
        assert!(set.contains(&entry("Arial Unicode MS", "Arial Unicode MS", "ARIALUNI.TTF")));
        assert!(!set.contains(&entry("Arial", "Arial", "arial.ttf")));
    }

    #[test]
    fn identifier_prefers_family() {
        let e = entry("Foo Family", "Foo Family Regular", "foo.ttf");
        assert_eq!(InactiveSet::identifier_for(&e), "Foo Family");
    }
}