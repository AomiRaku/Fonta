// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

//! 应用数据目录与配置读写，数据位于 `%USERPROFILE%\.FontFox\`。

use std::path::{Path, PathBuf};

use crate::model::Settings;

/// 配置目录名。
pub const DIR_NAME: &str = ".FontFox";
const CONFIG_FILE: &str = "config.ini";

/// `%USERPROFILE%\.FontFox`
pub fn app_dir() -> PathBuf {
    let profile = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .unwrap_or_else(|| std::ffi::OsString::from(r"C:\"));
    PathBuf::from(profile).join(DIR_NAME)
}

/// `%USERPROFILE%\.FontFox\config.ini`
pub fn config_file() -> PathBuf {
    app_dir().join(CONFIG_FILE)
}

/// 确保配置目录存在。
pub fn ensure_dir() -> std::io::Result<PathBuf> {
    let dir = app_dir();
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 极简 INI 读取：忽略 `[section]`、注释与空行，取 `key=value`。
fn parse_ini(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('[') || line.starts_with('#') || line.starts_with(';')
        {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        out.push((key.to_string(), value.trim().to_string()));
    }
    out
}

fn entry<'a>(entries: &'a [(String, String)], key: &str) -> Option<&'a str> {
    entries
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.as_str())
}

pub fn load() -> Settings {
    let mut settings = Settings::default();
    let Ok(text) = std::fs::read_to_string(config_file()) else {
        return settings;
    };
    let entries = parse_ini(&text);

    if let Some(v) = entry(&entries, "ViewMode") {
        settings.view_mode = v.to_string();
    }
    if let Some(v) = entry(&entries, "Theme") {
        settings.theme = v.to_string();
    }
    if let Some(v) = entry(&entries, "Language") {
        settings.language = v.to_string();
    }
    if let Some(v) = entry(&entries, "AutoCheckUpdates") {
        settings.auto_check_updates = v.eq_ignore_ascii_case("true");
    }
    if let Some(v) = entry(&entries, "UpdateSource") {
        settings.update_source = v.to_string();
    }
    if let Some(v) = entry(&entries, "IgnoredUpdateVersion") {
        settings.ignored_update_version = v.to_string();
    }
    // 预览文字只存在于本次会话，启动时为空。
    settings.preview_text = String::new();
    if let Some(v) = entry(&entries, "DetailOpen") {
        settings.detail_open = v.eq_ignore_ascii_case("true");
    }
    if let Some(v) = entry(&entries, "RowHover") {
        settings.row_hover = v.eq_ignore_ascii_case("true");
    }
    if let Some(v) = entry(&entries, "DisableMode") {
        settings.disable_mode = v.to_string();
    }
    if let Some(v) = entry(&entries, "DisableModeNext") {
        settings.disable_mode_next = v.to_string();
    }
    settings
}

/// 单行化：INI 是逐行解析的，预览文字里的换行会破坏文件结构。
fn one_line(value: &str) -> String {
    value.replace(['\r', '\n'], " ")
}

pub fn save(settings: &Settings) -> Result<(), String> {
    let dir = ensure_dir().map_err(|e| format!("Unable to create config directory: {}", e))?;
    let path = dir.join(CONFIG_FILE);
    let text = format!(
        "; FontFox 配置\r\n\
         ; 卸载或迁移时直接删除本目录即可\r\n\
         \r\n\
         [general]\r\n\
         ViewMode={}\r\n\
         Theme={}\r\n\
         Language={}\r\n\
         DetailOpen={}\r\n\
         RowHover={}\r\n\
         DisableMode={}\r\n\
         DisableModeNext={}\r\n\
         AutoCheckUpdates={}\r\n\
         UpdateSource={}\r\n\
         IgnoredUpdateVersion={}\r\n",
        one_line(&settings.view_mode),
        one_line(&settings.theme),
        one_line(&settings.language),
        settings.detail_open,
        settings.row_hover,
        one_line(&settings.disable_mode),
        one_line(&settings.disable_mode_next),
        settings.auto_check_updates,
        one_line(&settings.update_source),
        one_line(&settings.ignored_update_version),
    );
    write_atomic(&path, &text).map_err(|e| format!("Unable to write config: {}", e))
}

/// 先写临时文件再替换，避免写一半断电留下半个配置。
fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("ini.tmp");
    std::fs::write(&tmp, text.as_bytes())?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ini_lines() {
        let entries = parse_ini(
            "; comment\r\n[general]\r\nViewMode=preview\r\nTheme = dark\r\nEmpty=\r\nNoEquals\r\n",
        );
        assert_eq!(entry(&entries, "ViewMode"), Some("preview"));
        assert_eq!(entry(&entries, "theme"), Some("dark"));
        assert_eq!(entry(&entries, "Empty"), Some(""));
        assert_eq!(entry(&entries, "NoEquals"), None);
    }

    #[test]
    fn config_path_is_under_user_profile() {
        let dir = app_dir();
        assert!(dir.ends_with(DIR_NAME));
        assert!(config_file().ends_with(CONFIG_FILE));
    }
}