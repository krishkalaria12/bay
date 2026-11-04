//! uBO's modifier options adblock-rust 0.13 doesn't know: its parser drops a whole rule for one unrecognised option.
//! This module lifts those rules out of the list before the engine sees them, and applies them itself:
//!
//! - `$urlskip=` follows a redirect tracker's own URL out of the request, as uBO's `urlskip.js` does (trusted
//!   `ublock-*` lists only). The result may be another origin, which the engine follows as the list intends.
//! - `$uritransform=/re/replacement/` rewrites a matching URL before it loads.
//! - `$removeparam` removes query parameters: a name, `~name`, `|prefix`, `/regex/`, or every parameter with no
//!   value. Its exceptions keep the parameters they name (or all of them when they name none).
//! - `$header=name[:value]` blocks a response whose headers match (wildcards and `/re/flags` values).
//! - `$ipaddress=` blocks a response from an address (literal, `*` wildcards or a regex).
//! - `$permissions=` adds a `Permissions-Policy` to a document's response.
//! - `$strict1p`/`$strict3p` ask that the request's hostname equal (or differ from) the document's hostname, which is
//!   stricter than adblock-rust's registrable-domain `$1p`.
//! - `$replace=/re/replacement/flags` replaces text in a response body before the renderer parses it.
//! - HTML filtering (`##^selector`) removes elements from an HTML response (`crate::html`), as uBO does.
//! - `$requestheader=name[:value]` blocks a request whose headers match, as `$header` does a response's.
//! - `$cname` exceptions lift a block found through a hostname's CNAME for the sites they name.
//! - `##^responseheader(name)` removes a header from a response for the matching site, and generic cosmetic
//!   exceptions (`#@#selector`) un-hide a selector on every site.

use std::sync::Mutex;

use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::Engine;
use base64::Engine as _;
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};

use crate::adapt::{is_not_network_rule, split_rule};
use crate::body;
use crate::html::{self, HtmlRules, HtmlSpec};
use crate::removeparam::is_type_option;

/// A rule's line as given, and whether its list may use trusted options (`$urlskip`).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    #[serde(default)]
    pub rules: Vec<RuleSpec>,
    #[serde(default)]
    pub response_headers: Vec<ResponseHeaderSpec>,
    #[serde(default)]
    pub cosmetic_exceptions: Vec<String>,
    /// `##^selector` HTML filters, in list order (uBO's HTML filtering engine).
    #[serde(default)]
    pub html_rules: Vec<HtmlSpec>,
    /// Plain `@@` exceptions, for `$header`/`$ipaddress` rules: uBO's header check treats one as
    /// an allow for the whole response. Kept in the main list too.
    #[serde(default)]
    pub exceptions: Vec<String>,
}

impl Spec {
    pub(crate) fn merge(&mut self, other: Spec) {
        self.rules.extend(other.rules);
        self.response_headers.extend(other.response_headers);
        self.cosmetic_exceptions.extend(other.cosmetic_exceptions);
        self.html_rules.extend(other.html_rules);
        self.exceptions.extend(other.exceptions);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSpec {
    pub line: String,
    pub trusted: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseHeaderSpec {
    pub domains: Vec<String>,
    pub names: Vec<String>,
    pub exception: bool,
}

/// A rule's actions, with the pattern and the options the engine still understands.
struct Rule {
    engine: Mutex<Engine>,
    exception: bool,
    types: Types,
    prefilter: Prefilter,
    strict_party: Option<bool>,
    urlskip: Option<UrlSkip>,
    transform: Option<Transform>,
    removeparam: Option<Prune>,
    /// The `$removeparam` or `$replace` option's value: uBO matches exceptions to blocks by it.
    value_key: String,
    header: Option<HeaderCheck>,
    ip: Option<IpCheck>,
    permissions: Option<String>,
    /// A `$replace` rule; `replace` is its directive, none on an exception (which names one by `value_key`).
    replaces: bool,
    /// `$replace=` in a response body, for text responses this request matches.
    replace: Option<TextReplace>,
    /// `$requestheader=`: the request is blocked when its headers match.
    request_header: Option<HeaderCheck>,
    /// A `$urlskip` exception, which names the skip it cancels by `value_key`, or all with none.
    urlskip_exception: bool,
    /// A `$cname` exception: blocks found through a CNAME don't apply to the documents it matches.
    cname: bool,
    /// `$important`: exceptions don't cancel it.
    important: bool,
    /// `$redirect=` on a rule with a response condition: the resource answering a response it blocks.
    stand_in: Option<String>,
    /// Blocks the request when it matches, unless a modifier redirects it first (`$urlskip`, a strict party rule).
    block: bool,
}

pub struct Modifiers {
    spec: Spec,
    rules: Vec<Rule>,
    /// Plain exceptions, as block rules: one matching means uBO's `matchHeaders` allows.
    exceptions: Mutex<Engine>,
    html: HtmlRules,
    /// The `$requestheader` rules: every request asks, so they aren't found by a scan of `rules`.
    request_header_rules: Vec<usize>,
}

/// What a response gets, and whether it is blocked.
#[derive(Default, Serialize)]
pub struct ResponseMatch {
    pub blocked: bool,
    /// What answers a blocked response in its place (`$redirect=` on a condition's rule): the resource's name here, its
    /// data URL from [`crate::Blocker::response`].
    pub stand_in: Option<String>,
    /// Response headers to add, in order.
    pub headers: Vec<(String, String)>,
    /// Response headers to remove, lowercased.
    pub removed_headers: Vec<String>,
}

type Bits = u16;

#[derive(Clone, Copy)]
struct Types(Bits);

impl Types {
    const DOCUMENT: Bits = 1 << 0;
    const SUBDOCUMENT: Bits = 1 << 1;
    const SCRIPT: Bits = 1 << 2;
    const IMAGE: Bits = 1 << 3;
    const STYLESHEET: Bits = 1 << 4;
    const OBJECT: Bits = 1 << 5;
    const XHR: Bits = 1 << 6;
    const PING: Bits = 1 << 7;
    const WEBSOCKET: Bits = 1 << 8;
    const MEDIA: Bits = 1 << 9;
    const FONT: Bits = 1 << 10;
    const OTHER: Bits = 1 << 11;
    const ALL: Bits = Self::DOCUMENT
        | Self::SUBDOCUMENT
        | Self::SCRIPT
        | Self::IMAGE
        | Self::STYLESHEET
        | Self::OBJECT
        | Self::XHR
        | Self::PING
        | Self::WEBSOCKET
        | Self::MEDIA
        | Self::FONT
        | Self::OTHER;

    fn from_kind(kind: &str) -> Self {
        Self(match kind {
            "document" | "doc" => Self::DOCUMENT,
            "subdocument" | "frame" => Self::SUBDOCUMENT,
            "script" => Self::SCRIPT,
            "image" => Self::IMAGE,
            "stylesheet" | "css" => Self::STYLESHEET,
            "object" => Self::OBJECT,
            "xmlhttprequest" | "xhr" => Self::XHR,
            "ping" | "beacon" => Self::PING,
            "websocket" => Self::WEBSOCKET,
            "media" => Self::MEDIA,
            "font" => Self::FONT,
            _ => Self::OTHER,
        })
    }

    fn allows(self, kind: &str) -> bool {
        self.0 & Self::from_kind(kind).0 != 0
    }
}

/// A cheap test before an engine lookup: most rules are anchored to a host that a URL either contains or not.
enum Prefilter {
    Always,
    Host(String),
    Contains(String),
}

impl Prefilter {
    fn matches(&self, url_lower: &str) -> bool {
        match self {
            Self::Always => true,
            Self::Host(host) | Self::Contains(host) => url_lower.contains(host),
        }
    }

    fn of(pattern: &str) -> Self {
        let pattern = pattern.trim();
        if let Some(host) = pattern.strip_prefix("||") {
            let host = host.split(['/', '^', '?', '|', '*']).next().unwrap_or("");
            if host.len() >= 3 && host.is_ascii() {
                return Self::Host(host.to_ascii_lowercase());
            }
            return Self::Always;
        }
        // A literal opening run (as in `/ads/banner`) narrows a rule that isn't host-anchored.
        let mut literal = String::new();
        for c in pattern.chars() {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '/' | '=') {
                literal.push(c.to_ascii_lowercase());
            } else {
                break;
            }
        }
        if literal.len() >= 6 && !pattern.starts_with('/') {
            Self::Contains(literal)
        } else {
            Self::Always
        }
    }
}

/// uBO's body filterer only rewrites text: `text/*` plus the listed application and audio types. Event streams are
/// left alone: buffering a stream that never ends would break it.
fn filterable_mime(mime: &str) -> bool {
    if mime == "text/event-stream" {
        return false;
    }
    mime.starts_with("text/")
        || matches!(
            mime,
            "application/dash+xml"
                | "application/javascript"
                | "application/json"
                | "application/mpegurl"
                | "application/vnd.api+json"
                | "application/vnd.apple.mpegurl"
                | "application/vnd.apple.mpegurl.audio"
                | "application/x-javascript"
                | "application/x-mpegurl"
                | "application/xhtml+xml"
                | "application/xml"
                | "audio/mpegurl"
                | "audio/x-mpegurl"
        )
}

/// A `Content-Type`'s MIME type, lowercased, without its parameters. Without one, uBO goes by the request's type.
fn body_mime(content_type: &str, kind: &str) -> String {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match (mime.is_empty(), kind) {
        (false, _) => mime,
        (true, "script") => "text/javascript".to_owned(),
        (true, "stylesheet") => "text/css".to_owned(),
        (true, _) => "text/plain".to_owned(),
    }
}

fn is_html(mime: &str) -> bool {
    matches!(mime, "text/html" | "application/xhtml+xml")
}

/// The URL a `$urlskip=...` rule extracts, step by step as uBO's `js/urlskip.js`.
struct UrlSkip {
    steps: Vec<Step>,
    allow_blocked: bool,
}

#[derive(Clone)]
enum Step {
    Param(String),
    ParamAt(usize),
    Hash,
    Regex(Pattern),
    Https,
    Base64,
    SafeBase64,
    UriComponent,
}

impl UrlSkip {
    fn parse(value: &str) -> Option<Self> {
        let mut steps = Vec::new();
        let mut allow_blocked = false;
        for step in value.split_whitespace() {
            match step {
                "#" => steps.push(Step::Hash),
                "+https" => steps.push(Step::Https),
                "-base64" => steps.push(Step::Base64),
                "-safebase64" => steps.push(Step::SafeBase64),
                "-uricomponent" => steps.push(Step::UriComponent),
                "-blocked" => allow_blocked = true,
                _ if step.starts_with('?') && step.len() > 1 => {
                    steps.push(Step::Param(step[1..].to_owned()))
                }
                _ if step.starts_with('&') => {
                    let index = step[1..].parse::<usize>().ok()?.checked_sub(1)?;
                    steps.push(Step::ParamAt(index));
                }
                _ if step.starts_with('/') => {
                    // uBO keeps everything between the first and last `/`, so a `/` inside the pattern needs no escape.
                    let pattern = step.strip_prefix('/')?.strip_suffix('/')?;
                    let re = compile_regex(pattern, "")?;
                    steps.push(Step::Regex(re));
                }
                _ => return None,
            }
        }
        (!steps.is_empty()).then_some(Self {
            steps,
            allow_blocked,
        })
    }

    fn apply(&self, url: &str) -> Option<String> {
        let mut out = url.to_owned();
        for step in &self.steps {
            out = match step {
                Step::Hash => out.split_once('#')?.1.to_owned(),
                Step::Param(name) => {
                    let (_, value) = query_params(&out)?
                        .into_iter()
                        .find(|(key, _)| key == name)?;
                    value.replace(' ', "%20")
                }
                Step::ParamAt(index) => query_params(&out)?.into_iter().nth(*index)?.0,
                Step::Regex(re) => re.capture(&out)?,
                Step::Https => {
                    let rest = out
                        .strip_prefix("https://")
                        .or_else(|| out.strip_prefix("http://"))
                        .unwrap_or(&out);
                    if has_other_scheme(rest) {
                        return None;
                    }
                    format!("https://{rest}")
                }
                Step::Base64 => decode_base64(&out, false)?,
                Step::SafeBase64 => decode_base64(&out, true)?,
                Step::UriComponent => percent_decode_str(&out).decode_utf8().ok()?.into_owned(),
            };
        }
        is_web_url(&out).then_some(out)
    }
}

struct Transform {
    re: Pattern,
    replacement: Template,
    global: bool,
}

impl Transform {
    /// `rule` is the rule's own pattern: `uritransform=//$1/` applies a regex rule's regex.
    fn parse(value: &str, rule: &str) -> Option<Self> {
        let (pattern, rest) = delimited(value, '/')?;
        // The replacement follows the pattern's closing slash, up to its own; a trailing `//`
        // is an empty replacement, and anything after the last slash are flags.
        let (replacement, flags) = if let Some(flags) = rest.strip_prefix('/') {
            ("", flags)
        } else {
            until(rest, '/')?
        };
        let pattern = if pattern.is_empty() {
            rule.strip_prefix('/')?.strip_suffix('/')?
        } else {
            pattern
        };
        Some(Self {
            re: compile_regex(pattern, flags)?,
            replacement: Template::parse(&replacements(replacement)),
            global: flags.contains('g'),
        })
    }

    fn apply(&self, url: &str) -> Option<String> {
        let rewritten = self.re.replace(url, &self.replacement, self.global)?;
        is_web_url(&rewritten).then_some(rewritten)
    }
}

/// A `$replace` value: a JS-style regex and its replacement. uBO applies one directive per matching rule, first match
/// only unless the regex has the `g` flag.
struct TextReplace {
    re: Pattern,
    replacement: Template,
    global: bool,
}

impl TextReplace {
    fn parse(value: &str) -> Option<Self> {
        let (pattern, rest) = delimited(value, '/')?;
        let (replacement, flags) = if let Some(flags) = rest.strip_prefix('/') {
            ("", flags)
        } else {
            until(rest, '/')?
        };
        if pattern.is_empty() {
            return None;
        }
        Some(Self {
            re: compile_regex(pattern, flags)?,
            replacement: Template::parse(&replacements(replacement)),
            global: flags.contains('g'),
        })
    }

    fn apply(&self, text: &str) -> Option<String> {
        self.re.replace(text, &self.replacement, self.global)
    }
}

/// One `$removeparam` value: every parameter, a name, a prefix, or a regex.
enum Prune {
    All,
    Name { name: String, not: bool },
    Regex { re: Pattern, not: bool },
}

impl Prune {
    fn parse(value: &str) -> Option<Self> {
        let value = value.trim();
        if value.is_empty() {
            return Some(Self::All);
        }
        let (not, value) = match value.strip_prefix('~') {
            Some(value) => (true, value),
            None => (false, value),
        };
        if let Some((pattern, flags)) = delimited(value, '/') {
            return Some(Self::Regex {
                re: compile_regex(pattern, flags)?,
                not,
            });
        }
        // A leading `|` is an old spelling of an anchored regex.
        if let Some(pattern) = value.strip_prefix('|') {
            return Some(Self::Regex {
                re: compile_regex(&format!("^{pattern}"), "i")?,
                not,
            });
        }
        // uBO does not support several values in one `$removeparam`.
        if value.contains('|') || value.is_empty() {
            return None;
        }
        Some(Self::Name {
            name: value.to_owned(),
            not,
        })
    }

    /// Whether a parameter is one this value would remove (or, for an exception, keep).
    fn matches(&self, key: &str, raw_value: &str) -> bool {
        match self {
            Self::All => true,
            Self::Name { name, not } => (key == name) != *not,
            // uBO tests the regex against `name=decodedValue` (percent-decoded, but `+` kept).
            Self::Regex { re, not } => {
                let value = percent_decode_str(raw_value).decode_utf8_lossy();
                re.is_match(&format!("{key}={value}")) != *not
            }
        }
    }
}

struct HeaderCheck {
    name: String,
    value: ValueCheck,
    not: bool,
}

enum ValueCheck {
    Empty,
    Literal(String),
    Regex(Pattern),
}

impl HeaderCheck {
    fn parse(value: &str) -> Option<Self> {
        let (name, rest) = value.split_once(':').unwrap_or((value, ""));
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() {
            return None;
        }
        let (not, rest) = match rest.strip_prefix('~') {
            Some(rest) => (true, rest),
            None => (false, rest),
        };
        let rest = rest.trim();
        if rest.is_empty() {
            return Some(Self {
                name,
                value: ValueCheck::Empty,
                not,
            });
        }
        if let Some((pattern, flags)) = delimited(rest, '/') {
            return Some(Self {
                name,
                value: ValueCheck::Regex(compile_regex(pattern, flags)?),
                not,
            });
        }
        let value = if rest.contains(['*', '?']) {
            ValueCheck::Regex(compile_glob(rest)?)
        } else {
            ValueCheck::Literal(rest.to_ascii_lowercase())
        };
        Some(Self { name, value, not })
    }

    fn matches(&self, headers: &[(String, String)]) -> bool {
        // uBO looks up the first header of that name, and a plain value is a substring test (it
        // becomes an unanchored, case-insensitive regex).
        let value = headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(&self.name))
            .map(|(_, value)| value.as_str());
        let Some(value) = value else {
            return self.not;
        };
        if matches!(self.value, ValueCheck::Empty) {
            return true;
        }
        let matched = match &self.value {
            ValueCheck::Empty => true,
            ValueCheck::Literal(literal) => value.to_ascii_lowercase().contains(literal),
            ValueCheck::Regex(re) => re.is_match(value),
        };
        matched != self.not
    }
}

enum IpCheck {
    Literal(String),
    Prefix(String),
    Lan,
    Loopback,
    Regex(Pattern),
}

impl IpCheck {
    fn parse(value: &str) -> Option<Self> {
        let value = value.trim();
        if let Some((pattern, flags)) = delimited(value, '/') {
            return Some(Self::Regex(compile_regex(pattern, flags)?));
        }
        match value {
            "" => None,
            "lan" => Some(Self::Lan),
            "loopback" => Some(Self::Loopback),
            // A trailing `*` is a prefix test; uBO doesn't give `?` a meaning here.
            _ if value.ends_with('*') => Some(Self::Prefix(value.trim_end_matches('*').to_owned())),
            _ if value.contains(['*', '?']) => None,
            _ => Some(Self::Literal(value.to_owned())),
        }
    }

