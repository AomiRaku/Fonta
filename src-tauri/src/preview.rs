// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

//! 预览样字的 Rust 栅格化。
//!
//! 为什么不用 WebView 的字体：Chromium 会把加载过的字体文件缓存在渲染进程里，
//! 删除 `FontFace`、重载页面、甚至 Worker 被销毁都不会释放，滚一遍全库能涨到 1GB。
//! 因此样字改由 Rust 渲染成位图，前端只贴图，WebView 不再接触任何字体文件。

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

use ab_glyph::{Font, FontRef, Glyph, PxScale, ScaleFont, point};
use base64::Engine;

/// 缓存条数上限
const MAX_CACHED: usize = 400;
/// 缓存总字节上限
const MAX_CACHED_BYTES: usize = 48 * 1024 * 1024;
/// 位图四周留白（设备像素）
const PAD: i32 = 2;

pub fn render(path: &str, text: &str, size: f32, color: &str, dpr: f32) -> Result<String, String> {
    let key = format!("{path}|{text}|{size}|{dpr}|{color}");
    if let Some(hit) = cache_lookup(&key) {
        return Ok(hit);
    }

    let bytes = std::fs::read(path).map_err(|error| format!("读取字体失败：{error}"))?;
    let font = FontRef::try_from_slice(&bytes).map_err(|error| format!("解析字体失败：{error}"))?;
    let fallback_bytes = fallback_bytes();
    let fallback = fallback_bytes
        .as_deref()
        .and_then(|data| FontRef::try_from_slice_and_index(data, 0).ok());
    let data_url = rasterize(&font, fallback.as_ref(), text, size, color, dpr)?;
    cache_store(key, data_url.clone());
    Ok(data_url)
}

/// 缺字回退用的系统字体（微软雅黑），只读一次。
fn fallback_bytes() -> Option<Vec<u8>> {
    static BYTES: OnceLock<Option<Vec<u8>>> = OnceLock::new();
    BYTES
        .get_or_init(|| {
            let root = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into());
            std::fs::read(std::path::Path::new(&root).join("Fonts").join("msyh.ttc")).ok()
        })
        .clone()
}

fn rasterize(
    font: &FontRef<'_>,
    fallback: Option<&FontRef<'_>>,
    text: &str,
    size: f32,
    color: &str,
    dpr: f32,
) -> Result<String, String> {
    let scale = (size * dpr).clamp(6.0, 512.0);
    let px_scale = PxScale::from(scale);
    let scaled = font.as_scaled(px_scale);
    let (red, green, blue) = parse_color(color);

    let ascent = scaled.ascent().ceil();
    let descent = scaled.descent().ceil();
    let line_height = (ascent - descent).max(scale);

    // 先量宽度：逐字符累加 advance，顺便记录每个字形的位置
    let mut glyphs: Vec<(u8, ab_glyph::GlyphId, f32)> = Vec::new();
    let mut pen_x = 0.0f32;
    for ch in text.chars() {
        // 主字体缺字时换成回退字体，和浏览器的字形回退行为一致
        let use_fallback = font.glyph_id(ch).0 == 0 && fallback.is_some();
        let chosen = if use_fallback {
            fallback.unwrap_or(font)
        } else {
            font
        };
        let id = chosen.glyph_id(ch);
        let advance = chosen.as_scaled(px_scale).h_advance(id);
        glyphs.push((if use_fallback { 1 } else { 0 }, id, pen_x));
        pen_x += advance;
    }

    let width = (pen_x.ceil() as i32 + PAD * 2).max(8) as u32;
    let height = (line_height.ceil() as i32 + PAD * 2).max(8) as u32;
    let stride = width as usize * 4;
    let mut pixels = vec![0u8; stride * height as usize];

    let baseline = PAD as f32 + ascent;
    for (which, id, x) in &glyphs {
        let chosen = if *which == 1 {
            fallback.unwrap_or(font)
        } else {
            font
        };
        let glyph = Glyph {
            id: *id,
            scale: px_scale,
            position: point(PAD as f32 + *x, baseline),
        };
        let Some(outlined) = chosen.outline_glyph(glyph) else {
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
            // 取覆盖度更高的像素即可：样字基本不重叠，不做复杂混合
            if alpha <= pixels[offset + 3] {
                return;
            }
            pixels[offset] = red;
            pixels[offset + 1] = green;
            pixels[offset + 2] = blue;
            pixels[offset + 3] = alpha;
        });
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
