// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

//! 暴露给前端的 Tauri 命令。
//!
//! 所有会触碰文件系统 / 注册表的操作都在 `spawn_blocking` 线程上执行，
//! 避免阻塞 WebView 的 IPC。

use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;

use crate::delete;
use crate::elevation;
use crate::enumerate;
use crate::inactive;
use crate::library;
use crate::model::{
    DeleteReport, FontEntry, FontListPayload, HiddenReport, PendingDelete, Scope, Settings,
};
use crate::official;
use crate::registry;
use crate::settings as settings_store;

/// 缓存的字体表，让删除 / 隐藏命令不必重新扫描。
#[derive(Default)]
pub struct AppState {
    pub fonts: Mutex<Vec<FontEntry>>,
}

impl AppState {
    fn cached(&self, ids: &[String]) -> Vec<FontEntry> {
        let Ok(cache) = self.fonts.lock() else {
            return Vec::new();
        };
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(entry) = cache.iter().find(|f| &f.id == id) {
                out.push(entry.clone());
            }
        }
        out
    }

    fn replace(&self, fonts: Vec<FontEntry>) {
        if let Ok(mut cache) = self.fonts.lock() {
            *cache = fonts;
        }
    }

    fn set_hidden_flags(&self, ids: &[String], hidden: bool) {
        if let Ok(mut cache) = self.fonts.lock() {
            for entry in cache.iter_mut() {
                if ids.iter().any(|id| id == &entry.id) {
                    entry.hidden = hidden;
                }
            }
        }
    }
}

fn merge(into: &mut DeleteReport, from: DeleteReport) {
    into.items.extend(from.items);
    into.removed_count += from.removed_count;
    into.locked_count += from.locked_count;
    into.elevation_required |= from.elevation_required;
    into.cancelled |= from.cancelled;
    into.errors.extend(from.errors);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub elevated: bool,
    pub pending: Vec<PendingDelete>,
    pub official_count: usize,
    pub core_count: usize,
    pub system_font_dir: String,
    pub user_font_dir: String,
    /// 配置目录：`%USERPROFILE%\.FontFox`
    pub config_path: String,
    /// 待清理清单所在目录（与配置同目录）
    pub pending_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AboutPayload {
    pub version: String,
    pub license_name: String,
    pub license_text: String,
    pub notice_text: String,
    pub config_path: String,
    pub pending_path: String,
}

#[tauri::command]
pub async fn list_fonts(app: tauri::AppHandle) -> Result<FontListPayload, String> {
    let payload = tauri::async_runtime::spawn_blocking(enumerate::scan)
        .await
        .map_err(|e| format!("扫描字体失败：{}", e))?;
    let state = app.state::<AppState>();
    state.replace(payload.fonts.clone());
    Ok(payload)
}

#[tauri::command]
pub async fn set_fonts_hidden(
    app: tauri::AppHandle,
    ids: Vec<String>,
    hidden: bool,
) -> Result<HiddenReport, String> {
    let state = app.state::<AppState>();
    let mut entries = state.cached(&ids);
    if entries.len() != ids.len() {
        let payload = tauri::async_runtime::spawn_blocking(enumerate::scan)
            .await
            .map_err(|e| format!("扫描字体失败：{}", e))?;
        state.replace(payload.fonts.clone());
        entries = payload
            .fonts
            .into_iter()
            .filter(|f| ids.iter().any(|id| id == &f.id))
            .collect();
    }
    if entries.is_empty() {
        return Err("未找到对应字体。".to_string());
    }

    let report = tauri::async_runtime::spawn_blocking(move || inactive::set_hidden(&entries, hidden))
        .await
        .map_err(|e| format!("隐藏状态写入失败：{}", e))?;
    if report.errors.is_empty() {
        crate::fontchange::broadcast();
        state.set_hidden_flags(&ids, hidden);
    }
    Ok(report)
}

#[tauri::command]
pub async fn delete_fonts(
    app: tauri::AppHandle,
    ids: Vec<String>,
) -> Result<DeleteReport, String> {
    let state = app.state::<AppState>();
    let entries = state.cached(&ids);
    if entries.len() != ids.len() {
        return Err("字体列表已过期，请刷新后重试。".to_string());
    }

    let elevated = registry::is_elevated();
    let (user_entries, system_entries): (Vec<_>, Vec<_>) =
        entries.into_iter().partition(|e| e.scope == Scope::User);

    let mut report = DeleteReport::default();

    if !user_entries.is_empty() {
        let result = tauri::async_runtime::spawn_blocking(move || {
            delete::delete_entries(&user_entries, elevated)
        })
        .await
        .map_err(|e| format!("删除失败：{}", e))?;
        merge(&mut report, result);
    }

    if !system_entries.is_empty() {
        if elevated {
            let result = tauri::async_runtime::spawn_blocking(move || {
                delete::delete_entries(&system_entries, true)
            })
            .await
            .map_err(|e| format!("删除失败：{}", e))?;
            merge(&mut report, result);
        } else {
            let system_ids: Vec<String> = system_entries.iter().map(|e| e.id.clone()).collect();
            match tauri::async_runtime::spawn_blocking(move || {
                elevation::delete_with_elevation(system_ids)
            })
            .await
            {
                Ok(Ok(result)) => merge(&mut report, result),
                Ok(Err(err)) => {
                    report.cancelled = true;
                    report.errors.push(err);
                }
                Err(err) => {
                    report.errors.push(format!("提权进程调度失败：{}", err));
                }
            }
        }
    }

    // 删除后重新扫描，保证列表、隐藏状态、残留标记都是最新的。
    if report.removed_count > 0 {
        if let Ok(payload) = tauri::async_runtime::spawn_blocking(enumerate::scan).await {
            state.replace(payload.fonts);
        }
    }

    Ok(report)
}

/// 仅清理注册表残留（文件已经不存在的条目）。
#[tauri::command]
pub async fn clean_missing(
    app: tauri::AppHandle,
    ids: Vec<String>,
) -> Result<DeleteReport, String> {
    let state = app.state::<AppState>();
    let entries = state.cached(&ids);
    if entries.is_empty() {
        return Err("未找到对应字体。".to_string());
    }
    let report = tauri::async_runtime::spawn_blocking(move || delete::clean_missing(&entries))
        .await
        .map_err(|e| format!("清理失败：{}", e))?;

    if let Ok(payload) = tauri::async_runtime::spawn_blocking(enumerate::scan).await {
        state.replace(payload.fonts);
    }
    Ok(report)
}

#[tauri::command]
pub async fn retry_pending_deletes() -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(delete::retry_pending)
        .await
        .map_err(|e| format!("重试清理失败：{}", e))
}

