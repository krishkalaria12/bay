//! The phone's search field over the browser store: the rows for typed text, as the Expo app's `useSuggestions` did,
//! with the site the text names ("Search IMDb") and bangs first, and the rows inside a site's chip.

use std::collections::HashSet;

use super::address::engine_for;
use super::bangs::{BUNDLED_BANGS, bang_named, find_bang};
use super::engines::{SearchEngine, built_in_engines};
use super::site_search::{
    SearchScope, bang_scope, find_scope, is_on_site, offered_scope, scope_for_host,
    scoped_search_url,
};
use super::suggest::{
    SuggestArchived, SuggestBookmark, SuggestEngine, SuggestHistory, SuggestOptions, SuggestTab,
    Suggestion, SuggestionResult, SuggestionSource, build_suggestions,
};
use super::url::host_of;
use crate::js;
use crate::store::bookmarks::{BOOKMARKS_ROOT, bookmark_links};
use crate::store::handle::BrowserStore;
use crate::store::types::{BrowserData, PinKind};

/// How many rows the search card shows.
const LIMIT: u32 = 7;
/// Recent pages shown before anything is typed.
const RECENT: usize = 4;
/// Pages of the site shown inside its chip, before its own results.
const SITE_PAGES: usize = 2;

/// Bay's engines and the custom one, for naming a site.
fn engines(data: &BrowserData) -> Vec<SearchEngine> {
    let mut engines = built_in_engines();
    let chosen = engine_for(
        &data.preferences.search_engine_id,
        data.preferences.custom_search_url.as_deref(),
    );
    if chosen.custom {
        engines.push(chosen);
    }
    engines
}

/// The hosts of the space's history, for naming a site Bay has no search for.
fn history_hosts(data: &BrowserData) -> Vec<String> {
    let space = &data.active_space_id;
    let mut seen = HashSet::new();
    data.history
        .iter()
        .filter(|entry| &entry.space_id == space)
        .map(|entry| host_of(&entry.url))
        .filter(|host| !host.is_empty() && seen.insert(host.clone()))
        .collect()
}

fn on_host(url: &str, host: &str) -> bool {
    is_on_site(&host_of(url), host)
}

/// The space's tabs, history, bookmarks and archived tabs, as the ranking reads them; only those on `host`, if given.
fn source(data: &BrowserData, host: Option<&str>) -> SuggestionSource {
    let space = &data.active_space_id;
    let keep = |url: &str| host.is_none_or(|host| on_host(url, host));
    let history = data
        .history
        .iter()
        .filter(|entry| &entry.space_id == space && keep(&entry.url))
        .map(|entry| SuggestHistory {
            url: entry.url.clone(),
            title: entry.title.clone(),
            favicon: entry.favicon.clone(),
            visits: entry.visits as f64,
            last_visit: entry.last_visit as f64,
        })
        .collect();
    let bookmarks = data
        .bookmarks
        .get(space)
        .map(|tree| bookmark_links(tree, BOOKMARKS_ROOT))
        .unwrap_or_default()
        .into_iter()
        .filter(|(url, _)| keep(url))
        .map(|(url, title)| SuggestBookmark {
            url,
            title,
            favicon: None,
        })
        .collect();
    SuggestionSource {
        tabs: data
            .tabs
            .iter()
            .filter(|tab| !tab.url.is_empty() && keep(&tab.url))
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
            .filter(|tab| &tab.tab.space_id == space && keep(&tab.tab.url))
            .map(|tab| SuggestArchived {
                id: tab.tab.id.clone(),
                url: tab.tab.url.clone(),
                title: tab.tab.title.clone(),
                favicon: tab.tab.favicon.clone(),
                closed_at: tab.closed_at as f64,
            })
            .collect(),
    }
}

