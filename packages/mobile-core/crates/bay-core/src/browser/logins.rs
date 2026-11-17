//! The saved-logins document: one JSON list of entries keyed per origin + username, most recent save last. What comes
//! from storage is untrusted, so everything is validated and repaired.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::Url;

use crate::js::trim;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct SavedLogin {
    /// Scheme + host (+ port) of the server that asked: the key a later challenge looks up by.
    pub origin: String,
    pub username: String,
    pub password: String,
    /// When it was saved (milliseconds since epoch).
    pub saved_at: f64,
}

fn login(value: &Value) -> Option<SavedLogin> {
    let entry = value.as_object()?;
    Some(SavedLogin {
        origin: trim(entry.get("origin")?.as_str()?).to_owned(),
        username: entry.get("username")?.as_str()?.to_owned(),
        password: entry.get("password")?.as_str()?.to_owned(),
        saved_at: entry.get("savedAt")?.as_f64()?,
    })
}

/// Reads the stored document: nothing for anything unparseable or malformed. Entries dedupe by origin + username, the
/// newest kept where the first stood.
#[uniffi::export]
pub fn parse_saved_logins(value: Option<String>) -> Vec<SavedLogin> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(&value) else {
        return Vec::new();
    };
    let Some(logins) = entries.iter().map(login).collect::<Option<Vec<_>>>() else {
        return Vec::new();
    };
    let mut by_key = IndexMap::new();
    for login in logins {
        if !login.origin.is_empty() && !login.username.is_empty() {
            by_key.insert(format!("{}\n{}", login.origin, login.username), login);
        }
    }
    by_key.into_values().collect()
}

/// The logins as the secure store keeps them, written as JavaScript writes them (a whole time without a fraction).
#[uniffi::export]
pub fn format_saved_logins(logins: Vec<SavedLogin>) -> String {
    let entries: Vec<Value> = logins
        .iter()
        .map(|login| {
            let saved_at = if login.saved_at.fract() == 0.0 && login.saved_at.abs() < 9.0e15 {
                json!(login.saved_at as i64)
            } else {
                json!(login.saved_at)
            };
            json!({
                "origin": login.origin,
                "username": login.username,
                "password": login.password,
                "savedAt": saved_at,
            })
        })
        .collect();
    Value::Array(entries).to_string()
}

/// The origin a page request belongs to, for later matching: scheme + host + port, or none when it isn't a web page.
#[uniffi::export]
pub fn origin_of(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|host| !host.is_empty()))
    .then(|| url.origin().ascii_serialization())
}
