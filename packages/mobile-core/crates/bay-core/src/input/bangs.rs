//! Bangs: "!w font" or "font !w" searches Wikipedia. The list is DuckDuckGo's as Helium trims it, compiled in
//! (`data/bangs.txt`, exported from `@bay/core`'s `bangList.ts`). A port of `@bay/core`'s `bangs.ts`: the same
//! lookup, the same escaping, and the same check that the words can't move the search to another site.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, RwLock};

use super::{Pattern, pattern};
use crate::js;

/// Where the words go in a bang's template.
pub const BANG_PLACEHOLDER: &str = "{searchTerms}";
/// How the list stores it, to keep the file small.
const STORED_PLACEHOLDER: &str = "{s}";

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Bang {
    pub trigger: String,
    pub name: String,
    /// The search address, with `{searchTerms}` where the words go.
    pub template: String,
    /// The site's front page, for a bang with no words.
    pub home: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BangMatch {
    pub bang: Bang,
    pub query: String,
    pub url: String,
}

/// A bang list: each trigger to the line that holds it. Lines are only read when a trigger is looked up.
pub struct BangTable {
    text: Cow<'static, str>,
    lines: HashMap<String, usize>,
}

static VALID_TEMPLATE: Pattern = Pattern::new(|| {
    pattern(r"(?i)^https?://(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])(?::\d+)?(?:[/?#]\S*)?$")
});
static ORIGIN: Pattern = Pattern::new(|| pattern(r"(?i)^([a-z][a-z0-9+.-]*)://([^/?#\\]*)"));
static PATH_UNSAFE: Pattern = Pattern::new(|| pattern(r##"[^\x21-\x7e]+|["#%:<>?\[\\\]^`{|}]"##));

/// A template the words can only fill after the host: an http(s) address whose host and port are fixed.
pub fn is_valid_bang_template(template: &str) -> bool {
    VALID_TEMPLATE.is_match(template)
}

/// Whether `url` kept the scheme, host and port of the template it was made from.
pub fn stays_on_site(url: &str, template: &str) -> bool {
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let (Some(to), Some(from)) = (ORIGIN.captures(url), ORIGIN.captures(template)) else {
        return false;
    };
    !from[2].is_empty()
        && to[1].eq_ignore_ascii_case(&from[1])
        && to[2].eq_ignore_ascii_case(&from[2])
}

fn expand_template(stored: &str) -> String {
    // `get` rather than slicing: a template can start with a character wider than a byte.
    let starts = |scheme: &str| {
        stored
            .get(..scheme.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(scheme))
    };
    let full = if starts("http://") || starts("https://") {
        stored.to_owned()
    } else {
        format!("https://{stored}")
    };
    full.replace(STORED_PLACEHOLDER, BANG_PLACEHOLDER)
}

fn home_of(template: &str) -> String {
    ORIGIN
        .find(template)
        .map(|origin| format!("{}/", origin.as_str()))
        .unwrap_or_else(|| template.to_owned())
}

impl BangTable {
    /// Indexes a list of `triggers\tname\ttemplate` lines; a trigger in two lines keeps the first.
    pub fn new(text: impl Into<Cow<'static, str>>) -> Self {
        let text = text.into();
        let mut lines = HashMap::new();
        let mut at = 0;
        for line in text.split('\n') {
            if let Some((triggers, _)) = line.split_once('\t') {
                for trigger in triggers.split(' ').filter(|t| !t.is_empty()) {
                    lines.entry(trigger.to_owned()).or_insert(at);
                }
            }
            at += line.len() + 1;
        }
        Self { text, lines }
    }

    pub fn len(&self) -> usize {
        self.lines.len()
    }

    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    pub fn get(&self, trigger: &str) -> Option<Bang> {
        let key = trigger.to_lowercase();
        let at = *self.lines.get(&key)?;
        let line = self.text[at..].split('\n').next()?;
        let mut fields = line.split('\t').skip(1);
        let (name, stored) = (fields.next()?, fields.next()?);
        let template = expand_template(stored);
        (!name.is_empty() && is_valid_bang_template(&template)).then(|| Bang {
            trigger: key,
            name: name.to_owned(),
            home: home_of(&template),
            template,
        })
    }
}

/// The list Bay ships.
pub static BUNDLED_BANGS: LazyLock<Arc<BangTable>> =
    LazyLock::new(|| Arc::new(BangTable::new(include_str!("../../../../data/bangs.txt"))));

/// The list in use: the one Bay ships, until a newer one is fetched and checked (`bang_list.rs`).
static CURRENT_BANGS: LazyLock<RwLock<Arc<BangTable>>> =
    LazyLock::new(|| RwLock::new(Arc::clone(&BUNDLED_BANGS)));

/// The bang list searches use now.
pub fn current_bangs() -> Arc<BangTable> {
    Arc::clone(
        &CURRENT_BANGS
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
    )
}

/// Puts a checked list in use in place of the one before.
pub fn use_bangs(table: BangTable) {
    *CURRENT_BANGS
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::new(table);
}

/// The search escaped for where it goes: after a template's `?` as a query value (spaces as `+`, like Chrome's
/// engines), else in the path, keeping `/` and escaping what would end the path.
pub fn escape_search_terms(terms: &str, in_query: bool) -> String {
    if in_query {
        js::encode_uri_component(terms).replace("%20", "+")
    } else {
        PATH_UNSAFE
            .replace_all(terms, |m: &regex::Captures| js::encode_uri_component(&m[0]))
            .into_owned()
    }
}

pub fn fill_bang_template(template: &str, terms: &str) -> String {
    let Some(at) = template.find(BANG_PLACEHOLDER) else {
        return template.to_owned();
    };
    let in_query = template.find('?').is_some_and(|question| at > question);
    template.replace(BANG_PLACEHOLDER, &escape_search_terms(terms, in_query))
}

/// The bang at the start or the end of typed text, with the words around it and where they go. A leading "?" is a
/// plain search, and a bang whose address would leave its site is no bang.
pub fn find_bang(text: &str, table: &BangTable) -> Option<BangMatch> {
    if !text.contains('!') || text.trim_start().starts_with('?') {
        return None;
    }
    let words: Vec<&str> = text.split_whitespace().collect();
    let last = words.len().checked_sub(1)?;
    let ends: &[usize] = if last > 0 { &[0, last] } else { &[0] };
    for &at in ends {
        let word = words[at];
        let Some(trigger) = word.strip_prefix('!').filter(|t| !t.is_empty()) else {
            continue;
        };
        let Some(bang) = table.get(trigger) else {
            continue;
        };
        let query = words
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != at)
            .map(|(_, word)| *word)
            .collect::<Vec<_>>()
            .join(" ");
        let url = if query.is_empty() {
            bang.home.clone()
        } else {
            fill_bang_template(&bang.template, &query)
        };
        if stays_on_site(&url, &bang.template) {
            return Some(BangMatch { bang, query, url });
        }
    }
    None
}

/// The bang a word names, when typed text is just "!yt": for turning the field into that site's chip.
pub fn bang_named(word: &str, table: &BangTable) -> Option<Bang> {
    let trigger = js::trim(word)
        .strip_prefix('!')
        .filter(|t| !t.is_empty() && !t.contains(char::is_whitespace))?;
    table.get(trigger)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = "gh git github\tGitHub\tgithub.com/search?q={s}\n\
ghr\tGitHub Repo\tgithub.com/{s}\n\
w wiki\tWikipedia\twikipedia.org/w/index.php?search={s}\n\
yt ют\tYouTube\twww.youtube.com/results?search_query={s}\n\
zig\tZig\tziglang.org/documentation/master/std/#?{s}\n\
gmail\tGmail\tmail.google.com/mail/u/0/#search/{s}\n\
copilot\tMicrosoft Copilot\tcopilot.microsoft.com/?q={s}\n\
rtfd\tRead the Docs\t{s}.rtfd.io/\n\
hypestat\thypestat\twww.{s}.hypestat.com/\n\
noslash\tNo slash\texample.com{s}\n\
user\tUser\t{s}@example.com/\n\
gh\tTaken\ttaken.example/?q={s}";

    fn table() -> BangTable {
        BangTable::new(FIXTURE)
    }

    fn url(text: &str) -> Option<String> {
        find_bang(text, &table()).map(|m| m.url)
    }

    #[test]
    fn a_bang_at_either_end_picks_the_site_in_any_case() {
        assert_eq!(
            url("!gh react").as_deref(),
            Some("https://github.com/search?q=react")
        );
        assert_eq!(
            url("react !w").as_deref(),
            Some("https://wikipedia.org/w/index.php?search=react")
        );
        assert_eq!(
            url("!GH react hooks").as_deref(),
            Some("https://github.com/search?q=react+hooks")
        );
        assert_eq!(
            url("  react   hooks   !Wiki ").as_deref(),
            Some("https://wikipedia.org/w/index.php?search=react+hooks")
        );
        assert_eq!(
            url("!ют cats").as_deref(),
            Some("https://www.youtube.com/results?search_query=cats")
        );
        let bang = find_bang("!gh react", &table()).unwrap().bang;
        assert_eq!(bang.template, "https://github.com/search?q={searchTerms}");
        assert_eq!(bang.home, "https://github.com/");
        assert_eq!(bang.name, "GitHub");
    }

    #[test]
    fn a_bare_bang_opens_the_site() {
        assert_eq!(url("!yt").as_deref(), Some("https://www.youtube.com/"));
        assert_eq!(url("  !W  ").as_deref(), Some("https://wikipedia.org/"));
    }

    #[test]
    fn unknown_bangs_and_stray_marks_are_no_bang() {
        for text in [
            "!nope react",
            "react !nope",
            "hello!",
            "wow ! nice",
            "!",
            "! gh react",
            "hi!gh",
            "say !gh in the middle",
            "example.com/!gh",
            "?!gh react",
            "a!w",
            "?!gh react !w",
            "  ?react !w",
        ] {
            assert_eq!(find_bang(text, &table()), None, "{text}");
        }
    }

    #[test]
    fn the_first_end_that_matches_wins() {
        assert_eq!(
            url("!gh react !w").as_deref(),
            Some("https://github.com/search?q=react+!w")
        );
        assert_eq!(
            url("!nope react !w").as_deref(),
            Some("https://wikipedia.org/w/index.php?search=!nope+react")
        );
    }

    #[test]
    fn words_are_escaped_for_the_query_or_the_path() {
        assert_eq!(
            url("!gh a+b & c/d #x 100%").as_deref(),
            Some("https://github.com/search?q=a%2Bb+%26+c%2Fd+%23x+100%25")
        );
        assert_eq!(
            url("!gh 日本 語").as_deref(),
            Some("https://github.com/search?q=%E6%97%A5%E6%9C%AC+%E8%AA%9E")
        );
        assert_eq!(
            url("!gh it's (ok)*!~").as_deref(),
            Some("https://github.com/search?q=it's+(ok)*!~")
        );
        assert_eq!(
            url("!zig std.mem a b").as_deref(),
            Some("https://ziglang.org/documentation/master/std/#?std.mem+a+b")
        );
        assert_eq!(
            url("!ghr facebook/react").as_deref(),
            Some("https://github.com/facebook/react")
        );
        assert_eq!(
            url("!ghr a b?c#d%e").as_deref(),
            Some("https://github.com/a%20b%3Fc%23d%25e")
        );
        assert_eq!(
            url("!gmail from:me").as_deref(),
            Some("https://mail.google.com/mail/u/0/#search/from%3Ame")
        );
        assert_eq!(escape_search_terms("é ü", false), "%C3%A9%20%C3%BC");
        assert_eq!(
            fill_bang_template("https://a.example/{searchTerms}/x?q={searchTerms}", "p q"),
            "https://a.example/p%20q/x?q=p%20q"
        );
    }

    #[test]
    fn templates_that_let_the_words_pick_the_host_are_left_out() {
        for trigger in ["rtfd", "hypestat", "noslash", "user"] {
            assert_eq!(table().get(trigger), None, "{trigger}");
        }
        assert!(stays_on_site(
            "https://GitHub.com/a",
            "https://github.com/{searchTerms}"
        ));
        for url in [
            "https://github.com@evil.example/",
            "https://evil.example/github.com/",
            "http://github.com/a",
            "https://github.com:444/a",
            "https://github.com.evil.example/",
            "https://github.com/a\tb",
        ] {
            assert!(
                !stays_on_site(url, "https://github.com/{searchTerms}"),
                "{url}"
            );
        }
    }

    #[test]
    fn a_trigger_keeps_its_first_site_and_the_bundled_list_has_the_common_ones() {
        assert_eq!(table().get("gh").unwrap().name, "GitHub");
        assert_eq!(bang_named("!YT", &table()).unwrap().name, "YouTube");
        assert_eq!(bang_named("!yt cats", &table()), None);
        assert!(BUNDLED_BANGS.len() > 10_000);
        for trigger in ["gh", "w", "yt", "imdb", "g"] {
            assert!(BUNDLED_BANGS.get(trigger).is_some(), "{trigger}");
        }
    }
}
