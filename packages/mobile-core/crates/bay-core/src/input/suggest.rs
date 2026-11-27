//! The rows under the search field, ranked as the desktop ranks them: the typed address or a matching site first,
//! the search, open tabs, history, bookmarks and archived tabs by match and frecency, the engine's suggestions, and
//! the calculator, emoji and quick-create rows. Sites to search and bangs are added over these by the phone's
//! search field (`search_field.rs`); commands are the desktop's alone.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::calc::calculate;
use super::emoji::find_emoji;
use super::engines::search_url;
use super::quick_create::{QuickCreate, match_quick_create};
use super::url::{fixup_url, host_of, url_for_display};
use super::{Pattern, pattern};
use crate::js;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct SuggestTab {
    pub id: String,
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
    #[serde(default)]
    pub custom_title: Option<String>,
    #[serde(default)]
    pub pinned_url: Option<String>,
    #[serde(default)]
    pub last_active_at: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct SuggestHistory {
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
    pub visits: f64,
    pub last_visit: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct SuggestBookmark {
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
}

/// A tab put away in the archive: a row for one restores it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct SuggestArchived {
    pub id: String,
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
    pub closed_at: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct SuggestionSource {
    pub tabs: Vec<SuggestTab>,
    pub history: Vec<SuggestHistory>,
    #[serde(default)]
    pub bookmarks: Vec<SuggestBookmark>,
    #[serde(default)]
    pub cleaned: Vec<SuggestArchived>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct SuggestEngine {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SuggestOptions {
    pub limit: u32,
    /// The engine's suggestions, at most.
    pub remote_limit: u32,
    /// How many rows (matching sites, then pages) come before the engine's suggestions.
    pub pages_ahead: u32,
    pub now: f64,
    pub engine: SuggestEngine,
    /// Whether a matching page comes before the search (`true`) or after it.
    pub website_first: bool,
    pub remote: Vec<String>,
    pub current_tab_id: Option<String>,
    pub current_url: Option<String>,
    pub calculator_enabled: bool,
}

/// A bookmark's place: its space, and the folder it's in ("" at the top of the space's bookmarks).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkPlace {
    pub space_id: String,
    pub folder: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, uniffi::Enum)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Suggestion {
    Page {
        url: String,
        title: String,
        favicon: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tab_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cleaned_id: Option<String>,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        bookmarked: bool,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        visited: bool,
        /// Where the page is saved as a bookmark, filled in by the phone's search field.
        #[serde(skip_serializing_if = "Option::is_none")]
        location: Option<BookmarkPlace>,
    },
    Search {
        query: String,
        url: String,
        engine: String,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        suggested: bool,
    },
    Calc {
        expression: String,
        value: String,
        url: String,
    },
    Emoji {
        value: String,
        name: String,
    },
    Create {
        id: String,
        title: String,
        url: String,
        site: String,
    },
    /// "Search IMDb": a site the typed text names. Choosing it turns the field into the site's chip.
    Scope {
        scope: super::site_search::SearchScope,
    },
    /// A result from the site being searched (an IMDb title, a Wikipedia article), opened directly.
    Result {
        title: String,
        detail: String,
        image: Option<String>,
        url: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, uniffi::Record)]
pub struct SuggestionResult {
    pub items: Vec<Suggestion>,
    /// What the field fills in after the typed text, selected.
    pub completion: String,
}

const DAY: f64 = 86_400_000.0;

static TRAILING_SLASH: Pattern = Pattern::new(|| pattern(r"/$"));
static ORIGIN: Pattern = Pattern::new(|| pattern(r"(?i)^https?://[^/?#]+"));

/// An address as the rows show it.
#[uniffi::export]
pub fn display_url(url: &str) -> String {
    TRAILING_SLASH
        .replace(&url_for_display(url), "")
        .into_owned()
}

fn page_key(url: &str) -> String {
    let without_hash = match url.find('#') {
        Some(at) if !url[at..].contains('\n') => &url[..at],
        _ => url,
    };
    without_hash
        .strip_suffix('/')
        .unwrap_or(without_hash)
        .to_owned()
}

#[derive(Clone)]
struct PageText {
    url: String,
    key: String,
    shown: String,
    shown_lower: String,
    title_lower: String,
}

impl PageText {
    fn new(url: &str, title: &str) -> Self {
        let shown = display_url(url);
        Self {
            url: url.into(),
            key: page_key(url),
            shown_lower: shown.to_lowercase(),
            shown,
            title_lower: title.to_lowercase(),
        }
    }

    fn origin(&self) -> Option<String> {
        ORIGIN.find(&self.url).map(|m| m.as_str().to_owned())
    }
}

#[derive(Clone)]
struct Candidate {
    url: String,
    title: String,
    favicon: Option<String>,
    visits: f64,
    last_visit: f64,
    bookmarked: bool,
    tab_id: Option<String>,
    cleaned_id: Option<String>,
    text: PageText,
}

struct Pool {
    list: Vec<Candidate>,
    by_key: HashMap<String, usize>,
}

/// History first (each page once), then bookmarks not in the history.
fn pool(history: &[SuggestHistory], bookmarks: &[SuggestBookmark]) -> Pool {
    let mut bookmark_list: Vec<Candidate> = Vec::new();
    let mut bookmark_keys: HashSet<String> = HashSet::new();
    for row in bookmarks {
        let text = PageText::new(&row.url, &row.title);
        if bookmark_keys.insert(text.key.clone()) {
            bookmark_list.push(Candidate {
                url: row.url.clone(),
                title: row.title.clone(),
                favicon: row.favicon.clone(),
                visits: 0.0,
                last_visit: 0.0,
                bookmarked: true,
                tab_id: None,
                cleaned_id: None,
                text,
            });
        }
    }
    let mut list: Vec<Candidate> = Vec::new();
    let mut by_key: HashMap<String, usize> = HashMap::new();
    for row in history {
        let text = PageText::new(&row.url, &row.title);
        if by_key.contains_key(&text.key) {
            continue;
        }
        by_key.insert(text.key.clone(), list.len());
        list.push(Candidate {
            url: row.url.clone(),
            title: row.title.clone(),
            favicon: row.favicon.clone(),
            visits: row.visits,
            last_visit: row.last_visit,
            bookmarked: bookmark_keys.contains(&text.key),
            tab_id: None,
            cleaned_id: None,
            text,
        });
    }
    for candidate in bookmark_list {
        if !by_key.contains_key(&candidate.text.key) {
            by_key.insert(candidate.text.key.clone(), list.len());
            list.push(candidate);
        }
    }
    Pool { list, by_key }
}

struct TabsOver {
    tab_ids: HashMap<String, String>,
    cleaned_ids: HashMap<String, String>,
    extra: Vec<Candidate>,
}

// Open tabs, then archived ones, over the pool: a page open in a tab switches to it rather than restoring a copy.
fn tabs_over(
    pool: &Pool,
    tabs: &[SuggestTab],
    cleaned: &[SuggestArchived],
    now: f64,
    current_tab_id: Option<&str>,
) -> TabsOver {
    let mut over = TabsOver {
        tab_ids: HashMap::new(),
        cleaned_ids: HashMap::new(),
        extra: Vec::new(),
    };
    for tab in tabs {
        if tab.url.is_empty() || Some(tab.id.as_str()) == current_tab_id {
            continue;
        }
        let text = PageText::new(&tab.url, &tab.title);
        if over.tab_ids.contains_key(&text.key) {
            continue;
        }
        over.tab_ids.insert(text.key.clone(), tab.id.clone());
        if !pool.by_key.contains_key(&text.key) {
            over.extra.push(Candidate {
                url: tab.url.clone(),
                title: tab.title.clone(),
                favicon: tab.favicon.clone(),
                visits: 0.0,
                last_visit: now,
                bookmarked: false,
                tab_id: Some(tab.id.clone()),
                cleaned_id: None,
                text,
            });
        }
    }
    for row in cleaned {
        if row.url.is_empty() {
            continue;
        }
        let text = PageText::new(&row.url, &row.title);
        if over.tab_ids.contains_key(&text.key) || over.cleaned_ids.contains_key(&text.key) {
            continue;
        }
        over.cleaned_ids.insert(text.key.clone(), row.id.clone());
        if !pool.by_key.contains_key(&text.key) {
            over.extra.push(Candidate {
                url: row.url.clone(),
                title: row.title.clone(),
                favicon: row.favicon.clone(),
                visits: 0.0,
                last_visit: row.closed_at,
                bookmarked: false,
                tab_id: None,
                cleaned_id: Some(row.id.clone()),
                text,
            });
        }
    }
    over
}

// The tab a site's address goes to when none is on that very page: one pinned to the site, else the one used last.
fn tab_on_site<'a>(
    tabs: &'a [SuggestTab],
    host: &str,
    current_tab_id: Option<&str>,
) -> Option<&'a SuggestTab> {
    if host.is_empty() {
        return None;
    }
    let mut best: Option<&SuggestTab> = None;
    let mut best_pinned = false;
    for tab in tabs {
        if tab.url.is_empty() || Some(tab.id.as_str()) == current_tab_id {
            continue;
        }
        let pinned = tab
            .pinned_url
            .as_deref()
            .is_some_and(|pinned| !pinned.is_empty() && host_of(pinned) == host);
        if !pinned && host_of(&tab.url) != host {
            continue;
        }
        let newer = tab.last_active_at.unwrap_or(0.0)
            > best.and_then(|best| best.last_active_at).unwrap_or(0.0);
        if best.is_none() || (pinned && !best_pinned) || (pinned == best_pinned && newer) {
            best = Some(tab);
            best_pinned = pinned;
        }
    }
    best
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_digit() || c.is_ascii_lowercase()
}

fn word_starts_with(text: &str, word: &str) -> bool {
    let mut from = 0;
    while let Some(found) = text.get(from..).and_then(|rest| rest.find(word)) {
        let at = from + found;
        if at == 0 || !text[..at].chars().next_back().is_some_and(is_word_char) {
            return true;
        }
        from = at + text[at..].chars().next().map_or(1, char::len_utf8);
    }
    false
}

struct Query {
    q: String,
    segment_starts: Option<(String, String)>,
    word: bool,
    tokens: Vec<(String, bool)>,
    needle: String,
}

fn is_word(text: &str) -> bool {
    !text.is_empty() && text.chars().all(is_word_char)
}

fn parse_query(q: &str, tokens: &[String]) -> Query {
    Query {
        q: q.into(),
        segment_starts: (!q.contains(['.', '/'])).then(|| (format!(".{q}"), format!("/{q}"))),
        word: is_word(q),
        tokens: tokens
            .iter()
            .map(|token| (token.clone(), is_word(token)))
            .collect(),
        needle: tokens.iter().fold(String::new(), |a, b| {
            if js::utf16_len(b) > js::utf16_len(&a) {
                b.clone()
            } else {
                a
            }
        }),
    }
}

fn match_score(text: &PageText, query: &Query) -> f64 {
    let (shown, title, q) = (&text.shown_lower, &text.title_lower, &query.q);
    if !shown.contains(&query.needle) && !title.contains(&query.needle) {
        return 0.0;
    }
    let long = js::utf16_len(q) >= 2;
    let mut score = if shown.starts_with(q.as_str()) {
        100.0
    } else if query
        .segment_starts
        .as_ref()
        .is_some_and(|(dot, slash)| shown.contains(dot) || shown.contains(slash))
    {
        60.0
    } else if long && shown.contains(q.as_str()) {
        30.0
    } else {
        0.0
    };
    if title.starts_with(q.as_str()) {
        score += 40.0;
    } else if if long {
        title.contains(q.as_str())
    } else {
        query.word && word_starts_with(title, q)
    } {
        score += 20.0;
    }
    if score > 0.0 || query.tokens.len() < 2 {
        return score;
    }
    for (token, word) in &query.tokens {
        if *word && word_starts_with(title, token) {
            score += 15.0;
        } else if *word && word_starts_with(shown, token) {
            score += 10.0;
        } else if js::utf16_len(token) >= 3
            && (title.contains(token.as_str()) || shown.contains(token.as_str()))
        {
            score += 5.0;
        } else {
            return 0.0;
        }
    }
    score
}

fn frecency(c: &Candidate, tab_id: bool, cleaned_id: bool, now: f64) -> f64 {
    let age_days = if c.last_visit != 0.0 {
        ((now - c.last_visit) / DAY).max(0.0)
    } else {
        10.0
    };
    (1.0 + c.visits).log2() * 8.0 - age_days.min(30.0)
        + if c.bookmarked { 20.0 } else { 0.0 }
        + if tab_id {
            6.0
        } else if cleaned_id {
            4.0
        } else {
            0.0
        }
}

#[derive(Clone)]
struct Ranked {
    c: Candidate,
    tab_id: Option<String>,
    cleaned_id: Option<String>,
    m: f64,
    s: f64,
}

struct TopList {
    items: Vec<Ranked>,
    size: usize,
}

impl TopList {
    fn offer(&mut self, ranked: Ranked) {
        if self.items.len() == self.size && self.items.last().is_some_and(|last| last.s >= ranked.s)
        {
            return;
        }
        let mut i = self.items.len();
        while i > 0 && self.items[i - 1].s < ranked.s {
            i -= 1;
        }
        self.items.insert(i, ranked);
        if self.items.len() > self.size {
            self.items.pop();
        }
    }
}

fn page_suggestion(
    c: &Candidate,
    tab_id: Option<String>,
    cleaned_id: Option<String>,
) -> Suggestion {
    // Like JavaScript's default parameters: a missing id falls back to the candidate's own.
    let tab_id = tab_id.or_else(|| c.tab_id.clone());
    let cleaned_id = cleaned_id.or_else(|| c.cleaned_id.clone());
    Suggestion::Page {
        url: c.url.clone(),
        title: c.title.clone(),
        favicon: c.favicon.clone(),
        cleaned_id: if tab_id.is_some() { None } else { cleaned_id },
        tab_id,
        bookmarked: c.bookmarked,
        visited: c.visits > 0.0,
        location: None,
    }
}

fn suggestion_key(s: &Suggestion) -> String {
    match s {
        Suggestion::Page { url, .. } => format!("page:{}", page_key(url)),
        Suggestion::Search { url, .. } => format!("search:{url}"),
        Suggestion::Calc { expression, .. } => format!("calc:{expression}"),
        Suggestion::Emoji { value, .. } => format!("emoji:{value}"),
        Suggestion::Create { id, .. } => format!("create:{id}"),
        Suggestion::Scope { scope } => format!("scope:{}", scope.host),
        Suggestion::Result { url, .. } => format!("result:{url}"),
    }
}

struct Output {
    items: Vec<Suggestion>,
    seen: HashSet<String>,
    limit: usize,
}

impl Output {
    fn new(limit: usize) -> Self {
        Self {
            items: Vec::new(),
            seen: HashSet::new(),
            limit,
        }
    }

    fn push(&mut self, rows: impl IntoIterator<Item = Suggestion>) {
        for row in rows {
            let key = suggestion_key(&row);
            if self.items.len() >= self.limit || self.seen.contains(&key) {
                continue;
            }
            self.seen.insert(key);
            self.items.push(row);
        }
    }
}

fn dedupe_suggestions(remote: &[String], query: &str) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::from([js::trim(query).to_lowercase()]);
    remote
        .iter()
        .filter(|s| {
            let key = js::trim(s).to_lowercase();
            !key.is_empty() && seen.insert(key)
        })
        .cloned()
        .collect()
}

