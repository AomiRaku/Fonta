// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

//! 广播 `WM_FONTCHANGE`，让已打开的应用程序尽快感知字体变化。
//!
//! Windows 对“隐藏/显示”本来就没有即时通知机制，广播只是尽力而为：
//! 部分老应用仍可能继续使用缓存中的字体表。

use windows_sys::Win32::UI::WindowsAndMessaging::{
    SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_FONTCHANGE,
};

pub fn broadcast() {
    let mut result: usize = 0;
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_FONTCHANGE,
            0,
            0,
            SMTO_ABORTIFHUNG,
            1000,
            &mut result,
        );
    }
}