fn recent_page(url: &str, title: &str) -> Suggestion {
    Suggestion::Page {
        url: url.to_owned(),
        title: title.to_owned(),
        favicon: None,
        tab_id: None,
        cleaned_id: None,
        bookmarked: false,
        visited: true,
    }
}

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
        if js::trim(&query).is_empty() {
            let items = data
                .history
                .iter()
                .filter(|entry| entry.space_id == space && Some(&entry.url) != current_url.as_ref())
                .take(RECENT)
                .map(|entry| recent_page(&entry.url, &entry.title))
                .collect();
            return SuggestionResult {
                items,
                completion: String::new(),
            };
        }
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
        let mut result = build_suggestions(&query, &source(&data, None), &options);
        // The search card shows pages, searches and answers; emoji and quick-create rows are the desktop's.
        result.items.retain(|item| {
            matches!(
                item,
                Suggestion::Page { .. } | Suggestion::Search { .. } | Suggestion::Calc { .. }
            )
        });
        // A bang searches its site at once, first. "!yt" alone, or a site's name, offers the site's chip: first, or
        // second under the page the field is completing to, so typing a site's address still goes there.
        if let Some(found) =
            find_bang(&query, &BUNDLED_BANGS).filter(|found| !found.query.is_empty())
        {
            result.items.insert(
                0,
                Suggestion::Search {
                    query: found.query,
                    url: found.url,
                    engine: found.bang.name,
                    suggested: false,
                },
            );
            result.completion = String::new();
        } else if let Some(scope) = bang_named(&query, &BUNDLED_BANGS)
            .map(|bang| bang_scope(&bang))
            .or_else(|| offered_scope(&query, &engines(&data), || history_hosts(&data)))
        {
            let at = usize::from(!result.completion.is_empty()).min(result.items.len());
            result.items.insert(at, Suggestion::Scope { scope });
        }
        result.items.truncate(LIMIT as usize);
        result
    }

    /// The site that typed text names exactly ("yt", "imdb", "github.com", "!w"), for turning the field into its
    /// chip when a space or Tab follows it.
    pub fn search_scope(&self, text: String) -> Option<SearchScope> {
        if let Some(bang) = bang_named(&text, &BUNDLED_BANGS) {
            return Some(bang_scope(&bang));
        }
        let data = self.snapshot();
        find_scope(&text, &engines(&data), || history_hosts(&data))
    }

    /// The rows inside a site's chip. Before typing: the space's latest pages on the site. After: the search on the
    /// site, a couple of its pages that match, then `results`, the site's own answer (`parse_scope_suggestions`).
    pub fn scoped_suggestions(
        &self,
        scope: SearchScope,
        query: String,
        results: Vec<Suggestion>,
        now: f64,
    ) -> Vec<Suggestion> {
        let data = self.snapshot();
        let text = js::trim(&query);
        if text.is_empty() {
            if scope.host.is_empty() {
                return Vec::new();
            }
            let mut seen = HashSet::new();
            return data
                .history
                .iter()
                .filter(|entry| {
                    entry.space_id == data.active_space_id && on_host(&entry.url, &scope.host)
                })
                .filter(|entry| seen.insert(entry.url.clone()))
                .take(RECENT)
                .map(|entry| recent_page(&entry.url, &entry.title))
                .collect();
        }
        let engine = engine_for(
            &data.preferences.search_engine_id,
            data.preferences.custom_search_url.as_deref(),
        );
        let mut items = vec![Suggestion::Search {
            query: text.to_owned(),
            url: scoped_search_url(scope.clone(), text.to_owned(), engine.url.clone()),
            engine: scope.name.clone(),
            suggested: false,
        }];
        if !scope.host.is_empty() {
            let options = SuggestOptions {
                limit: LIMIT,
                remote_limit: 0,
                pages_ahead: SITE_PAGES as u32,
                now,
                engine: SuggestEngine {
                    name: engine.name,
                    url: engine.url,
                },
                website_first: true,
                remote: Vec::new(),
                current_tab_id: Some(data.active_tab_id.clone()),
                current_url: None,
                calculator_enabled: false,
            };
            let pages = build_suggestions(text, &source(&data, Some(&scope.host)), &options);
            items.extend(
                pages
                    .items
                    .into_iter()
                    .filter(|item| matches!(item, Suggestion::Page { .. }))
                    .take(SITE_PAGES),
            );
        }
        let mut seen: HashSet<String> = items
            .iter()
            .filter_map(|item| match item {
                Suggestion::Page { url, .. } | Suggestion::Search { url, .. } => Some(url.clone()),
                _ => None,
            })
            .collect();
        for result in results {
            let url = match &result {
                Suggestion::Result { url, .. } | Suggestion::Search { url, .. } => url.clone(),
                _ => continue,
            };
            if seen.insert(url) {
                items.push(result);
            }
        }
        items.truncate(LIMIT as usize);
        items
    }

    /// The sites under the empty search field: the space's pinned sites that have a search, then the sites with one
    /// that it visits most. Each opens the site's chip.
    pub fn scope_shortcuts(&self, limit: u32) -> Vec<SearchScope> {
        let data = self.snapshot();
        let space = &data.active_space_id;
        let mut visits: Vec<(String, i64)> = Vec::new();
        for entry in data.history.iter().filter(|entry| &entry.space_id == space) {
            let host = host_of(&entry.url);
            match visits.iter_mut().find(|(known, _)| known == &host) {
                Some((_, count)) => *count += entry.visits,
                None => visits.push((host, entry.visits)),
            }
        }
        visits.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
        let mut pins: Vec<_> = data
            .pinned_sites
            .iter()
            .filter(|pin| &pin.space_id == space)
            .collect();
        pins.sort_by_key(|pin| pin.kind != PinKind::Essential);
        let mut seen = HashSet::new();
        pins.iter()
            .map(|pin| host_of(&pin.url))
            .chain(visits.into_iter().map(|(host, _)| host))
            .filter_map(|host| scope_for_host(&host))
            .filter(|scope| seen.insert(scope.host.clone()))
            .take(limit as usize)
            .collect()
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

    #[test]
    fn sites_and_bangs_lead_the_rows_and_a_chip_searches_its_site() {
        let dir = std::env::temp_dir().join(format!("bay-search-scope-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = BrowserStore::open(dir.to_string_lossy().into(), "first".into(), 1);
        let visit = |url: &str, title: &str, now: i64| Action::Visit {
            space_id: PERSONAL_SPACE_ID.into(),
            url: url.into(),
            title: title.into(),
            favicon: None,
            now,
        };
        store.dispatch(visit(
            "https://www.imdb.com/title/tt1/",
            "Past Lives (2023) - IMDb",
            1_000,
        ));
        store.dispatch(visit(
            "https://www.imdb.com/title/tt2/",
            "Perfect Days (2023) - IMDb",
            2_000,
        ));
        store.dispatch(visit("https://research.example/paper", "A paper", 3_000));
        store.dispatch(visit(
            "https://en.wikipedia.org/wiki/Lens",
            "Lens - Wikipedia",
            4_000,
        ));
        store.dispatch(Action::AddPin {
            site: crate::store::types::PinnedSite {
                id: "p1".into(),
                url: "https://www.youtube.com/".into(),
                title: "YouTube".into(),
                favicon: None,
                space_id: PERSONAL_SPACE_ID.into(),
                kind: PinKind::Essential,
                folder_id: None,
            },
            index: 0,
        });

        // No page of the site to complete to: the site comes first.
        let typed = store.suggestions("yo".into(), Vec::new(), None, 5_000.0);
        assert!(typed.completion.is_empty());
        assert!(matches!(&typed.items[0], Suggestion::Scope { scope } if scope.name == "YouTube"));
        // A visited site keeps its completion, and its chip comes second.
        let typed = store.suggestions("im".into(), Vec::new(), None, 5_000.0);
        assert_eq!(typed.completion, "db.com");
        assert!(matches!(&typed.items[1], Suggestion::Scope { scope } if scope.name == "IMDb"));

        let bang = store.suggestions("font !w".into(), Vec::new(), None, 5_000.0);
        assert!(
            matches!(&bang.items[0], Suggestion::Search { url, engine, .. }
            if engine == "Wikipedia" && url.ends_with("search=font"))
        );
        assert!(
            matches!(&store.suggestions("!yt".into(), Vec::new(), None, 5_000.0).items[0],
            Suggestion::Scope { scope } if scope.name == "YouTube")
        );

        assert_eq!(store.search_scope("imdb".into()).unwrap().name, "IMDb");
        assert_eq!(
            store.search_scope("research.example".into()).unwrap().host,
            "research.example"
        );
        assert!(store.search_scope("im".into()).is_none());

        let imdb = store.search_scope("imdb".into()).unwrap();
        let before = store.scoped_suggestions(imdb.clone(), String::new(), Vec::new(), 5_000.0);
        assert_eq!(before.len(), 2);
        let result = Suggestion::Result {
            title: "Perfect Days".into(),
            detail: "2023".into(),
            image: None,
            url: "https://www.imdb.com/title/tt3/".into(),
        };
        let rows = store.scoped_suggestions(imdb, "perfect".into(), vec![result.clone()], 5_000.0);
        assert!(
            matches!(&rows[0], Suggestion::Search { url, engine, .. } if engine == "IMDb" && url == "https://www.imdb.com/find/?q=perfect")
        );
        assert!(
            matches!(&rows[1], Suggestion::Page { url, .. } if url == "https://www.imdb.com/title/tt2/")
        );
        assert_eq!(rows.last(), Some(&result));

        let shortcuts: Vec<String> = store
            .scope_shortcuts(5)
            .into_iter()
            .map(|scope| scope.name)
            .collect();
        assert_eq!(shortcuts, ["YouTube", "IMDb", "Wikipedia"]);
    }
}
