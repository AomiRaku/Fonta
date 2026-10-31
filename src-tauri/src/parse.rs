// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

//! 字体文件解析：只读 `name` 表，提取家族名 / 样式 / 版本 / 版权。
//!
//! 用 `ttf-parser` 做纯解析，不写回、不修改任何字体文件。

use std::path::Path;

use ttf_parser::{name_id, Face, PlatformId};

/// 从字体文件中读到的最小元信息集合。
#[derive(Debug, Clone, Default)]
pub struct FontMeta {
    /// 选中的那个 face 的家族名。
    pub family: String,
    pub style: String,
    pub full_name: String,
    pub version: String,
    pub copyright: String,
    /// 主语言（列表里显示的那一个）：中文 / 日文 / 英语 …。
    pub language: String,
    /// 依据字形覆盖算出的全部语言，按常见度排序。
    pub languages: Vec<String>,
    /// 可变字体（含 fvar 表）。
    pub variable: bool,
    /// 可变字体 `wght` 轴范围；不是可变字体时为 0。
    pub weight_min: u16,
    pub weight_max: u16,
    /// 等宽字体。
    pub monospace: bool,
    /// 含连字特性（GSUB 里的 liga / clig）。
    pub ligatures: bool,
    /// 文件内所有 face 的家族名（TTC 时会有多个）。
    pub families: Vec<String>,
    pub format: String,
}

fn system_ui_language() -> u16 {
    // 只影响“优先显示哪个语言的 name 记录”，失败时回退英文。FontFox 仅面向 Windows。
    unsafe { windows_sys::Win32::Globalization::GetUserDefaultUILanguage() as u16 }
}

/// 可变字体的 `wght` 轴范围；非可变字体返回 `(0, 0)`。
fn weight_range(face: &Face) -> (u16, u16) {
    let Some(fvar) = face.tables().fvar else {
        return (0, 0);
    };
    for axis in fvar.axes {
        if &axis.tag.to_bytes() == b"wght" {
            let min = axis.min_value.round().clamp(1.0, 1000.0) as u16;
            let max = axis.max_value.round().clamp(1.0, 1000.0) as u16;
            return (min.min(max), max);
        }
    }
    (0, 0)
}

fn pick_name(face: &Face, wanted: u16, ui_lang: u16) -> Option<String> {
    let mut english: Option<String> = None;
    let mut fallback: Option<String> = None;

    for name in face.names() {
        if name.name_id != wanted {
            continue;
        }
        let Some(value) = name.to_string() else {
            continue;
        };
        let value = value.trim().to_string();
        if value.is_empty() {
            continue;
        }
        if name.language_id == ui_lang {
            return Some(value);
        }
        if name.platform_id == PlatformId::Windows
            && name.language_id == 0x0409
            && english.is_none()
        {
            english = Some(value.clone());
        }
        if fallback.is_none() {
            fallback = Some(value);
        }
    }

    english.or(fallback)
}

/// 书写系统归类。仅作为「字形覆盖判不出语言」时的兜底。
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Script {
    Han,
    Japanese,
    Korean,
    Latin,
    Cyrillic,
    Arabic,
    Hebrew,
    Greek,
    Thai,
    Devanagari,
    Other,
}

impl Script {
    fn from_lcid(lcid: u16) -> Script {
        // 只列常见分支；未命中一律当拉丁文（绝大多数西文字体声明 en/de/fr…）
        match lcid {
            // 中文：zh-TW / zh-CN / zh-HK / zh-SG / zh-MO …
            0x0404 | 0x0804 | 0x0C04 | 0x1004 | 0x1404 => Script::Han,
            0x0411 => Script::Japanese,
            0x0412 => Script::Korean,
            // 阿拉伯 / 波斯 / 乌尔都
            0x0401 | 0x0801 | 0x0C01 | 0x1001 | 0x1401 | 0x1801 | 0x1C01 | 0x2001 | 0x2401
            | 0x2801 | 0x2C01 | 0x3001 | 0x3401 | 0x3801 | 0x3C01 | 0x4001 | 0x0420 | 0x0429 => {
                Script::Arabic
            }
            // 西里尔：ru / uk / be / bg / sr / mk / kk / ky / tt / mn …
            0x0419 | 0x0422 | 0x0423 | 0x0402 | 0x0C1A | 0x1C1A | 0x042F | 0x043F | 0x0440
            | 0x0444 | 0x0450 | 0x0850 => Script::Cyrillic,
            0x040D => Script::Hebrew,
            0x0408 => Script::Greek,
            0x041E => Script::Thai,
            0x0439 | 0x044E | 0x044F | 0x0464 => Script::Devanagari,
            0 => Script::Other, // 语言中立：不参与统计，只在无其他记录时兜底
            _ => Script::Latin,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Script::Han => "中文",
            Script::Japanese => "日文",
            Script::Korean => "韩文",
            Script::Latin => "拉丁文",
            Script::Cyrillic => "西里尔文",
            Script::Arabic => "阿拉伯文",
            Script::Hebrew => "希伯来文",
            Script::Greek => "希腊文",
            Script::Thai => "泰文",
            Script::Devanagari => "天城文",
            Script::Other => "其他",
        }
    }
}