    fn matches(&self, ip: &str) -> bool {
        match self {
            Self::Literal(literal) => ip == literal,
            Self::Prefix(prefix) => ip.starts_with(prefix),
            Self::Lan => is_lan(ip),
            Self::Loopback => ip == "127.0.0.1" || ip == "::1",
            Self::Regex(re) => re.is_match(ip),
        }
    }
}

/// uBO's `$ipaddress=lan`: the reserved addresses a local network uses.
fn is_lan(ip: &str) -> bool {
    if let Ok(address) = ip.parse::<std::net::IpAddr>() {
        return match address {
            std::net::IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
            std::net::IpAddr::V6(v6) => {
                v6.is_loopback()
                    || v6.is_unspecified()
                    || (v6.segments()[0] & 0xfe00) == 0xfc00
                    || v6
                        .to_ipv4_mapped()
                        .is_some_and(|v4| v4.is_private() || v4.is_loopback() || v4.is_link_local())
            }
        };
    }
    ip.starts_with("0.")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Action {
    UrlSkip,
    UriTransform,
    RemoveParam,
    Header,
    RequestHeader,
    IpAddress,
    Permissions,
    StrictParty,
    Replace,
    Cname,
}

impl Action {
    fn of(name: &str) -> Option<Self> {
        Some(match name {
            "urlskip" => Self::UrlSkip,
            "uritransform" => Self::UriTransform,
            "removeparam" => Self::RemoveParam,
            "header" | "responseheader" => Self::Header,
            "requestheader" => Self::RequestHeader,
            "ipaddress" => Self::IpAddress,
            "permissions" => Self::Permissions,
            "strict1p" | "strict-first-party" | "strict3p" | "strict-third-party" => {
                Self::StrictParty
            }
            "replace" => Self::Replace,
            "cname" => Self::Cname,
            _ => return None,
        })
    }
}

/// What [`extract`] took out of a list.
pub struct Extracted {
    /// The list without the rules this module handles.
    pub list: String,
    pub spec: Spec,
}

/// Lifts this module's rules out of a list, before the engine parses it. `trusted` is the list's scriptlet
/// permission: uBO only lets its own lists use `$urlskip`.
pub fn extract(list: &str, trusted: bool) -> Extracted {
    let mut extracted = Extracted {
        list: String::with_capacity(list.len()),
        spec: Spec::default(),
    };
    for line in list.lines() {
        let line = line.trim_end();
        if is_not_network_rule(line) {
            if let Some(selector) = line.strip_prefix("#@#") {
                // A generic exception (no host): adblock-rust rejects it, but it lifts a generic selector everywhere.
                if !selector.is_empty() && !selector.starts_with('^') {
                    extracted.spec.cosmetic_exceptions.push(selector.to_owned());
                    continue;
                }
            }
            if let Some(rule) = response_header_rule(line) {
                extracted.spec.response_headers.push(rule);
                continue;
            }
            if let Some(rule) = HtmlSpec::parse(line) {
                extracted.spec.html_rules.push(rule);
                continue;
            }
            extracted.list.push_str(line);
            extracted.list.push('\n');
            continue;
        }
        match modifier_actions(line) {
            Some(_) => {
                extracted.spec.rules.push(RuleSpec {
                    line: line.to_owned(),
                    trusted,
                });
                continue;
            }
            None => {
                if line.starts_with("@@") && is_plain_exception(line) {
                    extracted.spec.exceptions.push(line.to_owned());
                }
            }
        }
        extracted.list.push_str(line);
        extracted.list.push('\n');
    }
    extracted
}

/// Whether an exception is a general allow rule, the realm uBO's `matchHeaders` checks. An exception whose option
/// names another action (`$csp`, `$redirect`, `$generichide`…) only allows that action, not a response header block.
fn is_plain_exception(line: &str) -> bool {
    let Some(body) = line.strip_prefix("@@") else {
        return false;
    };
    let Some((_, options)) = split_rule(body) else {
        return true;
    };
    !options.iter().any(|option| {
        let name = option
            .trim_start_matches('~')
            .split('=')
            .next()
            .unwrap_or("")
            .trim();
        matches!(
            name,
            "csp"
                | "redirect"
                | "redirect-rule"
                | "generichide"
                | "ghide"
                | "elemhide"
                | "ehide"
                | "specifichide"
                | "shide"
                | "genericblock"
                | "badfilter"
        )
    })
}

/// The modifier options a network rule carries, if any.
fn modifier_actions(line: &str) -> Option<Vec<Action>> {
    let body = line.strip_prefix("@@").unwrap_or(line);
    let (_, options) = split_rule(body)?;
    let mut actions = Vec::new();
    for option in options {
        let name = option
            .trim_start_matches('~')
            .split('=')
            .next()
            .unwrap_or("")
            .trim();
        if let Some(action) = Action::of(name) {
            actions.push(action);
        }
    }
    (!actions.is_empty()).then_some(actions)
}

impl Modifiers {
    pub fn new(spec: Spec) -> Self {
        let rules: Vec<Rule> = spec.rules.iter().filter_map(parse_rule).collect();
        let exceptions = Mutex::new(build_exceptions(&spec.exceptions));
        let html = HtmlRules::new(spec.html_rules.clone());
        let request_header_rules = rules
            .iter()
            .enumerate()
            .filter(|(_, rule)| rule.request_header.is_some())
            .map(|(at, _)| at)
            .collect();
        Self {
            spec,
            rules,
            exceptions,
            html,
            request_header_rules,
        }
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
            && self.spec.response_headers.is_empty()
            && self.spec.cosmetic_exceptions.is_empty()
            && self.spec.exceptions.is_empty()
    }

    /// Whether [`Modifiers::response`] can change a response at all.
    pub fn has_response_rules(&self) -> bool {
        !self.spec.response_headers.is_empty()
            || self.rules.iter().any(|rule| {
                rule.header.is_some() || rule.ip.is_some() || rule.permissions.is_some()
            })
    }

    /// The resources `$redirect=` names on rules with a response condition.
    pub fn stand_ins(&self) -> impl Iterator<Item = &str> {
        self.rules
            .iter()
            .filter_map(|rule| rule.stand_in.as_deref())
    }

    /// Whether any `$requestheader` rule exists.
    pub fn has_request_header_rules(&self) -> bool {
        !self.request_header_rules.is_empty()
    }

    /// Whether a response body can be rewritten at all (`$replace`, HTML `##^`).
    pub fn has_body_rules(&self) -> bool {
        !self.html.is_empty()
            || self
                .rules
                .iter()
                .any(|rule| rule.replaces && !rule.exception)
    }

    /// Whether [`Modifiers::filter_body`] should see this response: uBO's body-filter gates plus a matching
    /// `$replace` or HTML rule. `status` is 0 when there is no response, and a partial response isn't a whole body.
    #[allow(clippy::too_many_arguments)]
    pub fn body_filter_applies(
        &self,
        url: &str,
        source: &str,
        kind: &str,
        method: &str,
        status: i32,
        content_type: &str,
        content_disposition: &str,
    ) -> bool {
        if matches!(status, 0 | 206)
            || host_of(url).is_empty()
            || !matches!(method, "GET" | "POST")
            || matches!(kind, "font" | "image" | "media" | "websocket")
            || !content_disposition.is_empty()
                && !content_disposition
                    .get(..6)
                    .is_some_and(|start| start.eq_ignore_ascii_case("inline"))
        {
            return false;
        }
        let mime = body_mime(content_type, kind);
        if !filterable_mime(&mime) {
            return false;
        }
        !self.replaces_for(url, source, kind, method).is_empty()
            || (is_html(&mime) && self.html.applies(&host_of(url)))
    }

    /// The response body after `$replace` and HTML `##^` filtering, or `None` when neither changed it.
    pub fn filter_body(
        &self,
        url: &str,
        source: &str,
        kind: &str,
        method: &str,
        content_type: &str,
        body: &[u8],
    ) -> Option<Vec<u8>> {
        let mime = body_mime(content_type, kind);
        if !filterable_mime(&mime) || body.len() > body::MAX_BODY {
            return None;
        }
        let encoding = body::charset(content_type, &mime, body)?;
        let (decoded, _, malformed) = encoding.decode(body);
        // Bytes the charset can't represent don't survive a round trip through a legacy charset.
        if malformed && encoding != encoding_rs::UTF_8 {
            return None;
        }
        let mut text = decoded.into_owned();
        let mut changed = false;
        for replace in self.replaces_for(url, source, kind, method) {
            if let Some(replaced) = replace.apply(&text) {
                text = replaced;
                changed = true;
            }
        }
        if is_html(&mime) {
            let host = host_of(url);
            if self.html.applies(&host) {
                let mut document = scraper::Html::parse_document(&text);
                if html::filter(&mut document, &self.html.for_host(&host)) {
                    text = document.html();
                    changed = true;
                }
            }
        }
        changed.then(|| body::encode(&text, encoding))
    }

    /// The `$replace` directives this request matches, in list order, less what exceptions cancel: one with no value
    /// cancels them all, one with a value its own directive, and neither an `$important` rule (uBO's
    /// `matchAndFetchModifiers`).
    fn replaces_for<'a>(
        &'a self,
        url: &str,
        source: &str,
        kind: &str,
        method: &str,
    ) -> Vec<&'a TextReplace> {
        let lower = url.to_ascii_lowercase();
        let source_host = host_of(source);
        let request_host = host_of(url);
        let request = Request::new(url, source, kind, method).ok();
        let matched: Vec<&Rule> = self
            .rules
            .iter()
            .filter(|rule| {
                rule.replaces
                    && rule.types.allows(kind)
                    && rule.prefilter.matches(&lower)
                    && matches_rule(rule, request.as_ref(), &source_host, &request_host)
            })
            .collect();
        let excepted: Vec<&str> = matched
            .iter()
            .filter(|rule| rule.exception)
            .map(|rule| rule.value_key.as_str())
            .collect();
        matched
            .iter()
            .filter(|rule| {
                !rule.exception
                    && (rule.important
                        || !excepted
                            .iter()
                            .any(|key| key.is_empty() || *key == rule.value_key))
            })
            .filter_map(|rule| rule.replace.as_ref())
            .collect()
    }

