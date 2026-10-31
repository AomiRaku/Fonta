// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

//! 预览样字的 Rust 栅格化；WebView 不加载字体文件。
//! 缺失字符不回落；`max_width > 0` 时按词或字符折行。

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::sync::{Arc, Mutex, OnceLock};

use memmap2::Mmap;

use ab_glyph::{Font, FontRef, Glyph, GlyphId, PxScale, ScaleFont, VariableFont, point};
use base64::Engine;

/// 缓存条数上限
const MAX_CACHED: usize = 400;
/// 缓存总字节上限
const MAX_CACHED_BYTES: usize = 48 * 1024 * 1024;
/// 位图四周留白（设备像素）
const PAD: i32 = 2;
/// 折行后最多渲染的行数
const MAX_LINES: usize = 8;

/// 预览文字 → 实际渲染文字的解析缓存（无字形时取样）。
static RESOLVED: OnceLock<Mutex<VecDeque<(String, String)>>> = OnceLock::new();
/// cmap 映射缓存：(路径, 文件时间戳, 映射)。
type GlyphEntry = (String, String, Arc<HashMap<u32, u16>>);
static GLYPH_MAPS: OnceLock<Mutex<VecDeque<GlyphEntry>>> = OnceLock::new();
/// mmap 缓存：(路径, 文件时间戳, 映射)。
type FileEntry = (String, String, Arc<Mmap>);
static FILE_MAPS: OnceLock<Mutex<Vec<FileEntry>>> = OnceLock::new();

/// 文件长度 + 修改时间；字体被替换后缓存自动失效。
fn file_stamp(path: &str) -> String {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let modified = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|span| span.as_nanos())
                .unwrap_or(0);
            format!("{}:{}", meta.len(), modified)
        }
        Err(_) => "0:0".to_string(),
    }
}

/// 释放所有预览缓存。删除字体前调用，避免 Windows 因 mmap 占用而删不掉文件；
/// 字体文件被替换后也用它强制重新读取。
pub fn clear_caches() {
    if let Ok(mut cache) = cache().lock() {
        cache.data.clear();
        cache.order.clear();
        cache.bytes = 0;
    }
    if let Some(cache) = RESOLVED.get() {
        if let Ok(mut cache) = cache.lock() {
            cache.clear();
        }
    }
    if let Some(cache) = GLYPH_MAPS.get() {
        if let Ok(mut cache) = cache.lock() {
            cache.clear();
        }
    }
    if let Some(cache) = FILE_MAPS.get() {
        if let Ok(mut cache) = cache.lock() {
            cache.clear();
        }
    }
}

pub fn render(
    path: &str,
    text: &str,
    size: f32,
    color: &str,
    dpr: f32,
    max_width: f32,
    weight: f32,
    fresh: bool,
    fallback: bool,
) -> Result<String, String> {
    // 默认预览文字在字体里没有字形时，回退到字体自身字符集；
    // 用户手动输入的预览文字则直接报「没有对应字符」。
    let text = resolve_text(path, text, fallback)?;
    let key = format!("{path}|{}|{text}|{size}|{dpr}|{color}|{max_width}|{weight}|{fallback}", file_stamp(path));
    if !fresh {
        if let Some(hit) = cache_lookup(&key) {
            return Ok(hit);
        }
    }

    let mapped = font_map(path)?;
    let glyphs = glyph_map(path)?;
    let mut font = FontRef::try_from_slice(&mapped[..])
        .map_err(|error| format!("解析字体失败：{error}"))?;
    if weight > 0.0 {
        // 可变字体：按调用方给的字重实例化（Regular 或可变范围的中点）
        font.set_variation(b"wght", weight);
    }
    let data_url = rasterize(&font, &glyphs, &text, size, color, dpr, max_width)?;
    if !fresh {
        cache_store(key, data_url.clone());
    }
    Ok(data_url)
}

/// 预览文本在该字体里一个字形都没有时，从字体自己的 cmap 取样一行字。
/// 这样符号 / 图标字体不会预览成空白，而是显示它真正拥有的字符。
fn resolve_text(path: &str, raw: &str, fallback: bool) -> Result<String, String> {
    let key = format!("{path}|{}|{raw}|{fallback}", file_stamp(path));
    if let Ok(mut cache) = RESOLVED.get_or_init(|| Mutex::new(VecDeque::new())).lock() {
        if let Some(position) = cache.iter().position(|(item, _)| *item == key) {
            if let Some(value) = cache.remove(position) {
                let text = value.1.clone();
                cache.push_back(value);
                return Ok(text);
            }
        }
    }

    let mut resolved = raw.to_string();
    if let Ok(glyphs) = glyph_map(path) {
        // 空格几乎在所有字体里都有，判定覆盖时要忽略空白字符
        let has_any = raw
            .chars()
            .filter(|ch| !ch.is_whitespace())
            .any(|ch| glyphs.contains_key(&(ch as u32)));
        if !has_any {
            if !fallback {
                // 用户手动输入的预览文字：不替换，交给前端显示提示
                return Err("NO_GLYPHS".to_string());
            }
            if let Some(sample) = cmap_sample(&glyphs) {
                resolved = sample;
            }
        }
    }

    if let Ok(mut cache) = RESOLVED.get_or_init(|| Mutex::new(VecDeque::new())).lock() {
        cache.push_back((key, resolved.clone()));
        while cache.len() > 256 {
            cache.pop_front();
        }
    }
    Ok(resolved)
}

