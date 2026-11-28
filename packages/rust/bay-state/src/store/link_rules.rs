//! Where a link opens (lib/externalLinkRules.ts): the person's rules, matched by host and path globs, by text, or by
//! the whole address, each sending its links to a space, Little Bay, the most recent space or a new window.

use std::collections::HashSet;

use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use bay_core::input::idn::punycode_encode;
use bay_core::input::url::parse_url;

/// Where a rule's links open.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkDestination {
    Space {
        space_id: String,
        sync_profile_id: Option<String>,
    },
    LittleBay,
    MostRecentSpace,
    NewWindow,
}

/// "contains" or "equals"; none for an older rule's host/path wildcard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkMatchType {
    Contains,
    Equals,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalLinkRule {
    pub id: String,
    pub pattern: String,
    pub match_type: Option<LinkMatchType>,
    /// Only links from this app (its bundle id).
    pub source_app: Option<String>,
    pub destination: LinkDestination,
}

struct WebUrl {
    protocol: String,
    host: String,
    pathname: String,
    query: String,
    hash: String,
    href: String,
}

/// Each URL part escaped without decoding escapes already there, so a literal and an escaped delimiter stay apart.
fn url_text(value: &str, component: Option<&str>) -> String {
    let escaped = match component {
        Some("path") => "\"#<>?^`{}",
        Some("query") => "\"#<>'",
        Some("fragment") => "\"<>`",
        _ => "",
    };
    let mut text = String::new();
    for c in value.chars() {
        let code = c as u32;
        if code > 126 {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).bytes() {
                text.push_str(&format!("%{b:02X}"));
            }
        } else if code <= 32 || escaped.contains(c) {
            text.push_str(&format!("%{code:02X}"));
        } else {
            text.push(c);
        }
    }
    // Escapes upper-cased: "%2f" reads as "%2F". Everything past ASCII is escaped by now.
    let mut chars: Vec<char> = text.chars().collect();
    for i in 0..chars.len() {
        let hex = |at: usize| chars.get(at).is_some_and(char::is_ascii_hexdigit);
        if chars[i] == '%' && hex(i + 1) && hex(i + 2) {
            chars[i + 1] = chars[i + 1].to_ascii_uppercase();
            chars[i + 2] = chars[i + 2].to_ascii_uppercase();
        }
    }
    chars.into_iter().collect()
}

