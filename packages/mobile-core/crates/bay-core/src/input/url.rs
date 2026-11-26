//! What typed text means as an address: parsing, the host, fixing up what's typed into a full address, search URLs,
//! pasted text, and how an address shows.

use super::app_urls::{app_url_origin, to_app_url};
use super::clean::clean_url;
use super::idn::display_host;
use super::{Pattern, fancy, pattern};
use crate::js;

pub const SEARCH_URL: &str = "https://www.google.com/search?q=";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ParsedUrl {
    pub scheme: String,
    pub host: String,
    pub port: String,
    pub path: String,
    pub query: String,
    pub hash: String,
}

static URL_PARTS: Pattern = Pattern::new(|| {
    pattern(
        r"(?is)^([a-z][a-z0-9+.-]*)://(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)(?::([0-9]+))?([^?#]*)(\?[^#]*)?(#.*)?$",
    )
});

pub fn parse_url(url: &str) -> Option<ParsedUrl> {
    let m = URL_PARTS.captures(js::trim(url))?;
    let part = |i: usize| m.get(i).map_or("", |m| m.as_str()).to_owned();
    Some(ParsedUrl {
        scheme: part(1).to_lowercase(),
        host: part(2).to_lowercase(),
        port: part(3),
        path: part(4),
        query: part(5),
        hash: part(6),
    })
}

/// The host without "www.", or "" when the text isn't an address.
#[uniffi::export]
pub fn host_of(url: &str) -> String {
    let host = parse_url(url).map(|parsed| parsed.host).unwrap_or_default();
    host.strip_prefix("www.").map(str::to_owned).unwrap_or(host)
}

const KNOWN_SCHEMES: &[&str] = &[
    "http",
    "https",
    "file",
    "about",
    "data",
    "blob",
    "mailto",
    "tel",
    "sms",
    "facetime",
    "ftp",
    "view-source",
    "bay",
    "chrome",
    "chrome-extension",
    "devtools",
    "x-apple.systempreferences",
    "itms-apps",
    "slack",
    "zoommtg",
    "vscode",
    "cursor",
    "notion",
    "figma",
    "spotify",
    "linear",
    "obsidian",
    "raycast",
];

const KNOWN_TLDS: &str = "com net org edu gov mil int info biz name pro mobi app dev io ai co me tv cc gg sh fm ly so to xyz online site tech store \
blog shop cloud page news live art design studio agency media digital network systems solutions services software \
email chat social link click space website world today life fun games game zone wiki tools codes run build host \
rocks ninja guru expert academy school university health care money finance bank capital fund law legal travel \
photos photo pics gallery video music film movie radio audio events social group team community church city \
london nyc paris berlin tokyo africa asia eu aero coop museum jobs cat post tel travel moe onl one top vip win \
work works company business center global plus inc ltd llc gmbh srl cafe restaurant pizza bar pub coffee wine beer \
fashion style shoes clothing jewelry watch camera computer phone mobile download security domains hosting \
google youtube gmail android chrome amazon apple microsoft windows office azure aws netflix meta search \
local localhost test internal lan arpa onion \
ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cc \
cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga \
gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp \
ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms \
mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro \
rs ru rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt \
tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw";

fn known_tld(tld: &str) -> bool {
    KNOWN_TLDS.split(' ').any(|known| known == tld)
}

static LOCAL_SUFFIX: Pattern =
    Pattern::new(|| pattern(r"\.(local|localhost|test|internal|lan|home\.arpa)$"));
static IPV4: Pattern = Pattern::new(|| pattern(r"^([0-9]{1,3}\.){3}[0-9]{1,3}$"));

fn is_local_host(host: &str) -> bool {
    host == "localhost"
        || host.starts_with('[')
        || IPV4.is_match(host)
        || LOCAL_SUFFIX.is_match(host)
}

/// JavaScript's `\s`: Unicode white space and the byte-order mark.
fn has_space(text: &str) -> bool {
    text.chars().any(|c| c.is_whitespace() || c == '\u{feff}')
}

fn replace_space(text: &str, with: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_whitespace() || c == '\u{feff}' {
                with.to_owned()
            } else {
                c.to_string()
            }
        })
        .collect()
}

static SCHEME_OR_PATH: Pattern = Pattern::new(|| pattern(r"(?i)^([a-z][a-z0-9+.-]*://|/[^\s/])"));
static BARE_SCHEMES: Pattern =
    Pattern::new(|| pattern(r"(?i)^(about|data|mailto|tel|sms|facetime|view-source):"));
static SCHEME: Pattern = Pattern::new(|| pattern(r"(?i)^([a-z][a-z0-9+.-]*):"));
static HOST: std::sync::LazyLock<fancy_regex::Regex> = std::sync::LazyLock::new(|| {
    fancy(
        r"(?i)^(localhost|\[[0-9a-f:.]+\]|([0-9]{1,3}\.){3}[0-9]{1,3}|([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z][a-z0-9-]*[a-z0-9]|xn--[a-z0-9-]+))\.?(:[0-9]{1,5})?(?=[/?#]|$)",
    )
});

