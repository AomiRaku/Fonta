// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

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
use crate::system_fonts;
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
    pub system_count: usize,
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
    pub third_party_text: String,
    pub config_path: String,
    pub pending_path: String,
}

#[tauri::command]
pub async fn list_fonts(app: tauri::AppHandle) -> Result<FontListPayload, String> {
    let mut payload = tauri::async_runtime::spawn_blocking(enumerate::scan)
        .await
        .map_err(|e| format!("扫描字体失败：{}", e))?;
    // 动态模式下被隔离的字体不在注册表里，补进列表才能重新启用
    crate::mode::merged_entries(&mut payload.fonts);
    let state = app.state::<AppState>();
    state.replace(payload.fonts.clone());

    // 列表阶段不需要版权 / 版本 / TTC 家族名，按需走 font_extras
    for font in &mut payload.fonts {
        font.families.clear();
        font.version.clear();
        font.copyright.clear();
    }
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

    let dynamic = crate::settings::load().disable_mode == "dynamic";
    if dynamic {
        let ids_for_enable = ids.clone();
        let entries_for_disable = entries.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            if hidden {
                crate::mode::disable(&entries_for_disable)
            } else {
                crate::mode::enable(&ids_for_enable)
            }
        })
        .await
        .map_err(|e| format!("字体文件操作失败：{}", e))?;

        let mut report = HiddenReport::default();
        match result {
            Ok(count) => {
                report.changed = count;
                state.set_hidden_flags(&ids, hidden);
                std::thread::spawn(crate::fontchange::broadcast);
            }
            Err(err) => report.errors.push(err),
        }
        return Ok(report);
    }

    let report = tauri::async_runtime::spawn_blocking(move || inactive::set_hidden(&entries, hidden))
        .await
        .map_err(|e| format!("隐藏状态写入失败：{}", e))?;
    if report.errors.is_empty() {
        state.set_hidden_flags(&ids, hidden);
        // 广播要等所有顶层窗口应答（最长 1s），放到后台线程，别拖住这次 IPC
        std::thread::spawn(crate::fontchange::broadcast);
    }
    Ok(report)
}