struct Site {
    origin: String,
    prefix: bool,
    visits: f64,
    last_visit: f64,
    bookmarked: bool,
    favicon: Option<String>,
}

fn host_part(shown: &str) -> &str {
    &shown[..shown.find(['/', '?', '#']).unwrap_or(shown.len())]
}

// A page counts toward its site when the query starts the site's address, or (three letters or more) one of its
// names before the domain's end ("cloud" in dash.cloudflare.com, not "com").
fn add_site(sites: &mut IndexMap<String, Site>, c: &Candidate, q: &str) {
    let Some(origin) = c.text.origin() else {
        return;
    };
    let host = host_part(&c.text.shown_lower);
    let prefix = host.starts_with(q);
    let labels: Vec<&str> = host.split('.').collect();
    let names = if labels.len() > 2 {
        &labels[1..labels.len() - 1]
    } else {
        &[][..]
    };
    if !prefix && (js::utf16_len(q) < 3 || !names.iter().any(|name| name.starts_with(q))) {
        return;
    }
    match sites.get_mut(&origin) {
        None => {
            sites.insert(
                origin.clone(),
                Site {
                    origin,
                    prefix,
                    visits: c.visits,
                    last_visit: c.last_visit,
                    bookmarked: c.bookmarked,
                    favicon: c.favicon.clone(),
                },
            );
        }
        Some(site) => {
            site.visits += c.visits;
            site.last_visit = site.last_visit.max(c.last_visit);
            site.bookmarked |= c.bookmarked;
            if site.favicon.is_none() {
                site.favicon = c.favicon.clone();
            }
        }
    }
}

