// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

//! FontFox / 字狐 —— Windows 字体管理器的应用入口。

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
            // asset 协议默认只放行 tauri.conf.json 里写死的 scope。系统字体目录形如
            // `%SystemRoot%\Fonts`，盘符和安装位置都可能不同（而且 Tauri 的 `$FONT`
            // 指向的是**每用户**字体目录），所以这里按运行时解析出的真实路径放行。
            let scope = app.asset_protocol_scope();
            for dir in [registry::system_font_dir(), registry::user_font_dir()] {
                if !dir.is_dir() {
                    continue;
                }
                if let Err(err) = scope.allow_directory(&dir, true) {
                    eprintln!(
                        "FontFox: 无法把字体目录 {} 加入 asset 作用域：{}",
                        dir.display(),
                        err
                    );
                }
            }

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