    /// The headers (lowercased) `$requestheader` rules would look at for this request; none for most requests.
    pub fn request_header_names(
        &self,
        url: &str,
        source: &str,
        kind: &str,
        method: &str,
    ) -> Vec<String> {
        let mut names: Vec<String> = self
            .request_header_rules_for(url, source, kind, method)
            .into_iter()
            .filter_map(|rule| Some(rule.request_header.as_ref()?.name.clone()))
            .collect();
        names.sort();
        names.dedup();
        names
    }

    /// Whether `$requestheader` blocks a request with these headers. An exception with the same condition or a plain
    /// one matching the request cancels the block, as for `$header`.
    pub fn request_headers_blocked(
        &self,
        url: &str,
        source: &str,
        kind: &str,
        method: &str,
        headers: &[(String, String)],
    ) -> bool {
        let mut blocked = false;
        for rule in self.request_header_rules_for(url, source, kind, method) {
            if !rule
                .request_header
                .as_ref()
                .is_some_and(|check| check.matches(headers))
            {
                continue;
            }
            if rule.exception {
                return false;
            }
            blocked = true;
        }
        blocked
            && !Request::new(url, source, kind, method).is_ok_and(|request| {
                self.exceptions
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .check_network_request(&request)
                    .should_block()
            })
    }

    fn request_header_rules_for(
        &self,
        url: &str,
        source: &str,
        kind: &str,
        method: &str,
    ) -> Vec<&Rule> {
        if self.request_header_rules.is_empty() {
            return Vec::new();
        }
        let lower = url.to_ascii_lowercase();
        let source_host = host_of(source);
        let request_host = host_of(url);
        let request = Request::new(url, source, kind, method).ok();
        self.request_header_rules
            .iter()
            .map(|&at| &self.rules[at])
            .filter(|rule| {
                rule.types.allows(kind)
                    && rule.prefilter.matches(&lower)
                    && matches_rule(rule, request.as_ref(), &source_host, &request_host)
            })
            .collect()
    }

    /// Whether a `$cname` exception covers this document (uBO's `shouldExceptCname`).
    pub fn cname_excepted(&self, document: &str) -> bool {
        let lower = document.to_ascii_lowercase();
        let host = host_of(document);
        let request = Request::new(document, document, "document", "GET").ok();
        self.rules.iter().any(|rule| {
            rule.cname
                && rule.prefilter.matches(&lower)
                && matches_rule(rule, request.as_ref(), &host, &host)
        })
    }

    pub fn cosmetic_exceptions(&self) -> &[String] {
        &self.spec.cosmetic_exceptions
    }

    pub fn spec(&self) -> &Spec {
        &self.spec
    }

