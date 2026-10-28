// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Raku Inkyetta 羽梦千景

//! 依据字形覆盖判断字体支持哪些语言。
//!
//! 思路和 macOS 的 Font Book 一致：给每种语言定义一组「必需字符」，
//! 字体必须把这些字都画得出来，才算支持该语言。这里的表是按常见语言手工整理的
//! 近似值（每种语言取 4–40 个区分度高的字符），不追求覆盖全部语言。

use ttf_parser::cmap::Subtable;
use ttf_parser::Face;

/// 一种语言的判定条件：`chars` 里的字符必须全部被 cmap 覆盖。
struct Lang {
    name: &'static str,
    chars: &'static str,
}

/// 表里顺序即展示顺序：先 CJK，再西欧，再其他。
const LANGS: &[Lang] = &[
    Lang {
        name: "中文",
        // 常用汉字抽样：能画出这批高频字，基本就是中文字体
        chars: "的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经去法学如都同现当",
    },
    Lang {
        name: "日文",
        chars: "あいうえおかきくけこアイウエオ日本語",
    },
    Lang {
        name: "韩文",
        chars: "가나다라마바사아자차카타파하한국어",
    },
    Lang { name: "英语", chars: "AEIOUaeiou" },
    Lang { name: "德语", chars: "äöüßÄÖÜ" },
    Lang { name: "法语", chars: "àâçéèêëîïôùûüœ" },
    Lang { name: "西班牙语", chars: "ñáéíóúü¿¡" },
    Lang { name: "葡萄牙语", chars: "ãõáâêôçà" },
    Lang { name: "意大利语", chars: "àèéìîòóù" },
    Lang { name: "荷兰语", chars: "ĳĲéë" },
    Lang { name: "瑞典语", chars: "åäöÅÄÖ" },
    Lang { name: "挪威语", chars: "åæøÅÆØ" },
    Lang { name: "丹麦语", chars: "æøåÆØÅ" },
    Lang { name: "芬兰语", chars: "äöÄÖ" },
    Lang { name: "波兰语", chars: "ąćęłńóśźżĄĆĘŁŃÓŚŹŻ" },
    Lang {
        name: "捷克语",
        chars: "ěščřžýáíéůúňťďĚŠČŘŽÝÁÍÉ",
    },
    Lang {
        name: "匈牙利语",
        chars: "áéíóöőúüűÁÉÍÓÖŐÚÜŰ",
    },
    Lang {
        name: "罗马尼亚语",
        chars: "ăâîșțĂÂÎȘȚ",
    },
    Lang {
        name: "土耳其语",
        chars: "çğıöşüÇĞİÖŞÜ",
    },
    Lang {
        name: "越南语",
        chars: "ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệ",
    },
    Lang {
        name: "俄语",
        chars: "абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
    },
    Lang { name: "乌克兰语", chars: "іїєґІЇЄҐ" },
    Lang {
        name: "希腊语",
        chars: "αβγδεζηθικλμνξοπρστυφχψω",
    },
    Lang {
        name: "希伯来语",
        chars: "אבגדהוזחטיכלמנסעפצקרשת",
    },
    Lang {
        name: "阿拉伯语",
        chars: "ابتثجحخدذرزسشصضطظعغفقكلمنهوي",
    },
    Lang { name: "波斯语", chars: "پچژگ" },
    Lang {
        name: "印地语",
        chars: "अआइईउऊएऐओऔकखगघङ",
    },
    Lang {
        name: "泰语",
        chars: "กขคงจฉชซญดตถทธนบปผพฟภมยรลวศสหอฮ",
    },
];

/// 返回字体覆盖到的语言（按 `LANGS` 顺序）。没有 cmap 时返回空。
pub fn detect(face: &Face) -> Vec<&'static str> {
    let Some(cmap) = face.tables().cmap else {
        return Vec::new();
    };
    let subtables: Vec<Subtable> = cmap
        .subtables
        .into_iter()
        .filter(|table| table.is_unicode())
        .collect();
    if subtables.is_empty() {
        return Vec::new();
    }
    let has = |c: char| {
        subtables
            .iter()
            .any(|table| table.glyph_index(c as u32).is_some())
    };

    LANGS
        .iter()
        .filter(|lang| {
            let mut needed: Vec<char> = lang.chars.chars().collect();
            needed.sort_unstable();
            needed.dedup();
            needed.iter().all(|c| has(*c))
        })
        .map(|lang| lang.name)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_sane() {
        assert!(LANGS.len() >= 20, "语言表太小");
        for lang in LANGS {
            assert!(!lang.chars.is_empty(), "{} 没有必需字符", lang.name);
        }
    }

    #[test]
    fn detects_real_system_font() {
        let path = std::path::Path::new(r"C:\Windows\Fonts\segoeui.ttf");
        if !path.exists() {
            return;
        }
        let data = std::fs::read(path).unwrap();
        let face = Face::parse(&data, 0).unwrap();
        let langs = detect(&face);
        assert!(langs.contains(&"英语"), "Segoe UI 应支持英语，实际 {langs:?}");
        assert!(langs.contains(&"德语"), "Segoe UI 应支持德语，实际 {langs:?}");
        assert!(!langs.contains(&"泰语"), "Segoe UI 不含泰文，实际 {langs:?}");
    }
}
