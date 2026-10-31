// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

//! UAC 提权：以管理员身份重启自身执行删除，并读取子进程写回的结果。

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::delete::{self, ElevationRequest};
use crate::model::DeleteReport;

/// 提权子进程的命令行开关。
pub const ELEVATED_FLAG: &str = "--fontfox-elevated-delete";

fn run_as_admin(exe: &Path, parameters: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
    use windows_sys::Win32::System::Threading::{WaitForSingleObject, INFINITE};
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };

    const ERROR_CANCELLED: u32 = 1223;
    const SW_HIDE: i32 = 0;

    let verb: Vec<u16> = "runas\0".encode_utf16().collect();
    let file: Vec<u16> = exe
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let params: Vec<u16> = parameters
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = params.as_ptr();
    info.nShow = SW_HIDE;

    let ok = unsafe { ShellExecuteExW(&mut info) };
    if ok == 0 {
        let code = unsafe { GetLastError() };
        return Err(if code == ERROR_CANCELLED {
            "已取消管理员授权，未执行任何删除。".to_string()
        } else {
            format!("无法启动管理员进程（错误码 {}）。", code)
        });
    }

    if !info.hProcess.is_null() {
        unsafe {
            WaitForSingleObject(info.hProcess, INFINITE);
            CloseHandle(info.hProcess);
        }
    }
    Ok(())
}

/// 提权删除一组字体。返回提权子进程写回的报告。
pub fn delete_with_elevation(ids: Vec<String>) -> Result<DeleteReport, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let request_path = std::env::temp_dir().join(format!(
        "fontfox-elev-{}-{}.json",
        std::process::id(),
        stamp
    ));

    let request = ElevationRequest { ids };
    let text = serde_json::to_string(&request).map_err(|e| format!("序列化请求失败：{}", e))?;
    std::fs::write(&request_path, text).map_err(|e| format!("写入提权请求失败：{}", e))?;

    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(err) => {
            let _ = std::fs::remove_file(&request_path);
            return Err(format!("无法定位程序自身路径：{}", err));
        }
    };
    let parameters = format!("{} {}", ELEVATED_FLAG, quote(&request_path));

    if let Err(err) = run_as_admin(&exe, &parameters) {
        let _ = std::fs::remove_file(&request_path);
        return Err(err);
    }

    let response_path = delete::elevation_response_path(&request_path);
    let outcome = delete::read_elevation_response(&response_path);
    let _ = std::fs::remove_file(&request_path);
    let _ = std::fs::remove_file(&response_path);
    outcome
}

/// 给含空格的路径加引号（ShellExecuteEx 的 lpParameters 需要自行处理）。
fn quote(path: &Path) -> String {
    let text = path.as_os_str().to_string_lossy().to_string();
    if text.contains(' ') {
        format!("\"{}\"", text)
    } else {
        text
    }
}