#[tauri::command]
pub async fn delete_fonts(
    app: tauri::AppHandle,
    ids: Vec<String>,
) -> Result<DeleteReport, String> {
    let state = app.state::<AppState>();
    let mut entries = state.cached(&ids);
    if entries.len() != ids.len() {
        return Err("字体列表已过期，请刷新后重试。".to_string());
    }
    // 动态模式下请求删除的可能是隔离中的字体：用隔离目录里的真实路径
    let quarantine = crate::mode::quarantine_paths(&ids);
    for entry in entries.iter_mut() {
        if let Some(path) = quarantine.get(&entry.id) {
            entry.path = path.clone();
            entry.exists = std::path::Path::new(path).is_file();
        }
    }
    // 释放预览 mmap，否则 Windows 可能拒绝删除仍被映射的字体文件
    crate::preview::clear_caches();

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

    // 只为真正删除成功的条目清理隔离记录；删除失败的不能丢记录
    let removed_ids: Vec<String> = report
        .items
        .iter()
        .filter(|item| item.registry_removed || item.file_removed)
        .map(|item| item.id.clone())
        .collect();
    if !removed_ids.is_empty() {
        crate::mode::drop_missing(&removed_ids);
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

/// 对外版本号：内部 semver 为 `major.minor.0`，界面显示为 `major.minor`（minor 补足两位）。
fn display_version(version: &str) -> String {
    let mut parts = version.split('.');
    let major = parts.next().unwrap_or("0");
    let minor = parts.next().unwrap_or("0");
    let patch = parts.next().unwrap_or("0");
    if patch == "0" {
        format!("{major}.{minor}")
    } else {
        version.to_string()
    }
}
/// 诊断接口：返回版本、提权状态、待清理文件、受保护字体统计。
///
/// 界面目前不调用它（状态栏已移除），保留给排障脚本 / 开发者控制台使用；
/// 删除前请先确认没有外部工具依赖。
#[tauri::command]
pub fn app_info(app: tauri::AppHandle) -> AppInfo {
    let (system_count, core_count) = system_fonts::index().counts();
    AppInfo {
        version: display_version(&app.package_info().version.to_string()),
        elevated: registry::is_elevated(),
        pending: delete::pending_items(),
        system_count,
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
        version: display_version(&app.package_info().version.to_string()),
        license_name: "Apache License 2.0".to_string(),
        license_text: include_str!("../../LICENSE").to_string(),
        notice_text: include_str!("../../NOTICE").to_string(),
        third_party_text: include_str!("../../THIRD_PARTY_LICENSES.txt").to_string(),
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
/// 切换「字体禁用方式」时返回的迁移结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeSwitchReport {
    pub mode: String,
    pub migrated: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

/// 切换失败时，尽量把字体恢复到旧模式的隐藏状态。
async fn reapply_hidden(current: &str, targets: &[FontEntry]) {
    if targets.is_empty() {
        return;
    }
    let entries = targets.to_vec();
    if current == "dynamic" {
        let users: Vec<FontEntry> = entries
            .into_iter()
            .filter(|font| font.scope == Scope::User)
            .collect();
        let _ = tauri::async_runtime::spawn_blocking(move || crate::mode::disable(&users)).await;
    } else {
        let _ = tauri::async_runtime::spawn_blocking(move || inactive::set_hidden(&entries, true))
            .await;
    }
}

/// 当前 Windows 用户区域设置（BCP 47，例如 `zh-CN`）。
#[tauri::command]
pub fn system_locale() -> String {
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;

    let mut buffer = [0u16; 85];
    let len = unsafe { GetUserDefaultLocaleName(buffer.as_mut_ptr(), buffer.len() as i32) };
    if len <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..(len as usize - 1)])
}
/// 用系统默认浏览器打开外部链接（只允许 GitHub HTTPS）。
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/") {
        return Err("不支持的外部链接".to_string());
    }
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let target: Vec<u16> = format!("{url}\0").encode_utf16().collect();
    let result = unsafe {
        windows_sys::Win32::UI::Shell::ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL,
        )
    };
    if (result as isize) <= 32 {
        Err(format!("无法打开链接：{url}"))
    } else {
        Ok(())
    }
}
/// 打开当前窗口的 DevTools（发布版需要 tauri `devtools` feature）。
#[tauri::command]
pub fn open_devtools(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        window.open_devtools();
    }
}
/// 列出可用的界面语言包（exe 同级 `lang/*.ini`）。
#[tauri::command]
pub async fn list_languages() -> Vec<crate::i18n::LanguageInfo> {
    tauri::async_runtime::spawn_blocking(crate::i18n::available)
        .await
        .unwrap_or_default()
}
/// 切换禁用方式：先在旧模式下恢复，再切到新模式并按原集合重新禁用。
#[tauri::command]
pub async fn set_disable_mode(
    _app: tauri::AppHandle,
    mode: String,
) -> Result<ModeSwitchReport, String> {
    let mode = if mode == "dynamic" { "dynamic" } else { "windows" }.to_string();
    let mut current_settings = settings_store::load();
    let current = current_settings.disable_mode.clone();
    if current == mode {
        return Ok(ModeSwitchReport {
            mode,
            migrated: 0,
            failed: 0,
            errors: Vec::new(),
        });
    }

    let payload = tauri::async_runtime::spawn_blocking(enumerate::scan)
        .await
        .map_err(|e| format!("扫描字体失败：{}", e))?;

    // 当前模式下处于禁用状态的字体
    let disabled_ids: Vec<String> = if current == "dynamic" {
        crate::mode::records()
            .into_iter()
            .map(|record| record.id)
            .collect()
    } else {
        payload
            .fonts
            .iter()
            .filter(|font| font.hidden)
            .map(|font| font.id.clone())
            .collect()
    };

    // 1. 在旧模式下恢复启用；失败则中止切换，保持原模式不变
    if current == "dynamic" {
        crate::mode::restore_all().map_err(|err| format!("恢复隔离字体失败：{}", err))?;
    } else {
        let hidden: Vec<FontEntry> = payload
            .fonts
            .iter()
            .filter(|font| font.hidden)
            .cloned()
            .collect();
        let report = inactive::set_hidden(&hidden, false);
        if !report.errors.is_empty() {
            return Err(format!(
                "恢复 Inactive Fonts 失败：{}",
                report.errors.join("；")
            ));
        }
    }

    // 2. 重新扫描（动态恢复后字体回到注册表），按原集合在新模式下停用
    let payload = tauri::async_runtime::spawn_blocking(enumerate::scan)
        .await
        .map_err(|e| format!("扫描字体失败：{}", e))?;
    let targets: Vec<FontEntry> = payload
        .fonts
        .into_iter()
        .filter(|font| disabled_ids.contains(&font.id))
        .collect();

    let mut migrated = 0usize;
    if mode == "dynamic" {
        // 动态模式只处理用户作用域；系统作用域继续用 Windows 隐藏，避免切换后突然可见
        let (users, systems): (Vec<FontEntry>, Vec<FontEntry>) = targets
            .iter()
            .cloned()
            .partition(|font| font.scope == Scope::User);
        if !systems.is_empty() {
            let report = inactive::set_hidden(&systems, true);
            if !report.errors.is_empty() {
                reapply_hidden(&current, &targets).await;
                return Err(format!(
                    "迁移系统作用域字体失败：{}",
                    report.errors.join("；")
                ));
            }
            migrated += report.changed;
        }
        match crate::mode::disable(&users) {
            Ok(count) => migrated += count,
            Err(err) => {
                if !systems.is_empty() {
                    let _ = inactive::set_hidden(&systems, false);
                }
                reapply_hidden(&current, &targets).await;
                return Err(format!("切换禁用方式失败：{}", err));
            }
        }
    } else {
        let report = inactive::set_hidden(&targets, true);
        if !report.errors.is_empty() {
            reapply_hidden(&current, &targets).await;
            return Err(format!(
                "写入 Inactive Fonts 失败：{}",
                report.errors.join("；")
            ));
        }
        migrated = report.changed;
    }

    // 3. 全部停用成功后才落盘新模式；保存失败则撤销新模式的停用
    current_settings.disable_mode = mode.clone();
    if let Err(err) = settings_store::save(&current_settings) {
        if mode == "dynamic" {
            let users: Vec<String> = targets
                .iter()
                .filter(|font| font.scope == Scope::User)
                .map(|font| font.id.clone())
                .collect();
            let _ = crate::mode::enable(&users);
            let _ = inactive::set_hidden(&targets, false);
        } else {
            let _ = inactive::set_hidden(&targets, false);
        }
        reapply_hidden(&current, &targets).await;
        return Err(format!("写入设置失败：{}", err));
    }

    std::thread::spawn(crate::fontchange::broadcast);

    Ok(ModeSwitchReport {
        mode,
        migrated,
        failed: disabled_ids.len().saturating_sub(migrated),
        errors: Vec::new(),
    })
}
/// 启动时对账：隔离目录里多出来的文件、清单里丢失的文件。
#[tauri::command]
pub async fn reconcile_disabled(force: Option<bool>) -> crate::mode::ReconcileReport {
    // 基础模式下不使用隔离目录，直接返回空结果，避免误报；重置流程强制完整对账
    if !force.unwrap_or(false) && crate::settings::load().disable_mode != "dynamic" {
        return crate::mode::ReconcileReport {
            extra: Vec::new(),
            missing: Vec::new(),
        };
    }
    tauri::async_runtime::spawn_blocking(crate::mode::reconcile)
        .await
        .unwrap_or(crate::mode::ReconcileReport {
            extra: Vec::new(),
            missing: Vec::new(),
        })
}

