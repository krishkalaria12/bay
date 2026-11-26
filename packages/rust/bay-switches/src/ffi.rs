//! C ABI (`include/bay_switches.h`), linked into both desktop hosts through `bay-desktop`. Strings returned to the
//! caller are owned by Rust; release them with `bay_switches_string_free`.

use std::ffi::{CStr, CString, c_char};

use serde_json::json;

/// # Safety
/// `text` must be null or a valid NUL-terminated string.
unsafe fn read<'a>(text: *const c_char) -> Option<&'a [u8]> {
    // SAFETY: the caller passes null or a valid string, which outlives this call.
    (!text.is_null()).then(|| unsafe { CStr::from_ptr(text) }.to_bytes())
}

/// The switches in `feed` that apply here, as JSON: `{"ok":true,"issued":…,"switches":[{"id","feature","reason",
/// "until"?}]}`, or `{"ok":false,"error":"signature"|"format"|"stale"}`. `platform` is "macos", "windows" or "linux";
/// `now` and `last_issued` are seconds since 1970 (`last_issued` 0 when the host has no feed yet).
///
/// # Safety
/// Each string must be null or a valid NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_switches_check(
    feed: *const c_char,
    signature: *const c_char,
    platform: *const c_char,
    version: *const c_char,
    now: i64,
    last_issued: i64,
) -> *mut c_char {
    // SAFETY: as the caller's.
    let (feed, signature, platform, version) =
        unsafe { (read(feed), read(signature), read(platform), read(version)) };
    let text = |bytes: Option<&[u8]>| {
        bytes
            .map(|b| String::from_utf8_lossy(b).into_owned())
            .unwrap_or_default()
    };

    let result = match crate::check(
        feed.unwrap_or_default(),
        &text(signature),
        &text(platform),
        &text(version),
        now,
        last_issued,
    ) {
        Ok(checked) => {
            json!({ "ok": true, "issued": checked.issued, "switches": checked.switches })
        }
        Err(refusal) => json!({ "ok": false, "error": refusal.code() }),
    };

    CString::new(result.to_string()).map_or(std::ptr::null_mut(), CString::into_raw)
}

/// Releases a string this library returned.
///
/// # Safety
/// `text` must be null or a string from this library, not yet released.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_switches_string_free(text: *mut c_char) {
    if !text.is_null() {
        // SAFETY: it came from CString::into_raw above.
        drop(unsafe { CString::from_raw(text) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unsigned_feed_is_refused_as_json() {
        let feed = CString::new(r#"{"issued":1,"switches":[]}"#).unwrap();
        let signature = CString::new("AAAA").unwrap();
        let platform = CString::new("macos").unwrap();
        let version = CString::new("1.6.2").unwrap();
        // SAFETY: valid strings, and the result is released below.
        let result = unsafe {
            bay_switches_check(
                feed.as_ptr(),
                signature.as_ptr(),
                platform.as_ptr(),
                version.as_ptr(),
                0,
                0,
            )
        };
        // SAFETY: a string from the call above.
        let text = unsafe { CStr::from_ptr(result) }
            .to_str()
            .unwrap()
            .to_owned();
        // SAFETY: as above, released once.
        unsafe { bay_switches_string_free(result) };

        assert_eq!(text, r#"{"error":"signature","ok":false}"#);
    }

    #[test]
    fn the_header_declares_these_functions() {
        let header = include_str!("../include/bay_switches.h");

        for name in ["bay_switches_check(", "bay_switches_string_free("] {
            assert!(
                header.contains(name),
                "{name} is missing from bay_switches.h"
            );
        }

        assert_eq!(
            header.matches("*bay_switches_").count() + header.matches("void bay_switches_").count(),
            2,
            "bay_switches.h declares a function ffi.rs doesn't define"
        );
    }
}
