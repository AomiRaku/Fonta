// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

//! 版本检查与更新下载，使用 GitHub Releases API 读取原始日志。

use std::cmp::Ordering;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const REPO: &str = "AomiRaku/font-fox";
const GITHUB_API: &str = "https://api.github.com";
const MIRROR1_PREFIX: &str = "https://github.chenc.dev/";
const MIRROR1_API_PREFIX: &str = "https://github.chenc.dev/https:/api.github.com";
const MIRROR2_PREFIX: &str = "https://gh-proxy.org/";
const DOWNLOAD_BASE: &str = "https://github.com/AomiRaku/font-fox/releases/latest/download";
const DOWNLOAD_EVENT: &str = "update-download";
const RELEASE_NOT_FOUND: &str = "RELEASE_NOT_FOUND";

static DOWNLOAD_CANCEL: AtomicBool = AtomicBool::new(false);
static DOWNLOAD_ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub latest_version: String,
    pub notes: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
    speed_kbps: f64,
}

#[derive(Deserialize)]
struct ReleaseResponse {
    tag_name: String,
    body: Option<String>,
}

fn current_version() -> String {
    let full = env!("CARGO_PKG_VERSION");
    let mut parts = full.split('.');
    format!(
        "{}.{}",
        parts.next().unwrap_or("0"),
        parts.next().unwrap_or("0")
    )
}

fn parse_version(value: &str) -> Option<Vec<u64>> {
    let text = value.trim().trim_start_matches(['v', 'V']);
    if text.is_empty() || !text.chars().all(|ch| ch.is_ascii_digit() || ch == '.') {
        return None;
    }
    let parts: Option<Vec<u64>> = text.split('.').map(|part| part.parse::<u64>().ok()).collect();
    if parts.as_ref().map_or(true, Vec::is_empty) {
        return None;
    }
    Some(parts.unwrap())
}

fn is_newer(latest: &str, current: &str) -> bool {
    let (Some(mut latest), Some(mut current)) = (parse_version(latest), parse_version(current)) else {
        return false;
    };
    while latest.len() < current.len() {
        latest.push(0);
    }
    while current.len() < latest.len() {
        current.push(0);
    }
    latest.cmp(&current) == Ordering::Greater
}

fn normalize_version(raw: &str) -> Result<String, String> {
    let text = raw.trim().trim_start_matches(['v', 'V']);
    if parse_version(text).is_none() {
        return Err(format!("Unable to parse version: {raw}"));
    }
    Ok(text.to_string())
}

fn mirror_prefix(source: &str) -> Option<&'static str> {
    match source {
        "mirror1" => Some(MIRROR1_PREFIX),
        "mirror2" => Some(MIRROR2_PREFIX),
        _ => None,
    }
}

fn api_url(source: &str, tag: Option<&str>) -> String {
    let base = match source {
        "mirror1" => MIRROR1_API_PREFIX.to_string(),
        "mirror2" => format!("{MIRROR2_PREFIX}{GITHUB_API}"),
        _ => GITHUB_API.to_string(),
    };
    match tag {
        Some(tag) => format!("{base}/repos/{REPO}/releases/tags/{tag}"),
        None => format!("{base}/repos/{REPO}/releases/latest"),
    }
}

fn download_url(source: &str, version: &str) -> String {
    let file = format!("FontFox_{version}_x64.exe");
    let url = format!("{DOWNLOAD_BASE}/{file}");
    mirror_prefix(source)
        .map(|prefix| format!("{prefix}{url}"))
        .unwrap_or(url)
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(format!("FontFox/{}", current_version()))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|err| format!("Failed to create HTTP client: {err}"))
}

fn fetch_release(source: &str, tag: Option<&str>) -> Result<ReleaseResponse, String> {
    let url = api_url(source, tag);
    let response = client()?
        .get(url)
        .timeout(Duration::from_secs(20))
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|err| format!("Failed to request update information: {err}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(RELEASE_NOT_FOUND.to_string());
    }
    if !response.status().is_success() {
        return Err(format!("Update source returned HTTP {}", response.status()));
    }
    response
        .json::<ReleaseResponse>()
        .map_err(|err| format!("Failed to parse update information: {err}"))
}

