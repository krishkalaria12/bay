//! The phone's search field over the browser store: the rows for typed text, as the Expo app's `useSuggestions` did.

use super::address::engine_for;
use super::suggest::{
    SuggestArchived, SuggestBookmark, SuggestEngine, SuggestHistory, SuggestOptions, SuggestTab,
    Suggestion, SuggestionResult, SuggestionSource, build_suggestions,
};
use crate::js;
use crate::store::bookmarks::{BOOKMARKS_ROOT, bookmark_links};
use crate::store::handle::BrowserStore;

/// How many rows the search card shows.
const LIMIT: u32 = 7;
/// Recent pages shown before anything is typed.
const RECENT: usize = 4;

#[uniffi::export]
impl BrowserStore {
    /// The rows under the search field. Before typing: recent pages of the space showing. After: its open tabs,
    /// history, bookmarks and archived tabs, ranked, the search, the calculator, and the engine's `remote` suggestions.
    pub fn suggestions(
        &self,
        query: String,
        remote: Vec<String>,
        current_url: Option<String>,
        now: f64,
    ) -> SuggestionResult {
        let data = self.snapshot();
        let space = data.active_space_id.clone();
        let history: Vec<SuggestHistory> = data
            .history
            .iter()
            .filter(|entry| entry.space_id == space)
            .map(|entry| SuggestHistory {
                url: entry.url.clone(),
                title: entry.title.clone(),
                favicon: entry.favicon.clone(),
                visits: entry.visits as f64,
                last_visit: entry.last_visit as f64,
            })
            .collect();
        if js::trim(&query).is_empty() {
            let items = history
                .iter()
                .filter(|entry| Some(&entry.url) != current_url.as_ref())
                .take(RECENT)
                .map(|entry| Suggestion::Page {
                    url: entry.url.clone(),
                    title: entry.title.clone(),
                    favicon: None,
                    tab_id: None,
                    cleaned_id: None,
                    bookmarked: false,
                    visited: true,
                })
                .collect();
            return SuggestionResult {
                items,
                completion: String::new(),
            };
        }
        let bookmarks = data
            .bookmarks
            .get(&space)
            .map(|tree| bookmark_links(tree, BOOKMARKS_ROOT))
            .unwrap_or_default()
            .into_iter()
            .map(|(url, title)| SuggestBookmark {
                url,
                title,
                favicon: None,
            })
            .collect();
        let source = SuggestionSource {
            tabs: data
                .tabs
                .iter()
                .filter(|tab| !tab.url.is_empty())
                .map(|tab| SuggestTab {
                    id: tab.id.clone(),
                    url: tab.url.clone(),
                    title: tab.title.clone(),
                    favicon: tab.favicon.clone(),
                    custom_title: None,
                    pinned_url: None,
                    last_active_at: None,
                })
                .collect(),
            history,
            bookmarks,
            cleaned: data
                .archive
                .iter()
                .filter(|tab| tab.tab.space_id == space)
                .map(|tab| SuggestArchived {
                    id: tab.tab.id.clone(),
                    url: tab.tab.url.clone(),
                    title: tab.tab.title.clone(),
                    favicon: tab.tab.favicon.clone(),
                    closed_at: tab.closed_at as f64,
                })
                .collect(),
        };
        let engine = engine_for(
            &data.preferences.search_engine_id,
            data.preferences.custom_search_url.as_deref(),
        );
        let options = SuggestOptions {
            limit: LIMIT,
            remote_limit: 4,
            pages_ahead: 3,
            now,
            engine: SuggestEngine {
                name: engine.name,
                url: engine.url,
            },
            website_first: true,
            remote,
            current_tab_id: Some(data.active_tab_id.clone()),
            current_url,
            calculator_enabled: true,
        };
        let mut result = build_suggestions(&query, &source, &options);
        // The search card shows pages, searches and answers; emoji and quick-create rows are the desktop's.
        result.items.retain(|item| {
            matches!(
                item,
                Suggestion::Page { .. } | Suggestion::Search { .. } | Suggestion::Calc { .. }
            )
        });
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Action;
    use crate::store::model::{PERSONAL_SPACE_ID, create_tab};

    #[test]
    fn the_search_field_ranks_the_space_showing() {
        let dir = std::env::temp_dir().join(format!("bay-search-field-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = BrowserStore::open(dir.to_string_lossy().into(), "first".into(), 1);
        let visit = |url: &str, title: &str, now: i64| Action::Visit {
            space_id: PERSONAL_SPACE_ID.into(),
            url: url.into(),
            title: title.into(),
            favicon: None,
            now,
        };
        store.dispatch(visit("https://github.com/", "GitHub", 1_000));
        store.dispatch(visit("https://docs.rs/serde", "serde - Rust", 2_000));
        store.dispatch(Action::NewTab {
            tab: create_tab("t2", 3, "https://example.com/", false, PERSONAL_SPACE_ID),
            background: true,
        });

        let recent = store.suggestions(String::new(), Vec::new(), None, 5_000.0);
        assert_eq!(recent.items.len(), 2);

        let typed = store.suggestions("git".into(), vec!["github desktop".into()], None, 5_000.0);
        assert_eq!(typed.completion, "hub.com");
        assert!(
            matches!(&typed.items[0], Suggestion::Page { url, .. } if url == "https://github.com/")
        );
        assert!(typed.items.iter().any(|item| matches!(item, Suggestion::Search { query, suggested: true, .. } if query == "github desktop")));

        let math = store.suggestions("2+2".into(), Vec::new(), None, 5_000.0);
        assert!(matches!(&math.items[0], Suggestion::Calc { value, .. } if value == "4"));
        assert!(
            !store
                .suggestions("emoji heart".into(), Vec::new(), None, 5_000.0)
                .items
                .iter()
                .any(|item| matches!(item, Suggestion::Emoji { .. }))
        );
    }
}
