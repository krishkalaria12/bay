//! The request type options adblock-rust knows (and uBO's aliases), shared with the modifier rules.

/// adblock-rust's request type options (and uBO's aliases), negated or not.
const TYPES: &[&str] = &[
    "document",
    "doc",
    "subdocument",
    "frame",
    "script",
    "image",
    "stylesheet",
    "css",
    "object",
    "xmlhttprequest",
    "xhr",
    "ping",
    "beacon",
    "websocket",
    "media",
    "font",
    "other",
    "popup",
    "object-subrequest",
    "webrtc",
];

/// Whether an option names a request type, as `script` or `~image`.
pub fn is_type_option(option: &str) -> bool {
    TYPES.contains(&option.trim_start_matches('~'))
}
