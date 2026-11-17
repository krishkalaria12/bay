//! The search that finds a page or a row by what it says, and the way back from a page. The Expo app's
//! `src/settings/model.ts`.

use std::cmp::Ordering;
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed};
use regex::Regex;

use super::{SearchEntry, SettingsMatch, SettingsPage};
use crate::js::trim;

static NOT_A_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}\p{M}]+").unwrap());

/// JavaScript's `localeCompare` as Node answers it: ICU's root collation.
static COLLATOR: LazyLock<CollatorBorrowed<'static>> =
    LazyLock::new(|| Collator::try_new(Default::default(), CollatorOptions::default()).unwrap());

/// Words of a query or a text, lowercased, in any script.
pub fn words(text: &str) -> Vec<String> {
    NOT_A_WORD
        .split(&text.to_lowercase())
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

/// What a query finds: every word of it starts a word of what it searches. An entry's name first, then a row on it (so
/// "dark" opens the Dark choice, not just Appearance), then the words it is known by. An exact name comes first, then
/// whole entries before rows, then by name.
pub fn match_settings(query: &str, entries: &[SearchEntry]) -> Vec<SettingsMatch> {
    let tokens = words(query);
    if tokens.is_empty() {
        return Vec::new();
    }
    let finds = |text: &str| {
        let candidates = words(text);
        tokens.iter().all(|token| {
            candidates
                .iter()
                .any(|candidate| candidate.starts_with(token.as_str()))
        })
    };

    let mut matches: Vec<(SettingsMatch, &str)> = Vec::new();
    for entry in entries {
        let id = entry.entry.id();
        if finds(&entry.title) {
            matches.push((
                SettingsMatch {
                    entry: entry.entry,
                    row: None,
                    page: None,
                    detail: None,
                    id: id.into(),
                },
                &entry.title,
            ));
            continue;
        }
        let row = entry.rows.iter().find(|row| {
            finds(&format!(
                "{} {} {}",
                row.label,
                row.detail.as_deref().unwrap_or_default(),
                row.value.as_deref().unwrap_or_default()
            ))
        });
        if let Some(row) = row {
            let on = row.page.map_or(id, SettingsPage::name);
            matches.push((
                SettingsMatch {
                    entry: entry.entry,
                    row: Some(row.id.clone()),
                    page: row.page,
                    detail: Some(row.label.clone()),
                    id: format!("{id}.{on}.{}", row.id),
                },
                &entry.title,
            ));
        } else if finds(&entry.keywords) {
            matches.push((
                SettingsMatch {
                    entry: entry.entry,
                    row: None,
                    page: None,
                    detail: None,
                    id: id.into(),
                },
                &entry.title,
            ));
        }
    }

    let typed = trim(query).to_lowercase();
    let exact = |title: &str| title.to_lowercase() == typed;
    matches.sort_by(|(a, a_title), (b, b_title)| {
        exact(b_title)
            .cmp(&exact(a_title))
            .then_with(|| a.row.is_some().cmp(&b.row.is_some()))
            .then_with(|| collate(a_title, b_title))
    });
    matches.into_iter().map(|(found, _)| found).collect()
}

fn collate(a: &str, b: &str) -> Ordering {
    COLLATOR.compare(a, b)
}

/// The pages to open for a page: its parents first, so ‹ goes where it would have.
pub fn path_to(target: SettingsPage) -> Vec<SettingsPage> {
    let mut path = vec![target];
    while let Some(parent) = path[0].parent() {
        path.insert(0, parent);
    }
    path
}
