//! C ABI (`include/bay_adblock.h`): the iOS engine calls it through `BayAdblock.xcframework`. Strings returned to the caller are
//! owned by Rust; release them with `bay_string_free`.

use std::ffi::{c_char, CStr, CString};
use std::sync::RwLock;

use crate::{content_blocking_rules, TrackingParams};

pub(crate) static TRACKING: RwLock<Option<TrackingParams>> = RwLock::new(None);

/// # Safety
/// `text` must be null or a valid NUL-terminated string.
unsafe fn read(text: *const c_char) -> Option<String> {
    (!text.is_null()).then(|| CStr::from_ptr(text).to_string_lossy().into_owned())
}

fn give(text: String) -> *mut c_char {
    CString::new(text).map_or(std::ptr::null_mut(), CString::into_raw)
}

/// WebKit content-blocking rules (a JSON array) for filter list text.
///
/// # Safety
/// `lists` must be a valid NUL-terminated string.
#[no_mangle]
pub unsafe extern "C" fn bay_content_blocking_rules(lists: *const c_char) -> *mut c_char {
    give(content_blocking_rules(&read(lists).unwrap_or_default()))
}

/// Sets the tracking-parameter table (JSON from `@bay/core`). Returns false if it can't be read.
///
/// # Safety
/// `json` must be a valid NUL-terminated string.
#[no_mangle]
pub unsafe extern "C" fn bay_tracking_set(json: *const c_char) -> bool {
    set_tracking(&read(json).unwrap_or_default())
}

/// The URL without tracking parameters, or null when it has none.
///
/// # Safety
/// `url` must be a valid NUL-terminated string.
#[no_mangle]
pub unsafe extern "C" fn bay_tracking_clean(url: *const c_char) -> *mut c_char {
    read(url)
        .and_then(|url| clean_url(&url))
        .map_or(std::ptr::null_mut(), give)
}

/// # Safety
/// `text` must be null or a pointer returned by this library, freed once.
#[no_mangle]
pub unsafe extern "C" fn bay_string_free(text: *mut c_char) {
    if !text.is_null() {
        drop(CString::from_raw(text));
    }
}

pub(crate) fn set_tracking(json: &str) -> bool {
    let Some(params) = TrackingParams::from_json(json) else {
        return false;
    };
    *TRACKING
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(params);
    true
}

pub(crate) fn clean_url(url: &str) -> Option<String> {
    TRACKING
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()?
        .clean(url)
}
