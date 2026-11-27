//! Readers for what a browser keeps secret: Chromium's saved passwords, autofill (addresses, local cards) and cookies,
//! and Firefox's cookies. Each host unlocks the browser its own way (Keychain, DPAPI and app-bound keys, Secret Service,
//! the engine's own OSCrypt) and only that crosses in: macOS gives its unlocked `v10` key, and any value the key
//! doesn't open goes to the host's opener. A value no one opens is counted, not guessed at.

use std::collections::HashSet;
use std::path::Path;

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::crypto::decrypt_cbc;
use crate::failure::{Failure, Result};
use crate::readers::{Cancel, chromium_time};
use crate::snapshot::{
    Snapshot, column, integer, is_null, named_blob, named_integer, named_text, text,
};

/// Plain bytes the host's opener gave, wiped when they go.
pub type Plain = Zeroizing<Vec<u8>>;

/// Opens a sealed value the given key can't: `None` when the host can't either.
pub type Opener<'a> = &'a mut dyn FnMut(&[u8]) -> Option<Plain>;

/// Takes a card number or cookie value and answers its index (`{"secret": n}` in the answer).
pub type Sink<'a> = &'a mut dyn FnMut(&[u8]) -> usize;

/// Where card numbers and cookie values go: into the answer as text, or to a host that keeps them in memory it wipes,
/// one by one, so it never holds a copy it can't wipe.
pub struct Secrets<'a>(pub Option<Sink<'a>>);

impl Secrets<'_> {
    fn hand(&mut self, plain: &[u8]) -> Value {
        match &mut self.0 {
            Some(sink) => json!({"secret": sink(plain)}),
            None => json!(String::from_utf8_lossy(plain)),
        }
    }
}

/// How a reader opens Chromium's encrypted values: macOS's unlocked `v10` key, the host's opener, or both.
pub struct Unlock<'a> {
    pub key: Option<Plain>,
    /// macOS: a value without the `v10` prefix was saved before Chromium encrypted anything, and is the plain text.
    pub unsealed_is_plain: bool,
    pub opener: Option<Opener<'a>>,
}

impl Unlock<'_> {
    /// Whether anything could open a sealed value: without a key or an opener, a sealed value is locked, not bad.
    fn can_open(&self) -> bool {
        self.key.is_some() || self.opener.is_some()
    }

    /// A saved password: on macOS one without the `v10` prefix is its plain text.
    fn open_login(&mut self, value: &[u8]) -> Option<Plain> {
        if self.unsealed_is_plain && !value.starts_with(b"v10") && !value.starts_with(b"v20") {
            return Some(Zeroizing::new(value.to_vec()));
        }
        self.open(value)
    }

    /// A sealed value: `None` for app-bound (`v20`) values, which only the source browser can open, for anything
    /// nobody opened, and on macOS for anything but `v10`.
    fn open(&mut self, value: &[u8]) -> Option<Plain> {
        if value.starts_with(b"v20") || (self.unsealed_is_plain && !value.starts_with(b"v10")) {
            return None;
        }
        if let Some(key) = &self.key
            && value.starts_with(b"v10")
            && let Some(plain) = decrypt_cbc(value, key)
        {
            return Some(Zeroizing::new(plain));
        }
        self.opener.as_mut().and_then(|open| open(value))
    }
}

fn nonzero_time(micros: i64) -> Option<f64> {
    let time = chromium_time(micros);
    (time > 0.0).then_some(time)
}

