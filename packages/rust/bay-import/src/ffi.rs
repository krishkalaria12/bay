//! C ABI (`include/bay_import.h`), linked into both desktop hosts through `bay-desktop`: one entry point that takes a
//! JSON request naming a reader and answers `{"value": …}` or `{"error": {"code": …, "message": …}}`.

use std::ffi::{CStr, CString, c_char, c_void};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use serde_json::{Value, json};

use crate::readers::Cancel;
use crate::{Failure, HistoryOptions};

/// Hears a reader's events (history progress and chunks) as JSON, on the reading thread.
pub type BayImportObserver =
    Option<unsafe extern "C" fn(context: *mut c_void, event: *const c_char)>;

fn give(text: String) -> *mut c_char {
    CString::new(text).map_or(std::ptr::null_mut(), CString::into_raw)
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

fn read(
    request: &Value,
    cancel: Cancel<'_>,
    observer: &mut dyn FnMut(Value),
) -> Result<Value, Failure> {
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
        "chromiumTabs" => crate::chromium_tabs(&path(request, "profile")?, cancel),
        "firefoxTabs" => crate::firefox_tabs(&path(request, "profile")?, cancel),
        "zenSpaces" => crate::zen_spaces(&path(request, "profile")?, field(request, "profileId")?),
        "arcSidebar" => crate::arc_sidebar(&path(request, "file")?),
        "extensions" => crate::extensions(&path(request, "profile")?),
        other => Err(Failure::new("format", format!("No import reader {other}"))),
    }
}

/// Runs the reader `request` names (`{"reader": "chromiumBookmarks", "profile": "…"}`; see `include/bay_import.h`).
/// `cancelled` is the host's stop flag (a C++ `std::atomic_bool`), or null; `observer` hears events, or is null. The
/// answer is `{"value": …}` or `{"error": {"code": …, "message": …}}`; free it with `bay_import_string_free`.
///
/// # Safety
/// `request` must be a valid string; `cancelled` null or a live flag only written atomically while this runs;
/// `observer`'s `context` as the observer expects.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_import_read(
    request: *const c_char,
    cancelled: *const bool,
    observer: BayImportObserver,
    context: *mut c_void,
) -> *mut c_char {
    let never = AtomicBool::new(false);
    let flag = if cancelled.is_null() {
        &never
    } else {
        // SAFETY: the caller passes a live flag it writes only atomically (std::atomic_bool has bool's layout).
        unsafe { AtomicBool::from_ptr(cancelled.cast_mut()) }
    };
    let request = if request.is_null() {
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
    let answer = match read(&request, Cancel(flag), &mut hear) {
        Ok(value) => json!({"value": value}),
        Err(failure) => json!({"error": {"code": failure.code, "message": failure.message}}),
    };
    give(answer.to_string())
}

/// Frees an answer from `bay_import_read`.
///
/// # Safety
/// `text` must be null or come from this library, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_import_string_free(text: *mut c_char) {
    if !text.is_null() {
        // SAFETY: as the caller's.
        drop(unsafe { CString::from_raw(text) });
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
            bay_import_read(request.as_ptr(), flag, Some(hear), (&raw mut events).cast())
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