#[tauri::command]
pub fn get_settings() -> Settings {
    settings_store::load()
}

#[tauri::command]
pub fn save_settings(settings: Settings) -> Result<(), String> {
    settings_store::save(&settings)
}

#[tauri::command]
pub fn load_library() -> library::Library {
    library::load()
}

#[tauri::command]
pub fn save_library(library: library::Library) -> Result<(), String> {
    crate::library::save(&library)
}

/// 诊断接口：返回版本、提权状态、待清理文件、受保护字体统计。
///
/// 界面目前不调用它（状态栏已移除），保留给排障脚本 / 开发者控制台使用；
/// 删除前请先确认没有外部工具依赖。
#[tauri::command]
pub fn app_info(app: tauri::AppHandle) -> AppInfo {
    let (official_count, core_count) = official::index().counts();
    AppInfo {
        version: app.package_info().version.to_string(),
        elevated: registry::is_elevated(),
        pending: delete::pending_items(),
        official_count,
        core_count,
        system_font_dir: registry::system_font_dir().to_string_lossy().to_string(),
        user_font_dir: registry::user_font_dir().to_string_lossy().to_string(),
        config_path: crate::config::app_dir().to_string_lossy().to_string(),
        pending_path: delete::pending_file().to_string_lossy().to_string(),
    }
}