/// A Chromium profile's saved passwords ("Login Data" and "Login Data For Account"):
/// `{"credentials": [...], "blocked": n}`, `blocked` counting the passwords nobody could open. A site and username
/// saved twice (once per file) is one credential.
pub fn chromium_logins(
    profile: &Path,
    unlock: &mut Unlock<'_>,
    cancel: Cancel<'_>,
) -> Result<Value> {
    let files: Vec<_> = ["Login Data", "Login Data For Account"]
        .iter()
        .map(|name| profile.join(name))
        .filter(|file| file.exists())
        .collect();
    if files.is_empty() {
        return Err(Failure::new(
            "notFound",
            "No saved passwords in this profile",
        ));
    }
    let mut credentials = Vec::new();
    let mut seen = HashSet::new();
    let mut blocked = 0;
    for file in files {
        let db = Snapshot::open(&file)?;
        if !db.table("logins")? {
            return Err(Failure::new("unreadable", "Login Data has no logins table"));
        }
        db.query("SELECT * FROM logins", |row| {
            cancel.check()?;
            if named_integer(row, "blacklisted_by_user") != 0
                || named_integer(row, "blocked_by_user") != 0
            {
                return Ok(true);
            }
            let sealed = named_blob(row, "password_value");
            if sealed.is_empty() {
                return Ok(true);
            }
            // A password that isn't text didn't really open.
            let Some(password) = unlock
                .open_login(&sealed)
                .filter(|plain| std::str::from_utf8(plain).is_ok())
            else {
                blocked += 1;
                return Ok(true);
            };
            if password.is_empty() {
                return Ok(true);
            }
            let realm = named_text(row, "signon_realm");
            let origin = named_text(row, "origin_url");
            let url = if origin.is_empty() {
                realm.clone()
            } else {
                origin
            };
            let username = named_text(row, "username_value");
            let identity = format!(
                "{}\0{username}",
                if realm.is_empty() { &url } else { &realm }
            );
            if !seen.insert(identity) {
                return Ok(true);
            }
            let mut credential = Map::new();
            credential.insert("url".into(), json!(url));
            credential.insert("username".into(), json!(username));
            credential.insert("password".into(), json!(String::from_utf8_lossy(&password)));
            if !realm.is_empty() {
                credential.insert("realm".into(), json!(realm));
            }
            for (from, to) in [("date_created", "created"), ("date_last_used", "lastUsed")] {
                if let Some(time) = nonzero_time(named_integer(row, from)) {
                    credential.insert(to.into(), json!(time));
                }
            }
            if column(row, "times_used").is_some() {
                credential.insert("timesUsed".into(), json!(named_integer(row, "times_used")));
            }
            credentials.push(Value::Object(credential));
            Ok(true)
        })?;
    }
    Ok(json!({"credentials": credentials, "blocked": blocked}))
}

