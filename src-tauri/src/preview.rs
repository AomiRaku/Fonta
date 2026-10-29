// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

//! 预览样字的 Rust 栅格化。
//!
//! 为什么不用 WebView 的字体：Chromium 会把加载过的字体文件缓存在渲染进程里，
//! 删除 `FontFace`、重载页面、甚至 Worker 被销毁都不会释放，滚一遍全库能涨到 1GB。
//! 因此样字改由 Rust 渲染成位图，前端只贴图，WebView 不再接触任何字体文件。
//!
//! 字体里没有的字符直接跳过（不做字形回退）：英文字体展示中文时留空，
//! 而不是用系统字体冒充该字体的字形。`max_width > 0` 时按词 / 字符折行。

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

use ab_glyph::{Font, FontRef, Glyph, GlyphId, PxScale, ScaleFont, point};
use base64::Engine;

/// 缓存条数上限
const MAX_CACHED: usize = 400;
/// 缓存总字节上限
const MAX_CACHED_BYTES: usize = 48 * 1024 * 1024;
/// 位图四周留白（设备像素）
const PAD: i32 = 2;
/// 折行后最多渲染的行数
const MAX_LINES: usize = 8;

pub fn render(
    path: &str,
    text: &str,
    size: f32,
    color: &str,
    dpr: f32,
    max_width: f32,
) -> Result<String, String> {
    let key = format!("{path}|{text}|{size}|{dpr}|{color}|{max_width}");
    if let Some(hit) = cache_lookup(&key) {
        return Ok(hit);
    }

    let bytes = std::fs::read(path).map_err(|error| format!("读取字体失败：{error}"))?;
    let font = FontRef::try_from_slice(&bytes).map_err(|error| format!("解析字体失败：{error}"))?;
    let data_url = rasterize(&font, text, size, color, dpr, max_width)?;
    cache_store(key, data_url.clone());
    Ok(data_url)
}

fn rasterize(
    font: &FontRef<'_>,
    text: &str,
    size: f32,
    color: &str,
    dpr: f32,
    max_width: f32,
) -> Result<String, String> {
    let scale = (size * dpr).clamp(6.0, 512.0);
    let px_scale = PxScale::from(scale);
    let scaled = font.as_scaled(px_scale);
    let (red, green, blue) = parse_color(color);
    let limit = max_width * dpr;

    let ascent = scaled.ascent().ceil();
    let descent = scaled.descent().ceil();
    let line_height = (ascent - descent).max(scale);

    let lines = layout(font, px_scale, text, limit);
    let mut widest = 0.0f32;
    for line in &lines {
        let mut end = 0.0f32;
        if let Some((last_id, last_x)) = line.last() {
            end = *last_x + scaled.h_advance(*last_id);
        }
        widest = widest.max(end);
    }

    let width = (widest.ceil() as i32 + PAD * 2).max(8) as u32;
    let height = ((line_height * lines.len() as f32).ceil() as i32 + PAD * 2).max(8) as u32;
    let stride = width as usize * 4;
    let mut pixels = vec![0u8; stride * height as usize];

    for (line_index, line) in lines.iter().enumerate() {
        let baseline = PAD as f32 + ascent + line_index as f32 * line_height;
        for (id, x) in line {
            let glyph = Glyph {
                id: *id,
                scale: px_scale,
                position: point(PAD as f32 + *x, baseline),
            };
            let Some(outlined) = font.outline_glyph(glyph) else {
                continue;
            };
            let bounds = outlined.px_bounds();
            outlined.draw(|gx, gy, coverage| {
                let px = bounds.min.x as i32 + gx as i32;
                let py = bounds.min.y as i32 + gy as i32;
                if px < 0 || py < 0 || px >= width as i32 || py >= height as i32 {
                    return;
                }
                let offset = py as usize * stride + px as usize * 4;
                let alpha = (coverage * 255.0).round() as u8;
                if alpha <= pixels[offset + 3] {
                    return;
                }
                pixels[offset] = red;
                pixels[offset + 1] = green;
                pixels[offset + 2] = blue;
                pixels[offset + 3] = alpha;
            });
        }
    }

    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| format!("编码失败：{error}"))?;
        writer
            .write_image_data(&pixels)
            .map_err(|error| format!("编码失败：{error}"))?;
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    Ok(format!("data:image/png;base64,{encoded}"))
}

