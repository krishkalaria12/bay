//! Links from other apps: the page one opens, the page a `bay://share` link carries, and the `bay://` commands that
//! quick actions and widgets send.

use url::Url;

use crate::input::address::is_web_url;
use crate::js::trim;

/// The web page a link from another app (the default browser or a share target) opens: HTTP(S) with a host and no
/// credentials, canonicalised as typed addresses are. `bay://share` links carry the page in their `url` parameter and
/// are answered from it. Anything else (the dev client, mailto) is left alone.
#[uniffi::export]
pub fn incoming_link(value: Option<String>) -> Option<String> {
    let value = value.filter(|value| !value.is_empty())?;
    let url = trim(&value);
    if let Some(shared) = share_link(url) {
        return Some(shared);
    }
    if !is_web_url(url) {
        return None;
    }
    Url::parse(url).ok().map(Into::into)
}

/// The page a `bay://share` link carries, or none for any other form.
pub fn share_link(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    if parsed.scheme() != "bay" || host(&parsed) != "share" {
        return None;
    }
    let carried = parsed
        .query_pairs()
        .find(|(name, _)| name == "url")
        .map(|(_, value)| value.into_owned());
    incoming_link(carried)
}

/// The URL's `host` as JavaScript reports it: the host and any port.
fn host(url: &Url) -> String {
    match (url.host_str(), url.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_owned(),
        _ => String::new(),
    }
}

/// What a `bay://` command asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, uniffi::Enum)]
#[serde(rename_all = "kebab-case")]
pub enum BayCommand {
    NewTab,
    PrivateTab,
    Search,
    Voice,
}

/// What a `bay://` command asks for: exactly these hosts, and nothing with a path or query. Anything else (a stray
/// `bay:` address) is left alone.
#[uniffi::export]
pub fn bay_command(value: Option<String>) -> Option<BayCommand> {
    let value = value.filter(|value| !value.is_empty())?;
    let parsed = Url::parse(trim(&value)).ok()?;
    let path = parsed.path();
    if parsed.scheme() != "bay"
        || (!path.is_empty() && path != "/")
        || parsed.query().is_some_and(|query| !query.is_empty())
    {
        return None;
    }
    // Hosts are case-insensitive, and non-special schemes don't get normalised by the URL parser.
    match host(&parsed).to_lowercase().as_str() {
        "new-tab" => Some(BayCommand::NewTab),
        "private-tab" => Some(BayCommand::PrivateTab),
        "search" => Some(BayCommand::Search),
        "voice" => Some(BayCommand::Voice),
        _ => None,
    }
}