/// 重置流程：恢复全部已停用字体（动态隔离 + Inactive Fonts）。
#[tauri::command]
pub async fn restore_all_fonts() -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(crate::restore_fonts_for_uninstall)
        .await
        .map_err(|err| format!("恢复字体失败：{err}"))?
}

/// 把指定的隔离字体文件移动到桌面 FontFox Uninstalled Fonts。
#[tauri::command]
pub async fn move_disabled_to_desktop(paths: Vec<String>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || crate::move_files_to_desktop(&paths))
        .await
        .map_err(|err| format!("移动字体失败：{err}"))?
        .map(|(_, count)| count)
}

/// 把隔离目录里剩余字体全部移动到桌面。
#[tauri::command]
pub async fn move_quarantined_to_desktop() -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(crate::move_quarantined_to_desktop)
        .await
        .map_err(|err| format!("移动字体失败：{err}"))?
        .map(|(_, count)| count)
}

/// 删除 `%USERPROFILE%\.FontFox\` 下的全部内容。
#[tauri::command]
pub async fn reset_user_data() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = crate::config::app_dir();
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|err| format!("删除配置目录失败：{err}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|err| format!("删除配置目录失败：{err}"))?
}

/// 重启应用。
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart();
}
/// 把多出来的文件收编为禁用记录。
#[tauri::command]
pub async fn adopt_disabled_files(paths: Vec<String>) -> usize {
    tauri::async_runtime::spawn_blocking(move || crate::mode::adopt(&paths))
        .await
        .unwrap_or(0)
}

