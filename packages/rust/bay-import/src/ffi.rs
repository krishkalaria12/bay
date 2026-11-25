//! C ABI (`include/bay_import.h`), linked into both desktop hosts through `bay-desktop`: one entry point that takes a
//! JSON request naming a reader and answers `{"value": …}` or `{"error": {"code": …, "message": …}}`.

use std::ffi::{CStr, CString, c_char, c_void};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use serde_json::{Value, json};

use zeroize::{Zeroize, Zeroizing};

use crate::readers::Cancel;
use crate::secrets::{Opener, Plain, Secrets, Sink, Unlock};
use crate::{Failure, HistoryOptions};

/// Hears a reader's events (history progress and chunks) as JSON, on the reading thread.
pub type BayImportObserver =
    Option<unsafe extern "C" fn(context: *mut c_void, event: *const c_char)>;

/// Takes the plain bytes an opener gives.
pub type BayImportPut = unsafe extern "C" fn(sink: *mut c_void, plain: *const u8, length: usize);

/// Opens a browser value the reader's key can't (DPAPI, the engine's OSCrypt, a keyring asked on demand): gives the
/// plain bytes to `put` with `sink` and answers true, or answers false. On the reading thread.
pub type BayImportOpener = Option<
    unsafe extern "C" fn(
        context: *mut c_void,
        sealed: *const u8,
        length: usize,
        sink: *mut c_void,
        put: BayImportPut,
    ) -> bool,
>;

/// Takes a card number or cookie value the reader hands out of its answer (`{"secret": index}` there), for a host
/// that keeps them in memory it wipes. On the reading thread.
pub type BayImportSecret = Option<
    unsafe extern "C" fn(context: *mut c_void, index: usize, plain: *const u8, length: usize),
>;

/// What a host gives a read besides the request: each callback may be null, and all take `context`.
#[repr(C)]
pub struct BayImportHooks {
    pub observer: BayImportObserver,
    pub opener: BayImportOpener,
    pub secret: BayImportSecret,
    pub context: *mut c_void,
}

/// Wipes what a request or an answer held (primary passwords, saved passwords, card numbers, cookies).
fn wipe(value: &mut Value) {
    match value {
        Value::String(text) => text.zeroize(),
        Value::Array(items) => items.iter_mut().for_each(wipe),
        Value::Object(fields) => fields.values_mut().for_each(wipe),
        _ => {}
    }
}

fn give(text: &str) -> *mut c_char {
    CString::new(text.as_bytes()).map_or(std::ptr::null_mut(), CString::into_raw)
}

fn field<'a>(request: &'a Value, key: &str) -> Result<&'a str, Failure> {
    request
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| Failure::new("format", format!("The import request has no {key}")))
}

fn path(request: &Value, key: &str) -> Result<PathBuf, Failure> {
    field(request, key).map(PathBuf::from)
}

/// A key given as hex in a request.
fn hex(text: &str) -> Result<Vec<u8>, Failure> {
    let invalid = || Failure::new("format", "The import request's key isn't hex");
    if !text.len().is_multiple_of(2) {
        return Err(invalid());
    }
    (0..text.len())
        .step_by(2)
        .map(|at| {
            u8::from_str_radix(text.get(at..at + 2).ok_or_else(invalid)?, 16).map_err(|_| invalid())
        })
        .collect()
}

