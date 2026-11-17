//! "emoji heart": emoji by name, from Unicode's list (`data/emoji.json`, exported from `@bay/core`).

use std::sync::LazyLock;

use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use super::{Pattern, pattern};
use crate::js;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, uniffi::Record)]
pub struct EmojiMatch {
    pub value: String,
    pub name: String,
}

static MARKS: Pattern = Pattern::new(|| pattern(r"\p{M}"));
static NOT_WORD: Pattern = Pattern::new(|| pattern(r"[^\p{L}\p{N}]+"));
static QUERY: Pattern = Pattern::new(|| pattern(r"(?i)^emoji\s+(.+)$"));

fn normalize(text: &str) -> String {
    let stripped = MARKS
        .replace_all(&text.nfkd().collect::<String>(), "")
        .to_lowercase();
    js::trim(&NOT_WORD.replace_all(&stripped, " ")).to_owned()
}

struct Entry {
    value: String,
    name: String,
    normalized: String,
    words: Vec<String>,
}

static ENTRIES: LazyLock<Vec<Entry>> = LazyLock::new(|| {
    let list: Vec<String> = serde_json::from_str(include_str!("../../../../data/emoji.json"))
        .expect("data/emoji.json is a list");
    list.into_iter()
        .filter_map(|entry| {
            let (value, name) = entry.split_once(' ')?;
            let normalized = normalize(name);
            let words = normalized.split(' ').map(str::to_owned).collect();
            Some(Entry {
                value: value.into(),
                name: name.into(),
                normalized,
                words,
            })
        })
        .collect()
});

/// Lower-case first, then as written: close to `localeCompare` for emoji names, which are lower-case English.
fn locale_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| a.cmp(b))
}

/// Explicit emoji searches keep ordinary queries such as "heart" available for web search.
pub fn find_emoji(raw: &str, limit: usize) -> Vec<EmojiMatch> {
    let Some(m) = QUERY.captures(js::trim(raw)) else {
        return Vec::new();
    };
    if limit < 1 {
        return Vec::new();
    }
    let query = normalize(&m[1]);
    if query.is_empty() {
        return Vec::new();
    }
    let tokens: Vec<&str> = query.split(' ').collect();
    let mut ranked: Vec<(u8, &Entry)> = ENTRIES
        .iter()
        .filter(|entry| {
            tokens
                .iter()
                .all(|token| entry.words.iter().any(|word| word.starts_with(token)))
        })
        .map(|entry| {
            let rank = if entry.normalized == query {
                0
            } else if query == "heart" && entry.normalized == "red heart" {
                1
            } else if entry.normalized.starts_with(&query) {
                2
            } else if tokens
                .iter()
                .all(|token| entry.words.iter().any(|word| word == token))
            {
                3
            } else {
                4
            };
            (rank, entry)
        })
        .collect();
    ranked.sort_by(|(ra, a), (rb, b)| {
        ra.cmp(rb)
            .then_with(|| js::utf16_len(&a.name).cmp(&js::utf16_len(&b.name)))
            .then_with(|| locale_cmp(&a.name, &b.name))
    });
    ranked
        .into_iter()
        .take(limit)
        .map(|(_, entry)| EmojiMatch {
            value: entry.value.clone(),
            name: entry.name.clone(),
        })
        .collect()
}
