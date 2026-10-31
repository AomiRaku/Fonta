// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

//! 用户收藏与「字体单」。存成 `%USERPROFILE%\.FontFox\library.json`，
//! 和配置分离：配置是偏好，这里是用户攒下来的数据。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::config::{app_dir, ensure_dir};

const LIBRARY_FILE: &str = "library.json";

/// 一个字体单。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    /// 标记颜色（十六进制，不含 #）；字段缺失时为空。
    #[serde(default)]
    pub color: String,
    /// 字体 id 列表（`{scope}:{valueName 小写}`）。
    #[serde(default)]
    pub fonts: Vec<String>,
}

/// 收藏 + 字体单。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    #[serde(default)]
    pub favorites: Vec<String>,
    #[serde(default)]
    pub collections: Vec<Collection>,
}

/// `%USERPROFILE%\.FontFox\library.json`
pub fn library_file() -> PathBuf {
    app_dir().join(LIBRARY_FILE)
}

/// 读取；文件不存在或损坏时返回空库（损坏的文件改名留档，避免反复失败）。
pub fn load() -> Library {
    let path = library_file();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Library::default();
    };
    match serde_json::from_str::<Library>(&text) {
        Ok(mut library) => {
            library.favorites.retain(|id| !id.trim().is_empty());
            library.collections.retain(|c| !c.id.trim().is_empty());
            library
        }
        Err(_) => {
            let broken = path.with_extension("json.broken");
            let _ = std::fs::rename(&path, broken);
            Library::default()
        }
    }
}

/// 写入：先写临时文件再替换，避免中途崩溃留下半个文件。
pub fn save(library: &Library) -> Result<(), String> {
    ensure_dir().map_err(|err| format!("Unable to create config directory: {err}"))?;
    let text = serde_json::to_string_pretty(library).map_err(|err| format!("Serialization failed: {err}"))?;
    let path = library_file();
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|err| format!("Failed to write temporary file: {err}"))?;
    std::fs::rename(&tmp, &path).map_err(|err| format!("Failed to replace file: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_through_json() {
        let library = Library {
            favorites: vec!["user:arial".into()],
            collections: vec![Collection {
                id: "c1".into(),
                name: "标题字体".into(),
                color: "0084FF".into(),
                fonts: vec!["user:arial".into(), "system:微软雅黑".into()],
            }],
        };
        let text = serde_json::to_string(&library).unwrap();
        let back: Library = serde_json::from_str(&text).unwrap();
        assert_eq!(back.favorites, library.favorites);
        assert_eq!(back.collections.len(), 1);
        assert_eq!(back.collections[0].name, "标题字体");
    }

    #[test]
    fn missing_fields_default_to_empty() {
        let back: Library = serde_json::from_str("{}").unwrap();
        assert!(back.favorites.is_empty());
        assert!(back.collections.is_empty());
    }
}