fn read(
    request: &Value,
    cancel: Cancel<'_>,
    observer: &mut dyn FnMut(Value),
    opener: Option<Opener<'_>>,
    secrets: &mut Secrets<'_>,
) -> Result<Value, Failure> {
    let now = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |since| since.as_secs_f64() * 1000.0)
    };
    // A cookie reader's database: "database", or the one in "profile".
    let cookies = |names: &[&str]| -> Result<PathBuf, Failure> {
        if request.get("database").is_some() {
            return path(request, "database");
        }
        let profile = path(request, "profile")?;
        names
            .iter()
            .map(|name| profile.join(name))
            .find(|file| file.exists())
            .ok_or_else(|| Failure::new("notFound", "No cookies in this profile"))
    };
    match field(request, "reader")? {
        "passwordsCsv" => crate::parse_passwords_csv(field(request, "text")?),
        "netscapeBookmarks" => Ok(crate::parse_netscape_bookmarks(field(request, "text")?)),
        "chromiumBookmarks" => crate::chromium_bookmarks(&path(request, "profile")?),
        "firefoxBookmarks" => crate::firefox_bookmarks(&path(request, "profile")?, cancel),
        "history" => {
            let number = |key: &str, default: f64| {
                request.get(key).and_then(Value::as_f64).unwrap_or(default)
            };
            let options = HistoryOptions {
                limit: number("limit", -1.0) as i64,
                since: number("since", 0.0),
                chunk_size: number("chunkSize", 1000.0) as i64,
                stream: request
                    .get("stream")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            };
            let firefox = request
                .get("firefox")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let (entries, count) = crate::history(
                &path(request, "profile")?,
                firefox,
                &options,
                observer,
                cancel,
            )?;
            Ok(json!({"entries": entries, "count": count}))
        }
        "chromiumTabs" => {
            let key = request
                .get("key")
                .and_then(Value::as_str)
                .map(hex)
                .transpose()?;
            let can_unlock = request
                .get("canUnlock")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            crate::chromium_tabs(
                &path(request, "profile")?,
                cancel,
                key.as_deref(),
                can_unlock,
            )
        }
        "firefoxTabs" => match request.get("text").and_then(Value::as_str) {
            Some(text) => crate::firefox_tabs_from_json(text, cancel),
            None => crate::firefox_tabs(&path(request, "profile")?, cancel),
        },
        "zenSpaces" => match request.get("text").and_then(Value::as_str) {
            Some(text) => crate::zen_spaces_from_json(text, field(request, "profileId")?),
            None => crate::zen_spaces(&path(request, "profile")?, field(request, "profileId")?),
        },
        "arcSidebar" => match request.get("text").and_then(Value::as_str) {
            Some(text) => crate::arc_sidebar_from_json(text),
            None => crate::arc_sidebar(&path(request, "file")?),
        },
        "extensions" => crate::extensions(&path(request, "profile")?),
        "chromiumLogins" | "chromiumAutofill" | "chromiumCookies" => {
            let key = request
                .get("key")
                .and_then(Value::as_str)
                .map(hex)
                .transpose()?
                .map(Zeroizing::new);
            let unsealed_is_plain = request
                .get("unsealedIsPlain")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut unlock = Unlock {
                key,
                unsealed_is_plain,
                opener,
            };
            match field(request, "reader")? {
                "chromiumLogins" => {
                    crate::chromium_logins(&path(request, "profile")?, &mut unlock, cancel)
                }
                "chromiumAutofill" => crate::chromium_autofill(
                    &path(request, "profile")?,
                    &mut unlock,
                    secrets,
                    cancel,
                ),
                _ => crate::chromium_cookies(
                    &cookies(&["Network/Cookies", "Cookies"])?,
                    &mut unlock,
                    secrets,
                    now(),
                    cancel,
                ),
            }
        }
        "firefoxCookies" => {
            crate::firefox_cookies(&cookies(&["cookies.sqlite"])?, secrets, now(), cancel)
        }
        "profiles" => {
            let flag = |key: &str| request.get(key).and_then(Value::as_bool).unwrap_or(false);
            let sidebar = request
                .get("arcSidebar")
                .and_then(Value::as_str)
                .map(PathBuf::from);
            let options = crate::DiscoveryOptions {
                firefox: flag("firefox"),
                root_is_profile: flag("rootIsProfile"),
                root_id: request
                    .get("rootId")
                    .and_then(Value::as_str)
                    .unwrap_or("Root"),
                chromium_cookies: flag("chromiumCookies"),
                arc_sidebar: sidebar.as_deref(),
            };
            Ok(crate::profiles(&path(request, "root")?, &options))
        }
        "available" => {
            let flag = |key: &str| request.get(key).and_then(Value::as_bool).unwrap_or(false);
            Ok(crate::available(
                &path(request, "profile")?,
                flag("firefox"),
                flag("chromiumCookies"),
            ))
        }
        "firefoxLogins" => {
            let password = request
                .get("primaryPassword")
                .and_then(Value::as_str)
                .unwrap_or("");
            crate::firefox_logins(&path(request, "profile")?, password, cancel)
        }
        other => Err(Failure::new("format", format!("No import reader {other}"))),
    }
}