/// 依 name 表里各语言的记录条数，取占比最高的书写系统；并列时按枚举顺序（CJK 优先）。
fn face_language(face: &Face) -> &'static str {
    let mut counts: Vec<(Script, usize)> = Vec::new();
    let mut neutral = 0usize;
    for name in face.names() {
        if !matches!(
            name.name_id,
            name_id::FAMILY | name_id::TYPOGRAPHIC_FAMILY | name_id::FULL_NAME
        ) {
            continue;
        }
        if name.language_id == 0 {
            neutral += 1;
            continue;
        }
        let script = Script::from_lcid(name.language_id);
        match counts.iter_mut().find(|(s, _)| *s == script) {
            Some((_, n)) => *n += 1,
            None => counts.push((script, 1)),
        }
    }
    // 拉丁文几乎出现在所有字体的 name 表里，只要有其它书写系统就优先显示它
    let non_latin: Vec<&(Script, usize)> =
        counts.iter().filter(|(s, _)| *s != Script::Latin).collect();
    if non_latin.len() == 1 {
        return non_latin[0].0.label();
    }
    if non_latin.len() > 1 {
        return "多语言";
    }
    if counts.iter().any(|(s, _)| *s == Script::Latin) {
        return "拉丁文";
    }
    if neutral > 0 {
        return "拉丁文";
    }
    "未知"
}

fn face_meta(face: &Face, ui_lang: u16) -> (String, String, String) {
    let family = pick_name(face, name_id::TYPOGRAPHIC_FAMILY, ui_lang)
        .or_else(|| pick_name(face, name_id::FAMILY, ui_lang))
        .unwrap_or_default();
    let style = pick_name(face, name_id::TYPOGRAPHIC_SUBFAMILY, ui_lang)
        .or_else(|| pick_name(face, name_id::SUBFAMILY, ui_lang))
        .unwrap_or_default();
    let full = pick_name(face, name_id::FULL_NAME, ui_lang).unwrap_or_else(|| {
        if style.is_empty() {
            family.clone()
        } else {
            format!("{} {}", family, style)
        }
    });
    (family, style, full)
}

fn format_of(path: &Path, data: &[u8]) -> String {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let magic = &data[..data.len().min(4)];
    match magic {
        b"ttcf" => "TrueType Collection".to_string(),
        b"OTTO" => "OpenType".to_string(),
        b"true" | b"\x00\x01\x00\x00" => "TrueType".to_string(),
        _ => match ext.as_str() {
            "ttc" => "TrueType Collection".to_string(),
            "otf" => "OpenType".to_string(),
            "fon" | "fnt" => "Raster".to_string(),
            "ttf" => "TrueType".to_string(),
            _ => "Unknown".to_string(),
        },
    }
}

/// GSUB 的 featureList 里是否包含指定标签。
fn has_gsub_feature(face: &Face, wanted: &[&[u8; 4]]) -> bool {
    let Some(gsub) = face.raw_face().table(ttf_parser::Tag::from_bytes(b"GSUB")) else {
        return false;
    };
    let read_u16 = |at: usize| -> Option<usize> {
        let bytes = gsub.get(at..at + 2)?;
        Some(u16::from_be_bytes([bytes[0], bytes[1]]) as usize)
    };
    let feature_list = match read_u16(6) {
        Some(offset) => offset,
        None => return false,
    };
    let count = read_u16(feature_list).unwrap_or(0);
    for i in 0..count {
        let record = feature_list + 2 + i * 6;
        let Some(tag) = gsub.get(record..record + 4) else {
            return false;
        };
        if wanted.iter().any(|w| tag == *w) {
            return true;
        }
    }
    false
}