    /// Applies URL transformations and request-time rules the main engine no longer sees. `blocked` is the engine's
    /// decision; `rewrite` is its `$removeparam` URL (usually none, since those rules live here). The returned bool is
    /// whether the replacement may cross origins.
    pub fn request(
        &self,
        url: &str,
        source: &str,
        kind: &str,
        method: &str,
        mut blocked: bool,
        rewrite: Option<String>,
    ) -> (bool, Option<String>, bool) {
        if self.rules.is_empty() {
            return (blocked, rewrite, false);
        }
        let lower = url.to_ascii_lowercase();
        let source_host = host_of(source);
        let request_host = host_of(url);
        let request = Request::new(url, source, kind, method).ok();

        // uBO applies a URI transform first, then the query prune, and only skips a URL when neither changed it.
        if !blocked {
            for rule in &self.rules {
                if rule.exception || !rule.types.allows(kind) || !rule.prefilter.matches(&lower) {
                    continue;
                }
                let Some(transform) = &rule.transform else {
                    continue;
                };
                if !matches_rule(rule, request.as_ref(), &source_host, &request_host) {
                    continue;
                }
                if let Some(rewritten) = transform.apply(url) {
                    let any_origin = !same_origin(url, &rewritten);
                    return (false, Some(rewritten), any_origin);
                }
            }
            let mut excepted: Vec<&str> = Vec::new();
            for rule in &self.rules {
                if !rule.exception || !rule.types.allows(kind) || !rule.prefilter.matches(&lower) {
                    continue;
                }
                if rule.removeparam.is_none() {
                    continue;
                }
                if matches_rule(rule, request.as_ref(), &source_host, &request_host) {
                    excepted.push(&rule.value_key);
                }
            }
            // uBO cancels each block whose value an exception names, and an exception with no
            // value cancels them all. A blanket `$removeparam` still removes everything, even
            // when an exception names one parameter.
            if !excepted.contains(&"") {
                let mut next = rewrite.clone();
                for rule in &self.rules {
                    if rule.exception || !rule.types.allows(kind) || !rule.prefilter.matches(&lower)
                    {
                        continue;
                    }
                    let Some(prune) = &rule.removeparam else {
                        continue;
                    };
                    if !matches_rule(rule, request.as_ref(), &source_host, &request_host) {
                        continue;
                    }
                    if excepted.contains(&rule.value_key.as_str()) {
                        continue;
                    }
                    if let Some(rewritten) = prune.apply(next.as_deref().unwrap_or(url)) {
                        next = Some(rewritten);
                    }
                }
                if next.is_some() {
                    let any_origin = next
                        .as_deref()
                        .is_some_and(|rewritten| !same_origin(url, rewritten));
                    return (false, next, any_origin);
                }
            }
        }

        // A `$urlskip` rule only redirects: a step that can't extract a URL leaves the request as
        // it is (uBO's urlSkip returns undefined, and the filter does nothing). uBO only skips the
        // resource types a navigation can be steered through, even if the rule names another.
        let skippable = matches!(
            kind,
            "document" | "subdocument" | "image" | "media" | "object" | "other"
        );
        for rule in &self.rules {
            if !skippable
                || rule.exception
                || !rule.types.allows(kind)
                || !rule.prefilter.matches(&lower)
            {
                continue;
            }
            let Some(skip) = &rule.urlskip else {
                continue;
            };
            if blocked && !skip.allow_blocked {
                continue;
            }
            if !matches_rule(rule, request.as_ref(), &source_host, &request_host) {
                continue;
            }
            let excepted = !rule.important
                && self.rules.iter().any(|exception| {
                    exception.urlskip_exception
                        && (exception.value_key.is_empty() || exception.value_key == rule.value_key)
                        && exception.types.allows(kind)
                        && exception.prefilter.matches(&lower)
                        && matches_rule(exception, request.as_ref(), &source_host, &request_host)
                });
            if excepted {
                continue;
            }
            if let Some(skipped_url) = skip.apply(url) {
                let any_origin = !same_origin(url, &skipped_url);
                return (false, Some(skipped_url), any_origin);
            }
        }

        // A rule whose only effect is its strict party constraint blocks like an ordinary block rule.
        let mut strict_blocked = false;
        let mut strict_excepted = false;
        for rule in &self.rules {
            if !rule.block || !rule.types.allows(kind) || !rule.prefilter.matches(&lower) {
                continue;
            }
            if !matches_rule(rule, request.as_ref(), &source_host, &request_host) {
                continue;
            }
            if rule.exception {
                strict_excepted = true;
            } else {
                strict_blocked = true;
            }
        }
        if strict_excepted {
            blocked = false;
        } else if strict_blocked {
            blocked = true;
        }
        (blocked, rewrite, false)
    }

    /// Applies response rules: `$header=`, `$ipaddress=`, `$permissions=` and `##^responseheader(...)`.
    /// A plain exception matching the request cancels `$header`/`$ipaddress` blocks, as uBO's `matchHeaders` does;
    /// a `$permissions` exception only omits its own value.
    pub fn response(
        &self,
        url: &str,
        source: &str,
        kind: &str,
        method: &str,
        ip: Option<&str>,
        headers: &[(String, String)],
    ) -> ResponseMatch {
        let mut matched = ResponseMatch::default();
        if self.rules.is_empty() && self.spec.response_headers.is_empty() {
            return matched;
        }
        let lower = url.to_ascii_lowercase();
        let source_host = host_of(source);
        let request_host = host_of(url);
        let host = request_host.clone();
        let request = Request::new(url, source, kind, method).ok();
        let excepted = request.as_ref().is_some_and(|request| {
            self.exceptions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .check_network_request(request)
                .should_block()
        });

        // ##^responseheader(name): a removable set, less the names (or the whole site) an exception keeps.
        let mut removed: Vec<String> = Vec::new();
        let mut header_exceptions: Vec<String> = Vec::new();
        let mut everything_excepted = false;
        for rule in &self.spec.response_headers {
            if !domain_list_matches(&rule.domains, &host) {
                continue;
            }
            if rule.exception {
                if rule.names.is_empty() {
                    everything_excepted = true;
                } else {
                    header_exceptions.extend(rule.names.iter().cloned());
                }
            } else {
                removed.extend(rule.names.iter().cloned());
            }
        }
        if !everything_excepted {
            removed.retain(|name| !name.is_empty() && !header_exceptions.contains(name));
            removed.sort();
            removed.dedup();
            matched.removed_headers = removed;
        }

        let mut permissions: Vec<String> = Vec::new();
        let mut header_blocked = false;
        let mut header_excepted = false;
        let mut ip_blocked = false;
        let mut ip_excepted = false;
        let mut stand_in = None;
        for rule in &self.rules {
            if !rule.types.allows(kind) || !rule.prefilter.matches(&lower) {
                continue;
            }
            if rule.header.is_none() && rule.ip.is_none() && rule.permissions.is_none() {
                continue;
            }
            if !matches_rule(rule, request.as_ref(), &source_host, &request_host) {
                continue;
            }
            // Every condition on the rule must hold: $header, $ipaddress and both together.
            let header_matched = rule
                .header
                .as_ref()
                .is_none_or(|check| check.matches(headers));
            let ip_matched = match (&rule.ip, ip) {
                (None, _) => true,
                // No address (an in-process or cached response): an address rule can't decide it.
                (Some(_), None) => false,
                (Some(check), Some(ip)) => check.matches(ip),
            };
            if !header_matched || !ip_matched {
                continue;
            }
            if !rule.exception && rule.stand_in.is_some() {
                stand_in = rule.stand_in.clone();
            }
            if rule.header.is_some() {
                if rule.exception {
                    header_excepted = true;
                } else {
                    header_blocked = true;
                }
            }
            if rule.ip.is_some() {
                if rule.exception {
                    ip_excepted = true;
                } else {
                    ip_blocked = true;
                }
            }
            if let Some(value) = &rule.permissions {
                if !rule.exception {
                    permissions.push(value.clone());
                }
            }
        }
        if !excepted && ((header_blocked && !header_excepted) || (ip_blocked && !ip_excepted)) {
            matched.blocked = true;
            matched.stand_in = stand_in;
        }
        if !permissions.is_empty() {
            matched
                .headers
                .push(("permissions-policy".to_owned(), permissions.join(", ")));
        }
        matched
    }
}

impl Prune {
    fn apply(&self, url: &str) -> Option<String> {
        let query_at = url.find('?')?;
        let fragment_at = url[query_at + 1..].find('#').map(|at| query_at + 1 + at);
        let end = fragment_at.unwrap_or(url.len());
        let query = &url[query_at + 1..end];
        if query.is_empty() {
            return None;
        }
        let mut kept: Vec<String> = Vec::new();
        let mut removed = false;
        for part in query.split('&') {
            let (key, raw_value) = part.split_once('=').unwrap_or((part, ""));
            if self.matches(key, raw_value) {
                removed = true;
            } else {
                kept.push(if raw_value.is_empty() {
                    key.to_owned()
                } else {
                    format!("{key}={raw_value}")
                });
            }
        }
        if !removed {
            return None;
        }
        let mut out = url[..query_at].to_owned();
        if !kept.is_empty() {
            out.push('?');
            out.push_str(&kept.join("&"));
        }
        if let Some(at) = fragment_at {
            out.push_str(&url[at..]);
        }
        Some(out)
    }
}

fn matches_rule(
    rule: &Rule,
    request: Option<&Request>,
    source_host: &str,
    request_host: &str,
) -> bool {
    if let Some(strict_first_party) = rule.strict_party {
        if (request_host == source_host) != strict_first_party {
            return false;
        }
    }
    let Some(request) = request else {
        return false;
    };
    let engine = rule
        .engine
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    engine.check_network_request(request).should_block()
}

fn parse_rule(spec: &RuleSpec) -> Option<Rule> {
    let line = spec.line.trim();
    let (exception, body) = match line.strip_prefix("@@") {
        Some(body) => (true, body),
        None => (false, line),
    };
    let (pattern, options) = split_rule(body)?;
    let mut kept: Vec<&str> = Vec::new();
    let mut types = Types(Types::ALL);
    let mut saw_type = false;
    let mut strict_party = None;
    let mut urlskip = None;
    let mut transform = None;
    let mut removeparam = None;
    let mut value_key = String::new();
    let mut header = None;
    let mut ip = None;
    let mut permissions = None;
    let mut replaces = false;
    let mut replace = None;
    let mut request_header = None;
    let mut urlskip_exception = false;
    let mut cname = false;
    let mut important = false;
    let mut stand_in = None;
    let mut modifiers = 0;
    let mut conditions = 0;
    let mut other_action = false;
    let mut drop = false;
    for option in options {
        let negated = option.starts_with('~');
        let bare = option.trim_start_matches('~');
        let (name, value) = bare.split_once('=').unwrap_or((bare, ""));
        let name = name.trim();
        if let Some(action) = Action::of(name) {
            match action {
                Action::Cname => {
                    // uBO only gives `$cname` a meaning on an exception.
                    cname = exception;
                    drop |= !exception;
                }
                Action::RequestHeader => {
                    conditions += 1;
                    request_header = HeaderCheck::parse(value);
                }
                Action::UrlSkip => {
                    // uBO only lets trusted lists use $urlskip and $uritransform; elsewhere it rejects the rule.
                    if !spec.trusted {
                        return None;
                    }
                    modifiers += 1;
                    value_key = value.trim().to_owned();
                    urlskip_exception = exception;
                    if !exception {
                        urlskip = UrlSkip::parse(value);
                    }
                }
                Action::UriTransform => {
                    if !spec.trusted {
                        return None;
                    }
                    modifiers += 1;
                    transform = Transform::parse(value, pattern);
                }
                Action::RemoveParam => {
                    modifiers += 1;
                    removeparam = Prune::parse(value);
                    value_key = value.trim().to_owned();
                }
                Action::Header => {
                    conditions += 1;
                    header = HeaderCheck::parse(value);
                }
                Action::IpAddress => {
                    conditions += 1;
                    ip = IpCheck::parse(value);
                }
                Action::Permissions => {
                    modifiers += 1;
                    permissions = Some(value.replace('|', ", "));
                }
                Action::Replace => {
                    modifiers += 1;
                    replaces = true;
                    value_key = value.trim().to_owned();
                    // An exception needs no directive of its own: it cancels by value, or all with none.
                    if !exception {
                        replace = Some(TextReplace::parse(value)?);
                    }
                }
                Action::StrictParty => {
                    strict_party = Some(name == "strict1p" || name == "strict-first-party")
                }
            }
            continue;
        }
        important |= name == "important";
        if name == "all" {
            saw_type = true;
            types.0 = Types::ALL;
            continue;
        }
        if is_type_option(name) {
            saw_type = true;
            let bit = Types::from_kind(name).0;
            if negated {
                types.0 &= !bit;
            } else {
                if types.0 == Types::ALL {
                    // The first positive type replaces the all-types default.
                    types.0 = 0;
                }
                types.0 |= bit;
            }
            kept.push(option);
            continue;
        }
        if matches!(name, "redirect" | "redirect-rule") && !value.is_empty() {
            // Only a response condition keeps it: the rule's own engine has no resources to redirect to.
            stand_in = Some((option, value.split(':').next().unwrap_or(value).to_owned()));
            continue;
        }
        if name == "csp" {
            other_action = true;
        }
        kept.push(option);
    }
    // uBO knows a request's address before it goes, so an address rule can redirect. A `$header` rule only cancels.
    if ip.is_none() || header.is_some() {
        if let Some((option, _)) = stand_in.take() {
            kept.push(option);
            other_action = true;
        }
    }
    if drop
        || modifiers > 1
        || (modifiers > 0 && other_action)
        || (conditions > 0 && (modifiers > 0 || other_action))
        || (request_header.is_some() && conditions > 1)
    {
        // uBO keeps one action per rule, and a response condition can't be evaluated at request
        // time, so a rule that combines them never applies. Drop it rather than give it a
        // meaning uBO doesn't.
        return None;
    }
    // uBO's strict party compares hostnames, not registrable domains, so the engine's party test must not run first.
    if strict_party.is_some() {
        kept.retain(|option| {
            !matches!(
                option.trim_start_matches('~'),
                "1p" | "3p" | "first-party" | "third-party" | "strict1p" | "strict3p"
            )
        });
    }
    // `$permissions` implicitly applies only to documents.
    if !saw_type && permissions.is_some() && header.is_none() && ip.is_none() {
        types = Types(Types::DOCUMENT | Types::SUBDOCUMENT);
    }
    let has_action = urlskip.is_some()
        || transform.is_some()
        || removeparam.is_some()
        || header.is_some()
        || ip.is_some()
        || permissions.is_some()
        || replaces
        || request_header.is_some()
        || urlskip_exception
        || cname;
    let block = strict_party.is_some() && !has_action;
    if !block && !has_action {
        return None;
    }
    let engine = build_engine(pattern, &kept, permissions.is_some())?;
    Some(Rule {
        engine: Mutex::new(engine),
        exception,
        types,
        prefilter: Prefilter::of(pattern),
        strict_party,
        urlskip,
        transform,
        removeparam,
        value_key,
        header,
        ip,
        permissions,
        replaces,
        replace,
        request_header,
        urlskip_exception,
        cname,
        important,
        stand_in: stand_in.map(|(_, name)| name),
        block,
    })
}

