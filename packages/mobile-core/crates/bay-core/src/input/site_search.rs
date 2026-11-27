//! Searching one site from the search field: "yt", "imdb" or "github.com" names a site, and the field turns into that
//! site's chip. A port of `@bay/core`'s `siteSearch.ts`, with the chip colours of the desktop's `scopeColors.ts`.

use super::bangs::{Bang, fill_bang_template};
use super::engines::{SearchEngine, engine_host};
use super::url::{host_of, search_url_for};
use crate::js;

/// A site the field can search before it was ever opened: its host, its name, a short keyword, and its search
/// address with `%s` where the words go.
struct SiteSearch {
    host: &'static str,
    name: &'static str,
    keyword: Option<&'static str>,
    url: &'static str,
}

const fn site(
    host: &'static str,
    name: &'static str,
    keyword: Option<&'static str>,
    url: &'static str,
) -> SiteSearch {
    SiteSearch {
        host,
        name,
        keyword,
        url,
    }
}

const POPULAR_SITE_SEARCHES: &[SiteSearch] = &[
    site(
        "youtube.com",
        "YouTube",
        Some("yt"),
        "https://www.youtube.com/results?search_query=%s",
    ),
    site(
        "wikipedia.org",
        "Wikipedia",
        Some("w"),
        "https://en.wikipedia.org/w/index.php?search=%s",
    ),
    site(
        "github.com",
        "GitHub",
        Some("gh"),
        "https://github.com/search?q=%s",
    ),
    site(
        "amazon.com",
        "Amazon",
        Some("a"),
        "https://www.amazon.com/s?k=%s",
    ),
    site(
        "reddit.com",
        "Reddit",
        Some("r"),
        "https://www.reddit.com/search/?q=%s",
    ),
    site("x.com", "X", None, "https://x.com/search?q=%s"),
    site("twitter.com", "X", None, "https://x.com/search?q=%s"),
    site(
        "stackoverflow.com",
        "Stack Overflow",
        None,
        "https://stackoverflow.com/search?q=%s",
    ),
    site(
        "npmjs.com",
        "npm",
        None,
        "https://www.npmjs.com/search?q=%s",
    ),
    site(
        "maps.google.com",
        "Google Maps",
        None,
        "https://www.google.com/maps/search/%s",
    ),
    site(
        "drive.google.com",
        "Google Drive",
        None,
        "https://drive.google.com/drive/search?q=%s",
    ),
    site(
        "mail.google.com",
        "Gmail",
        None,
        "https://mail.google.com/mail/u/0/#search/%s",
    ),
    site("imdb.com", "IMDb", None, "https://www.imdb.com/find/?q=%s"),
    site(
        "open.spotify.com",
        "Spotify",
        None,
        "https://open.spotify.com/search/%s",
    ),
    site(
        "linkedin.com",
        "LinkedIn",
        None,
        "https://www.linkedin.com/search/results/all/?keywords=%s",
    ),
    site(
        "ebay.com",
        "eBay",
        None,
        "https://www.ebay.com/sch/i.html?_nkw=%s",
    ),
    site(
        "pinterest.com",
        "Pinterest",
        None,
        "https://www.pinterest.com/search/pins/?q=%s",
    ),
    site(
        "news.ycombinator.com",
        "Hacker News",
        None,
        "https://hn.algolia.com/?q=%s",
    ),
    site(
        "developer.mozilla.org",
        "MDN",
        None,
        "https://developer.mozilla.org/en-US/search?q=%s",
    ),
    site(
        "figma.com",
        "Figma",
        None,
        "https://www.figma.com/files/search?q=%s",
    ),
    site(
        "notion.so",
        "Notion",
        None,
        "https://www.notion.so/search?q=%s",
    ),
    site(
        "apps.apple.com",
        "App Store",
        None,
        "https://www.apple.com/us/search/%s?src=serp",
    ),
    site(
        "translate.google.com",
        "Google Translate",
        None,
        "https://translate.google.com/?text=%s",
    ),
];