fn check_update_sync(source: &str) -> Result<Option<UpdateInfo>, String> {
    let release = fetch_release(source, None)?;
    let latest = normalize_version(&release.tag_name)?;
    let current = current_version();
    if !is_newer(&latest, &current) {
        return Ok(None);
    }
    Ok(Some(UpdateInfo {
        latest_version: latest,
        notes: release.body.unwrap_or_default(),
    }))
}

#[tauri::command]
pub async fn check_update(source: String) -> Result<Option<UpdateInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || check_update_sync(&source))
        .await
        .map_err(|err| format!("Update check failed: {err}"))?
}

fn release_notes_sync(source: &str, version: &str) -> Result<String, String> {
    let prefixed = format!("v{version}");
    fetch_release(source, Some(&prefixed)).map(|release| release.body.unwrap_or_default())
}

#[tauri::command]
pub async fn release_notes(source: String, version: String) -> Result<String, String> {
    let version = normalize_version(&version)?;
    tauri::async_runtime::spawn_blocking(move || release_notes_sync(&source, &version))
        .await
        .map_err(|err| format!("Failed to read release notes: {err}"))?
}

/// 删除上次更新遗留的安装包。启动时调用；正在被安装器占用的文件会跳过。
pub fn cleanup_stale_updates() {
    let dir = update_dir();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let _ = std::fs::remove_file(path);
        }
    }
}
fn update_dir() -> PathBuf {
    crate::config::app_dir().join("update")
}

fn download_path(version: &str) -> PathBuf {
    update_dir().join(format!("FontFox_{version}_x64.exe"))
}

fn emit_progress(app: &AppHandle, downloaded: u64, total: u64, speed_kbps: f64) {
    let _ = app.emit(
        DOWNLOAD_EVENT,
        DownloadProgress {
            downloaded,
            total,
            speed_kbps,
        },
    );
}