/// Plain exceptions as block rules: one matching a request means uBO's header check would allow it. An exception
/// without a type option also matches documents, as it does for uBO's request filtering.
fn build_exceptions(lines: &[String]) -> Engine {
    let mut list = String::with_capacity(lines.len() * 32);
    for line in lines {
        let Some(body) = line.trim().strip_prefix("@@") else {
            continue;
        };
        let Some((pattern, options)) = split_rule(body) else {
            list.push_str(body);
            list.push_str("$all\n");
            continue;
        };
        list.push_str(pattern);
        list.push('$');
        list.push_str(&options.join(","));
        if !options.iter().any(|option| is_type_option(option)) {
            list.push_str(",all");
        }
        list.push('\n');
    }
    let mut set = FilterSet::new(false);
    set.add_filter_list(list, ParseOptions::default());
    Engine::new_with_filter_set(set)
}

fn build_engine(pattern: &str, kept: &[&str], permissions: bool) -> Option<Engine> {
    let mut options: Vec<&str> = kept.to_vec();
    let typed = options
        .iter()
        .any(|option| is_type_option(option.trim_start_matches('~')));
    if !typed {
        if permissions {
            options.push("doc");
            options.push("frame");
        } else {
            options.push("all");
        }
    }
    let mut rule = if pattern.is_empty() {
        "*".to_owned()
    } else {
        pattern.to_owned()
    };
    if !options.is_empty() {
        rule.push('$');
        rule.push_str(&options.join(","));
    }
    let mut set = FilterSet::new(false);
    set.add_filter_list(rule, ParseOptions::default());
    Some(Engine::new_with_filter_set(set))
}

/// The text before the next unescaped delimiter, and what follows it.
fn until(text: &str, delimiter: char) -> Option<(&str, &str)> {
    let mut escaped = false;
    for (at, c) in text.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' => escaped = true,
            c if c == delimiter => return Some((&text[..at], &text[at + 1..])),
            _ => {}
        }
    }
    None
}

/// The text between `open` and the next unescaped `close`, and what follows the closing delimiter.
fn delimited(text: &str, delimiter: char) -> Option<(&str, &str)> {
    until(text.strip_prefix(delimiter)?, delimiter)
}

/// A regex as the lists write it. uBO's escaping of `/` and `,` is for its own parser, not the regex. Patterns with
/// lookaround or backreferences, which Rust's `regex` rejects, fall back to `fancy-regex` (uBO lists use a few for
/// `$removeparam`), and then to a JavaScript regex engine for the rest of JS's syntax.
#[derive(Clone)]
pub(crate) enum Pattern {
    Fast(regex::Regex),
    Fancy(fancy_regex::Regex),
    Regress(regress::Regex),
}

impl Pattern {
    pub(crate) fn new(pattern: &str, flags: &str) -> Option<Self> {
        let pattern = pattern.replace("\\/", "/").replace("\\,", ",");
        let (icase, multiline, dot_all) = (
            flags.contains('i'),
            flags.contains('m'),
            flags.contains('s'),
        );
        if let Ok(re) = regex::RegexBuilder::new(&pattern)
            .case_insensitive(icase)
            .multi_line(multiline)
            .dot_matches_new_line(dot_all)
            .build()
        {
            return Some(Self::Fast(re));
        }
        let inline: String = [(icase, 'i'), (multiline, 'm'), (dot_all, 's')]
            .into_iter()
            .filter_map(|(on, flag)| on.then_some(flag))
            .collect();
        let inline = if inline.is_empty() {
            pattern.clone()
        } else {
            format!("(?{inline}){pattern}")
        };
        if let Ok(re) = fancy_regex::Regex::new(&inline) {
            return Some(Self::Fancy(re));
        }
        let regress_flags = regress::Flags {
            icase,
            multiline,
            dot_all,
            unicode: flags.contains('u'),
            unicode_sets: flags.contains('v'),
            ..Default::default()
        };
        regress::Regex::with_flags(&pattern, regress_flags)
            .ok()
            .map(Self::Regress)
    }

    pub(crate) fn is_match(&self, text: &str) -> bool {
        match self {
            Self::Fast(re) => re.is_match(text),
            Self::Fancy(re) => re.is_match(text).unwrap_or(false),
            Self::Regress(re) => re.find(text).is_some(),
        }
    }

    /// The first capture group of the first match (uBO's `$urlskip` and `$uritransform` use it).
    fn capture(&self, text: &str) -> Option<String> {
        match self {
            Self::Fast(re) => re
                .captures(text)?
                .get(1)
                .map(|capture| capture.as_str().to_owned()),
            Self::Fancy(re) => re
                .captures(text)
                .ok()
                .flatten()?
                .get(1)
                .map(|capture| capture.as_str().to_owned()),
            Self::Regress(re) => {
                let found = re.find(text)?;
                let range = found.group(1)?;
                text.get(range).map(str::to_owned)
            }
        }
    }

    /// The text with the first (or every, with `all`) match replaced; none for an unchanged text, or one a pattern
    /// gave up on (`fancy-regex` stops at its backtracking limit).
    fn replace(&self, text: &str, template: &Template, all: bool) -> Option<String> {
        let limit = usize::from(!all);
        let replaced = match self {
            Self::Fast(re) => re
                .replacen(text, limit, |found: &regex::Captures<'_>| {
                    let groups = found.len() - 1;
                    let whole = found.get_match().range();
                    template.expand(
                        text,
                        whole,
                        groups,
                        |at| Some(found.get(at)?.range()),
                        |name| Some(found.name(name)?.range()),
                    )
                })
                .into_owned(),
            Self::Fancy(re) => re
                .try_replacen(text, limit, |found: &fancy_regex::Captures<'_, str>| {
                    let groups = found.len() - 1;
                    let whole = found.get(0).map_or(0..0, |whole| whole.range());
                    template.expand(
                        text,
                        whole,
                        groups,
                        |at| Some(found.get(at)?.range()),
                        |name| Some(found.name(name)?.range()),
                    )
                })
                .ok()?
                .into_owned(),
            Self::Regress(re) => {
                let mut out = String::with_capacity(text.len());
                let mut last = 0;
                for found in re.find_iter(text).take(if all { usize::MAX } else { 1 }) {
                    out.push_str(&text[last..found.start()]);
                    out.push_str(&template.expand(
                        text,
                        found.range(),
                        found.captures.len(),
                        |at| found.group(at),
                        |name| found.named_group(name),
                    ));
                    last = found.end();
                }
                out.push_str(&text[last..]);
                out
            }
        };
        (replaced != text).then_some(replaced)
    }
}

/// A JavaScript replacement string, which every regex engine here expands the same way: uBO hands these to
/// `String.replace`, and Rust's own syntax reads `$1abc` as a group called `1abc`.
struct Template(Vec<Part>);

enum Part {
    Text(String),
    /// `$1` to `$99`: the digits as written, as JS only reads a second digit that names a group.
    Group(usize, Option<usize>),
    Named(String),
    Whole,
    Before,
    After,
}

impl Template {
    fn parse(replacement: &str) -> Self {
        let mut parts = Vec::new();
        let mut text = String::new();
        let mut rest = replacement;
        while let Some(at) = rest.find('$') {
            text.push_str(&rest[..at]);
            let after = &rest[at + 1..];
            let mut chars = after.chars();
            let first = chars.next();
            let second = chars.next();
            let (part, used) = match (first, second) {
                (Some('$'), _) => {
                    text.push('$');
                    (None, 1)
                }
                (Some('&'), _) => (Some(Part::Whole), 1),
                (Some('`'), _) => (Some(Part::Before), 1),
                (Some('\''), _) => (Some(Part::After), 1),
                (Some('<'), _) if after.contains('>') => {
                    let end = after.find('>').unwrap_or(0);
                    (Some(Part::Named(after[1..end].to_owned())), end + 1)
                }
                (Some(digit), next) if digit.is_ascii_digit() => {
                    let tens = digit as usize - '0' as usize;
                    let ones = next.and_then(|c| c.to_digit(10)).map(|one| one as usize);
                    (
                        Some(Part::Group(tens, ones)),
                        1 + usize::from(ones.is_some()),
                    )
                }
                _ => {
                    text.push('$');
                    (None, 0)
                }
            };
            if let Some(part) = part {
                if !text.is_empty() {
                    parts.push(Part::Text(std::mem::take(&mut text)));
                }
                parts.push(part);
            }
            rest = &after[used..];
        }
        text.push_str(rest);
        if !text.is_empty() {
            parts.push(Part::Text(text));
        }
        Self(parts)
    }