/// 删除文件已丢失的清单记录。
#[tauri::command]
pub async fn drop_missing_disabled(ids: Vec<String>) -> usize {
    tauri::async_runtime::spawn_blocking(move || crate::mode::drop_missing(&ids))
        .await
        .unwrap_or(0)
}
/// 详情面板需要的附加字段（列表接口不再携带）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontExtras {
    pub id: String,
    pub families: Vec<String>,
    pub version: String,
    pub copyright: String,
}

#[tauri::command]
pub fn font_extras(app: tauri::AppHandle, ids: Vec<String>) -> Vec<FontExtras> {
    let state = app.state::<AppState>();
    let Ok(fonts) = state.fonts.lock() else {
        return Vec::new();
    };
    ids.iter()
        .filter_map(|id| {
            fonts.iter().find(|font| &font.id == id).map(|font| FontExtras {
                id: font.id.clone(),
                families: font.families.clone(),
                version: font.version.clone(),
                copyright: font.copyright.clone(),
            })
        })
        .collect()
}
/// 渲染一行预览样字（Rust 侧栅格化，WebView 不加载字体文件）。
///
/// `size` 是 CSS 像素字号，`dpr` 用来换算设备像素；返回 `data:image/png;base64,...`。
#[tauri::command]
pub async fn render_preview(
    path: String,
    text: String,
    size: f32,
    color: String,
    dpr: f32,
    max_width: Option<f32>,
    weight: Option<f32>,
    fresh: Option<bool>,
    fallback: Option<bool>,
) -> Result<String, String> {
    let max_width = max_width.unwrap_or(0.0);
    let weight = weight.unwrap_or(0.0);
    let fresh = fresh.unwrap_or(false);
    let fallback = fallback.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || {
        crate::preview::render(&path, &text, size, &color, dpr, max_width, weight, fresh, fallback)
    })
    .await
    .map_err(|error| error.to_string())?
}
#[cfg(test)]
mod tests {
    use super::display_version;

    #[test]
    fn formats_two_part_release_version() {
        assert_eq!(display_version("1000.0.0"), "1000.0");
        assert_eq!(display_version("2200.13.0"), "2200.13");
        assert_eq!(display_version("1000.1.2"), "1000.1.2");
    }
}
