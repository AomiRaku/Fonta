// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

use std::path::{Path, PathBuf};

/// 把根目录 `langBuild/*.ini` 复制到 `target/<profile>/lang/`。
///
/// 这样 debug 运行与 release 构建拿到的语言文件都来自根目录的同一份，
/// 手动改 `langBuild/schinese.ini` 后重新构建即可生效；
/// 想不重新编译就生效，直接改 exe 旁边的 `lang/schinese.ini` 即可。
fn copy_langs() {
    let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") else {
        return;
    };
    let Some(project_root) = Path::new(&manifest_dir).parent() else {
        return;
    };
    let source = project_root.join("langBuild");
    println!("cargo:rerun-if-changed={}", source.display());
    if !source.is_dir() {
        return;
    }

    // OUT_DIR = <target>/<profile>/build/<pkg>-<hash>/out，上溯三级即 <target>/<profile>
    let Ok(out_dir) = std::env::var("OUT_DIR") else {
        return;
    };
    let Some(profile_dir) = PathBuf::from(&out_dir).ancestors().nth(3).map(Path::to_path_buf) else {
        return;
    };
    let dest = profile_dir.join("lang");
    if std::fs::create_dir_all(&dest).is_err() {
        return;
    }

    let Ok(entries) = std::fs::read_dir(&source) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_ini = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("ini"));
        if !is_ini {
            continue;
        }
        println!("cargo:rerun-if-changed={}", path.display());
        let _ = std::fs::copy(&path, dest.join(entry.file_name()));
    }
}

fn main() {
    println!("cargo:rerun-if-changed=app.manifest");
    copy_langs();

    // 始终使用自带清单：Common-Controls v6 + Windows 10/11 兼容性声明（影响 DPI 行为）。
    // 权限级别是 asInvoker —— 启动不弹 UAC，只有删除系统作用域字体时才按需用 runas 提权。
    let windows = tauri_build::WindowsAttributes::new().app_manifest(include_str!("app.manifest"));
    let attributes = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attributes).expect("tauri-build 失败");
}
