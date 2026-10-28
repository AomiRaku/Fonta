// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

//! 系统「应用模式」主题读取与变更推送。
//!
//! Windows 有两套独立设置：
//! - `SystemUsesLightTheme`：窗口边框、任务栏等系统元素的明暗；
//! - `AppsUseLightTheme`：应用（UWP / WinUI / WebView2）应遵循的明暗。
//!
//! WebView2 的 `prefers-color-scheme` 与 Tauri 的 `Window::theme()` 未必都跟随
//! **应用模式**，所以这里直接读注册表，并在变化时通过事件推给前端。

use std::time::Duration;

use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

const PERSONALIZE: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
const APPS_USE_LIGHT: &str = "AppsUseLightTheme";

/// 事件名：值为 `"light"` 或 `"dark"`。
pub const THEME_EVENT: &str = "system-theme";

/// 读取「应用模式」是否为浅色；缺省按浅色处理（与 Windows 默认一致）。
pub fn apps_use_light() -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(key) = hkcu.open_subkey(PERSONALIZE) else {
        return true;
    };
    match key.get_value::<u32, _>(APPS_USE_LIGHT) {
        Ok(value) => value != 0,
        Err(_) => true,
    }
}

pub fn label(light: bool) -> &'static str {
    if light {
        "light"
    } else {
        "dark"
    }
}

/// 后台轮询注册表（1s 一次，读一个 DWORD 的开销可忽略），变化时发事件。
pub fn spawn_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        use tauri::Emitter;

        let mut last = apps_use_light();
        loop {
            std::thread::sleep(Duration::from_millis(1000));
            let now = apps_use_light();
            if now == last {
                continue;
            }
            last = now;
            let _ = app.emit(THEME_EVENT, label(now));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_stable() {
        assert_eq!(label(true), "light");
        assert_eq!(label(false), "dark");
    }

    #[test]
    fn reading_registry_does_not_panic() {
        let _ = apps_use_light();
    }
}