/// What typed text opens as an address, or `None` when it reads as a search.
#[uniffi::export]
pub fn fixup_url(raw: &str) -> Option<String> {
    fixup(raw).map(|url| to_app_url(&url))
}

fn fixup(raw: &str) -> Option<String> {
    let input = js::trim(raw);
    if input.is_empty() || (has_space(input) && !SCHEME_OR_PATH.is_match(input)) {
        return None;
    }
    if BARE_SCHEMES.is_match(input) {
        return Some(input.to_owned());
    }
    let scheme = SCHEME.captures(input).map(|m| m[1].to_lowercase());
    if let Some(scheme) = &scheme {
        let after = &input[scheme.len() + 1..];
        let known = KNOWN_SCHEMES.contains(&scheme.as_str());
        if known && (after.starts_with("//") || !after.starts_with(|c: char| c.is_ascii_digit())) {
            return Some(format!(
                "{scheme}{}",
                replace_space(&input[scheme.len()..], "%20")
            ));
        }
        if !known && after.starts_with("//") {
            return Some(input.to_owned());
        }
    }
    if input.starts_with('/') && !input.starts_with("//") {
        return Some(format!("file://{}", replace_space(input, "%20")));
    }
    let host = HOST.captures(input).ok().flatten()?;
    let name_raw = host.get(1)?.as_str().to_lowercase();
    let name = name_raw.strip_suffix('.').unwrap_or(&name_raw);
    let numeric = name.chars().all(|c| c.is_ascii_digit() || c == '.');
    let tld = if name.contains('.') && !numeric && !name.starts_with('[') {
        &name[name.rfind('.')? + 1..]
    } else {
        ""
    };
    let rest = &input[host.get(0)?.end()..];
    let explicit = host.get(5).is_some() || !rest.is_empty();
    if !tld.is_empty() && !known_tld(tld) && !tld.starts_with("xn--") && !explicit {
        return None;
    }
    Some(format!(
        "{}://{input}",
        if is_local_host(name) { "http" } else { "https" }
    ))
}

/// A search address: the words in place of `%s`, or after the template.
pub fn search_url_for(template: &str, query: &str) -> String {
    let q = js::encode_uri_component(js::trim(query));
    if template.contains("%s") {
        template.replace("%s", &q)
    } else {
        format!("{template}{q}")
    }
}

pub fn resolve_input(raw: &str, search: &str) -> String {
    let input = js::trim(raw);
    if input.is_empty() {
        return String::new();
    }
    if let Some(rest) = input.strip_prefix('?') {
        return if rest.is_empty() {
            String::new()
        } else {
            search_url_for(search, rest)
        };
    }
    fixup_url(input).unwrap_or_else(|| search_url_for(search, input))
}

/// What pasted text does: open an address, or search for the words.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, uniffi::Enum)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PasteAction {
    Go { url: String },
    Search { query: String },
}

static ABOUT_OR_DATA: Pattern = Pattern::new(|| pattern(r"(?i)^(about|data):"));

#[uniffi::export]
pub fn classify_paste(text: &str) -> Option<PasteAction> {
    let trimmed = js::trim(text);
    if trimmed.is_empty() {
        return None;
    }
    if !has_space(trimmed)
        && let Some(url) = fixup_url(trimmed).filter(|url| !ABOUT_OR_DATA.is_match(url))
    {
        return Some(PasteAction::Go {
            url: clean_url(&url),
        });
    }
    let collapsed = trimmed
        .split(|c: char| c.is_whitespace() || c == '\u{feff}')
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    // `replace(/\s+/g, " ")` keeps the text's own ends, which `trim` already took.
    Some(PasteAction::Search {
        query: js::slice(&collapsed.join(" "), 2000),
    })
}

static SCHEME_PREFIX: Pattern = Pattern::new(|| pattern(r"(?i)^[a-z][a-z0-9+.-]*://"));
static APP_ROOT_SLASH: Pattern = Pattern::new(|| pattern(r"(?s)^([^/]*//[^/?#]*)/([?#].*)?$"));

/// An address as the field shows it: no scheme, no "www.", the host in Unicode where that's safe.
pub fn url_for_display(url: &str) -> String {
    if app_url_origin(url).is_some() {
        let app = to_app_url(url);
        return match APP_ROOT_SLASH.captures(&app) {
            Some(m) => format!("{}{}", &m[1], m.get(2).map_or("", |m| m.as_str())),
            None => app,
        };
    }
    let rest = SCHEME_PREFIX.replace(url, "").into_owned();
    let host_end = rest.find(['/', '?', '#', ':']).unwrap_or(rest.len());
    let shown = format!("{}{}", display_host(&rest[..host_end]), &rest[host_end..]);
    if shown
        .get(..4)
        .is_some_and(|start| start.eq_ignore_ascii_case("www."))
    {
        shown[4..].to_owned()
    } else {
        shown
    }
}