    fn expand(
        &self,
        text: &str,
        whole: std::ops::Range<usize>,
        groups: usize,
        group: impl Fn(usize) -> Option<std::ops::Range<usize>>,
        named: impl Fn(&str) -> Option<std::ops::Range<usize>>,
    ) -> String {
        let slice = |range: Option<std::ops::Range<usize>>| {
            range.and_then(|range| text.get(range)).unwrap_or("")
        };
        let mut out = String::new();
        for part in &self.0 {
            match part {
                Part::Text(literal) => out.push_str(literal),
                Part::Whole => out.push_str(slice(Some(whole.clone()))),
                Part::Before => out.push_str(&text[..whole.start]),
                Part::After => out.push_str(&text[whole.end..]),
                Part::Named(name) => out.push_str(slice(named(name))),
                Part::Group(first, second) => {
                    let names_group = |at: &usize| (1..=groups).contains(at);
                    let two_digits = second.map(|second| first * 10 + second).filter(names_group);
                    if let Some(at) = two_digits {
                        out.push_str(slice(group(at)));
                        continue;
                    }
                    if names_group(first) {
                        out.push_str(slice(group(*first)));
                    } else {
                        // No such group: JS leaves the text as it was written.
                        out.push('$');
                        out.push_str(&first.to_string());
                    }
                    if let Some(second) = second {
                        out.push_str(&second.to_string());
                    }
                }
            }
        }
        out
    }
}

fn compile_regex(pattern: &str, flags: &str) -> Option<Pattern> {
    Pattern::new(pattern, flags)
}

fn compile_glob(value: &str) -> Option<Pattern> {
    let mut pattern = String::with_capacity(value.len() * 2);
    for c in value.chars() {
        match c {
            '*' => pattern.push_str(".*"),
            '?' => pattern.push_str(".?"),
            c => pattern.push_str(&regex::escape(&c.to_string())),
        }
    }
    Pattern::new(&pattern, "i")
}

fn replacements(value: &str) -> String {
    value
        .replace("\\/", "/")
        .replace("\\,", ",")
        .replace("\\$", "$")
}

fn query_params(url: &str) -> Option<Vec<(String, String)>> {
    let query_at = url.find('?')?;
    let end = url[query_at + 1..]
        .find('#')
        .map(|at| query_at + 1 + at)
        .unwrap_or(url.len());
    Some(
        url[query_at + 1..end]
            .split('&')
            .filter(|part| !part.is_empty())
            .map(|part| {
                let (key, value) = part.split_once('=').unwrap_or((part, ""));
                (form_decode(key), form_decode(value))
            })
            .collect(),
    )
}

fn form_decode(value: &str) -> String {
    let value = value.replace('+', " ");
    percent_decode_str(&value).decode_utf8_lossy().into_owned()
}

fn decode_base64(value: &str, safe: bool) -> Option<String> {
    let mut value: String = value
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| match c {
            '-' if safe => '+',
            '_' if safe => '/',
            c => c,
        })
        .collect();
    while !value.len().is_multiple_of(4) {
        value.push('=');
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value)
        .ok()?;
    String::from_utf8(bytes).ok()
}

fn has_other_scheme(value: &str) -> bool {
    let Some(colon) = value.find("://") else {
        return false;
    };
    colon > 0
        && value[..colon]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !value[..colon].eq_ignore_ascii_case("http")
        && !value[..colon].eq_ignore_ascii_case("https")
}

fn is_web_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://")) && !host_of(url).is_empty()
}

fn same_origin(a: &str, b: &str) -> bool {
    origin_of(a) == origin_of(b)
}

/// A URL's scheme, lowercased host and effective port: what makes two HTTP(S) URLs the same origin.
fn origin_of(url: &str) -> Option<(String, String, u16)> {
    let text = url.trim();
    let scheme_end = text.find("://")?;
    let scheme = text[..scheme_end].to_ascii_lowercase();
    let rest = &text[scheme_end + 3..];
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let mut authority = &rest[..authority_end];
    // User information isn't part of the origin.
    if let Some(at) = authority.rfind('@') {
        authority = &authority[at + 1..];
    }
    let (host, port) = if let Some(after_bracket) = authority.strip_prefix('[') {
        let (host, after) = after_bracket.split_once(']')?;
        (
            host,
            after.strip_prefix(':').and_then(|port| port.parse().ok()),
        )
    } else if let Some((host, port)) = authority.rsplit_once(':') {
        // A colon without a numeric port is part of an unbracketed IPv6 literal, which a URL
        // shouldn't have, but keep it as the host rather than splitting there.
        match port.parse::<u16>() {
            Ok(port) => (host, Some(port)),
            Err(_) => (authority, None),
        }
    } else {
        (authority, None)
    };
    let port = port.unwrap_or(match scheme.as_str() {
        "http" | "ws" => 80,
        "https" | "wss" => 443,
        _ => 0,
    });
    Some((scheme, host.to_ascii_lowercase(), port))
}

/// The lowercased host of a URL or origin ("" when it has none).
pub fn host_of(url: &str) -> String {
    let text = url.trim();
    let start = text.find("://").map(|at| at + 3).unwrap_or(0);
    let end = text[start..]
        .find(['/', '?', '#'])
        .map(|at| start + at)
        .unwrap_or(text.len());
    let mut authority = &text[start..end];
    if let Some(at) = authority.rfind('@') {
        authority = &authority[at + 1..];
    }
    if let Some(rest) = authority.strip_prefix('[') {
        authority = rest.split_once(']').map_or(rest, |(host, _)| host);
    } else if let Some((host, _)) = authority.split_once(':') {
        authority = host;
    }
    authority.to_ascii_lowercase()
}

fn response_header_rule(line: &str) -> Option<ResponseHeaderSpec> {
    let (exception, domains, name) = if let Some((domains, name)) = line.split_once("#@#^") {
        (true, domains, name)
    } else if let Some((domains, name)) = line.split_once("##^") {
        (false, domains, name)
    } else {
        return None;
    };
    let name = name.strip_prefix("responseheader(")?.strip_suffix(')')?;
    // uBO only lets these headers be removed: the ones a response can be steered by, without
    // touching the ones Chrome enforces itself.
    const REMOVABLE: [&str; 4] = ["location", "refresh", "report-to", "set-cookie"];
    let names: Vec<String> = name
        .split(',')
        .map(|name| name.trim().to_ascii_lowercase())
        .filter(|name| REMOVABLE.contains(&name.as_str()))
        .collect();
    if names.is_empty() {
        return None;
    }
    // A block rule with no site is meaningless; an exception without one lifts every site's removals.
    if !exception && domains.is_empty() {
        return None;
    }
    Some(ResponseHeaderSpec {
        domains: domains
            .split(',')
            .map(|domain| domain.trim().to_ascii_lowercase())
            .filter(|domain| !domain.is_empty())
            .collect(),
        names,
        exception,
    })
}

pub(crate) fn domain_list_matches(domains: &[String], host: &str) -> bool {
    let mut positive = false;
    let mut matched = false;
    for domain in domains {
        let (negated, domain) = match domain.strip_prefix('~') {
            Some(domain) => (true, domain),
            None => (false, domain.as_str()),
        };
        if domain_matches(domain, host) {
            if negated {
                return false;
            }
            matched = true;
        }
        positive |= !negated;
    }
    matched || !positive
}

fn domain_matches(domain: &str, host: &str) -> bool {
    if domain.is_empty() {
        return true;
    }
    if let Some(entity) = domain.strip_suffix(".*") {
        if !entity.contains(['*', '?']) {
            return entity_stem(host)
                .is_some_and(|stem| stem == entity || stem.ends_with(&format!(".{entity}")));
        }
    }
    if domain.contains(['*', '?']) {
        let mut pattern = String::from("^");
        for c in domain.chars() {
            match c {
                '*' => pattern.push_str(".*"),
                '?' => pattern.push('.'),
                c => pattern.push_str(&regex::escape(&c.to_string())),
            }
        }
        pattern.push('$');
        return regex::RegexBuilder::new(&pattern)
            .case_insensitive(true)
            .build()
            .is_ok_and(|re| re.is_match(host));
    }
    host == domain || host.ends_with(&format!(".{domain}"))
}

