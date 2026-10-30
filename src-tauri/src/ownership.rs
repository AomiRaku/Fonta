// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

//! 通过文件所有权判断「这个字体是不是系统自带的」。
//!
//! Windows 没有「系统字体」标志位，但随系统分发的字体文件有一个稳定特征：
//! 所有者是 `NT SERVICE\TrustedInstaller`（或 SYSTEM），由 Windows 资源保护
//! 托管，普通管理员也删不掉。第三方字体即使装进 `C:\Windows\Fonts`，所有者
//! 也是 `Administrators` 或当前用户。
//!
//! 探测失败的极端情况下退回 `SfcIsFileProtected`（Windows 资源保护自己的判定），
//! 再失败就当作「不是系统字体」，交给静态清单兜底。

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// 随系统分发的文件所有者 SID（与语言无关，直接比较 SID 字符串）。
const TRUSTED_INSTALLER: &str = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
/// 本地系统账户。
const LOCAL_SYSTEM: &str = "S-1-5-18";

fn cache() -> &'static Mutex<HashMap<String, bool>> {
    static CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 路径 → 是否系统自带；结果按路径缓存，扫描时同一文件只探测一次。
pub fn is_system_owned(path: &Path) -> bool {
    let key = path.to_string_lossy().to_lowercase();
    if let Ok(guard) = cache().lock() {
        if let Some(hit) = guard.get(&key) {
            return *hit;
        }
    }
    let owned = probe(path);
    if let Ok(mut guard) = cache().lock() {
        guard.insert(key, owned);
    }
    owned
}

#[cfg(windows)]
fn probe(path: &Path) -> bool {
    match owner_sid(path) {
        Some(sid) => matches_owner(&sid),
        None => sfc_protected(path),
    }
}

#[cfg(not(windows))]
fn probe(_path: &Path) -> bool {
    false
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;

    use windows_sys::Win32::Foundation::{LocalFree, ERROR_SUCCESS};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::OWNER_SECURITY_INFORMATION;

    #[link(name = "sfc")]
    extern "system" {
        /// Windows 资源保护判定（sfc.dll，未公开文档但长期稳定）。
        fn SfcIsFileProtected(rpc_handle: *mut c_void, file: *const u16) -> i32;
    }

    /// 读取文件所有者的 SID 字符串；任何一步失败都返回 None。
    pub fn owner_sid(path: &std::path::Path) -> Option<String> {
        use std::os::windows::ffi::OsStrExt;

        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let mut sd: *mut c_void = std::ptr::null_mut();
        let mut owner: *mut c_void = std::ptr::null_mut();
        // SAFETY: 传入合法宽字符串与出参指针；成功后 sd 需要 LocalFree。
        let rc = unsafe {
            GetNamedSecurityInfoW(
                wide.as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut sd,
            )
        };
        if rc != ERROR_SUCCESS || sd.is_null() {
            return None;
        }

        let mut text: *mut u16 = std::ptr::null_mut();
        // SAFETY: owner 由上面的调用填充，text 由系统分配，需要 LocalFree。
        let ok = unsafe { ConvertSidToStringSidW(owner, &mut text) } != 0;
        let mut out = None;
        if ok && !text.is_null() {
            let mut len = 0usize;
            // SAFETY: text 是 0 结尾的宽字符串。
            unsafe {
                while *text.add(len) != 0 {
                    len += 1;
                }
                let slice = std::slice::from_raw_parts(text, len);
                out = Some(String::from_utf16_lossy(slice));
                LocalFree(text as *mut c_void);
            }
        }
        // SAFETY: sd 由 GetNamedSecurityInfoW 分配。
        unsafe {
            LocalFree(sd);
        }
        out
    }

    pub fn sfc_protected(path: &std::path::Path) -> bool {
        use std::os::windows::ffi::OsStrExt;

        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: 传 NULL 句柄表示本地检查，路径是合法宽字符串。
        unsafe { SfcIsFileProtected(std::ptr::null_mut(), wide.as_ptr()) != 0 }
    }
}

#[cfg(windows)]
use win::{owner_sid, sfc_protected};

fn matches_owner(sid: &str) -> bool {
    sid == TRUSTED_INSTALLER || sid == LOCAL_SYSTEM
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trusted_installer_sid_is_recognized() {
        assert!(matches_owner(TRUSTED_INSTALLER));
        assert!(matches_owner(LOCAL_SYSTEM));
        assert!(!matches_owner("S-1-5-32-544")); // Administrators
        assert!(!matches_owner("S-1-5-21-1-2-3-1001")); // 普通用户
    }

    #[test]
    fn missing_path_is_not_system_owned() {
        assert!(!is_system_owned(Path::new(
            r"C:\__fontfox_不存在__\nope.ttf"
        )));
    }

    #[cfg(windows)]
    #[test]
    fn system_font_dir_reports_os_fonts() {
        let segoe = Path::new(r"C:\Windows\Fonts\segoeui.ttf");
        if segoe.exists() {
            assert!(is_system_owned(segoe), "Segoe UI 应判定为系统字体");
        }
    }

}
