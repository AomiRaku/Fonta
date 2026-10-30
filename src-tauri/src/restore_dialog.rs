// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

//! 卸载恢复失败时的原生对话框：仅「重试」按钮，关闭窗口同样视为重试。

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr;

    use windows_sys::Win32::UI::Controls::{
        TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TASKDIALOG_FLAGS, TDCBF_OK_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION,
        TaskDialog, TaskDialogIndirect,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 显示「恢复失败 + 重试」对话框。只有一个自定义按钮「重试」；
    /// 点关闭（X）同样会返回，调用方继续重试。
    pub fn show_retry(error: &str) {
        let title = wide("FontFox 恢复字体失败");
        let instruction = wide("无法恢复已停用的字体");
        let content = wide(&format!(
            "{error}\r\n\r\n请关闭占用字体的程序后重试；关闭本窗口也会重试。"
        ));
        let button_text = wide("重试");
        let button = TASKDIALOG_BUTTON {
            nButtonID: 101,
            pszButtonText: button_text.as_ptr(),
        };
        let mut config: TASKDIALOGCONFIG = unsafe { std::mem::zeroed() };
        config.cbSize = size_of::<TASKDIALOGCONFIG>() as u32;
        config.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION as TASKDIALOG_FLAGS;
        config.dwCommonButtons = 0;
        config.pszWindowTitle = title.as_ptr();
        config.pszMainInstruction = instruction.as_ptr();
        config.pszContent = content.as_ptr();
        config.cButtons = 1;
        config.pButtons = &button;
        config.nDefaultButton = 101;
        let mut pressed = 0i32;
        unsafe {
            TaskDialogIndirect(&config, &mut pressed, ptr::null_mut(), ptr::null_mut());
        }
    }

    /// 最终提示：失败的字体已经复制到桌面，可手动重新安装。
    pub fn show_final(error: &str, folder: &str, count: usize) {
        let title = wide("FontFox 恢复字体失败");
        let instruction = wide("恢复失败");
        let content = if count > 0 {
            wide(&format!(
                "以下字体未能自动恢复，已复制到桌面的 FontFox Uninstalled Fonts 文件夹，可以手动重新安装：\r\n{folder}\r\n\r\n{error}"
            ))
        } else {
            wide(&format!(
                "以下字体未能自动恢复，且没有可复制的隔离文件，请手动检查字体目录：\r\n\r\n{error}"
            ))
        };
        let mut pressed = 0i32;
        unsafe {
            TaskDialog(
                ptr::null_mut::<c_void>(),
                ptr::null_mut::<c_void>(),
                title.as_ptr(),
                instruction.as_ptr(),
                content.as_ptr(),
                TDCBF_OK_BUTTON,
                ptr::null(),
                &mut pressed,
            );
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn show_retry(_error: &str) {}
    pub fn show_final(_error: &str, _folder: &str, _count: usize) {}
}

pub use imp::{show_final, show_retry};