// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

//! 用户偏好：`%USERPROFILE%\.FontFox\config.ini`。
//!
//! 该文件是应用设置的唯一归属，卸载时删掉整个 `.FontFox` 目录即可。
//! 字体隐藏状态不在这里，因为那是用户对字体的功能状态，不属于应用设置。

use crate::config;
use crate::model::Settings;

const VIEW_MODES: [&str; 2] = ["compact", "preview"];
const THEMES: [&str; 3] = ["system", "dark", "light"];
const DISABLE_MODES: [&str; 2] = ["windows", "dynamic"];

/// 待应用的禁用方式：只接受已知值，且不能与当前生效值相同。
fn pick_optional_mode(value: &str, current: &str) -> String {
    if DISABLE_MODES.contains(&value) && value != current {
        value.to_string()
    } else {
        String::new()
    }
}

fn pick(value: &str, allowed: &[&str], fallback: &str) -> String {
    if allowed.contains(&value) {
        value.to_string()
    } else {
        fallback.to_string()
    }
}


pub fn load() -> Settings {
    let mut settings = config::load();
    let defaults = Settings::default();

    settings.view_mode = pick(&settings.view_mode, &VIEW_MODES, &defaults.view_mode);
    settings.theme = pick(&settings.theme, &THEMES, &defaults.theme);
    settings.disable_mode = pick(&settings.disable_mode, &DISABLE_MODES, &defaults.disable_mode);
    settings.disable_mode_next = pick_optional_mode(&settings.disable_mode_next, &settings.disable_mode);
    if settings.language.trim().is_empty() {
        settings.language = defaults.language;
    }
    settings
}

pub fn save(settings: &Settings) -> Result<(), String> {
    let defaults = Settings::default();
    let mut normalized = settings.clone();
    normalized.view_mode = pick(&settings.view_mode, &VIEW_MODES, &defaults.view_mode);
    normalized.theme = pick(&settings.theme, &THEMES, &defaults.theme);
    normalized.disable_mode = pick(&settings.disable_mode, &DISABLE_MODES, &defaults.disable_mode);
    normalized.disable_mode_next =
        pick_optional_mode(&settings.disable_mode_next, &normalized.disable_mode);
    if normalized.language.trim().is_empty() {
        normalized.language = defaults.language;
    }
    config::save(&normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_theme() {
        assert_eq!(pick("neon", &THEMES, "system"), "system");
        assert_eq!(pick("light", &THEMES, "system"), "light");
        assert_eq!(pick("system", &THEMES, "dark"), "system");
    }

    #[test]
    fn rejects_unknown_view_mode() {
        assert_eq!(pick("grid", &VIEW_MODES, "compact"), "compact");
        assert_eq!(pick("preview", &VIEW_MODES, "compact"), "preview");
    }
}