/// A hostname less its public suffix, which `example.*` in a list names: `www.example` for `www.example.co.uk`.
pub(crate) fn entity_stem(host: &str) -> Option<&str> {
    let suffix = psl::suffix_str(host)?;
    host.strip_suffix(suffix)?.strip_suffix('.')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn modifiers(lines: &str) -> Modifiers {
        Modifiers::new(extract(lines, true).spec)
    }

    fn request(blocker: &Modifiers, url: &str, kind: &str) -> (bool, Option<String>, bool) {
        blocker.request(url, "https://site.example/", kind, "GET", false, None)
    }

    #[test]
    fn wildcard_hosts_do_not_get_rejected_by_the_prefilter() {
        let rules = modifiers("||track.*.example^$removeparam=clickid\n");
        assert_eq!(
            request(
                &rules,
                "https://track.shop.example/?clickid=1&keep=2",
                "document"
            )
            .1,
            Some("https://track.shop.example/?keep=2".to_owned())
        );
        let rules = modifiers(
            "||track.shop.example^$removeparam=clickid\n\
             @@||track.*.example^$removeparam=clickid\n",
        );
        assert_eq!(
            request(
                &rules,
                "https://track.shop.example/?clickid=1&keep=2",
                "document"
            )
            .1,
            None
        );
        let rules = modifiers("||cdn.*.example^$script,header=server:nginx\n");
        assert!(
            rules
                .response(
                    "https://cdn.shop.example/a.js",
                    "https://site.example/",
                    "script",
                    "GET",
                    None,
                    &[("server".to_owned(), "nginx".to_owned())],
                )
                .blocked
        );
    }

    #[test]
    fn extracts_rules_the_engine_would_drop() {
        let extracted = extract(
            "||ads.example^\n\
             ||track.example/click$doc,urlskip=?url\n\
             ||remove.example/$doc,removeparam=/^utm_/\n\
             ||all.example/$removeparam\n\
             example.com##^responseheader(set-cookie)\n\
             #@#.ad\n",
            true,
        );
        assert_eq!(extracted.list, "||ads.example^\n");
        assert_eq!(extracted.spec.rules.len(), 3);
        assert_eq!(extracted.spec.response_headers.len(), 1);
        assert_eq!(extracted.spec.cosmetic_exceptions, [".ad"]);
    }

    #[test]
    fn follows_urlskip_steps() {
        let rules = modifiers(
            "||track.example/r$doc,urlskip=?url\n\
             ||encoded.example/r$doc,urlskip=/(aHR0c[^/]+)/ -base64\n\
             ||add.example/r$doc,urlskip=/\\/go\\/(example\\.com.*)/ +https\n",
        );
        assert_eq!(
            request(
                &rules,
                "https://track.example/r?url=https%3A%2F%2Fnews.example%2Fa%3Fb%3D1",
                "document"
            )
            .1,
            Some("https://news.example/a?b=1".to_owned())
        );
        assert_eq!(
            request(
                &rules,
                "https://encoded.example/r/aHR0cHM6Ly9uZXdzLmV4YW1wbGUvYQ",
                "document"
            )
            .1,
            Some("https://news.example/a".to_owned())
        );
        assert_eq!(
            request(&rules, "https://add.example/r/go/example.com/x", "document").1,
            Some("https://example.com/x".to_owned())
        );
    }

    #[test]
    fn urlskip_leaves_a_request_it_cannot_extract_and_is_trusted_only() {
        let rules = modifiers("||track.example^$doc,urlskip=?url\n");
        assert_eq!(
            request(&rules, "https://track.example/", "document"),
            (false, None, false)
        );
        // An untrusted list can't use $urlskip: uBO rejects the rule rather than blocking it.
        let spec = extract("||track.example^$doc,urlskip=?url\n", false).spec;
        let untrusted = Modifiers::new(spec);
        assert_eq!(
            untrusted.request(
                "https://track.example/?url=https%3A%2F%2Fnews.example%2F",
                "https://site.example/",
                "document",
                "GET",
                false,
                None
            ),
            (false, None, false)
        );
        let blocked = modifiers("||track.example^$doc,urlskip=?url -blocked\n");
        let (blocked, rewrite, any_origin) = blocked.request(
            "https://track.example/?url=https%3A%2F%2Fnews.example%2F",
            "https://track.example/",
            "document",
            "GET",
            true,
            None,
        );
        assert!(!blocked);
        assert_eq!(rewrite.as_deref(), Some("https://news.example/"));
        assert!(any_origin);
        // uBO only skips the resource types a page load can be steered through.
        let typed = modifiers("||track.example/r$urlskip=?url\n");
        assert_eq!(
            request(
                &typed,
                "https://track.example/r?url=https%3A%2F%2Fnews.example%2F",
                "script"
            ),
            (false, None, false)
        );
        assert_eq!(
            request(
                &typed,
                "https://track.example/r?url=https%3A%2F%2Fnews.example%2F",
                "image"
            )
            .1,
            Some("https://news.example/".to_owned())
        );
    }

    #[test]
    fn an_origin_includes_its_scheme_and_port() {
        assert!(same_origin(
            "https://example.com/a",
            "https://example.com:443/b"
        ));
        assert!(same_origin("http://example.com/", "http://example.com:80/"));
        assert!(!same_origin("http://example.com/", "https://example.com/"));
        assert!(!same_origin(
            "https://example.com:8443/",
            "https://example.com/"
        ));
        assert!(!same_origin("https://a.example/", "https://b.example/"));
    }

    #[test]
    fn transforms_a_uri_before_the_query_prune() {
        let rules = modifiers(
            "||shop.example/dp/*/ref=$doc,uritransform=/\\/ref=[^\\/?#]+//\n\
             ||replace.example/old$doc,uritransform=/old/new/g\n\
             ||prune.example^$doc,removeparam=/^utm_/\n\
             ||all.example^$doc,removeparam\n",
        );
        assert_eq!(
            request(&rules, "https://replace.example/old", "document").1,
            Some("https://replace.example/new".to_owned())
        );
        assert_eq!(
            request(&rules, "https://shop.example/dp/x/ref=abc?q=1", "document").1,
            Some("https://shop.example/dp/x?q=1".to_owned())
        );
        assert_eq!(
            request(
                &rules,
                "https://prune.example/?utm_source=x&keep=1",
                "document"
            )
            .1,
            Some("https://prune.example/?keep=1".to_owned())
        );
        assert_eq!(
            request(&rules, "https://all.example/?a=1&b=2", "document").1,
            Some("https://all.example/".to_owned())
        );
    }

    #[test]
    fn removeparam_names_regexes_and_exceptions() {
        let rules = modifiers(
            "$removeparam=/^utm_/\n\
             $removeparam=fbclid\n\
             @@||keep.example^$removeparam\n\
             @@||one.example^$removeparam=one\n",
        );
        assert_eq!(
            request(
                &rules,
                "https://site.example/?utm_source=x&fbclid=y&id=1",
                "document"
            )
            .1,
            Some("https://site.example/?id=1".to_owned())
        );
        let negated = modifiers("$removeparam=~keep\n");
        assert_eq!(
            request(&negated, "https://site.example/?keep=1&drop=2", "document").1,
            Some("https://site.example/?keep=1".to_owned())
        );
        assert!(request(
            &rules,
            "https://keep.example/?utm_source=x&fbclid=y",
            "document"
        )
        .1
        .is_none());
        assert_eq!(
            request(
                &rules,
                "https://one.example/?utm_source=x&fbclid=y&one=1",
                "document"
            )
            .1,
            Some("https://one.example/?one=1".to_owned())
        );
        // A pattern Rust's regex can't compile (a negative lookahead) still applies through fancy-regex.
        let lookahead =
            modifiers("||video.example/media$doc,removeparam=/^((?!formats|profile).)*$/\n");
        assert_eq!(
            request(
                &lookahead,
                "https://video.example/media?formats=mp4&profile=1&tracking=2",
                "document"
            )
            .1,
            Some("https://video.example/media?formats=mp4&profile=1".to_owned())
        );
    }

    #[test]
    fn removeparam_exceptions_cancel_matching_values_only() {
        let rules = modifiers(
            "$removeparam=utm_source\n\
             $removeparam=fbclid\n\
             @@||site.example^$removeparam=fbclid\n",
        );
        // A named exception cancels the block with the same value, and only that one.
        assert_eq!(
            request(
                &rules,
                "https://site.example/?utm_source=x&fbclid=y&id=1",
                "document"
            )
            .1,
            Some("https://site.example/?fbclid=y&id=1".to_owned())
        );
        // uBO's except-all cancels every removeparam block on the site.
        let all = modifiers("$removeparam=utm_source\n@@||site.example^$removeparam\n");
        assert!(
            request(&all, "https://site.example/?utm_source=x", "document")
                .1
                .is_none()
        );
        // A blanket block still removes everything: a named exception can't carve one parameter out.
        let blanket = modifiers("$removeparam\n@@||site.example^$removeparam=keep\n");
        assert_eq!(
            request(&blanket, "https://site.example/?keep=1&drop=2", "document").1,
            Some("https://site.example/".to_owned())
        );
    }

    #[test]
    fn matches_response_headers_addresses_and_permissions() {
        let rules = modifiers(
            "||cdn.example/script.js$script,header=server:/^openresty\\//\n\
             ||bad.example^$doc,ipaddress=185.100.85.248\n\
             *$doc,permissions=compute-pressure=()|idle-detection=()\n\
             stream.example##^responseheader(set-cookie)\n",
        );
        let headers = vec![("Server".to_owned(), "openresty/1.2".to_owned())];
        let response = rules.response(
            "https://cdn.example/script.js",
            "https://site.example/",
            "script",
            "GET",
            None,
            &headers,
        );
        assert!(response.blocked);
        let response = rules.response(
            "https://cdn.example/script.js",
            "https://site.example/",
            "script",
            "GET",
            None,
            &[("Server".to_owned(), "nginx".to_owned())],
        );
        assert!(!response.blocked);
        let response = rules.response(
            "https://bad.example/",
            "https://bad.example/",
            "document",
            "GET",
            Some("185.100.85.248"),
            &[],
        );
        assert!(response.blocked);
        let response = rules.response(
            "https://ok.example/",
            "https://ok.example/",
            "document",
            "GET",
            Some("1.1.1.1"),
            &[],
        );
        assert!(!response.blocked);
        assert_eq!(
            response.headers,
            [(
                "permissions-policy".to_owned(),
                "compute-pressure=(), idle-detection=()".to_owned()
            )]
        );
        let response = rules.response(
            "https://stream.example/",
            "https://stream.example/",
            "document",
            "GET",
            None,
            &[],
        );
        assert_eq!(response.removed_headers, ["set-cookie"]);
    }

    #[test]
    fn a_plain_exception_lifts_header_blocks_but_not_permissions() {
        let rules = modifiers(
            "||cdn.example^$script,header=server:nginx\n@@||cdn.example^\n\
             *$doc,permissions=compute-pressure=()\n",
        );
        let headers = [("Server".to_owned(), "nginx".to_owned())];
        assert!(
            !rules
                .response(
                    "https://cdn.example/a.js",
                    "https://site.example/",
                    "script",
                    "GET",
                    None,
                    &headers,
                )
                .blocked
        );
        let allowed = rules.response(
            "https://cdn.example/a.js",
            "https://site.example/",
            "script",
            "GET",
            None,
            &headers,
        );
        assert!(!allowed.blocked);
        let page = rules.response(
            "https://page.example/",
            "https://page.example/",
            "document",
            "GET",
            None,
            &[],
        );
        assert_eq!(
            page.headers,
            [(
                "permissions-policy".to_owned(),
                "compute-pressure=()".to_owned()
            )]
        );
        // A `$csp` exception allows that directive only; it is not the general allow uBO's header match checks.
        let realm = modifiers(
            "||cdn.example^$script,header=server:nginx\n\
             @@||cdn.example^$csp=script-src 'none'\n",
        );
        assert!(
            realm
                .response(
                    "https://cdn.example/a.js",
                    "https://site.example/",
                    "script",
                    "GET",
                    None,
                    &headers,
                )
                .blocked
        );
    }

    #[test]
    fn matches_the_first_header_value_and_both_conditions() {
        let rules = modifiers(
            "||cdn.example/a.js$script,header=via:google\n\
             ||later.example/a.js$script,header=via:nginx\n\
             ||both.example/a.js$script,header=server:nginx,ipaddress=1.2.3.4\n\
             ||prefix.example/a.js$script,ipaddress=10.0.0.*\n",
        );
        let headers = vec![
            ("Via".to_owned(), "cache, Google".to_owned()),
            ("Via".to_owned(), "nginx".to_owned()),
        ];
        assert!(
            rules
                .response(
                    "https://cdn.example/a.js",
                    "https://site.example/",
                    "script",
                    "GET",
                    None,
                    &headers,
                )
                .blocked
        );
        // uBO only reads the first header of that name, even when a later one would match.
        assert!(
            !rules
                .response(
                    "https://later.example/a.js",
                    "https://site.example/",
                    "script",
                    "GET",
                    None,
                    &headers,
                )
                .blocked
        );
        let headers = vec![("Server".to_owned(), "nginx".to_owned())];
        assert!(
            !rules
                .response(
                    "https://both.example/a.js",
                    "https://site.example/",
                    "script",
                    "GET",
                    Some("5.6.7.8"),
                    &headers,
                )
                .blocked
        );
        assert!(
            rules
                .response(
                    "https://both.example/a.js",
                    "https://site.example/",
                    "script",
                    "GET",
                    Some("1.2.3.4"),
                    &headers,
                )
                .blocked
        );
        assert!(
            rules
                .response(
                    "https://prefix.example/a.js",
                    "https://site.example/",
                    "script",
                    "GET",
                    Some("10.0.0.7"),
                    &[],
                )
                .blocked
        );
        assert!(
            !rules
                .response(
                    "https://prefix.example/a.js",
                    "https://site.example/",
                    "script",
                    "GET",
                    Some("110.0.0.7"),
                    &[],
                )
                .blocked
        );
    }

    #[test]
    fn drops_rules_whose_conditions_u_bo_cannot_evaluate() {
        // A response condition and a request-time modifier never meet in uBO, so it keeps neither.
        let spec = extract(
            "||mix.example^$doc,removeparam=x,header=server:nginx\n\
             ||redir.example^$script,redirect=noopjs,header=server:nginx\n",
            true,
        )
        .spec;
        assert!(Modifiers::new(spec).is_empty());
        // An untrusted uritransform is rejected as a whole, not applied.
        let spec = extract("||shop.example/ref$doc,uritransform=/ref/x/\n", false).spec;
        assert!(Modifiers::new(spec).is_empty());
    }

    #[test]
    fn strict_party_compares_hostnames_not_domains() {
        let strict1p = modifiers("||api.example/x$script,strict1p\n");
        assert_eq!(
            request(&strict1p, "https://api.example/x", "script"),
            (false, None, false)
        );
        let blocked = modifiers("||api.example/y$script,strict3p\n");
        assert_eq!(
            blocked.request(
                "https://api.example/y",
                "https://www.api.example/",
                "script",
                "GET",
                false,
                None
            ),
            (true, None, false)
        );
        let wildcard = modifiers("*$strict3p,ipaddress=0.0.0.0,domain=~0.0.0.0\n");
        assert_eq!(
            wildcard.request(
                "https://site.example/",
                "https://site.example/",
                "document",
                "GET",
                false,
                None
            ),
            (false, None, false)
        );
    }

    #[test]
    fn response_header_domains_cover_subdomains() {
        assert!(domain_matches("example.com", "www.example.com"));
        assert!(!domain_matches("example.com", "example.org"));
        assert!(!domain_list_matches(
            &["~a.example.com".to_owned()],
            "a.example.com"
        ));
        assert!(domain_list_matches(&[], "anything.example"));
    }

    #[test]
    fn replaces_text_in_a_response_body() {
        let rules = modifiers("||site.example^$replace=/openNewTab\\(\".*?\"\\)/null/g\n");
        assert!(rules.has_body_rules());
        assert!(rules.body_filter_applies(
            "https://site.example/app.js",
            "https://site.example/",
            "script",
            "GET",
            200,
            "application/javascript",
            "",
        ));
        assert!(!rules.body_filter_applies(
            "https://other.example/app.js",
            "https://other.example/",
            "script",
            "GET",
            200,
            "application/javascript",
            "",
        ));
        let body = b"openNewTab(\"a\");openNewTab(\"b\");";
        assert_eq!(
            rules
                .filter_body(
                    "https://site.example/app.js",
                    "https://site.example/",
                    "script",
                    "GET",
                    "application/javascript",
                    body,
                )
                .unwrap(),
            b"null;null;"
        );
    }

    #[test]
    fn html_filters_remove_elements_from_a_document() {
        let rules = modifiers(
            "site.example##^script:has-text(adserverDomain)\n\
             site.example##^script[data-cfasync]\n",
        );
        assert!(rules.has_body_rules());
        assert!(rules.body_filter_applies(
            "https://site.example/",
            "https://site.example/",
            "document",
            "GET",
            200,
            "text/html; charset=utf-8",
            "",
        ));
        assert!(!rules.body_filter_applies(
            "https://site.example/",
            "https://site.example/",
            "image",
            "GET",
            200,
            "text/html",
            "",
        ));
        let body = b"<html><head><script>var adserverDomain = 1;</script>\
                     <script data-cfasync>x()</script><script>keep()</script></head></html>";
        let filtered = rules
            .filter_body(
                "https://site.example/",
                "https://site.example/",
                "document",
                "GET",
                "text/html; charset=utf-8",
                body,
            )
            .unwrap();
        let text = String::from_utf8(filtered).unwrap();
        assert!(!text.contains("adserverDomain"));
        assert!(!text.contains("data-cfasync"));
        assert!(text.contains("keep()"));
    }

    #[test]
    fn body_filters_honour_methods_attachments_and_encodings() {
        let rules = modifiers("site.example##^script:has-text(ad)\n");
        let applies = |method: &str, status: i32, content_type: &str, disposition: &str| {
            rules.body_filter_applies(
                "https://site.example/",
                "https://site.example/",
                "document",
                method,
                status,
                content_type,
                disposition,
            )
        };
        assert!(applies("GET", 200, "text/html", ""));
        assert!(applies("POST", 200, "text/html; charset=utf-8", "inline"));
        assert!(!applies("PUT", 200, "text/html", ""));
        assert!(!applies("GET", 0, "text/html", ""));
        assert!(!applies("GET", 206, "text/html", ""));
        assert!(!applies("GET", 200, "text/html", "attachment; filename=x"));
        assert!(!applies("GET", 200, "image/png", ""));
        assert!(!applies("GET", 200, "text/event-stream", ""));
        assert!(rules
            .filter_body(
                "https://site.example/",
                "https://site.example/",
                "document",
                "GET",
                "text/html; charset=made-up",
                b"<script>ad</script>",
            )
            .is_none());
    }

    #[test]
    fn expands_replacements_as_javascript_does() {
        let rules = modifiers(concat!(
            "||one.example^$replace=/(a)(b)/$2$1x$$$&/\n",
            "||two.example^$replace=/(?<=a)b/[$&]/g\n",
            "||three.example^$replace=/a.b/z/s\n",
            "||four.example^$replace=/(?<n>a)/$<n>$9$/\n",
        ));
        let filter = |host: &str, body: &str| {
            let url = format!("https://{host}/");
            rules
                .filter_body(
                    &url,
                    &url,
                    "xmlhttprequest",
                    "GET",
                    "text/plain",
                    body.as_bytes(),
                )
                .map(|out| String::from_utf8(out).unwrap())
        };
        assert_eq!(filter("one.example", "ab").as_deref(), Some("bax$ab"));
        assert_eq!(filter("two.example", "ab ab").as_deref(), Some("a[b] a[b]"));
        assert_eq!(filter("three.example", "a\nb").as_deref(), Some("z"));
        assert_eq!(filter("four.example", "a").as_deref(), Some("a$9$"));
        assert_eq!(filter("one.example", "nothing"), None);
    }

    #[test]
    fn exceptions_cancel_replace_directives() {
        let rules = modifiers(concat!(
            "||a.example^$replace=/x/y/\n",
            "||a.example^$important,replace=/k/l/\n",
            "@@||a.example^$replace\n",
            "||b.example^$replace=/x/y/\n",
            "||b.example^$replace=/p/q/\n",
            "@@||b.example^$replace=/x/y/\n",
        ));
        let filter = |url: &str, body: &[u8]| {
            rules
                .filter_body(url, url, "xmlhttprequest", "GET", "text/plain", body)
                .map(|out| String::from_utf8(out).unwrap())
        };
        assert_eq!(filter("https://a.example/", b"xk").as_deref(), Some("xl"));
        assert_eq!(filter("https://b.example/", b"xp").as_deref(), Some("xq"));
    }

    #[test]
    fn request_header_rules_read_the_request() {
        let rules = modifiers(concat!(
            "||workers.dev/index.js$script,3p,requestheader=Cookie:*doubleclick.net*\n",
            "@@||allowed.workers.dev/index.js$script\n",
        ));
        let check = |url: &str, cookie: &str| {
            rules.request_headers_blocked(
                url,
                "https://site.example/",
                "script",
                "GET",
                &[("Cookie".to_owned(), cookie.to_owned())],
            )
        };
        assert_eq!(
            rules.request_header_names(
                "https://a.workers.dev/index.js",
                "https://site.example/",
                "script",
                "GET"
            ),
            ["cookie"]
        );
        assert!(rules
            .request_header_names(
                "https://a.workers.dev/other.js",
                "https://site.example/",
                "script",
                "GET"
            )
            .is_empty());
        assert!(check("https://a.workers.dev/index.js", "x=doubleclick.net"));
        assert!(!check("https://a.workers.dev/index.js", "x=fine"));
        assert!(!check(
            "https://allowed.workers.dev/index.js",
            "x=doubleclick.net"
        ));
    }

    #[test]
    fn cname_exceptions_name_documents() {
        let rules = modifiers("@@||site.example^$cname\n||blocked.example^$cname\n");
        assert!(rules.cname_excepted("https://www.site.example/page"));
        assert!(!rules.cname_excepted("https://blocked.example/"));
        assert!(!rules.cname_excepted("https://other.example/"));
    }

    #[test]
    fn uritransform_with_no_pattern_uses_the_rule_regex() {
        let rules = modifiers(r"/(.*\/play\?.*)%2Cad(.*)/$uritransform=//$1$2/");
        assert_eq!(
            request(&rules, "https://site.example/play?a=1%2Cad&b=2", "script")
                .1
                .as_deref(),
            Some("https://site.example/play?a=1&b=2")
        );
    }

    #[test]
    fn a_urlskip_exception_cancels_the_skip() {
        let rules = modifiers(concat!(
            "||skip.example/out$doc,urlskip=?url\n",
            "@@||skip.example/out?keep$doc,urlskip\n",
        ));
        let skip = |url: &str| request(&rules, url, "document").1;
        assert_eq!(
            skip("https://skip.example/out?url=https%3A%2F%2Fgo.example%2F").as_deref(),
            Some("https://go.example/")
        );
        assert_eq!(
            skip("https://skip.example/out?keep&url=https%3A%2F%2Fgo.example%2F"),
            None
        );
    }

    #[test]
    fn a_response_condition_keeps_its_stand_in() {
        let rules = modifiers("||site.example/a.js$script,redirect=noopjs:5,ipaddress=10.0.0.1\n");
        assert_eq!(rules.stand_ins().collect::<Vec<_>>(), ["noopjs"]);
        let answer = |ip: &str| {
            rules.response(
                "https://site.example/a.js",
                "https://site.example/",
                "script",
                "GET",
                Some(ip),
                &[],
            )
        };
        assert!(answer("10.0.0.1").blocked);
        assert_eq!(answer("10.0.0.1").stand_in.as_deref(), Some("noopjs"));
        assert!(!answer("10.0.0.2").blocked);
        assert_eq!(answer("10.0.0.2").stand_in, None);
    }

    #[test]
    fn entity_domains_ignore_the_public_suffix_and_subdomains() {
        assert!(domain_matches("example.*", "example.co.uk"));
        assert!(domain_matches("example.*", "www.example.com"));
        assert!(!domain_matches("example.*", "example.foo.com"));
        assert!(!domain_matches("example.*", "myexample.com"));
    }
}
