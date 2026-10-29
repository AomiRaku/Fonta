// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

//! 窗口圆角。
//!
//! 窗口是 `decorations: false`，形状、描边、阴影与窗口动画全部交给 DWM；
//! 这里只把系统圆角从默认的 8px 改成 4px。

/// `DWMWA_WINDOW_CORNER_PREFERENCE`
#[cfg(windows)]
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
/// `DWMWCP_ROUNDSMALL`：4px 圆角
#[cfg(windows)]
const DWMWCP_ROUNDSMALL: u32 = 3;

#[cfg(windows)]
pub fn apply_corners(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let handle = hwnd.0 as windows_sys::Win32::Foundation::HWND;
    let preference: u32 = DWMWCP_ROUNDSMALL;
    // 老系统不支持时保持默认形状，不影响启动
    unsafe {
        DwmSetWindowAttribute(
            handle,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &preference as *const u32 as *const _,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

#[cfg(not(windows))]
pub fn apply_corners(_window: &tauri::WebviewWindow) {}