fn download_sync(app: &AppHandle, source: &str, version: &str) -> Result<String, String> {
    let version = normalize_version(version)?;
    let url = download_url(source, &version);
    let dir = update_dir();
    std::fs::create_dir_all(&dir).map_err(|err| format!("Unable to create download directory: {err}"))?;
    let path = download_path(&version);
    let _ = std::fs::remove_file(&path);

    let mut response = client()?
        .get(url)
        .timeout(Duration::from_secs(300))
        .send()
        .map_err(|err| format!("Update download failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("Update download failed: HTTP {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    let mut file = File::create(&path).map_err(|err| format!("Unable to create installer package: {err}"))?;

    let mut buffer = vec![0u8; 64 * 1024];
    let mut downloaded = 0u64;
    let mut last_bytes = 0u64;
    let mut last_emit = Instant::now();

    emit_progress(app, 0, total, 0.0);

    loop {
        if DOWNLOAD_CANCEL.load(AtomicOrdering::SeqCst) {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err("Download canceled".to_string());
        }
        let read = match response.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(err) => {
                drop(file);
                let _ = std::fs::remove_file(&path);
                return Err(format!("Update download failed: {err}"));
            }
        };
        if let Err(err) = file.write_all(&buffer[..read]) {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err(format!("Failed to write installer package: {err}"));
        }
        downloaded += read as u64;

        if last_emit.elapsed() >= Duration::from_millis(120) {
            let speed =
                (downloaded.saturating_sub(last_bytes)) as f64 / last_emit.elapsed().as_secs_f64() / 1024.0;
            emit_progress(app, downloaded, total, speed);
            last_bytes = downloaded;
            last_emit = Instant::now();
        }
    }

    if let Err(err) = file.flush() {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(format!("Failed to write installer package: {err}"));
    }
    drop(file);
    if total > 0 && downloaded != total {
        let _ = std::fs::remove_file(&path);
        return Err("Downloaded installer is incomplete".to_string());
    }
    let valid = File::open(&path)
        .and_then(|mut file| {
            let mut magic = [0u8; 2];
            file.read_exact(&mut magic).map(|_| &magic == b"MZ")
        })
        .unwrap_or(false);
    if !valid {
        let _ = std::fs::remove_file(&path);
        return Err("Downloaded installer format is invalid".to_string());
    }
    if let Ok(metadata) = std::fs::metadata(&path) {
        emit_progress(app, downloaded, total.max(metadata.len()), 0.0);
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    source: String,
    version: String,
) -> Result<String, String> {
    if DOWNLOAD_ACTIVE.swap(true, AtomicOrdering::SeqCst) {
        return Err("An update is already being downloaded".to_string());
    }
    DOWNLOAD_CANCEL.store(false, AtomicOrdering::SeqCst);
    let app_for_task = app.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || download_sync(&app_for_task, &source, &version))
            .await;
    DOWNLOAD_ACTIVE.store(false, AtomicOrdering::SeqCst);
    result.map_err(|err| format!("Update download failed: {err}"))?
}

#[tauri::command]
pub fn cancel_update_download() {
    DOWNLOAD_CANCEL.store(true, AtomicOrdering::SeqCst);
}

fn launch_installer(path: &Path) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SHELLEXECUTEINFOW};

    const ERROR_CANCELLED: u32 = 1223;
    const SW_SHOWNORMAL: i32 = 1;

    let verb: Vec<u16> = "runas\0".encode_utf16().collect();
    let file: Vec<u16> = path
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let params: Vec<u16> = "/UPDATE\0".encode_utf16().collect();
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = params.as_ptr();
    info.nShow = SW_SHOWNORMAL;

    let ok = unsafe { ShellExecuteExW(&mut info) };
    if ok == 0 {
        let code = unsafe { GetLastError() };
        return Err(if code == ERROR_CANCELLED {
            "Administrator authorization was canceled; the installer was not started.".to_string()
        } else {
            format!("Unable to start installer (error code {}).", code)
        });
    }
    if !info.hProcess.is_null() {
        unsafe { CloseHandle(info.hProcess) };
    }
    Ok(())
}

#[tauri::command]
pub fn install_update(app: AppHandle, path: String) -> Result<(), String> {
    let dir = update_dir();
    let canonical_dir = dir
        .canonicalize()
        .map_err(|err| format!("Update directory does not exist: {err}"))?;
    let canonical_path = Path::new(&path)
        .canonicalize()
        .map_err(|err| format!("Installer package does not exist: {err}"))?;
    if !canonical_path.starts_with(&canonical_dir) {
        return Err("Invalid installer path".to_string());
    }
    launch_installer(&canonical_path)?;
    app.exit(0);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_release_versions() {
        assert!(is_newer("1100.0", "1000.0"));
        assert!(is_newer("1000.1", "1000.0"));
        assert!(!is_newer("1000.0", "1000.0"));
        assert!(!is_newer("0999.9", "1000.0"));
    }

    #[test]
    fn strips_tag_prefix() {
        assert_eq!(normalize_version("v1100.0").as_deref(), Ok("1100.0"));
        assert!(normalize_version("vnext").is_err());
    }

    #[test]
    fn builds_mirror_urls() {
        assert_eq!(
            download_url("mirror1", "1000.3"),
            "https://github.chenc.dev/https://github.com/AomiRaku/font-fox/releases/latest/download/FontFox_1000.3_x64.exe"
        );
        assert_eq!(
            download_url("mirror2", "1000.3"),
            "https://gh-proxy.org/https://github.com/AomiRaku/font-fox/releases/latest/download/FontFox_1000.3_x64.exe"
        );
        assert_eq!(
            api_url("mirror1", None),
            "https://github.chenc.dev/https:/api.github.com/repos/AomiRaku/font-fox/releases/latest"
        );
        assert_eq!(
            api_url("github", Some("v1000.3")),
            "https://api.github.com/repos/AomiRaku/font-fox/releases/tags/v1000.3"
        );
    }
}