#[tauri::command]
pub fn about(app: tauri::AppHandle) -> AboutPayload {
    AboutPayload {
        version: app.package_info().version.to_string(),
        license_name: "Apache License 2.0".to_string(),
        license_text: include_str!("../../LICENSE").to_string(),
        notice_text: include_str!("../../NOTICE").to_string(),
        config_path: crate::config::config_file().to_string_lossy().to_string(),
        pending_path: delete::pending_file().to_string_lossy().to_string(),
    }
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let target = std::path::Path::new(&path);
    if !target.exists() {
        return Err(format!("路径不存在：{}", path));
    }

    // C:\Windows\Fonts 是 Shell 虚拟文件夹：
    // 路径无法用 ILCreateFromPathW 解析，`explorer /select` 也会落到默认位置，
    // 所以系统字体直接打开「字体」文件夹。
    if is_system_fonts_dir(target) {
        std::process::Command::new("explorer")
            .arg("shell:Fonts")
            .spawn()
            .map_err(|e| format!("无法打开字体文件夹：{}", e))?;
        return Ok(());
    }

    // 其余位置（含用户字体目录）用 Shell 接口选中文件
    if select_in_explorer(&path).is_ok() {
        return Ok(());
    }

    // 退路：先试 /select，再退到打开所在目录
    if std::process::Command::new("explorer")
        .arg(format!("/select,{path}"))
        .spawn()
        .is_err()
    {
        if let Some(parent) = target.parent() {
            std::process::Command::new("explorer")
                .arg(parent)
                .spawn()
                .map_err(|e| format!("无法打开资源管理器：{}", e))?;
        }
    }
    Ok(())
}

/// 是否位于系统字体目录（`%WINDIR%\Fonts`）。
fn is_system_fonts_dir(path: &std::path::Path) -> bool {
    let Some(windir) = std::env::var_os("WINDIR") else {
        return false;
    };
    let fonts = std::path::Path::new(&windir).join("Fonts");
    match (path.canonicalize(), fonts.canonicalize()) {
        (Ok(file), Ok(dir)) => file.starts_with(&dir),
        _ => false,
    }
}

/// 用 Shell 接口在资源管理器里选中文件。
///
/// SHOpenFolderAndSelectItems 要求 STA：Tauri 命令线程的 COM 套间可能已是 MTA，
/// 所以单独起一个线程自己初始化 STA，避免 RPC_E_CHANGED_MODE。
fn select_in_explorer(path: &str) -> Result<(), String> {
    let path = path.to_owned();
    std::thread::spawn(move || unsafe { select_in_explorer_sta(&path) })
        .join()
        .map_err(|_| "线程异常".to_string())?
}

unsafe fn select_in_explorer_sta(path: &str) -> Result<(), String> {
    use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows_sys::Win32::UI::Shell::{ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems};

    // 新线程里第一次初始化必定返回 S_OK；S_FALSE 表示已初始化过
    let hr = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
    if hr < 0 {
        return Err(format!("COM 初始化失败：{hr:#x}"));
    }
    let own_com = hr == 0;

    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let pidl = ILCreateFromPathW(wide.as_ptr());
    if pidl.is_null() {
        if own_com {
            CoUninitialize();
        }
        return Err("无法解析路径".to_string());
    }

    let result = SHOpenFolderAndSelectItems(pidl, 0, std::ptr::null(), 0);
    ILFree(pidl);
    if own_com {
        CoUninitialize();
    }
    if result >= 0 {
        Ok(())
    } else {
        Err(format!("打开失败：{result:#x}"))
    }
}
/// 系统「应用模式」当前解析结果：`"light"` 或 `"dark"`。
#[tauri::command]
pub fn system_theme() -> &'static str {
    crate::theme::label(crate::theme::apps_use_light())
}

/// 读取外挂语言包（`lang/<id>.ini`），缺文件时回退内置简体中文。
#[tauri::command]
pub async fn load_language(id: String) -> Result<crate::i18n::LanguagePack, String> {
    tauri::async_runtime::spawn_blocking(move || crate::i18n::load(&id))
        .await
        .map_err(|e| format!("读取语言包失败：{}", e))
}

/// 供前端在调试 / 支持场景中直接查看某个字体的原始注册表键。
#[tauri::command]
pub fn registry_location(scope: Scope) -> String {
    match scope {
        Scope::System => {
            format!(r"HKEY_LOCAL_MACHINE\{}", registry::FONTS_SUBKEY)
        }
        Scope::User => {
            format!(r"HKEY_CURRENT_USER\{}", registry::FONTS_SUBKEY)
        }
    }
}
