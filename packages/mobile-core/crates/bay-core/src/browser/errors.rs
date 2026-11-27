//! Plain words for an engine's load failure. Chromium's net:: codes (Android) and NSURLError descriptions (iOS) for the
//! failures people actually hit.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

/// Which failure it was, so the screen can say it in the reader's language: a `pageError.<id>` message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, uniffi::Enum)]
#[serde(rename_all = "camelCase")]
pub enum PageErrorId {
    Offline,
    NotFound,
    Timeout,
    Refused,
    Certificate,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum PageErrorKind {
    Offline,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, uniffi::Record)]
pub struct PageErrorText {
    pub kind: PageErrorKind,
    pub title: String,
    pub detail: String,
}

struct Known {
    pattern: Regex,
    id: PageErrorId,
    kind: PageErrorKind,
    title: &'static str,
    detail: &'static str,
}

fn known(
    pattern: &str,
    id: PageErrorId,
    kind: PageErrorKind,
    title: &'static str,
    detail: &'static str,
) -> Known {
    Known {
        pattern: Regex::new(&format!("(?i-u:{pattern})")).unwrap(),
        id,
        kind,
        title,
        detail,
    }
}

static KNOWN: LazyLock<[Known; 5]> = LazyLock::new(|| {
    use PageErrorId as Id;
    use PageErrorKind::{Error, Offline};
    [
        known(
            "INTERNET_DISCONNECTED|NETWORK_CHANGED|appears to be offline|network connection was lost",
            Id::Offline,
            Offline,
            "You're offline",
            "Check your connection and try again.",
        ),
        known(
            "NAME_NOT_RESOLVED|hostname could not be found",
            Id::NotFound,
            Error,
            "Can't find this site",
            "Check the address for typos.",
        ),
        known(
            "TIMED_OUT|timed out",
            Id::Timeout,
            Error,
            "This site took too long",
            "It may be busy or down. Try again in a moment.",
        ),
        known(
            "CONNECTION_REFUSED|ADDRESS_UNREACHABLE|could not connect to the server",
            Id::Refused,
            Error,
            "This site refused to connect",
            "It may be down, or blocked on this network.",
        ),
        known(
            "CERT|SSL|certificate|secure connection",
            Id::Certificate,
            Error,
            "This connection isn't private",
            "Bay stopped loading because the site's certificate isn't valid.",
        ),
    ]
});

fn find(message: &str) -> Option<&'static Known> {
    KNOWN.iter().find(|known| known.pattern.is_match(message))
}

/// Plain words for an engine's load failure; unknown failures keep the engine's message.
#[uniffi::export]
pub fn describe_page_error(message: &str) -> PageErrorText {
    match find(message) {
        Some(known) => PageErrorText {
            kind: known.kind,
            title: known.title.into(),
            detail: known.detail.into(),
        },
        None => PageErrorText {
            kind: PageErrorKind::Error,
            title: "Can't open this page".into(),
            detail: message.into(),
        },
    }
}

/// Which of the known failures a load failure is, or `Unknown` when none matches.
#[uniffi::export]
pub fn page_error_id(message: &str) -> PageErrorId {
    find(message).map_or(PageErrorId::Unknown, |known| known.id)
}