fn top_sites(sites: IndexMap<String, Site>, now: f64, count: usize) -> Vec<Site> {
    let score = |site: &Site| {
        let age_days = if site.last_visit != 0.0 {
            ((now - site.last_visit) / DAY).max(0.0)
        } else {
            10.0
        };
        (if site.prefix { 40.0 } else { 0.0 }) + (1.0 + site.visits).log2() * 8.0
            - age_days.min(30.0)
            + if site.bookmarked { 20.0 } else { 0.0 }
    };
    let mut sites: Vec<Site> = sites.into_values().collect();
    sites.sort_by(|a, b| {
        score(b)
            .partial_cmp(&score(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    sites.truncate(count);
    sites
}

fn site_row(site: &Site) -> Suggestion {
    Suggestion::Page {
        url: format!("{}/", site.origin),
        title: String::new(),
        favicon: site.favicon.clone(),
        tab_id: None,
        cleaned_id: None,
        bookmarked: false,
        visited: true,
        location: None,
    }
}

fn inline_match(text: &PageText, q: &str) -> bool {
    if host_part(&text.shown_lower).starts_with(q) && text.origin().is_some() {
        return true;
    }
    q.contains('/') && !text.shown.contains(['?', '#']) && text.shown_lower.starts_with(q)
}

struct InlineTarget {
    text: String,
    url: String,
    favicon: Option<String>,
}

fn inline_target(q: &str, c: &Candidate) -> InlineTarget {
    let host = host_part(&c.text.shown);
    match c.text.origin() {
        Some(origin) if host.to_lowercase().starts_with(q) => InlineTarget {
            text: host.to_owned(),
            url: format!("{origin}/"),
            favicon: c.favicon.clone(),
        },
        _ => InlineTarget {
            text: c.text.shown.clone(),
            url: c.url.clone(),
            favicon: c.favicon.clone(),
        },
    }
}

/// `text.slice(units)`: what follows the first `units` UTF-16 units.
fn slice_from(text: &str, units: usize) -> String {
    let mut used = 0;
    for (at, c) in text.char_indices() {
        if used >= units {
            return text[at..].to_owned();
        }
        used += c.len_utf16();
    }
    String::new()
}

static BARE_HOST: Pattern = Pattern::new(|| pattern(r"^[^/?#]+$"));
static TWO_WORDS: Pattern = Pattern::new(|| pattern(r"^\S+\s+\S"));

fn create_row(create: QuickCreate) -> Suggestion {
    Suggestion::Create {
        id: create.id,
        title: create.title,
        url: create.url,
        site: create.site,
    }
}

/// The rows for typed text.
pub fn build_suggestions(
    raw: &str,
    source: &SuggestionSource,
    options: &SuggestOptions,
) -> SuggestionResult {
    let limit = options.limit as usize;
    let query = js::trim(raw);
    let empty = SuggestionResult {
        items: Vec::new(),
        completion: String::new(),
    };
    if query.is_empty() {
        return empty;
    }
    let q = query.to_lowercase();
    let tokens: Vec<String> = q
        .split(|c: char| c.is_whitespace() || c == '\u{feff}')
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect();
    let engine = &options.engine;
    let remote_rows = |text: &str| -> Vec<Suggestion> {
        dedupe_suggestions(&options.remote, text)
            .into_iter()
            .take(options.remote_limit as usize)
            .map(|t| Suggestion::Search {
                url: search_url(&engine.url, &t),
                query: t,
                engine: engine.name.clone(),
                suggested: true,
            })
            .collect()
    };

    if let Some(rest) = query.strip_prefix('?') {
        let text = js::trim(rest);
        if text.is_empty() {
            return empty;
        }
        let mut out = Output::new(limit);
        out.push([Suggestion::Search {
            query: text.into(),
            url: search_url(&engine.url, text),
            engine: engine.name.clone(),
            suggested: false,
        }]);
        out.push(remote_rows(text));
        return SuggestionResult {
            items: out.items,
            completion: String::new(),
        };
    }

    let pool = pool(&source.history, &source.bookmarks);
    let over = tabs_over(
        &pool,
        &source.tabs,
        &source.cleaned,
        options.now,
        options.current_tab_id.as_deref(),
    );
    let current_key = options.current_url.as_deref().map(page_key);
    let known = |url: &str| -> Option<Suggestion> {
        let key = page_key(url);
        let c = pool
            .by_key
            .get(&key)
            .map(|&i| &pool.list[i])
            .or_else(|| over.extra.iter().find(|x| x.text.key == key))?;
        Some(page_suggestion(
            c,
            over.tab_ids.get(&key).cloned(),
            over.cleaned_ids.get(&key).cloned(),
        ))
    };
    // Only a bare host as typed looks for the site's tab: a scheme or a path asks for that address.
    let to_address = |url: &str, favicon: Option<String>| -> Suggestion {
        let row = known(url);
        if let Some(
            row @ Suggestion::Page {
                tab_id: Some(_), ..
            },
        ) = &row
        {
            return row.clone();
        }
        let tab = if BARE_HOST.is_match(query) {
            tab_on_site(
                &source.tabs,
                &host_of(url),
                options.current_tab_id.as_deref(),
            )
        } else {
            None
        };
        if let Some(tab) = tab {
            let title = tab
                .custom_title
                .clone()
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| tab.title.clone());
            return Suggestion::Page {
                url: tab.url.clone(),
                title,
                favicon: tab.favicon.clone(),
                tab_id: Some(tab.id.clone()),
                cleaned_id: None,
                bookmarked: false,
                visited: false,
                location: None,
            };
        }
        row.unwrap_or(Suggestion::Page {
            url: url.into(),
            title: String::new(),
            favicon,
            tab_id: None,
            cleaned_id: None,
            bookmarked: false,
            visited: false,
            location: None,
        })
    };

    let one_word = tokens.len() == 1;
    let completes = options.website_first && one_word;
    let parsed = parse_query(&q, &tokens);
    let mut top = TopList {
        items: Vec::new(),
        size: limit + 1,
    };
    // One word that isn't a path: the sites whose address it starts, each counted over all its pages.
    let mut sites: Option<IndexMap<String, Site>> =
        (one_word && !q.contains(['/', '?', '#', ':'])).then(IndexMap::new);
    let mut inline: Option<Ranked> = None;

    for c in pool.list.iter().chain(&over.extra) {
        let m = match_score(&c.text, &parsed);
        if m <= 0.0 {
            continue;
        }
        let tab_id = c
            .tab_id
            .clone()
            .or_else(|| over.tab_ids.get(&c.text.key).cloned());
        let cleaned_id = if tab_id.is_some() {
            None
        } else {
            c.cleaned_id
                .clone()
                .or_else(|| over.cleaned_ids.get(&c.text.key).cloned())
        };
        let derank = if current_key.as_deref() == Some(c.text.key.as_str()) {
            80.0
        } else {
            0.0
        };
        let s = m + frecency(c, tab_id.is_some(), cleaned_id.is_some(), options.now) - derank;
        let ranked = Ranked {
            c: c.clone(),
            tab_id,
            cleaned_id,
            m,
            s,
        };
        if let Some(sites) = sites.as_mut() {
            add_site(sites, c, &q);
        }
        if completes
            && inline.as_ref().is_none_or(|inline| ranked.s > inline.s)
            && inline_match(&c.text, &q)
        {
            inline = Some(ranked.clone());
        }
        top.offer(ranked);
    }
    let ranked = top.items;

    let search = Suggestion::Search {
        query: query.into(),
        url: search_url(&engine.url, query),
        engine: engine.name.clone(),
        suggested: false,
    };
    let typed_url = fixup_url(query);
    let answer = if options.calculator_enabled {
        calculate(query)
    } else {
        None
    };
    let emoji: Vec<Suggestion> = find_emoji(query, 5)
        .into_iter()
        .map(|m| Suggestion::Emoji {
            value: m.value,
            name: m.name,
        })
        .collect();
    let creates = match_quick_create(raw.trim_start(), 3);

    let target = inline.as_ref().map(|inline| inline_target(&q, &inline.c));
    let completion = target
        .as_ref()
        .map(|target| slice_from(&target.text, js::utf16_len(query)))
        .unwrap_or_default();

    let first = if !creates.is_empty() && TWO_WORDS.is_match(query) {
        create_row(creates[0].clone())
    } else if let Some(target) = target.as_ref().filter(|_| !completion.is_empty()) {
        to_address(&target.url, target.favicon.clone())
    } else if let Some(url) = &typed_url {
        to_address(url, None)
    } else if let Some(best) = ranked
        .first()
        .filter(|best| options.website_first && best.m >= 40.0)
    {
        page_suggestion(&best.c, best.tab_id.clone(), best.cleaned_id.clone())
    } else {
        search.clone()
    };

    let mut out = Output::new(limit);
    let has_emoji = !emoji.is_empty();
    out.push(emoji);
    if let Some(answer) = &answer {
        out.push([Suggestion::Calc {
            expression: answer.expression.clone(),
            value: answer.display.clone(),
            url: search_url(&engine.url, &answer.expression),
        }]);
    }
    out.push([first, search]);
    out.push(creates.into_iter().map(create_row));
    // The sites themselves, as Chrome's omnibox lists them, ahead of the engine's suggestions, with the best pages.
    let pages_ahead = options.pages_ahead as usize;
    let shown_sites = sites
        .map(|sites| top_sites(sites, options.now, if pages_ahead > 3 { 4 } else { 2 }))
        .unwrap_or_default();
    let site_rows: Vec<Suggestion> = shown_sites
        .iter()
        .map(|site| known(&format!("{}/", site.origin)).unwrap_or_else(|| site_row(site)))
        .collect();
    let site_origins: HashSet<&str> = shown_sites
        .iter()
        .map(|site| site.origin.as_str())
        .collect();
    let page_rows: Vec<Suggestion> = ranked
        .iter()
        .map(|x| page_suggestion(&x.c, x.tab_id.clone(), x.cleaned_id.clone()))
        .collect();
    let deeper = |row: &Suggestion| matches!(row, Suggestion::Page { url, .. } if site_origins.contains(ORIGIN.find(url).map_or("", |m| m.as_str())));
    // Other sites' pages first; a shown site's deeper pages fill what room is left.
    let ahead: Vec<Suggestion> = page_rows
        .iter()
        .filter(|row| !deeper(row))
        .chain(page_rows.iter().filter(|row| deeper(row)))
        .take(pages_ahead.saturating_sub(site_rows.len()))
        .cloned()
        .collect();
    out.push(site_rows);
    out.push(ahead);
    out.push(remote_rows(query));
    out.push(page_rows);
    let completion = if answer.is_some() || has_emoji {
        String::new()
    } else {
        completion
    };
    SuggestionResult {
        items: out.items,
        completion,
    }
}
