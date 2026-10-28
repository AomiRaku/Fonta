// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

// 发布构建不弹出控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fontfox_lib::run()
}