/// 解析字体文件。
///
/// `hint` 是用来挑选 TTC 内 face 的注册表展示名（已去掉 `(TrueType)` 后缀）：
/// 一个 `.ttc` 里可能有多个家族，取与注册表条目最接近的那个 face 展示。
pub fn read_meta(path: &Path, hint: &str) -> Option<FontMeta> {
    let data = std::fs::read(path).ok()?;
    if data.len() < 12 {
        return None;
    }
    let format = format_of(path, &data);
    let count = ttf_parser::fonts_in_collection(&data).unwrap_or(1).max(1);
    let ui_lang = system_ui_language();

    let hint_key = crate::system_fonts::normalize(hint);
    let mut families_all: Vec<String> = Vec::new();
    let mut best: Option<(i32, FontMeta)> = None;

    for index in 0..count.min(64) {
        let Ok(face) = Face::parse(&data, index) else {
            continue;
        };
        let (family, style, full) = face_meta(&face, ui_lang);
        if family.is_empty() && full.is_empty() {
            continue;
        }
        if !family.is_empty() && !families_all.contains(&family) {
            families_all.push(family.clone());
        }
        // 同时收集同一文件内其它 face 的家族名，便于匹配。
        for id in [name_id::FAMILY, name_id::TYPOGRAPHIC_FAMILY] {
            if let Some(other) = pick_name(&face, id, ui_lang) {
                if !other.is_empty() && !families_all.contains(&other) {
                    families_all.push(other);
                }
            }
        }

        let mut score = 0i32;
        for candidate in [&family, &full] {
            let key = crate::system_fonts::normalize(candidate);
            if key.is_empty() {
                continue;
            }
            if key == hint_key {
                score += 100;
            } else if hint_key.contains(&key) || key.contains(&hint_key) {
                score += 40;
            }
        }
        if index == 0 {
            score += 1;
        }

        // 先按字形覆盖判定语言，判不出来时退回 name 表的书写系统启发
        let detected: Vec<String> = crate::langs::detect(&face)
            .into_iter()
            .map(|name| name.to_string())
            .collect();
        let language = detected
            .first()
            .cloned()
            .unwrap_or_else(|| face_language(&face).to_string());

        let weight = weight_range(&face);
        let meta = FontMeta {
            language,
            languages: detected,
            variable: face.is_variable(),
            weight_min: weight.0,
            weight_max: weight.1,
            monospace: face.is_monospaced(),
            ligatures: has_gsub_feature(&face, &[b"liga", b"clig"]),
            version: pick_name(&face, name_id::VERSION, ui_lang).unwrap_or_default(),
            copyright: pick_name(&face, name_id::COPYRIGHT_NOTICE, ui_lang).unwrap_or_default(),
            format: format.clone(),
            family,
            style,
            full_name: full,
            families: Vec::new(),
        };

        match &best {
            Some((best_score, _)) if *best_score >= score => {}
            _ => best = Some((score, meta)),
        }
    }

    let (_, mut meta) = best?;
    meta.families = families_all;
    Some(meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_system_font() {
        let dir = crate::registry::system_font_dir();
        let candidate = dir.join("segoeui.ttf");
        if !candidate.exists() {
            return;
        }
        let meta = read_meta(&candidate, "Segoe UI").expect("应能解析 Segoe UI");
        assert!(!meta.family.is_empty());
        assert_eq!(meta.format, "TrueType");
    }

    #[test]
    fn parses_a_collection() {
        let dir = crate::registry::system_font_dir();
        for name in ["msyh.ttc", "simsun.ttc", "gulim.ttc"] {
            let path = dir.join(name);
            if path.exists() {
                let meta = read_meta(&path, "Microsoft YaHei").expect("应能解析 TTC");
                assert!(!meta.families.is_empty());
                assert_eq!(meta.format, "TrueType Collection");
                return;
            }
        }
    }
}