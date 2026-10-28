// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

//! 注册表与路径相关的底层访问。
//!
//! 只使用标准库 + `winreg`，不引入额外运行时。

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use winreg::enums::{
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE, KEY_WOW64_64KEY, REG_MULTI_SZ,
};
use winreg::{RegKey, RegValue};

use crate::model::Scope;

/// 字体注册表键（HKLM / HKCU 下同名）。
pub const FONTS_SUBKEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts";
/// 字体隐藏状态键（仅 HKCU）。
pub const FONT_MANAGEMENT_SUBKEY: &str =
    r"Software\Microsoft\Windows NT\CurrentVersion\Font Management";
/// 被隐藏字体的多字符串值名。
pub const INACTIVE_FONTS_VALUE: &str = "Inactive Fonts";


/// `C:\Windows\Fonts`
pub fn system_font_dir() -> PathBuf {
    let root = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("WINDIR"))
        .unwrap_or_else(|| OsString::from(r"C:\Windows"));
    PathBuf::from(root).join("Fonts")
}

/// `%LOCALAPPDATA%\Microsoft\Windows\Fonts`
pub fn user_font_dir() -> PathBuf {
    let base = match std::env::var_os("LOCALAPPDATA") {
        Some(v) => PathBuf::from(v),
        None => {
            let profile = std::env::var_os("USERPROFILE").unwrap_or_else(|| OsString::from(r"C:\"));
            PathBuf::from(profile).join("AppData").join("Local")
        }
    };
    base.join("Microsoft").join("Windows").join("Fonts")
}

/// 展开 `%VAR%` 形式的环境变量（注册表里偶尔会写 `%SystemRoot%\Fonts\...`）。
pub fn expand_env(input: &str) -> String {
    if !input.contains('%') {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let var = &after[..end];
                match std::env::var(var) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => {
                        out.push('%');
                        out.push_str(var);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push('%');
                out.push_str(after);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// 把注册表 Data 解析为绝对路径。
///
/// Data 可能是纯文件名（HKLM 常见），也可能是绝对路径（HKCU 常见），
/// 因此不能只按作用域拼目录，必须先判断是否为绝对路径。
pub fn resolve_font_path(scope: Scope, data: &str) -> PathBuf {
    let expanded = expand_env(data.trim());
    let candidate = Path::new(&expanded);
    if candidate.is_absolute() {
        return candidate.to_path_buf();
    }
    match scope {
        Scope::System => system_font_dir().join(&expanded),
        Scope::User => user_font_dir().join(&expanded),
    }
}

/// 路径是否位于 `%WINDIR%\Fonts` 下。
pub fn is_in_system_font_dir(path: &Path) -> bool {
    let dir = system_font_dir();
    let dir = dir.as_os_str().to_string_lossy().to_lowercase();
    let p = path.as_os_str().to_string_lossy().to_lowercase();
    p.starts_with(&dir)
}

/// 去掉注册表值名末尾的 `(TrueType)` 一类后缀。
pub fn strip_type_suffix(value_name: &str) -> String {
    const SUFFIXES: [&str; 6] = [
        " (truetype collection)",
        " (truetype)",
        " (opentype)",
        " (postscript)",
        " (all res)",
        " (bitmap)",
    ];
    let lower = value_name.to_lowercase();
    for suffix in SUFFIXES {
        if lower.ends_with(suffix) {
            return value_name[..value_name.len() - suffix.len()]
                .trim_end()
                .to_string();
        }
    }
    value_name.trim().to_string()
}

fn decode_utf16_strings(bytes: &[u8]) -> Vec<String> {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    units
        .split(|u| *u == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf16_lossy(s))
        .collect()
}

fn decode_utf16z(bytes: &[u8]) -> String {
    decode_utf16_strings(bytes)
        .into_iter()
        .next()
        .unwrap_or_default()
}

/// 按作用域打开字体键（只读）。
pub fn open_fonts_key(scope: Scope) -> std::io::Result<RegKey> {
    let hive = match scope {
        Scope::System => RegKey::predef(HKEY_LOCAL_MACHINE),
        Scope::User => RegKey::predef(HKEY_CURRENT_USER),
    };
    hive.open_subkey_with_flags(FONTS_SUBKEY, KEY_READ | KEY_WOW64_64KEY)
}

/// 按作用域打开字体键（可写）。
pub fn open_fonts_key_writable(scope: Scope) -> std::io::Result<RegKey> {
    let hive = match scope {
        Scope::System => RegKey::predef(HKEY_LOCAL_MACHINE),
        Scope::User => RegKey::predef(HKEY_CURRENT_USER),
    };
    hive.open_subkey_with_flags(FONTS_SUBKEY, KEY_READ | KEY_WRITE | KEY_WOW64_64KEY)
}

/// 一条字体注册表记录。
#[derive(Debug, Clone)]
pub struct FontValue {
    pub name: String,
    pub data: String,
}

/// 读取某个作用域下 `...\Fonts` 的全部 Value。
pub fn read_font_values(scope: Scope) -> std::io::Result<Vec<FontValue>> {
    let key = match open_fonts_key(scope) {
        Ok(k) => k,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };

    let mut out = Vec::new();
    for item in key.enum_values() {
        let (name, raw) = match item {
            Ok(v) => v,
            Err(_) => continue,
        };
        let data = decode_utf16z(&raw.bytes);
        if data.trim().is_empty() {
            continue;
        }
        out.push(FontValue { name, data });
    }
    Ok(out)
}

/// 删除某个作用域下指定的字体注册表 Value。返回是否真的删掉了。
pub fn delete_font_value(scope: Scope, value_name: &str) -> Result<bool, String> {
    let key = open_fonts_key_writable(scope).map_err(|e| {
        format!(
            "无权限写入 {}\\{}：{}",
            match scope {
                Scope::System => "HKLM",
                Scope::User => "HKCU",
            },
            FONTS_SUBKEY,
            e
        )
    })?;
    match key.delete_value(value_name) {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(format!("删除注册表值 “{}” 失败：{}", value_name, err)),
    }
}

/// 读取 `Inactive Fonts`（REG_MULTI_SZ）。
pub fn read_inactive_fonts() -> Result<Vec<String>, String> {
    let hive = RegKey::predef(HKEY_CURRENT_USER);
    let key = match hive.open_subkey_with_flags(
        FONT_MANAGEMENT_SUBKEY,
        KEY_READ | KEY_WOW64_64KEY,
    ) {
        Ok(k) => k,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("读取 Font Management 键失败：{}", err)),
    };
    match key.get_raw_value(INACTIVE_FONTS_VALUE) {
        Ok(raw) => Ok(decode_utf16_strings(&raw.bytes)
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(format!("读取 Inactive Fonts 失败：{}", err)),
    }
}

/// 写回 `Inactive Fonts`。空列表也要写入合法的 REG_MULTI_SZ（两个 NUL 结尾）。
pub fn write_inactive_fonts(items: &[String]) -> Result<(), String> {
    let hive = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hive
        .create_subkey_with_flags(FONT_MANAGEMENT_SUBKEY, KEY_READ | KEY_WRITE | KEY_WOW64_64KEY)
        .map_err(|e| format!("无法打开 Font Management 键：{}", e))?;

    let mut bytes: Vec<u8> = Vec::new();
    for item in items {
        for unit in item.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes.extend_from_slice(&0u16.to_le_bytes());
    }
    // REG_MULTI_SZ 以额外的空字符串结尾。
    bytes.extend_from_slice(&0u16.to_le_bytes());

    let value = RegValue {
        bytes,
        vtype: REG_MULTI_SZ,
    };
    key.set_raw_value(INACTIVE_FONTS_VALUE, &value)
        .map_err(|e| format!("写入 Inactive Fonts 失败：{}", e))
}


/// 当前进程是否具备管理员权限。
///
/// 用“能否以写方式打开 HKLM 字体键”来判断，避免为一次权限检查引入
/// `OpenProcessToken` 相关的整组 FFI。
pub fn is_elevated() -> bool {
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(FONTS_SUBKEY, KEY_READ | KEY_WRITE | KEY_WOW64_64KEY)
        .is_ok()
}

/// 应用数据目录：`%USERPROFILE%\.FontFox`。
pub fn app_data_dir() -> PathBuf {
    crate::config::app_dir()
}
