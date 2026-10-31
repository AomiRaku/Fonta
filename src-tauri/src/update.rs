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
const MIRROR_PREFIX: &str = "https://gh-proxy.org/";
const DOWNLOAD_BASE: &str = "https://github.com/AomiRaku/font-fox/releases/download";
const DOWNLOAD_EVENT: &str = "update-download";

static DOWNLOAD_CANCEL: AtomicBool = AtomicBool::new(false);
static DOWNLOAD_ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub latest_version: String,
    pub notes: String,
    pub download_url: String,
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
    #[serde(default)]
    assets: Vec<ReleaseAsset>,
}

#[derive(Deserialize)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
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
        return Err(format!("无法解析版本号：{raw}"));
    }
    Ok(text.to_string())
}

fn api_url(source: &str, version: Option<&str>) -> String {
    let base = if source == "mirror" {
        format!("{MIRROR_PREFIX}{GITHUB_API}")
    } else {
        GITHUB_API.to_string()
    };
    match version {
        Some(version) => format!("{base}/repos/{REPO}/releases/tags/v{version}"),
        None => format!("{base}/repos/{REPO}/releases/latest"),
    }
}

fn download_url(source: &str, version: &str) -> String {
    let file = format!("FontFox_{version}_x64.exe");
    let url = format!("{DOWNLOAD_BASE}/v{version}/{file}");
    if source == "mirror" {
        format!("{MIRROR_PREFIX}{url}")
    } else {
        url
    }
}

fn release_asset_url(source: &str, release: &ReleaseResponse, version: &str) -> String {
    let asset = release
        .assets
        .iter()
        .find(|asset| {
            let name = asset.name.to_ascii_lowercase();
            name.ends_with(".exe") && name.contains("x64")
        })
        .or_else(|| {
            release
                .assets
                .iter()
                .find(|asset| asset.name.to_ascii_lowercase().ends_with(".exe"))
        });
    match asset {
        Some(asset) if source == "mirror" => {
            format!("{MIRROR_PREFIX}{}", asset.browser_download_url)
        }
        Some(asset) => asset.browser_download_url.clone(),
        None => download_url(source, version),
    }
}

fn normalize_download_url(source: &str, url: &str, version: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Ok(download_url(source, version));
    }
    if url.starts_with("https://github.com/")
        || url.starts_with("https://gh-proxy.org/https://github.com/")
    {
        Ok(url.to_string())
    } else {
        Err("更新地址无效".to_string())
    }
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(format!("FontFox/{}", current_version()))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|err| format!("创建网络客户端失败：{err}"))
}

fn fetch_release(source: &str, version: Option<&str>) -> Result<ReleaseResponse, String> {
    let url = api_url(source, version);
    let response = client()?
        .get(url)
        .timeout(Duration::from_secs(20))
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|err| format!("请求更新信息失败：{err}"))?;
    if !response.status().is_success() {
        return Err(format!("更新源返回 HTTP {}", response.status()));
    }
    response
        .json::<ReleaseResponse>()
        .map_err(|err| format!("解析更新信息失败：{err}"))
}

fn check_update_sync(source: &str) -> Result<Option<UpdateInfo>, String> {
    let release = fetch_release(source, None)?;
    let latest = normalize_version(&release.tag_name)?;
    let current = current_version();
    if !is_newer(&latest, &current) {
        return Ok(None);
    }
    let download_url = release_asset_url(source, &release, &latest);
    Ok(Some(UpdateInfo {
        latest_version: latest,
        notes: release.body.unwrap_or_default(),
        download_url,
    }))
}

#[tauri::command]
pub async fn check_update(source: String) -> Result<Option<UpdateInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || check_update_sync(&source))
        .await
        .map_err(|err| format!("检查更新失败：{err}"))?
}

#[tauri::command]
pub async fn release_notes(source: String, version: String) -> Result<String, String> {
    let version = normalize_version(&version)?;
    tauri::async_runtime::spawn_blocking(move || {
        fetch_release(&source, Some(&version)).map(|release| release.body.unwrap_or_default())
    })
    .await
    .map_err(|err| format!("读取更新日志失败：{err}"))?
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

fn download_sync(
    app: &AppHandle,
    source: &str,
    version: &str,
    url: &str,
) -> Result<String, String> {
    let version = normalize_version(version)?;
    let url = normalize_download_url(source, url, &version)?;
    let dir = update_dir();
    std::fs::create_dir_all(&dir).map_err(|err| format!("无法创建下载目录：{err}"))?;
    let path = download_path(&version);
    let _ = std::fs::remove_file(&path);

    let mut response = client()?
        .get(url)
        .send()
        .map_err(|err| format!("下载更新失败：{err}"))?;
    if !response.status().is_success() {
        return Err(format!("下载更新失败：HTTP {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    let mut file = File::create(&path).map_err(|err| format!("无法创建安装包：{err}"))?;

    let mut buffer = vec![0u8; 64 * 1024];
    let mut downloaded = 0u64;
    let mut last_bytes = 0u64;
    let mut last_emit = Instant::now();

    emit_progress(app, 0, total, 0.0);

    loop {
        if DOWNLOAD_CANCEL.load(AtomicOrdering::SeqCst) {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err("已取消下载".to_string());
        }
        let read = match response.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(err) => {
                drop(file);
                let _ = std::fs::remove_file(&path);
                return Err(format!("下载更新失败：{err}"));
            }
        };
        if let Err(err) = file.write_all(&buffer[..read]) {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err(format!("写入安装包失败：{err}"));
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
        return Err(format!("写入安装包失败：{err}"));
    }
    drop(file);
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
    url: String,
) -> Result<String, String> {
    if DOWNLOAD_ACTIVE.swap(true, AtomicOrdering::SeqCst) {
        return Err("已有更新正在下载".to_string());
    }
    DOWNLOAD_CANCEL.store(false, AtomicOrdering::SeqCst);
    let app_for_task = app.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || {
            download_sync(&app_for_task, &source, &version, &url)
        })
        .await;
    DOWNLOAD_ACTIVE.store(false, AtomicOrdering::SeqCst);
    result.map_err(|err| format!("下载更新失败：{err}"))?
}

#[tauri::command]
pub fn cancel_update_download() {
    DOWNLOAD_CANCEL.store(true, AtomicOrdering::SeqCst);
}

#[tauri::command]
pub fn install_update(app: AppHandle, path: String) -> Result<(), String> {
    let dir = update_dir();
    let canonical_dir = dir
        .canonicalize()
        .map_err(|err| format!("更新目录不存在：{err}"))?;
    let canonical_path = Path::new(&path)
        .canonicalize()
        .map_err(|err| format!("安装包不存在：{err}"))?;
    if !canonical_path.starts_with(&canonical_dir) {
        return Err("安装包路径无效".to_string());
    }
    std::process::Command::new(&canonical_path)
        .arg("/UPDATE")
        .spawn()
        .map_err(|err| format!("无法启动安装程序：{err}"))?;
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
}
