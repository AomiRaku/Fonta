// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

//! 端到端往返测试：会真的写入 HKCU 字体键与 `Inactive Fonts`，并在结束时还原。
//!
//! 默认 `#[ignore]`，避免普通 `cargo test` 触碰用户字体设置。手动运行：
//!
//! ```powershell
//! cargo test --test roundtrip -- --ignored --nocapture
//! ```

use std::path::PathBuf;

use fontfox_lib::inactive::{self, InactiveSet};
use fontfox_lib::model::{FontEntry, Protection, Scope};
use fontfox_lib::registry;

const TEST_VALUE: &str = "FontFox Self Test (TrueType)";
const TEST_FAMILY: &str = "FontFox Self Test";

fn source_font() -> Option<PathBuf> {
    let dir = registry::system_font_dir();
    for name in ["consola.ttf", "segoeui.ttf", "arial.ttf", "tahoma.ttf"] {
        let path = dir.join(name);
        if path.exists() {
            return Some(path);
        }
    }
    None
}

fn make_entry(path: &std::path::Path) -> FontEntry {
    FontEntry {
        id: format!("user:{}", TEST_VALUE.to_lowercase()),
        value_name: TEST_VALUE.to_string(),
        display_name: TEST_FAMILY.to_string(),
        family: TEST_FAMILY.to_string(),
        style: "Regular".to_string(),
        full_name: TEST_FAMILY.to_string(),
        language: "英语".to_string(),
        languages: vec!["英语".to_string()],
        variable: false,
        weight_min: 0,
        weight_max: 0,
        monospace: false,
        ligatures: false,
        scope: Scope::User,
        file_name: path
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: path.to_string_lossy().to_string(),
        exists: true,
        size: 1,
        added_at: 0,
        format: "TrueType".to_string(),
        families: vec![TEST_FAMILY.to_string()],
        protected: false,
        protection: Protection::None,
        hidden: false,
        deletable: true,
        requires_elevation: false,
        version: String::new(),
        copyright: String::new(),
    }
}

fn cleanup(path: &std::path::Path) {
    if let Ok(key) = registry::open_fonts_key_writable(Scope::User) {
        let _ = key.delete_value(TEST_VALUE);
    }
    let _ = std::fs::remove_file(path);
}

#[test]
#[ignore = "会写入真实 HKCU 字体键，需手动运行"]
fn hide_show_roundtrip() {
    let original = registry::read_inactive_fonts().expect("读取 Inactive Fonts");
    let entry = make_entry(&registry::user_font_dir().join("FontFoxSelfTest.ttf"));

    let added = inactive::hide(std::slice::from_ref(&entry)).expect("隐藏字体");
    assert!(added >= 1, "应新增至少一条 Inactive Fonts 记录");

    let after_hide = InactiveSet::load();
    assert!(after_hide.contains(&entry), "隐藏后应能匹配到该字体");

    let removed = inactive::show(std::slice::from_ref(&entry)).expect("显示字体");
    assert!(removed >= 1, "应移除至少一条 Inactive Fonts 记录");

    let restored = registry::read_inactive_fonts().expect("读取 Inactive Fonts");
    assert_eq!(restored, original, "隐藏状态应被还原");
}

#[test]
#[ignore = "会写入真实 HKCU 字体键，需手动运行"]
fn delete_user_font_roundtrip() {
    let Some(source) = source_font() else {
        eprintln!("跳过：系统字体目录里没有可用的测试字体");
        return;
    };

    let dest = registry::user_font_dir().join("FontFoxSelfTest.ttf");
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).expect("创建用户字体目录");
    }
    std::fs::copy(&source, &dest).expect("复制测试字体");

    // 注册到 HKCU，模拟一个真实的用户字体。
    {
        let key = registry::open_fonts_key_writable(Scope::User).expect("打开 HKCU 字体键");
        key.set_value(TEST_VALUE, &dest.to_string_lossy().to_string())
            .expect("写入测试字体注册项");
    }

    let entry = make_entry(&dest);
    let report = fontfox_lib::delete::delete_entries(std::slice::from_ref(&entry), false);
    eprintln!("删除报告：{:?}", report);

    assert_eq!(report.removed_count, 1, "应删除 1 条记录");
    assert!(!dest.exists(), "字体文件应被删除");

    let key = registry::open_fonts_key_writable(Scope::User).expect("打开 HKCU 字体键");
    assert!(
        key.get_value::<String, _>(TEST_VALUE).is_err(),
        "注册表值应被删除"
    );

    cleanup(&dest);
}