fn web_url(input: &str) -> Option<WebUrl> {
    let parsed = parse_url(input)?;
    if (parsed.scheme != "http" && parsed.scheme != "https")
        || parsed.host.is_empty()
        || parsed.host.contains(char::is_whitespace)
        || parsed.host.contains('\\')
    {
        return None;
    }
    if parsed.host.starts_with('[')
        && !(parsed.host.ends_with(']')
            && parsed.host[1..parsed.host.len() - 1]
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.'))
    {
        return None;
    }
    let port: Option<u32> = if parsed.port.is_empty() {
        None
    } else {
        Some(parsed.port.parse().ok()?)
    };
    if port.is_some_and(|p| p > 65535) {
        return None;
    }
    let protocol = format!("{}:", parsed.scheme);
    let hostname: String = parsed
        .host
        .nfc()
        .collect::<String>()
        .split('.')
        .map(|label| {
            if label.chars().any(|c| c as u32 > 127) {
                format!("xn--{}", punycode_encode(label))
            } else {
                label.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(".");
    let default_port = matches!(
        (protocol.as_str(), port),
        ("https:", Some(443)) | ("http:", Some(80))
    );
    let host = match port {
        Some(p) if !default_port => format!("{hostname}:{p}"),
        _ => hostname,
    };
    let raw_path = if parsed.path.is_empty() {
        "/".to_owned()
    } else {
        parsed.path.replace('\\', "/")
    };
    let parts: Vec<&str> = raw_path.split('/').collect();
    let mut segments: Vec<&str> = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        let dots = part.replace("%2e", ".").replace("%2E", ".");
        if dots == ".." {
            if segments.len() > 1 {
                segments.pop();
            }
        } else if dots != "." {
            segments.push(part);
        }
        if (dots == "." || dots == "..") && index == parts.len() - 1 {
            segments.push("");
        }
    }
    let joined = segments.join("/");
    let pathname = url_text(if joined.is_empty() { "/" } else { &joined }, Some("path"));
    let trimmed = input.trim();
    let authority = trimmed
        .find("://")
        .filter(|at| trimmed[..*at].chars().all(|c| c.is_ascii_alphabetic()))
        .map(|at| {
            let rest = &trimmed[at + 3..];
            &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())]
        })
        .unwrap_or("");
    let credentials = authority.rfind('@').map_or("", |at| &authority[..=at]);
    let query = url_text(&parsed.query, Some("query"));
    let hash = url_text(&parsed.hash, Some("fragment"));
    let href = format!(
        "{protocol}//{}{host}{pathname}{query}{hash}",
        url_text(credentials, Some("path"))
    );
    Some(WebUrl {
        protocol,
        host,
        pathname,
        query,
        hash,
        href,
    })
}

struct Pattern {
    protocol: Option<String>,
    host: String,
    path: Option<String>,
}

fn parse_pattern(input: &str, protocol: &str) -> Option<Pattern> {
    let value = input.trim();
    if value.is_empty() || value.contains(|c: char| c.is_whitespace() || "?#@\\".contains(c)) {
        return None;
    }
    let scheme = value
        .find("://")
        .filter(|at| {
            *at > 0
                && value[..*at]
                    .chars()
                    .all(|c| c.is_ascii_alphabetic() || c == '*')
        })
        .map(|at| &value[..at]);
    if scheme.is_some_and(|s| !s.eq_ignore_ascii_case("http") && !s.eq_ignore_ascii_case("https")) {
        return None;
    }
    let address = scheme.map_or(value, |s| &value[s.len() + 3..]);
    let slash = address.find('/');
    let host = slash.map_or(address, |at| &address[..at]);
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".*:[]-".contains(c))
    {
        return None;
    }
    let mut placeholder = "baywildcard".to_owned();
    while host.to_lowercase().contains(&placeholder) {
        placeholder.push('x');
    }
    let lead = scheme.map_or_else(|| protocol.to_owned(), |s| format!("{}:", s.to_lowercase()));
    let rest = slash.map_or("", |at| &address[at..]);
    let url = web_url(&format!(
        "{lead}//{}{rest}",
        host.replace('*', &placeholder)
    ))?;
    Some(Pattern {
        protocol: scheme.map(|s| format!("{}:", s.to_lowercase())),
        host: url.host.replace(&placeholder, "*"),
        path: slash.map(|_| url.pathname),
    })
}

/// Only `*` is special. Hosts are matched apart, so a path or query can't pass for a host.
fn glob(value: &str, pattern: &str) -> bool {
    let (v, p): (Vec<char>, Vec<char>) = (value.chars().collect(), pattern.chars().collect());
    let (mut at, mut pi, mut star, mut retry) = (0usize, 0usize, None::<usize>, 0usize);
    while at < v.len() {
        if p.get(pi) == Some(&'*') {
            star = Some(pi);
            pi += 1;
            retry = at;
        } else if pi < p.len() && p[pi] == v[at] {
            at += 1;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            retry += 1;
            at = retry;
        } else {
            return false;
        }
    }
    while p.get(pi) == Some(&'*') {
        pi += 1;
    }
    pi == p.len()
}

/// A pattern that can be saved, else what's wrong with it.
pub fn validate_link_pattern(
    pattern: &str,
    match_type: Option<LinkMatchType>,
) -> Option<&'static str> {
    match match_type {
        Some(kind) => {
            if pattern.trim().is_empty() || pattern.chars().any(|c| (c as u32) < 32 || c as u32 == 127) {
                return Some("Enter the URL or text to match.");
            }
            if kind == LinkMatchType::Contains || web_url(pattern.trim()).is_some() {
                return None;
            }
            Some("Enter a complete http:// or https:// URL, including its query string or fragment if needed.")
        }
        None => parse_pattern(pattern, "https:")
            .is_none()
            .then_some("Enter a host or path, such as github.com/acme/*. Use * as a wildcard; leave out query strings and fragments."),
    }
}