/// Runs the reader `request` names (`{"reader": "chromiumBookmarks", "profile": "…"}`; see `include/bay_import.h`).
/// `cancelled` is the host's stop flag (a C++ `std::atomic_bool`), or null; `hooks` its callbacks, or null. The
/// answer is `{"value": …}` or `{"error": {"code": …, "message": …}}`; free it with `bay_import_string_free`.
///
/// # Safety
/// `request` must be a valid string; `cancelled` null or a live flag only written atomically while this runs;
/// `hooks` null or live for the call, its `context` as its callbacks expect.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_import_read(
    request: *const c_char,
    cancelled: *const bool,
    hooks: *const BayImportHooks,
) -> *mut c_char {
    let (observer, opener, secret, context) = if hooks.is_null() {
        (None, None, None, std::ptr::null_mut())
    } else {
        // SAFETY: the caller passes live hooks for this call.
        let hooks = unsafe { &*hooks };
        (hooks.observer, hooks.opener, hooks.secret, hooks.context)
    };
    let never = AtomicBool::new(false);
    let flag = if cancelled.is_null() {
        &never
    } else {
        // SAFETY: the caller passes a live flag it writes only atomically (std::atomic_bool has bool's layout).
        unsafe { AtomicBool::from_ptr(cancelled.cast_mut()) }
    };
    let mut request = if request.is_null() {
        Value::Null
    } else {
        // SAFETY: the caller passes a valid string.
        serde_json::from_str(&unsafe { CStr::from_ptr(request) }.to_string_lossy())
            .unwrap_or(Value::Null)
    };
    let mut hear = |event: Value| {
        if let (Some(observer), Ok(text)) = (observer, CString::new(event.to_string())) {
            // SAFETY: as the caller's: the observer takes its own context and a valid string for this call.
            unsafe { observer(context, text.as_ptr()) };
        }
    };
    let mut open = |sealed: &[u8]| -> Option<Plain> {
        let opener = opener?;
        let mut plain = Zeroizing::new(Vec::new());
        unsafe extern "C" fn put(sink: *mut c_void, bytes: *const u8, length: usize) {
            if !bytes.is_null() {
                // SAFETY: the opener gives `length` readable bytes, and `sink` is the vector below for this call.
                unsafe {
                    (*sink.cast::<Vec<u8>>())
                        .extend_from_slice(std::slice::from_raw_parts(bytes, length))
                };
            }
        }
        let sink: *mut Vec<u8> = &mut *plain;
        // SAFETY: as the caller's: the opener takes its own context and these bytes for this call.
        let opened = unsafe { opener(context, sealed.as_ptr(), sealed.len(), sink.cast(), put) };
        opened.then_some(plain)
    };
    let mut handed = 0;
    let mut hand = |plain: &[u8]| -> usize {
        let index = handed;
        handed += 1;
        if let Some(secret) = secret {
            // SAFETY: as the caller's: the callback takes its own context and these bytes for this call.
            unsafe { secret(context, index, plain.as_ptr(), plain.len()) };
        }
        index
    };
    let mut secrets = Secrets(secret.is_some().then_some(&mut hand as Sink<'_>));
    let mut answer = match read(
        &request,
        Cancel(flag),
        &mut hear,
        opener.is_some().then_some(&mut open as Opener<'_>),
        &mut secrets,
    ) {
        Ok(value) => json!({"value": value}),
        Err(failure) => json!({"error": {"code": failure.code, "message": failure.message}}),
    };
    let text = Zeroizing::new(answer.to_string());
    wipe(&mut answer);
    wipe(&mut request);
    give(&text)
}

/// A stop flag the host owns through the library (Swift has no atomics of its own): pass it as `cancelled`. Free with
/// `bay_import_cancel_free`.
#[unsafe(no_mangle)]
pub extern "C" fn bay_import_cancel_new() -> *mut bool {
    Box::into_raw(Box::new(AtomicBool::new(false))).cast()
}

/// Asks the reads using `token` to stop.
///
/// # Safety
/// `token` must come from `bay_import_cancel_new` and not be freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_import_cancel(token: *mut bool) {
    // SAFETY: as the caller's: a flag this library allocated.
    unsafe { AtomicBool::from_ptr(token) }.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// Whether `token` was cancelled.
///
/// # Safety
/// `token` must come from `bay_import_cancel_new` and not be freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_import_cancelled(token: *const bool) -> bool {
    // SAFETY: as the caller's: a flag this library allocated.
    unsafe { AtomicBool::from_ptr(token.cast_mut()) }.load(std::sync::atomic::Ordering::Relaxed)
}

/// # Safety
/// `token` must be null or come from `bay_import_cancel_new`, with no read still using it.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_import_cancel_free(token: *mut bool) {
    if !token.is_null() {
        // SAFETY: as the caller's.
        drop(unsafe { Box::from_raw(token.cast::<AtomicBool>()) });
    }
}

/// Frees an answer from `bay_import_read`.
///
/// # Safety
/// `text` must be null or come from this library, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_import_string_free(text: *mut c_char) {
    if !text.is_null() {
        // SAFETY: as the caller's.
        let mut bytes = unsafe { CString::from_raw(text) }.into_bytes_with_nul();
        // An answer can hold passwords: wiped before the memory goes back.
        for byte in &mut bytes {
            // SAFETY: a byte of the vector, written in place.
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(request: Value, cancelled: Option<&AtomicBool>) -> (Value, Vec<Value>) {
        unsafe extern "C" fn hear(context: *mut c_void, event: *const c_char) {
            // SAFETY: the test's own Vec and a string valid for this call.
            let events = unsafe { &mut *context.cast::<Vec<Value>>() };
            events.push(
                serde_json::from_str(&unsafe { CStr::from_ptr(event) }.to_string_lossy()).unwrap(),
            );
        }
        let mut events: Vec<Value> = Vec::new();
        let request = CString::new(request.to_string()).unwrap();
        let flag = cancelled.map_or(std::ptr::null(), |flag| flag.as_ptr().cast_const());
        // SAFETY: a valid request, a live flag (or null) and the matching observer context.
        let answer = unsafe {
            bay_import_read(
                request.as_ptr(),
                flag,
                &BayImportHooks {
                    observer: Some(hear),
                    opener: None,
                    secret: None,
                    context: (&raw mut events).cast(),
                },
            )
        };
        // SAFETY: an answer this library gave, freed once.
        let value =
            serde_json::from_str(&unsafe { CStr::from_ptr(answer) }.to_string_lossy()).unwrap();
        unsafe { bay_import_string_free(answer) };
        (value, events)
    }

    #[test]
    fn readers_answer_through_the_c_function() {
        let (answer, _) = call(
            json!({"reader": "netscapeBookmarks", "text": "<DL><DT><A HREF='https://a.test'>A</A></DL>"}),
            None,
        );
        assert_eq!(answer["value"]["children"][0]["url"], "https://a.test");
        let (answer, _) = call(
            json!({"reader": "passwordsCsv", "text": "name,notes\nx,y\n"}),
            None,
        );
        assert_eq!(answer["error"]["code"], "unsupported");
        let (answer, _) = call(json!({"reader": "nope"}), None);
        assert_eq!(answer["error"]["code"], "format");
        let (answer, _) = call(json!({"reader": "chromiumBookmarks"}), None);
        assert_eq!(answer["error"]["code"], "format");
    }

    #[test]
    fn history_reports_progress_and_honours_the_hosts_stop_flag() {
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../import/fixtures/home/Library/Application Support/Google/Chrome/Default");
        let profile = tempfile::tempdir().unwrap();
        std::fs::copy(fixtures.join("History"), profile.path().join("History")).unwrap();
        let request = json!({"reader": "history", "profile": profile.path(), "chunkSize": 2});
        let (answer, events) = call(request.clone(), None);
        let count = answer["value"]["count"].as_i64().unwrap();
        assert_eq!(
            answer["value"]["entries"].as_array().unwrap().len() as i64,
            count
        );
        assert_eq!(events.first().unwrap()["phase"], "start");
        assert_eq!(events.last().unwrap()["total"], count);
        let stop = AtomicBool::new(true);
        let (answer, _) = call(request, Some(&stop));
        assert_eq!(answer["error"]["code"], "cancelled");
    }
}
