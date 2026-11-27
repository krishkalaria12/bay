//! Bay's own pages: `bay://history`, and the engine's `chrome://` and `about:` names for them.

use super::{Pattern, pattern};

pub const APP_SCHEME: &str = "bay";

static APP_PREFIX: Pattern = Pattern::new(|| pattern(r"(?i)^(view-source:)?bay:(?://)?"));
static ENGINE_PREFIX: Pattern = Pattern::new(|| pattern(r"(?i)^(view-source:)?chrome:(?://)?"));
static ABOUT_PAGE: Pattern = Pattern::new(|| pattern(r"(?i)^about:(blank|srcdoc)([?#]|$)"));
static ABOUT_ALIAS: Pattern = Pattern::new(|| pattern(r"(?i)^about:([a-z][a-z0-9-]*)"));
static APP_URL: Pattern = Pattern::new(|| pattern(r"(?i)^bay://[^/?#]"));

struct Split {
    view_source: &'static str,
    host: String,
    rest: String,
}

fn split(url: &str, prefix: &regex::Regex) -> Option<Split> {
    let m = prefix.captures(url)?;
    let after = &url[m.get(0)?.end()..];
    let host_end = after.find(['/', '?', '#']).unwrap_or(after.len());
    Some(Split {
        view_source: if m.get(1).is_some() {
            "view-source:"
        } else {
            ""
        },
        host: after[..host_end].to_lowercase(),
        rest: after[host_end..].to_owned(),
    })
}

/// An app or engine page's address as Bay names it: `chrome://x` and `about:x` become `bay://x`.
pub fn to_app_url(url: &str) -> String {
    if let Some(parts) = split(url, &APP_PREFIX).or_else(|| split(url, &ENGINE_PREFIX)) {
        return if parts.host.is_empty() {
            url.to_owned()
        } else {
            format!(
                "{}{APP_SCHEME}://{}{}",
                parts.view_source, parts.host, parts.rest
            )
        };
    }
    if ABOUT_PAGE.is_match(url) {
        return url.to_owned();
    }
    match ABOUT_ALIAS.captures(url) {
        Some(about) => format!(
            "{APP_SCHEME}://{}{}",
            about[1].to_lowercase(),
            &url[about.get(0).map_or(0, |m| m.end())..]
        ),
        None => url.to_owned(),
    }
}

pub fn is_app_url(url: &str) -> bool {
    APP_URL.is_match(url)
}

/// `bay://<host>` for an app page's address.
pub fn app_url_origin(url: &str) -> Option<String> {
    let url = to_app_url(url);
    if !is_app_url(&url) {
        return None;
    }
    split(&url, &APP_PREFIX).map(|parts| format!("{APP_SCHEME}://{}", parts.host))
}