/// 从 cmap 全部子表取最多 24 个有字形的字符，优先 ASCII。
fn cmap_sample(glyphs: &HashMap<u32, u16>) -> Option<String> {
    let mut candidates: Vec<u32> = (0x21..=0x7E).filter(|code| glyphs.contains_key(code)).collect();
    let mut rest: Vec<u32> = glyphs.keys().copied().collect();
    rest.sort_unstable();
    candidates.extend(rest);
    candidates.dedup();

    let mut picked: Vec<char> = Vec::new();
    for code in candidates {
        if (0xD800..=0xDFFF).contains(&code) {
            continue;
        }
        let Some(ch) = char::from_u32(code) else {
            continue;
        };
        if ch.is_control() || ch.is_whitespace() {
            continue;
        }
        if !picked.contains(&ch) {
            picked.push(ch);
        }
        if picked.len() >= 24 {
            break;
        }
    }
    if picked.is_empty() {
        None
    } else {
        Some(picked.into_iter().collect())
    }
}

/// 字体文件的 cmap 映射（码位 -> 字形 id），包含 symbol 子表。
fn glyph_map(path: &str) -> Result<Arc<HashMap<u32, u16>>, String> {
    let stamp = file_stamp(path);
    let cache = GLYPH_MAPS.get_or_init(|| Mutex::new(VecDeque::new()));
    if let Ok(mut list) = cache.lock() {
        if let Some(position) = list
            .iter()
            .position(|(item, item_stamp, _)| item == path && item_stamp == &stamp)
        {
            let entry = list.remove(position).expect("index valid");
            let value = entry.2.clone();
            list.push_back(entry);
            return Ok(value);
        }
    }

    let mapped = font_map(path)?;
    let face = ttf_parser::Face::parse(&mapped[..], 0)
        .map_err(|error| format!("解析字体失败：{error}"))?;
    let mut map: HashMap<u32, u16> = HashMap::new();
    if let Some(cmap) = face.tables().cmap {
        for table in cmap.subtables {
            table.codepoints(|code| {
                if let Some(id) = table.glyph_index(code) {
                    if id.0 != 0 {
                        map.entry(code).or_insert(id.0);
                    }
                }
            });
        }
    }
    let map = Arc::new(map);
    if let Ok(mut list) = cache.lock() {
        list.push_back((path.to_string(), stamp, map.clone()));
        while list.len() > 8 {
            list.pop_front();
        }
    }
    Ok(map)
}

/// 字体文件的 mmap 缓存：大字体（10MB+）反复读盘是实时预览的主要开销。
/// 文件页由系统管理，可回收，不计入应用堆内存；路径 + 时间戳作为缓存键。
fn font_map(path: &str) -> Result<Arc<Mmap>, String> {
    let stamp = file_stamp(path);
    let cache = FILE_MAPS.get_or_init(|| Mutex::new(Vec::new()));
    if let Ok(mut list) = cache.lock() {
        if let Some(position) = list
            .iter()
            .position(|(item, item_stamp, _)| item == path && item_stamp == &stamp)
        {
            let entry = list.remove(position);
            let map = entry.2.clone();
            list.push(entry);
            return Ok(map);
        }
    }

    let file = File::open(path).map_err(|error| format!("打开字体失败：{error}"))?;
    let map = unsafe { Mmap::map(&file) }.map_err(|error| format!("映射字体失败：{error}"))?;
    let map = Arc::new(map);
    if let Ok(mut list) = cache.lock() {
        list.push((path.to_string(), stamp, map.clone()));
        if list.len() > 8 {
            list.remove(0);
        }
    }
    Ok(map)
}
fn rasterize(
    font: &FontRef<'_>,
    glyphs: &HashMap<u32, u16>,
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

    let lines = layout(font, glyphs, px_scale, text, limit);
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

/// 先查 cmap 映射（覆盖 symbol 编码），再退回 ab_glyph 的 unicode 查询。
fn glyph_for(glyphs: &HashMap<u32, u16>, font: &FontRef<'_>, ch: char) -> GlyphId {
    let mapped = glyphs.get(&(ch as u32)).copied().unwrap_or(0);
    if mapped != 0 {
        GlyphId(mapped)
    } else {
        font.glyph_id(ch)
    }
}

/// 逐行排版：`limit <= 0` 表示不折行。
fn layout(
    font: &FontRef<'_>,
    glyphs: &HashMap<u32, u16>,
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
            .map(|ch| glyph_for(glyphs, font, ch))
            .filter(|id| id.0 != 0)
            .map(|id| scaled.h_advance(id))
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
                let id = glyph_for(glyphs, font, ch);
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
            let id = glyph_for(glyphs, font, ch);
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