/// 逐行排版：`limit <= 0` 表示不折行。
fn layout(
    font: &FontRef<'_>,
    px_scale: PxScale,
    text: &str,
    limit: f32,
) -> Vec<Vec<(GlyphId, f32)>> {
    let scaled = font.as_scaled(px_scale);
    let mut lines: Vec<Vec<(GlyphId, f32)>> = vec![Vec::new()];
    let mut pen = 0.0f32;

    for token in tokens(text) {
        let is_space = token.chars().all(char::is_whitespace);
        let token_width: f32 = token
            .chars()
            .filter(|ch| font.glyph_id(*ch).0 != 0)
            .map(|ch| scaled.h_advance(font.glyph_id(ch)))
            .sum();
        let current_empty = lines.last().map(|line| line.is_empty()).unwrap_or(true);

        if limit > 0.0 && !current_empty && pen + token_width > limit {
            if is_space {
                continue;
            }
            if lines.len() >= MAX_LINES {
                break;
            }
            lines.push(Vec::new());
            pen = 0.0;
        }

        for ch in token.chars() {
            if ch.is_whitespace() {
                // 行首不加空格
                if pen <= 0.0 {
                    continue;
                }
                let id = font.glyph_id(ch);
                if id.0 == 0 {
                    continue;
                }
                let advance = scaled.h_advance(id);
                if let Some(line) = lines.last_mut() {
                    line.push((id, pen));
                }
                pen += advance;
                continue;
            }
            let id = font.glyph_id(ch);
            // 字体没有这个字符：直接跳过，不用别的字体冒充
            if id.0 == 0 {
                continue;
            }
            let advance = scaled.h_advance(id);
            if limit > 0.0 && pen + advance > limit && pen > 0.0 {
                if lines.len() >= MAX_LINES {
                    return lines;
                }
                lines.push(Vec::new());
                pen = 0.0;
            }
            if let Some(line) = lines.last_mut() {
                line.push((id, pen));
            }
            pen += advance;
        }
    }

    if lines.is_empty() {
        lines.push(Vec::new());
    }
    lines
}

/// 切成「连续非空格」与「单个空格」两类片段，便于按词折行。
fn tokens(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut space_run = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !space_run && !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            space_run = true;
            out.push(" ".to_string());
        } else {
            space_run = false;
            current.push(ch);
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

fn parse_color(color: &str) -> (u8, u8, u8) {
    let trimmed = color.trim().trim_start_matches('#');
    if trimmed.len() >= 6 {
        if let (Ok(red), Ok(green), Ok(blue)) = (
            u8::from_str_radix(&trimmed[0..2], 16),
            u8::from_str_radix(&trimmed[2..4], 16),
            u8::from_str_radix(&trimmed[4..6], 16),
        ) {
            return (red, green, blue);
        }
    }
    (0, 0, 0)
}

struct Cache {
    data: HashMap<String, (String, usize)>,
    order: VecDeque<String>,
    bytes: usize,
}

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| {
        Mutex::new(Cache {
            data: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
        })
    })
}

fn cache_lookup(key: &str) -> Option<String> {
    let mut cache = cache().lock().ok()?;
    let entry = cache.data.get(key)?;
    let value = entry.0.clone();
    if let Some(index) = cache.order.iter().position(|item| item == key) {
        cache.order.remove(index);
    }
    cache.order.push_back(key.to_string());
    Some(value)
}

fn cache_store(key: String, value: String) {
    let Ok(mut cache) = cache().lock() else {
        return;
    };
    let size = value.len();
    if cache.data.insert(key.clone(), (value, size)).is_none() {
        cache.bytes += size;
        cache.order.push_back(key);
    }
    while cache.order.len() > MAX_CACHED || cache.bytes > MAX_CACHED_BYTES {
        let Some(oldest) = cache.order.pop_front() else {
            break;
        };
        if let Some((_, freed)) = cache.data.remove(&oldest) {
            cache.bytes = cache.bytes.saturating_sub(freed);
        }
    }
}
