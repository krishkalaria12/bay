//! History (store/history.ts). It's Chrome's (HistoryService): Chrome records every visit and keeps it. `history` is
//! the app's view of it, one entry per address, newest first, filled from the engine; nothing here is saved. Changes
//! go to the engine (`Effect`) and land in the view at once.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::model::is_incognito_space;
use super::{Browser, Effect};
use crate::number::JsNumber;

pub const MAX_HISTORY: usize = 5000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
    pub visits: JsNumber,
    pub last_visit: JsNumber,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visit_times: Option<Vec<JsNumber>>,
}

/// A visit to import: an entry without its icon.
#[derive(Clone, Debug, PartialEq)]
pub struct HistoryRow {
    pub url: String,
    pub title: String,
    pub visits: f64,
    pub last_visit: f64,
}

/// The entry without its visits since `since`; None when it has none left.
pub fn without_visits_since(entry: &HistoryEntry, since: f64) -> Option<HistoryEntry> {
    if entry.last_visit.0 < since {
        return Some(entry.clone());
    }
    let times: Vec<JsNumber> = match &entry.visit_times {
        Some(times) if !times.is_empty() => times.clone(),
        _ => vec![entry.last_visit],
    };
    let kept: Vec<JsNumber> = times.iter().copied().filter(|t| t.0 < since).collect();
    let last = *kept.last()?;
    Some(HistoryEntry {
        visits: JsNumber(entry.visits.0 - (times.len() - kept.len()) as f64),
        last_visit: last,
        visit_times: Some(kept),
        ..entry.clone()
    })
}

fn by_last_visit(list: &mut [HistoryEntry]) {
    list.sort_by(|a, b| b.last_visit.0.total_cmp(&a.last_visit.0));
}

impl Browser {
    pub fn remove_history(&mut self, space_id: &str, urls: &[String]) {
        if urls.is_empty() || is_incognito_space(space_id) {
            return;
        }
        self.history
            .entry(space_id.to_owned())
            .or_default()
            .retain(|h| !urls.contains(&h.url));
        self.effects.push(Effect::DeleteHistoryUrls {
            profile: self.engine_profile(space_id),
            urls: urls.to_vec(),
        });
    }

    /// The view only: Clear Browsing Data deletes from the engine.
    pub fn clear_history(&mut self, space_id: &str, since: Option<f64>) {
        let list = self.history.entry(space_id.to_owned()).or_default();
        let Some(since) = since else {
            list.clear();
            return;
        };
        let mut kept: Vec<HistoryEntry> = list
            .iter()
            .filter_map(|h| without_visits_since(h, since))
            .collect();
        by_last_visit(&mut kept);
        *list = kept;
    }

    /// Adds the addresses the view doesn't have (web and file pages only); how many it added.
    pub fn import_history(&mut self, space_id: &str, entries: &[HistoryRow]) -> usize {
        if is_incognito_space(space_id) {
            return 0;
        }
        let rows: Vec<HistoryRow> = entries
            .iter()
            .filter(|e| {
                e.url.starts_with("http:")
                    || e.url.starts_with("https:")
                    || e.url.starts_with("file:")
            })
            .cloned()
            .collect();
        let list = self.history.entry(space_id.to_owned()).or_default();
        let mut known: HashSet<String> = list.iter().map(|h| h.url.clone()).collect();
        let mut added = 0;
        for e in &rows {
            if !known.insert(e.url.clone()) {
                continue;
            }
            added += 1;
            list.push(HistoryEntry {
                url: e.url.clone(),
                title: e.title.clone(),
                favicon: None,
                visits: JsNumber(e.visits.max(1.0)),
                last_visit: JsNumber(e.last_visit),
                visit_times: Some(vec![JsNumber(e.last_visit)]),
            });
        }
        by_last_visit(list);
        list.truncate(MAX_HISTORY);
        self.effects.push(Effect::ImportHistory {
            profile: self.engine_profile(space_id),
            rows,
        });
        added
    }
}