/// Trimmed text, or `None` when nothing is left.
fn non_empty(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn join(parts: &[Option<&str>], separator: &str) -> Option<String> {
    let kept: Vec<String> = parts
        .iter()
        .flatten()
        .filter_map(|part| non_empty(part))
        .collect();
    (!kept.is_empty()).then(|| kept.join(separator))
}

#[derive(Default, PartialEq)]
struct Address {
    name: Option<String>,
    organization: Option<String>,
    street: Option<String>,
    city: Option<String>,
    state: Option<String>,
    postal_code: Option<String>,
    country: Option<String>,
    phone: Option<String>,
    email: Option<String>,
}

impl Address {
    fn fields(&self) -> [(&'static str, &Option<String>); 9] {
        [
            ("name", &self.name),
            ("organization", &self.organization),
            ("street", &self.street),
            ("city", &self.city),
            ("state", &self.state),
            ("postalCode", &self.postal_code),
            ("country", &self.country),
            ("phone", &self.phone),
            ("email", &self.email),
        ]
    }

    fn is_empty(&self) -> bool {
        self.fields().iter().all(|(_, value)| value.is_none())
    }

    fn to_json(&self) -> Value {
        let mut out = Map::new();
        for (name, value) in self.fields() {
            if let Some(value) = value {
                out.insert(name.into(), json!(value));
            }
        }
        Value::Object(out)
    }
}

/// Chromium FieldType values the address tables use.
mod field {
    pub const NAME_FIRST: i64 = 3;
    pub const NAME_LAST: i64 = 5;
    pub const NAME_FULL: i64 = 7;
    pub const EMAIL: i64 = 9;
    pub const PHONE: i64 = 14;
    pub const LINE1: i64 = 30;
    pub const LINE2: i64 = 31;
    pub const CITY: i64 = 33;
    pub const STATE: i64 = 34;
    pub const ZIP: i64 = 35;
    pub const COUNTRY: i64 = 36;
    pub const COMPANY: i64 = 60;
    pub const STREET: i64 = 77;
}

/// Addresses from a table of GUIDs and its table of typed values (Chromium 120 and later).
fn token_addresses(
    db: &Snapshot,
    table: &str,
    tokens: &str,
    cancel: Cancel<'_>,
) -> Result<Vec<(String, Address)>> {
    let mut values: std::collections::HashMap<String, std::collections::HashMap<i64, String>> =
        Default::default();
    db.query(&format!("SELECT guid, type, value FROM {tokens}"), |row| {
        cancel.check()?;
        if let Some(value) = non_empty(&text(row, 2)) {
            values
                .entry(text(row, 0))
                .or_default()
                .insert(crate::snapshot::integer(row, 1), value);
        }
        Ok(true)
    })?;
    let mut out = Vec::new();
    db.query(&format!("SELECT guid FROM {table} ORDER BY rowid"), |row| {
        let guid = text(row, 0);
        if let Some(fields) = values.get(&guid) {
            let get = |kind: i64| fields.get(&kind).cloned();
            let address = Address {
                name: get(field::NAME_FULL).or_else(|| {
                    join(
                        &[
                            fields.get(&field::NAME_FIRST).map(String::as_str),
                            fields.get(&field::NAME_LAST).map(String::as_str),
                        ],
                        " ",
                    )
                }),
                organization: get(field::COMPANY),
                street: get(field::STREET).or_else(|| {
                    join(
                        &[
                            fields.get(&field::LINE1).map(String::as_str),
                            fields.get(&field::LINE2).map(String::as_str),
                        ],
                        "\n",
                    )
                }),
                city: get(field::CITY),
                state: get(field::STATE),
                postal_code: get(field::ZIP),
                country: get(field::COUNTRY).map(|country| country.to_uppercase()),
                phone: get(field::PHONE),
                email: get(field::EMAIL),
            };
            out.push((guid, address));
        }
        Ok(true)
    })?;
    Ok(out)
}

/// Addresses from the older autofill_profiles tables, with their first name, email and phone.
fn legacy_addresses(db: &Snapshot, cancel: Cancel<'_>) -> Result<Vec<(String, Address)>> {
    let first_values = |table: &str,
                        value: &dyn Fn(&rusqlite::Row<'_>) -> Option<String>|
     -> Result<std::collections::HashMap<String, String>> {
        let mut out = std::collections::HashMap::new();
        if db.table(table)? {
            db.query(&format!("SELECT * FROM {table} ORDER BY rowid"), |row| {
                let guid = named_text(row, "guid");
                if !out.contains_key(&guid)
                    && let Some(value) = value(row)
                {
                    out.insert(guid, value);
                }
                Ok(true)
            })?;
        }
        Ok(out)
    };
    let names = first_values("autofill_profile_names", &|row| {
        non_empty(&named_text(row, "full_name")).or_else(|| {
            join(
                &[
                    Some(&named_text(row, "first_name")),
                    Some(&named_text(row, "middle_name")),
                    Some(&named_text(row, "last_name")),
                ]
                .map(|part| part.map(String::as_str)),
                " ",
            )
        })
    })?;
    let emails = first_values("autofill_profile_emails", &|row| {
        non_empty(&named_text(row, "email"))
    })?;
    let phones = first_values("autofill_profile_phones", &|row| {
        non_empty(&named_text(row, "number"))
    })?;
    let mut out = Vec::new();
    db.query("SELECT * FROM autofill_profiles ORDER BY rowid", |row| {
        cancel.check()?;
        let guid = named_text(row, "guid");
        let get = |name: &str| non_empty(&named_text(row, name));
        let address = Address {
            name: names.get(&guid).cloned(),
            organization: get("company_name"),
            street: get("street_address").or_else(|| {
                join(
                    &[
                        Some(named_text(row, "address_line_1").as_str()),
                        Some(named_text(row, "address_line_2").as_str()),
                    ],
                    "\n",
                )
            }),
            city: get("city"),
            state: get("state"),
            postal_code: get("zipcode"),
            country: get("country_code").map(|country| country.to_uppercase()),
            phone: phones.get(&guid).cloned(),
            email: emails.get(&guid).cloned(),
        };
        out.push((guid, address));
        Ok(true)
    })?;
    Ok(out)
}

/// A card number with its spaces and dashes taken out: 12 to 19 digits, or `None`.
fn card_number(plain: &[u8]) -> Option<Plain> {
    if !plain
        .iter()
        .all(|byte| byte.is_ascii_digit() || *byte == b' ' || *byte == b'-')
    {
        return None;
    }
    let digits: Plain = Zeroizing::new(plain.iter().copied().filter(u8::is_ascii_digit).collect());
    (12..=19).contains(&digits.len()).then_some(digits)
}

/// A Chromium profile's autofill ("Web Data"): `{"addresses": [...], "cards": [...], "blocked": n, "locked": n}`.
/// Server (masked) cards live in other tables and are never read. `blocked` counts the numbers that didn't open to a
/// card number, `locked` the ones nothing was given to open.
pub fn chromium_autofill(
    profile: &Path,
    unlock: &mut Unlock<'_>,
    secrets: &mut Secrets<'_>,
    cancel: Cancel<'_>,
) -> Result<Value> {
    let file = profile.join("Web Data");
    if !file.exists() {
        return Err(Failure::new("notFound", "No autofill data in this profile"));
    }
    let db = Snapshot::open(&file)?;
    let tables = [
        "credit_cards",
        "addresses",
        "local_addresses",
        "contact_info",
        "autofill_profiles",
    ];
    let mut any = false;
    for table in tables {
        any |= db.table(table)?;
    }
    if !any {
        return Err(Failure::new(
            "unreadable",
            "Web Data has no autofill tables",
        ));
    }
    let mut found = Vec::new();
    for (table, tokens) in [
        ("addresses", "address_type_tokens"),
        ("local_addresses", "local_addresses_type_tokens"),
        ("contact_info", "contact_info_type_tokens"),
    ] {
        if db.table(table)? && db.table(tokens)? {
            found.extend(token_addresses(&db, table, tokens, cancel)?);
        }
    }
    if db.table("autofill_profiles")? {
        found.extend(legacy_addresses(&db, cancel)?);
    }
    let mut guids = HashSet::new();
    let mut addresses: Vec<Address> = Vec::new();
    for (guid, address) in found {
        if guids.insert(guid) && !address.is_empty() && !addresses.contains(&address) {
            addresses.push(address);
        }
    }
    let mut out_cards = Vec::new();
    let mut blocked = 0;
    let mut locked = 0;
    if db.table("credit_cards")? {
        db.query("SELECT * FROM credit_cards", |row| {
            cancel.check()?;
            let sealed = named_blob(row, "card_number_encrypted");
            if sealed.is_empty() {
                return Ok(true);
            }
            if !unlock.can_open() {
                locked += 1;
                return Ok(true);
            }
            let Some(number) = unlock.open(&sealed).and_then(|plain| card_number(&plain)) else {
                blocked += 1;
                return Ok(true);
            };
            let mut card = Map::new();
            card.insert("number".into(), secrets.hand(&number));
            for (from, to) in [("name_on_card", "name"), ("nickname", "nickname")] {
                if let Some(value) = non_empty(&named_text(row, from)) {
                    card.insert(to.into(), json!(value));
                }
            }
            let month = named_integer(row, "expiration_month");
            if (1..=12).contains(&month) {
                card.insert("expMonth".into(), json!(month));
            }
            let year = named_integer(row, "expiration_year");
            if year > 0 {
                card.insert(
                    "expYear".into(),
                    json!(if year < 100 { 2000 + year } else { year }),
                );
            }
            out_cards.push(Value::Object(card));
            Ok(true)
        })?;
    }
    Ok(json!({
        "addresses": addresses.iter().map(Address::to_json).collect::<Vec<_>>(),
        "cards": out_cards,
        "blocked": blocked,
        "locked": locked,
    }))
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%'
            && let Some(hex) = text.get(at + 1..at + 3)
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            at += 3;
            continue;
        }
        out.push(bytes[at]);
        at += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `(https,example.com[,port])` as Chromium's top-level site (`https://example.com`; a schemeful site has no port).
fn partition_site(key: &str) -> Option<String> {
    let inner = key.strip_prefix('(')?.strip_suffix(')')?;
    let fields: Vec<&str> = inner.split(',').collect();
    if !(2..=3).contains(&fields.len()) || !matches!(fields[0], "https" | "http") {
        return None;
    }
    if fields.len() == 3
        && !fields[2]
            .parse::<u32>()
            .is_ok_and(|port| (1..=65535).contains(&port))
    {
        return None;
    }
    let host = fields[1].to_lowercase();
    let allowed =
        |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-' | '_');
    if host.is_empty() || host.starts_with('.') || host.ends_with('.') || !host.chars().all(allowed)
    {
        return None;
    }
    Some(format!("{}://{host}", fields[0]))
}

/// An originAttributes suffix such as `^partitionKey=%28https%2Cexample.com%29&userContextId=2`: whether the cookie
/// belongs to a jar Chromium has no equivalent for (containers, private browsing, first-party isolation, a partition
/// key that isn't a top-level site), and its partition.
fn origin_attributes(suffix: &str) -> (bool, Option<String>) {
    let mut isolated = false;
    let mut partition = None;
    for pair in suffix
        .strip_prefix('^')
        .unwrap_or(suffix)
        .split('&')
        .filter(|pair| !pair.is_empty())
    {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = percent_decode(value);
        match key {
            // Malformed: don't guess which jar it belongs to.
            "" => isolated = true,
            "userContextId" | "privateBrowsingId" => isolated |= !value.is_empty() && value != "0",
            "firstPartyDomain" | "geckoViewSessionContextId" => isolated |= !value.is_empty(),
            "partitionKey" => match partition_site(&value) {
                Some(site) => partition = Some(site),
                None => isolated = true,
            },
            _ => {}
        }
    }
    (isolated, partition)
}

/// nsICookie: SAMESITE_NONE 0, LAX 1, STRICT 2, UNSET 256. Older Firefox kept what the site sent in rawSameSite; a
/// differing value means Firefox applied its own default. NONE also meant "not set" in older Firefox, and Chromium
/// rejects SameSite=None without Secure, so an insecure NONE is unspecified.
fn same_site(value: i64, raw: Option<i64>, secure: bool) -> &'static str {
    if raw.is_some_and(|raw| raw != value) {
        return "unspecified";
    }
    match value {
        0 if secure => "none",
        1 => "lax",
        2 => "strict",
        _ => "unspecified",
    }
}

/// A Firefox profile's cookies.sqlite (plaintext on disk): `{"cookies": [...], "skipped": n}`, `skipped`
/// counting the ones from jars Chromium has no equivalent for. Expired cookies are left out.
pub fn firefox_cookies(
    database: &Path,
    secrets: &mut Secrets<'_>,
    now_ms: f64,
    cancel: Cancel<'_>,
) -> Result<Value> {
    let db = Snapshot::open(database)?;
    if !db.table("moz_cookies")? {
        return Err(Failure::new("unreadable", "cookies.sqlite has no cookies"));
    }
    let mut cookies = Vec::new();
    let mut skipped = 0;
    db.query("SELECT * FROM moz_cookies", |row| {
        cancel.check()?;
        let (Some(host_at), Some(name_at)) = (column(row, "host"), column(row, "name")) else {
            return Ok(true);
        };
        if crate::snapshot::is_null(row, host_at) || crate::snapshot::is_null(row, name_at) {
            return Ok(true);
        }
        let (isolated, partition) = origin_attributes(&named_text(row, "originAttributes"));
        if isolated {
            skipped += 1;
            return Ok(true);
        }
        // Older Firefox stored expiry in seconds, newer in milliseconds.
        let expiry = named_integer(row, "expiry");
        let expires = if expiry > 100_000_000_000 {
            expiry as f64
        } else {
            expiry as f64 * 1000.0
        };
        if expires > 0.0 && expires < now_ms {
            return Ok(true);
        }
        let secure = named_integer(row, "isSecure") != 0;
        let scheme_map = named_integer(row, "schemeMap");
        let path = named_text(row, "path");
        let raw = column(row, "rawSameSite").map(|at| crate::snapshot::integer(row, at));
        let mut cookie = Map::new();
        cookie.insert("domain".into(), json!(text(row, host_at)));
        cookie.insert("name".into(), json!(text(row, name_at)));
        let value = Zeroizing::new(named_blob(row, "value"));
        cookie.insert("value".into(), secrets.hand(&value));
        cookie.insert(
            "path".into(),
            json!(if path.is_empty() {
                "/".to_owned()
            } else {
                path
            }),
        );
        cookie.insert("secure".into(), json!(secure));
        cookie.insert(
            "httpOnly".into(),
            json!(named_integer(row, "isHttpOnly") != 0),
        );
        cookie.insert(
            "sameSite".into(),
            json!(same_site(named_integer(row, "sameSite"), raw, secure)),
        );
        cookie.insert("priority".into(), json!("medium"));
        cookie.insert(
            "sourceScheme".into(),
            json!(if scheme_map & 2 != 0 {
                "secure"
            } else if scheme_map & 1 != 0 {
                "nonSecure"
            } else {
                "unset"
            }),
        );
        cookie.insert("sourcePort".into(), json!(-1));
        if let Some(site) = partition {
            cookie.insert(
                "partitionKey".into(),
                json!({"topLevelSite": site, "crossSite": false}),
            );
        }
        if expires > 0.0 {
            cookie.insert("expires".into(), json!(expires));
        }
        for (from, to) in [("creationTime", "created"), ("lastAccessed", "lastAccess")] {
            let micros = named_integer(row, from);
            if micros > 0 {
                cookie.insert(to.into(), json!(micros as f64 / 1000.0));
            }
        }
        cookies.push(Value::Object(cookie));
        Ok(true)
    })?;
    Ok(json!({"cookies": cookies, "skipped": skipped}))
}

/// A WebKit-epoch time in microseconds as Unix milliseconds, unrounded (a cookie's times are to the microsecond).
fn webkit_time(micros: i64) -> Option<f64> {
    (micros > 0).then(|| (micros - 11_644_473_600_000_000) as f64 / 1000.0)
}

fn chromium_same_site(value: Option<i64>) -> &'static str {
    match value {
        Some(0) => "none",
        Some(1) => "lax",
        Some(2) => "strict",
        _ => "unspecified",
    }
}

/// A Chromium profile's Cookies database: `{"cookies": [...], "blocked": n}`, `blocked` counting the values nobody
/// could open (and rows with both a plain and a sealed value, which Chromium rejects). Expired cookies are left out.
/// From version 24 every sealed value starts with SHA-256 of its host, which is checked and taken off.
pub fn chromium_cookies(
    database: &Path,
    unlock: &mut Unlock<'_>,
    secrets: &mut Secrets<'_>,
    now_ms: f64,
    cancel: Cancel<'_>,
) -> Result<Value> {
    let db = Snapshot::open(database)?;
    if !db.table("cookies")? {
        return Err(Failure::new("unreadable", "Cookies has no cookies table"));
    }
    let mut version = 0;
    if db.table("meta")? {
        db.query(
            "SELECT CAST(value AS INTEGER) FROM meta WHERE key='version'",
            |row| {
                version = integer(row, 0);
                Ok(false)
            },
        )?;
    }
    let host_hashed = version >= 24;
    let mut cookies = Vec::new();
    let mut blocked = 0;
    db.query("SELECT * FROM cookies", |row| {
        cancel.check()?;
        let (Some(host_at), Some(name_at)) = (column(row, "host_key"), column(row, "name")) else {
            return Ok(true);
        };
        if is_null(row, host_at) || is_null(row, name_at) {
            return Ok(true);
        }
        let host = text(row, host_at);
        let number = |name: &str| column(row, name).filter(|at| !is_null(row, *at)).map(|at| integer(row, at));
        // Columns were renamed over the years (secure → is_secure, persistent → is_persistent → has_expires).
        let flag = |names: &[&str]| names.iter().find_map(|name| number(name)).map(|value| value != 0);
        let persistent = flag(&["has_expires", "is_persistent", "persistent"]).unwrap_or(true);
        let expires = if persistent { number("expires_utc").and_then(webkit_time) } else { None };
        if expires.is_some_and(|expires| expires < now_ms) {
            return Ok(true);
        }
        let plain = Zeroizing::new(named_blob(row, "value"));
        let sealed = named_blob(row, "encrypted_value");
        let value = if !plain.is_empty() && !sealed.is_empty() {
            blocked += 1;
            return Ok(true);
        } else if !sealed.is_empty() {
            let Some(opened) = unlock.open(&sealed) else {
                blocked += 1;
                return Ok(true);
            };
            if host_hashed {
                let hash = Sha256::digest(host.as_bytes());
                if !opened.starts_with(&hash) {
                    blocked += 1;
                    return Ok(true);
                }
                Zeroizing::new(opened[hash.len()..].to_vec())
            } else {
                opened
            }
        } else {
            plain
        };
        let path = named_text(row, "path");
        let port = number("source_port").unwrap_or(-1);
        let mut cookie = Map::new();
        cookie.insert("domain".into(), json!(host));
        cookie.insert("name".into(), json!(text(row, name_at)));
        cookie.insert("value".into(), secrets.hand(&value));
        cookie.insert("path".into(), json!(if path.is_empty() { "/".to_owned() } else { path }));
        cookie.insert("secure".into(), json!(flag(&["is_secure", "secure"]).unwrap_or(false)));
        cookie.insert("httpOnly".into(), json!(flag(&["is_httponly", "httponly"]).unwrap_or(false)));
        cookie.insert(
            "sameSite".into(),
            json!(chromium_same_site(number("samesite").or_else(|| number("firstpartyonly")))),
        );
        cookie.insert(
            "priority".into(),
            json!(match number("priority") {
                Some(0) => "low",
                Some(2) => "high",
                _ => "medium",
            }),
        );
        cookie.insert(
            "sourceScheme".into(),
            json!(match number("source_scheme") {
                Some(1) => "nonSecure",
                Some(2) => "secure",
                _ => "unset",
            }),
        );
        cookie.insert("sourcePort".into(), json!(if (0..=65535).contains(&port) { port } else { -1 }));
        let top_frame = named_text(row, "top_frame_site_key");
        if !top_frame.is_empty() {
            cookie.insert(
                "partitionKey".into(),
                json!({"topLevelSite": top_frame, "crossSite": number("has_cross_site_ancestor").unwrap_or(0) != 0}),
            );
        }
        if let Some(expires) = expires {
            cookie.insert("expires".into(), json!(expires));
        }
        for (from, to) in [("creation_utc", "created"), ("last_access_utc", "lastAccess")] {
            if let Some(time) = number(from).and_then(webkit_time) {
                cookie.insert(to.into(), json!(time));
            }
        }
        cookies.push(Value::Object(cookie));
        Ok(true)
    })?;
    Ok(json!({"cookies": cookies, "blocked": blocked}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_attributes_keep_only_jars_chromium_has() {
        assert_eq!(origin_attributes(""), (false, None));
        assert_eq!(origin_attributes("^userContextId=2"), (true, None));
        assert_eq!(origin_attributes("^privateBrowsingId=0"), (false, None));
        assert_eq!(
            origin_attributes("^partitionKey=%28https%2CExample.com%2C8443%29"),
            (false, Some("https://example.com".into()))
        );
        assert!(origin_attributes("^partitionKey=%28ftp%2Cexample.com%29").0);
        assert!(origin_attributes("^=x").0);
    }

    #[test]
    fn malformed_origin_attributes_are_another_jar() {
        assert!(origin_attributes("^=").0);
        assert!(origin_attributes("^=1&userContextId=0").0);
    }

    // On macOS a card number or cookie value is sealed with v10 or not at all; a password may be plain.
    #[test]
    fn macos_opens_only_v10_sealed_values() {
        let mut unlock = Unlock {
            key: Some(Zeroizing::new(vec![7; 16])),
            unsealed_is_plain: true,
            opener: None,
        };
        assert!(unlock.open(b"v11garbage-but-printable").is_none());
        assert!(unlock.open(b"v10\x01\x02\x03").is_none());
        assert!(unlock.open(b"plain").is_none());
        assert_eq!(
            unlock.open_login(b"plain").as_deref().map(Vec::as_slice),
            Some(&b"plain"[..])
        );
    }

    #[test]
    fn same_site_follows_what_the_site_sent() {
        assert_eq!(same_site(0, None, true), "none");
        assert_eq!(same_site(0, None, false), "unspecified");
        assert_eq!(same_site(1, Some(0), true), "unspecified");
        assert_eq!(same_site(2, Some(2), false), "strict");
        assert_eq!(same_site(256, None, true), "unspecified");
    }

    #[test]
    fn card_numbers_lose_their_separators() {
        assert_eq!(
            card_number(b"4111 1111-1111 1111")
                .as_deref()
                .map(Vec::as_slice),
            Some(&b"4111111111111111"[..])
        );
        assert!(card_number(b"4111").is_none());
        assert!(card_number(b"4111x111111111111").is_none());
    }

    #[test]
    fn app_bound_values_open_for_no_one() {
        let mut opened = 0;
        let mut opener = |_: &[u8]| {
            opened += 1;
            Some(Zeroizing::new(b"plain".to_vec()))
        };
        let mut unlock = Unlock {
            key: None,
            unsealed_is_plain: false,
            opener: Some(&mut opener),
        };
        assert!(unlock.open(b"v20sealed").is_none());
        assert_eq!(
            unlock.open(b"v10sealed").as_deref().map(Vec::as_slice),
            Some(&b"plain"[..])
        );
        drop(unlock);
        assert_eq!(opened, 1);
    }
}

#[cfg(test)]
mod fixture_tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;

    static NOT_CANCELLED: AtomicBool = AtomicBool::new(false);
    /// The fixtures' Safe Storage key (PBKDF2 of "bay-fixture-secret").
    const KEY: [u8; 16] = [
        0xb4, 0x2c, 0xf0, 0x3a, 0x29, 0xcc, 0x14, 0xe8, 0x85, 0x85, 0x1f, 0x16, 0x4d, 0xd6, 0x59,
        0x4c,
    ];

    fn support(path: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../import/fixtures/home/Library/Application Support")
            .join(path)
    }

    fn mac(key: Option<&[u8]>) -> Unlock<'static> {
        Unlock {
            key: key.map(|key| Zeroizing::new(key.to_vec())),
            unsealed_is_plain: true,
            opener: None,
        }
    }

    #[test]
    fn logins_open_and_merge_the_account_store() {
        let answer = chromium_logins(
            &support("Google/Chrome/Default"),
            &mut mac(Some(&KEY)),
            Cancel(&NOT_CANCELLED),
        )
        .unwrap();
        let pairs: Vec<String> = answer["credentials"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                format!(
                    "{}@{}={}",
                    c["username"].as_str().unwrap(),
                    c["url"].as_str().unwrap(),
                    c["password"].as_str().unwrap()
                )
            })
            .collect();
        assert_eq!(
            pairs,
            [
                "alex@example.com@https://accounts.example.com/login=correct horse",
                "alex@https://shop.example/=pässwörd 🔑",
                "alex@android://hash@com.example.app/=from-android",
                "old@https://legacy.example/=plain-legacy",
                "sam@https://account-only.example/=only-in-account",
            ]
        );
        assert_eq!(answer["blocked"], 1);
        let first = &answer["credentials"][0];
        assert_eq!(first["realm"], "https://accounts.example.com/");
        assert_eq!(first["timesUsed"], 12);
        assert_eq!(
            first["lastUsed"],
            json!((1788220800_i64 - 3600) as f64 * 1000.0)
        );
        assert_eq!(
            first["created"],
            json!((1788220800_i64 - 86400 * 30) as f64 * 1000.0)
        );
    }

    #[test]
    fn autofill_reads_addresses_without_a_key_and_cards_with_it() {
        let profile = support("Google/Chrome/Default");
        let open = chromium_autofill(
            &profile,
            &mut mac(Some(&KEY)),
            &mut Secrets(None),
            Cancel(&NOT_CANCELLED),
        )
        .unwrap();
        assert_eq!(
            open["addresses"][0],
            json!({"name": "Alex Example", "organization": "Bay Ltd", "street": "1 Example Way\nSuite 2",
                   "city": "Cupertino", "state": "CA", "postalCode": "95014", "country": "US",
                   "phone": "+14155550100", "email": "alex@example.com"})
        );
        assert_eq!(open["addresses"].as_array().unwrap().len(), 3);
        assert_eq!(
            open["cards"],
            json!([
                {"name": "Alex Example", "number": "4111111111111111", "expMonth": 4, "expYear": 2030, "nickname": "Travel"},
                {"number": "5555555555554444", "expMonth": 12, "expYear": 2031},
            ])
        );
        assert_eq!(open["blocked"], 1);
        let locked = chromium_autofill(
            &profile,
            &mut mac(None),
            &mut Secrets(None),
            Cancel(&NOT_CANCELLED),
        )
        .unwrap();
        assert_eq!(locked["addresses"].as_array().unwrap().len(), 3);
        assert_eq!(locked["cards"], json!([]));
        assert_eq!(locked["locked"], 3);
    }

    #[test]
    fn chromium_cookies_hand_their_values_out_byte_for_byte() {
        let mut values: Vec<Vec<u8>> = Vec::new();
        let mut sink = |plain: &[u8]| {
            values.push(plain.to_vec());
            values.len() - 1
        };
        let answer = chromium_cookies(
            &support("Google/Chrome/Default/Network/Cookies"),
            &mut mac(Some(&KEY)),
            &mut Secrets(Some(&mut sink)),
            1_000.0,
            Cancel(&NOT_CANCELLED),
        )
        .unwrap();
        // A wrong key, a v24 value without the host hash, and a row with both a value and a sealed one.
        assert_eq!(answer["blocked"], 3);
        let value = |name: &str| {
            let cookie = answer["cookies"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["name"] == name)
                .unwrap();
            values[cookie["value"]["secret"].as_u64().unwrap() as usize].clone()
        };
        assert_eq!(value("sid"), b"s3ss10n");
        assert_eq!(value("pref"), b"dark");
        assert_eq!(value("bin"), [0xFF, 0xFE]);
    }

    #[test]
    fn firefox_cookies_leave_out_other_jars() {
        let answer = firefox_cookies(
            &support("Firefox/Profiles/abcd1234.default-release/cookies.sqlite"),
            &mut Secrets(None),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs_f64()
                * 1000.0,
            Cancel(&NOT_CANCELLED),
        )
        .unwrap();
        assert_eq!(answer["cookies"].as_array().unwrap().len(), 6);
    }
}
