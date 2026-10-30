// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

//! FontFox —— Windows 字体管理器的应用入口。

pub mod commands;
pub mod config;
pub mod delete;
mod frame;
pub mod elevation;
pub mod enumerate;
pub mod fontchange;
pub mod i18n;
pub mod langs;
pub mod library;
pub mod inactive;
pub mod mode;
pub mod model;
mod preview;
mod restore_dialog;
pub mod ownership;
pub mod official;
pub mod parse;
pub mod registry;
pub mod settings;
pub mod theme;

use commands::AppState;
use tauri::Manager;

pub fn run() {
    // 提权子进程分支必须在 Tauri 初始化之前处理：它没有 WebView 窗口。
    let args: Vec<String> = std::env::args().collect();
    if let Some(position) = args.iter().position(|arg| arg == elevation::ELEVATED_FLAG) {
        let code = match args.get(position + 1) {
            Some(path) => delete::run_elevated_request(std::path::Path::new(path)),
            None => 2,
        };
        std::process::exit(code);
    }


    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::default())

        .setup(|app| {
            // 上次会话中被 GDI 锁定的字体文件，在这里重试清理。
            std::thread::spawn(delete::retry_pending);

            // 跟随系统「应用模式」：注册表变化时推给前端。
            theme::spawn_watcher(app.handle().clone());

            // 圆角交给 DWM：Windows 11 22H2+ 支持 4px 小圆角，
            // 比自绘窗口区域更稳（阴影、最小化动画都保留）。
            if let Some(window) = app.get_webview_window("main") {
                frame::apply_corners(&window);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_fonts,
            commands::set_fonts_hidden,
            commands::delete_fonts,
            commands::clean_missing,
            commands::retry_pending_deletes,
            commands::get_settings,
            commands::save_settings,
            commands::load_library,
            commands::save_library,
            commands::app_info,
            commands::about,
            commands::reveal_path,
            commands::registry_location,
            commands::system_theme,
            commands::load_language,

            commands::set_disable_mode,
            commands::font_extras,
            commands::render_preview,
            commands::reconcile_disabled,
            commands::adopt_disabled_files,
            commands::drop_missing_disabled,
        ])
        .run(tauri::generate_context!())
        .expect("FontFox 启动失败");
}
/// 卸载恢复：失败时弹原生「重试」对话框（只有重试，关闭窗口也重试），
/// 连续重试 4 次仍失败则把隔离字体复制到桌面文件夹，并提示手动重新安装。
pub fn restore_fonts_for_uninstall_with_retry() -> Result<usize, String> {
    const MAX_RETRIES: usize = 4;
    let mut retries = 0usize;
    loop {
        match restore_fonts_for_uninstall() {
            Ok(count) => return Ok(count),
            Err(error) => {
                if retries >= MAX_RETRIES {
                    let (folder, copied) = copy_quarantined_to_desktop();
                    restore_dialog::show_final(&error, &folder, copied);
                    return Err(error);
                }
                retries += 1;
                restore_dialog::show_retry(&error);
            }
        }
    }
}

/// 把隔离目录里的字体文件复制到 `桌面\FontFox Uninstalled Fonts`。
/// 返回 (目标文件夹, 复制成功数量)；复制失败只影响数量，不阻断卸载。
fn copy_quarantined_to_desktop() -> (String, usize) {
    let Some(profile) = std::env::var_os("USERPROFILE") else {
        return (String::new(), 0);
    };
    let profile = std::path::PathBuf::from(profile);
    let desktop = {
        let direct = profile.join("Desktop");
        if direct.is_dir() {
            direct
        } else {
            let one_drive = profile.join("OneDrive").join("Desktop");
            if one_drive.is_dir() {
                one_drive
            } else {
                direct
            }
        }
    };
    let target_dir = desktop.join("FontFox Uninstalled Fonts");
    if std::fs::create_dir_all(&target_dir).is_err() {
        return (target_dir.to_string_lossy().to_string(), 0);
    }

    let mut copied = 0usize;
    if let Ok(entries) = std::fs::read_dir(crate::mode::quarantine_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if path
                .extension()
                .map(|ext| ext.eq_ignore_ascii_case("json"))
                .unwrap_or(false)
            {
                continue;
            }
            let Some(name) = path.file_name() else {
                continue;
            };
            let mut target = target_dir.join(name);
            let stem = path
                .file_stem()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| "font".to_string());
            let ext = path
                .extension()
                .map(|value| format!(".{}", value.to_string_lossy()))
                .unwrap_or_default();
            let mut index = 1usize;
            while target.exists() {
                target = target_dir.join(format!("{stem}-{index}{ext}"));
                index += 1;
            }
            if std::fs::copy(&path, &target).is_ok() {
                copied += 1;
            }
        }
    }
    (target_dir.to_string_lossy().to_string(), copied)
}
/// 卸载前调用：把两种停用模式下的字体全部恢复。
///
/// - 动态模式：把 `disabled\` 里的隔离文件迁回用户字体目录并重新注册；
/// - Windows 模式：删除 `Inactive Fonts` 值。
///
/// 返回恢复的隔离字体数量；失败时返回错误描述（卸载流程只记录日志，不阻塞）。
pub fn restore_fonts_for_uninstall() -> Result<usize, String> {
    let restored = crate::mode::restore_all()?;
    let mut errors: Vec<String> = Vec::new();
    if let Err(error) = crate::registry::clear_inactive_fonts() {
        errors.push(error);
    }
    if errors.is_empty() {
        Ok(restored)
    } else {
        Err(errors.join("；"))
    }
}