pub fn normalize_link_destination(input: &Value) -> Option<LinkDestination> {
    let kind = input.get("kind")?.as_str()?;
    match kind {
        "littleBay" => Some(LinkDestination::LittleBay),
        "mostRecentSpace" => Some(LinkDestination::MostRecentSpace),
        "newWindow" => Some(LinkDestination::NewWindow),
        "space" => {
            let space_id = input
                .get("spaceId")?
                .as_str()
                .filter(|s| !s.is_empty())?
                .to_owned();
            let sync = match input.get("syncProfileId") {
                None => None,
                Some(v) => Some(v.as_str().filter(|s| !s.is_empty())?.to_owned()),
            };
            Some(LinkDestination::Space {
                space_id,
                sync_profile_id: sync,
            })
        }
        _ => None,
    }
}

/// The settings' rules that are fine to use, in order, each id once.
pub fn normalize_external_link_rules(input: Option<&Value>) -> Vec<ExternalLinkRule> {
    let mut ids = HashSet::new();
    input
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|rule| {
            let id = rule.get("id")?.as_str().filter(|s| !s.is_empty())?;
            let pattern = rule.get("pattern")?.as_str()?;
            let match_type = match rule.get("matchType") {
                None => None,
                Some(Value::String(s)) if s == "contains" => Some(LinkMatchType::Contains),
                Some(Value::String(s)) if s == "equals" => Some(LinkMatchType::Equals),
                Some(_) => return None,
            };
            if validate_link_pattern(pattern, match_type).is_some() {
                return None;
            }
            let source_app = match rule.get("sourceApp") {
                None => None,
                Some(v) => Some(
                    v.as_str()
                        .filter(|s| {
                            !s.is_empty()
                                && s.chars().all(|c| c.is_alphanumeric() || "_.-".contains(c))
                        })?
                        .to_owned(),
                ),
            };
            let destination = normalize_link_destination(rule.get("destination")?)?;
            ids.insert(id.to_owned()).then(|| ExternalLinkRule {
                id: id.to_owned(),
                pattern: pattern.trim().to_owned(),
                match_type,
                source_app,
                destination,
            })
        })
        .collect()
}

/// The first rule an address (from `source_app`, if a link from another app) matches.
pub fn matching_link_rule<'a>(
    rules: &'a [ExternalLinkRule],
    address: &str,
    source_app: Option<&str>,
) -> Option<&'a ExternalLinkRule> {
    let url = web_url(address)?;
    rules.iter().find(|rule| {
        if let Some(app) = &rule.source_app
            && !source_app.is_some_and(|s| s.eq_ignore_ascii_case(app))
        {
            return false;
        }
        match rule.match_type {
            Some(LinkMatchType::Contains) => {
                url.href.contains(&url_text(&rule.pattern, None))
                    || url
                        .pathname
                        .contains(&url_text(&rule.pattern, Some("path")))
                    || url.query.contains(&url_text(&rule.pattern, Some("query")))
                    || url
                        .hash
                        .contains(&url_text(&rule.pattern, Some("fragment")))
                    || web_url(&rule.pattern).is_some_and(|prefix| url.href.contains(&prefix.href))
            }
            Some(LinkMatchType::Equals) => {
                web_url(&rule.pattern).is_some_and(|p| p.href == url.href)
            }
            None => parse_pattern(&rule.pattern, &url.protocol).is_some_and(|p| {
                p.protocol.as_ref().is_none_or(|x| *x == url.protocol)
                    && glob(&url.host.to_lowercase(), &p.host)
                    && p.path.as_ref().is_none_or(|path| glob(&url.pathname, path))
            }),
        }
    })
}
