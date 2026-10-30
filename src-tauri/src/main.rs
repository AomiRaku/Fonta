// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

// 发布构建不弹出控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 卸载程序调用：恢复所有停用字体后直接退出（不创建窗口）
    if std::env::args().any(|arg| arg == "--restore-fonts") {
        let result = fontfox_lib::restore_fonts_for_uninstall_with_retry();
        let message = match &result {
            Ok(count) => format!("restored={count}"),
            Err(error) => format!("error={error}"),
        };
        if let Some(dir) = std::env::var_os("TEMP") {
            let _ = std::fs::write(std::path::Path::new(&dir).join("fontfox-restore.log"), message);
        }
        if result.is_err() {
            std::process::exit(1);
        }
        return;
    }
    fontfox_lib::run()
}