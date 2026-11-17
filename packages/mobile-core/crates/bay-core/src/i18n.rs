//! The app's words in every shipped language: the catalog in `strings/<locale>.json`, English behind every other
//! locale, and `{name}` placeholders filled from named values. Both apps show the language picked in Settings at once,
//! without a restart, so they read their words from here rather than from iOS's or Android's resource files.

use std::collections::HashMap;
use std::sync::LazyLock;

/// The locales Bay ships. English is first: it is what every other locale falls back to.
pub const LOCALE_IDS: [&str; 7] = ["en", "es", "fr", "de", "pt-BR", "ja", "hi"];

/// The locale a missing translation falls back to.
pub const DEFAULT_LOCALE: &str = "en";

/// Languages that ship one variant: a region on the device doesn't change them.
const LANGUAGE_LOCALES: [&str; 6] = ["en", "es", "fr", "de", "ja", "hi"];

const SOURCES: [(&str, &str); 7] = [
    ("en", include_str!("../../../strings/en.json")),
    ("es", include_str!("../../../strings/es.json")),
    ("fr", include_str!("../../../strings/fr.json")),
    ("de", include_str!("../../../strings/de.json")),
    ("pt-BR", include_str!("../../../strings/pt-BR.json")),
    ("ja", include_str!("../../../strings/ja.json")),
    ("hi", include_str!("../../../strings/hi.json")),
];

static CATALOG: LazyLock<HashMap<&'static str, HashMap<String, String>>> = LazyLock::new(|| {
    SOURCES
        .iter()
        .map(|(locale, json)| {
            let strings = serde_json::from_str(json)
                .unwrap_or_else(|error| panic!("strings/{locale}.json: {error}"));
            (*locale, strings)
        })
        .collect()
});

/// A shipped locale with its name in its own language, so a reader finds their own in the list.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct LocaleInfo {
    pub id: String,
    pub name: String,
}

/// The shipped locales, English first.
#[uniffi::export]
pub fn locales() -> Vec<LocaleInfo> {
    LOCALE_IDS
        .iter()
        .map(|id| LocaleInfo {
            id: (*id).to_owned(),
            name: locale_name(id).to_owned(),
        })
        .collect()
}

fn locale_name(id: &str) -> &'static str {
    match id {
        "es" => "Español",
        "fr" => "Français",
        "de" => "Deutsch",
        "pt-BR" => "Português (Brasil)",
        "ja" => "日本語",
        "hi" => "हिन्दी",
        _ => "English",
    }
}

/// The shipped locale a device tag names. An unknown language stays English, and Portuguese is told apart by its
/// region, so pt-PT doesn't slip into pt-BR.
#[uniffi::export]
pub fn match_locale(tag: Option<String>) -> String {
    let normalized = tag
        .unwrap_or_default()
        .trim()
        .replace('_', "-")
        .to_lowercase();
    if normalized.is_empty() {
        return DEFAULT_LOCALE.to_owned();
    }
    if let Some(exact) = LOCALE_IDS
        .iter()
        .find(|locale| locale.to_lowercase() == normalized)
    {
        return (*exact).to_owned();
    }
    let mut parts = normalized.split('-');
    let language = parts.next().unwrap_or_default();
    let region = parts.find(|part| {
        part.len() == 2 || (part.len() == 3 && part.bytes().all(|b| b.is_ascii_digit()))
    });
    if language == "pt" {
        return if region.is_none_or(|region| region == "br") {
            "pt-BR"
        } else {
            DEFAULT_LOCALE
        }
        .to_owned();
    }
    LANGUAGE_LOCALES
        .iter()
        .find(|locale| **locale == language)
        .copied()
        .unwrap_or(DEFAULT_LOCALE)
        .to_owned()
}

/// Every message in `locale`, with English filling any key the locale lacks. The apps load this once per language
/// and look words up locally.
#[uniffi::export]
pub fn catalog(locale: String) -> HashMap<String, String> {
    let mut strings = CATALOG[DEFAULT_LOCALE].clone();
    if let Some(translated) = CATALOG.get(locale.as_str()) {
        strings.extend(
            translated
                .iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
    }
    strings
}

/// `template` with each `{name}` replaced by the value `params` carries under that name. A placeholder without a
/// value stays as written, so a missing argument shows up instead of vanishing.
#[uniffi::export]
pub fn format_message(template: String, params: HashMap<String, String>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template.as_str();
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) if is_placeholder(&after[..close]) => {
                let name = &after[..close];
                match params.get(name) {
                    Some(value) => out.push_str(value),
                    None => out.push_str(&rest[open..open + close + 2]),
                }
                rest = &after[close + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn is_placeholder(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn placeholders(text: &str) -> Vec<String> {
        let mut names = Vec::new();
        let mut rest = text;
        while let Some(open) = rest.find('{') {
            let after = &rest[open + 1..];
            match after.find('}') {
                Some(close) if is_placeholder(&after[..close]) => {
                    names.push(after[..close].to_owned());
                    rest = &after[close + 1..];
                }
                _ => rest = after,
            }
        }
        names.sort();
        names
    }

    #[test]
    fn the_catalog_holds_every_shipped_locale() {
        let shipped: BTreeSet<_> = LOCALE_IDS.into_iter().collect();
        let loaded: BTreeSet<_> = CATALOG.keys().copied().collect();
        assert_eq!(loaded, shipped);
    }

    #[test]
    fn every_locale_has_exactly_the_english_keys_and_placeholders() {
        let english = &CATALOG[DEFAULT_LOCALE];
        let keys: BTreeSet<_> = english.keys().collect();
        for locale in LOCALE_IDS {
            let strings = &CATALOG[locale];
            assert_eq!(
                strings.keys().collect::<BTreeSet<_>>(),
                keys,
                "{locale}: keys"
            );
            for (key, text) in english {
                let translated = &strings[key];
                assert!(!translated.trim().is_empty(), "{locale}: {key} is empty");
                assert_eq!(
                    placeholders(translated),
                    placeholders(text),
                    "{locale}: {key}"
                );
            }
        }
    }

    #[test]
    fn match_locale_maps_device_tags_to_shipped_locales() {
        let cases = [
            (Some("pt-PT"), "en"),
            (Some("pt"), "pt-BR"),
            (Some("pt-BR"), "pt-BR"),
            (Some("pt_BR"), "pt-BR"),
            (Some("fr-CA"), "fr"),
            (Some("zh"), "en"),
            (Some("ja-JP"), "ja"),
            (Some(" DE "), "de"),
            (None, "en"),
        ];
        for (tag, expected) in cases {
            assert_eq!(match_locale(tag.map(str::to_owned)), expected, "{tag:?}");
        }
    }

    #[test]
    fn catalog_falls_back_to_english_and_translates_the_rest() {
        let german = catalog("de".into());
        assert_eq!(german["start.morning"], "Guten Morgen");
        assert_eq!(german.len(), CATALOG[DEFAULT_LOCALE].len());
        assert_eq!(catalog("xx".into())["start.morning"], "Good morning");
    }

    #[test]
    fn format_message_fills_named_placeholders() {
        let params = HashMap::from([("name".to_owned(), "Wikipedia".to_owned())]);
        assert_eq!(
            format_message("Open {name}".into(), params.clone()),
            "Open Wikipedia"
        );
        assert_eq!(
            format_message("{name} · {count}".into(), params.clone()),
            "Wikipedia · {count}"
        );
        assert_eq!(
            format_message("a { b } {} {name".into(), params),
            "a { b } {} {name"
        );
    }
}
