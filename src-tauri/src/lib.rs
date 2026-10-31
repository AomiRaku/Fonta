// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

//! FontFox —— Windows 字体管理器的应用入口。

pub mod commands;
pub mod config;
pub mod delete;
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
pub mod system_fonts;
pub mod parse;
pub mod registry;
pub mod settings;
pub mod theme;
pub mod update;

use commands::AppState;

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
            update::cleanup_stale_updates();


            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_fonts,
            commands::set_fonts_hidden,
            commands::delete_fonts,
            commands::clean_missing,
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
            commands::list_languages,

            commands::set_disable_mode,
            commands::font_extras,
            commands::render_preview,
            commands::reconcile_disabled,
            commands::open_devtools,
            commands::open_url,
            commands::system_locale,
            update::check_update,
            update::release_notes,
            update::download_update,
            update::cancel_update_download,
            update::install_update,
            commands::restore_all_fonts,
            commands::move_disabled_to_desktop,
            commands::move_quarantined_to_desktop,
            commands::reset_user_data,
            commands::restart_app,
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
fn desktop_folder() -> Option<std::path::PathBuf> {
    let profile = std::path::PathBuf::from(std::env::var_os("USERPROFILE")?);
    let direct = profile.join("Desktop");
    if direct.is_dir() {
        Some(direct)
    } else {
        let one_drive = profile.join("OneDrive").join("Desktop");
        if one_drive.is_dir() {
            Some(one_drive)
        } else {
            Some(direct)
        }
    }
}

fn unique_destination(dir: &std::path::Path, src: &std::path::Path) -> std::path::PathBuf {
    let Some(name) = src.file_name() else {
        return dir.join("font");
    };
    let stem = src
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "font".to_string());
    let ext = src
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    let mut target = dir.join(name);
    let mut index = 1usize;
    while target.exists() {
        target = dir.join(format!("{stem}-{index}{ext}"));
        index += 1;
    }
    target
}

/// 把指定文件移动到 `桌面\FontFox Uninstalled Fonts`，返回 (目录, 成功数量)。
pub fn move_files_to_desktop(paths: &[String]) -> Result<(String, usize), String> {
    let desktop = desktop_folder().ok_or_else(|| "无法定位桌面目录".to_string())?;
    let target_dir = desktop.join("FontFox Uninstalled Fonts");
    std::fs::create_dir_all(&target_dir)
        .map_err(|err| format!("无法创建桌面文件夹：{err}"))?;

    let mut moved = 0usize;
    let mut errors: Vec<String> = Vec::new();
    for raw in paths {
        let source = std::path::PathBuf::from(raw);
        if !source.is_file() {
            continue;
        }
        let target = unique_destination(&target_dir, &source);
        let result = std::fs::rename(&source, &target).or_else(|_| {
            std::fs::copy(&source, &target).and_then(|_| std::fs::remove_file(&source))
        });
        match result {
            Ok(()) => moved += 1,
            Err(err) => errors.push(format!("{}：{}", source.display(), err)),
        }
    }
    if errors.is_empty() {
        Ok((target_dir.to_string_lossy().to_string(), moved))
    } else {
        Err(errors.join("；"))
    }
}

/// 把隔离目录里剩余的所有字体文件移动到桌面，返回 (目录, 成功数量)。
pub fn move_quarantined_to_desktop() -> Result<(String, usize), String> {
    let mut paths: Vec<String> = Vec::new();
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
            paths.push(path.to_string_lossy().to_string());
        }
    }
    move_files_to_desktop(&paths)
}

fn copy_quarantined_to_desktop() -> (String, usize) {
    let Some(desktop) = desktop_folder() else {
        return (String::new(), 0);
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
            let target = unique_destination(&target_dir, &path);
            if std::fs::copy(&path, &target).is_ok() {
                copied += 1;
            }
        }
    }
    (target_dir.to_string_lossy().to_string(), copied)
}
/// 卸载前恢复停用字体；失败时返回错误描述。
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