/// Sites' own colours, for the chip: a site is known by its colour before it has been opened.
const SITE_COLORS: &[(&str, &str)] = &[
    ("youtube.com", "#D90000"),
    ("google.com", "#1967D2"),
    ("wikipedia.org", "#FFFFFF"),
    ("github.com", "#24292F"),
    ("amazon.com", "#FF9900"),
    ("reddit.com", "#D93900"),
    ("twitter.com", "#006BB3"),
    ("x.com", "#242424"),
    ("spotify.com", "#1DB954"),
    ("stackoverflow.com", "#D95600"),
    ("npmjs.com", "#CB3837"),
    ("duckduckgo.com", "#C9442C"),
    ("bing.com", "#007D83"),
    ("notion.so", "#37352F"),
    ("figma.com", "#A259FF"),
    ("imdb.com", "#F5C518"),
    ("linkedin.com", "#0A66C2"),
    ("pinterest.com", "#E60023"),
    ("ebay.com", "#E53238"),
    ("news.ycombinator.com", "#FF6600"),
    ("developer.mozilla.org", "#1B1B1B"),
    ("apple.com", "#1D1D1F"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum ScopeKind {
    /// A search engine: one of Bay's, or the custom one.
    Engine,
    /// A site from the list of popular site searches.
    Site,
    /// A host from history with no search of its own: searched with the default engine and `site:`.
    History,
    /// A bang ("!yt"): the site from the bang list.
    Bang,
}

/// What the field searches while it shows a site's chip.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct SearchScope {
    pub kind: ScopeKind,
    pub name: String,
    /// The site's host without "www.", for its icon and the pages of it in history and bookmarks.
    pub host: String,
    /// The search address: `%s` where the words go, or a bang's `{searchTerms}`. Empty for a history scope.
    pub url: String,
    /// The site's home page, opened when the field is submitted with nothing typed.
    pub home: String,
    pub engine_id: Option<String>,
    /// The site's colour (`#RRGGBB`), when Bay knows it.
    pub color: Option<String>,
}

fn normalize(text: &str) -> String {
    let lower = js::trim(text).to_lowercase();
    let after_scheme = match lower.split_once("://") {
        Some((scheme, rest))
            if !scheme.is_empty() && scheme.chars().all(|c| c.is_ascii_lowercase()) =>
        {
            rest
        }
        _ => lower.as_str(),
    };
    let bare = after_scheme.strip_prefix("www.").unwrap_or(after_scheme);
    bare.strip_suffix('/').unwrap_or(bare).to_owned()
}

/// The name part of a host: "youtube" for "youtube.com".
fn site_label(host: &str) -> &str {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() >= 2 {
        parts[parts.len() - 2]
    } else {
        host
    }
}

/// Whether `host` is `site` or a part of it: "en.wikipedia.org" is on "wikipedia.org".
pub fn is_on_site(host: &str, site: &str) -> bool {
    host.strip_suffix(site)
        .is_some_and(|rest| rest.is_empty() || rest.ends_with('.'))
}

/// A search address filled with a stand-in word, so it parses as an address: for its host and home page.
pub fn sample_address(template: &str) -> String {
    template.replace("%s", "q").replace("{searchTerms}", "q")
}

fn home_of(url: &str) -> String {
    super::url::parse_url(&sample_address(url))
        .filter(|parsed| !parsed.host.is_empty())
        .map(|parsed| {
            let port = if parsed.port.is_empty() {
                String::new()
            } else {
                format!(":{}", parsed.port)
            };
            format!("{}://{}{port}/", parsed.scheme, parsed.host)
        })
        .unwrap_or_default()
}

/// The chip colour for a site's host, matched on the host or a part of it ("en.wikipedia.org" is Wikipedia's).
pub fn site_color(host: &str) -> Option<String> {
    let host = host.strip_prefix("www.").unwrap_or(host);
    SITE_COLORS
        .iter()
        .find(|(site, _)| is_on_site(host, site))
        .map(|(_, color)| (*color).to_owned())
}

fn engine_scope(engine: &SearchEngine) -> SearchScope {
    let host = engine_host(&engine.url);
    SearchScope {
        kind: ScopeKind::Engine,
        name: engine.name.clone(),
        color: site_color(&host),
        home: home_of(&engine.url),
        host,
        url: engine.url.clone(),
        engine_id: Some(engine.id.clone()),
    }
}

fn site_scope(site: &SiteSearch) -> SearchScope {
    SearchScope {
        kind: ScopeKind::Site,
        name: site.name.into(),
        host: site.host.into(),
        url: site.url.into(),
        home: home_of(site.url),
        engine_id: None,
        color: site_color(site.host),
    }
}

/// The scope a bang names: its site, searched with its own template.
pub fn bang_scope(bang: &Bang) -> SearchScope {
    let host = host_of(&bang.home);
    SearchScope {
        kind: ScopeKind::Bang,
        name: bang.name.clone(),
        color: site_color(&host),
        host,
        url: bang.template.clone(),
        home: bang.home.clone(),
        engine_id: None,
    }
}

/// The site typed text names, when it names one: a custom engine's keyword first, then Bay's engines (keyword, host,
/// or a name of three letters or more), the popular sites (keyword, host or a part of it, or name), and last a host
/// in history. Text with a space in it is a search, never a site. `hosts` is only asked for at the very end.
pub fn find_scope(
    text: &str,
    engines: &[SearchEngine],
    hosts: impl FnOnce() -> Vec<String>,
) -> Option<SearchScope> {
    let t = normalize(text);
    // A search, or an address with a path (the page's own, say), names no site.
    if t.is_empty() || t.chars().any(|c| c.is_whitespace() || c == '/') {
        return None;
    }
    let parsed = host_of(&format!("https://{t}"));
    let host = if parsed.is_empty() { t.clone() } else { parsed };

    if let Some(engine) = engines
        .iter()
        .find(|e| e.custom && e.keyword.to_lowercase() == t)
    {
        return Some(engine_scope(engine));
    }
    for engine in engines.iter().filter(|e| !e.custom) {
        let engine_host = engine_host(&engine.url);
        if engine.keyword.to_lowercase() == host
            || engine_host == host
            || (t.chars().count() >= 3 && t == site_label(&engine_host))
        {
            return Some(engine_scope(engine));
        }
    }
    for site in POPULAR_SITE_SEARCHES {
        if site.keyword == Some(t.as_str())
            || is_on_site(&host, site.host)
            || (t == host
                && t.chars().count() >= 3
                && site.host.split('.').count() == 2
                && site_label(site.host) == t)
        {
            return Some(site_scope(site));
        }
    }
    if host.contains('.') && hosts().iter().any(|known| known == &host) {
        return Some(SearchScope {
            kind: ScopeKind::History,
            name: host.clone(),
            color: site_color(&host),
            home: format!("https://{host}/"),
            host,
            url: String::new(),
            engine_id: None,
        });
    }
    None
}

/// The site to offer as the first row while a name is still being typed: the site the text names, else the first
/// engine or popular site whose name starts with it ("im" offers IMDb). Two letters at least, and no spaces.
pub fn offered_scope(
    text: &str,
    engines: &[SearchEngine],
    hosts: impl FnOnce() -> Vec<String>,
) -> Option<SearchScope> {
    if let Some(scope) = find_scope(text, engines, hosts) {
        return Some(scope);
    }
    let t = normalize(text);
    if t.chars().count() < 2 || t.chars().any(|c| c.is_whitespace() || c == '.' || c == '/') {
        return None;
    }
    let starts = |name: &str| name.to_lowercase().replace(' ', "").starts_with(&t);
    if let Some(engine) = engines.iter().find(|e| !e.custom && starts(&e.name)) {
        return Some(engine_scope(engine));
    }
    POPULAR_SITE_SEARCHES
        .iter()
        .find(|site| starts(site.name) || site_label(site.host).starts_with(&t))
        .map(site_scope)
}

/// The popular site whose host is `host` (or a part of it), as a scope: for the shortcut row's pinned sites.
pub fn scope_for_host(host: &str) -> Option<SearchScope> {
    let host = host.strip_prefix("www.").unwrap_or(host);
    POPULAR_SITE_SEARCHES
        .iter()
        .find(|site| is_on_site(host, site.host))
        .map(site_scope)
}

/// Where submitting `query` inside a scope goes: the site's search, a bang's template, or for a history host the
/// default engine with `site:`. Nothing typed opens the site itself.
#[uniffi::export]
pub fn scoped_search_url(scope: SearchScope, query: String, default_engine_url: String) -> String {
    let query = js::trim(&query);
    if query.is_empty() {
        return scope.home;
    }
    match scope.kind {
        ScopeKind::History => {
            search_url_for(&default_engine_url, &format!("site:{} {query}", scope.host))
        }
        ScopeKind::Bang => fill_bang_template(&scope.url, query),
        ScopeKind::Engine | ScopeKind::Site => search_url_for(&scope.url, query),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::engines::built_in_engines;

    fn none() -> Vec<String> {
        Vec::new()
    }

    #[test]
    fn default_shortcuts_enter_a_site_and_fill_its_search() {
        let engines = built_in_engines();
        let google = &engines[0].url;
        for (shortcut, name, url) in [
            (
                "yt",
                "YouTube",
                "https://www.youtube.com/results?search_query=react%20hooks",
            ),
            (
                "w",
                "Wikipedia",
                "https://en.wikipedia.org/w/index.php?search=react%20hooks",
            ),
            ("gh", "GitHub", "https://github.com/search?q=react%20hooks"),
            ("a", "Amazon", "https://www.amazon.com/s?k=react%20hooks"),
            (
                "r",
                "Reddit",
                "https://www.reddit.com/search/?q=react%20hooks",
            ),
        ] {
            let scope = find_scope(shortcut, &engines, none).unwrap();
            assert_eq!(scope.name, name);
            assert_eq!(
                scoped_search_url(scope, "react hooks".into(), google.clone()),
                url
            );
        }
    }

    #[test]
    fn a_site_is_found_by_its_name_or_host_but_a_search_is_not() {
        let engines = built_in_engines();
        let imdb = find_scope("imdb", &engines, none).unwrap();
        assert_eq!(
            (imdb.name.as_str(), imdb.color.as_deref()),
            ("IMDb", Some("#F5C518"))
        );
        assert_eq!(imdb.home, "https://www.imdb.com/");
        assert_eq!(
            find_scope("YouTube", &engines, none).unwrap().host,
            "youtube.com"
        );
        assert_eq!(
            find_scope("https://www.github.com/", &engines, none)
                .unwrap()
                .host,
            "github.com"
        );
        assert_eq!(
            find_scope("docs.github.com", &engines, none).unwrap().host,
            "github.com"
        );
        assert_eq!(
            find_scope("Wikipedia", &engines, none)
                .unwrap()
                .color
                .as_deref(),
            Some("#FFFFFF")
        );
        assert!(find_scope("yt cats", &engines, none).is_none());
        assert!(find_scope("unknown-shortcut", &engines, none).is_none());
        assert!(find_scope("", &engines, none).is_none());
        assert!(find_scope("https://en.wikipedia.org/wiki/Font", &engines, none).is_none());
        assert!(offered_scope("https://en.wikipedia.org/wiki/Font", &engines, none).is_none());
    }

    #[test]
    fn a_host_is_on_a_site_or_one_of_its_parts_only() {
        assert!(is_on_site("wikipedia.org", "wikipedia.org"));
        assert!(is_on_site("en.wikipedia.org", "wikipedia.org"));
        assert!(!is_on_site("notwikipedia.org", "wikipedia.org"));
        assert!(!is_on_site("wikipedia.org.evil.example", "wikipedia.org"));
    }

    #[test]
    fn a_site_is_offered_while_its_name_is_typed() {
        let engines = built_in_engines();
        assert_eq!(offered_scope("im", &engines, none).unwrap().name, "IMDb");
        assert_eq!(
            offered_scope("wi", &engines, none).unwrap().name,
            "Wikipedia"
        );
        assert_eq!(offered_scope("yo", &engines, none).unwrap().name, "YouTube");
        assert_eq!(
            offered_scope("w", &engines, none).unwrap().name,
            "Wikipedia"
        );
        assert!(offered_scope("i", &engines, none).is_none());
        assert!(offered_scope("im a", &engines, none).is_none());
        assert!(offered_scope("zzq", &engines, none).is_none());
    }

    #[test]
    fn engines_come_before_sites_and_a_custom_keyword_before_both() {
        let mut engines = built_in_engines();
        assert_eq!(
            find_scope("duckduckgo", &engines, none).unwrap().kind,
            ScopeKind::Engine
        );
        engines.push(SearchEngine {
            id: "work".into(),
            name: "Work videos".into(),
            keyword: "yt".into(),
            url: "https://video.work.example/?q=%s".into(),
            suggest_url: None,
            custom: true,
        });
        assert_eq!(
            find_scope("yt", &engines, none).unwrap().url,
            "https://video.work.example/?q=%s"
        );
    }

    #[test]
    fn history_hosts_are_asked_for_last_and_searched_with_site() {
        let engines = built_in_engines();
        let asked = std::cell::Cell::new(false);
        let hosts = || {
            asked.set(true);
            vec!["research.example".to_owned()]
        };
        let scope = find_scope("HTTPS://WWW.Research.Example/", &engines, hosts).unwrap();
        assert!(asked.get());
        assert_eq!(scope.kind, ScopeKind::History);
        assert_eq!(
            scoped_search_url(scope.clone(), "papers".into(), engines[0].url.clone()),
            "https://www.google.com/search?q=site%3Aresearch.example%20papers"
        );
        assert_eq!(
            scoped_search_url(scope, " ".into(), engines[0].url.clone()),
            "https://research.example/"
        );
        let untouched = || -> Vec<String> { panic!("a site already matched never reads history") };
        assert_eq!(
            find_scope("gh", &engines, untouched).unwrap().name,
            "GitHub"
        );
        assert!(find_scope("unknown.example", &engines, none).is_none());
    }
}
