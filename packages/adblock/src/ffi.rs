//! C ABI (`include/bay_adblock.h`): the iOS engine calls it through `BayAdblock.xcframework`, and desktop's native core
//! links it as a static library (`bay_blocker_*`). Strings returned to the caller are owned by Rust; release them with
//! `bay_string_free`, and bytes with `bay_bytes_free`.

use std::ffi::{c_char, CStr, CString};
use std::sync::RwLock;

use serde::Deserialize;

use crate::{Blocker, FilterList, TrackingParams};

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
#[cfg(not(target_os = "android"))]
#[no_mangle]
pub unsafe extern "C" fn bay_content_blocking_rules(lists: *const c_char) -> *mut c_char {
    give(crate::content_blocking_rules(&read(lists).unwrap_or_default()))
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

/// # Safety
/// `text` must be null or a valid NUL-terminated string that outlives the borrow.
unsafe fn borrow<'a>(text: *const c_char) -> &'a str {
    if text.is_null() {
        return "";
    }
    CStr::from_ptr(text).to_str().unwrap_or("")
}

fn give_json(value: &impl serde::Serialize) -> *mut c_char {
    serde_json::to_string(value).map_or(std::ptr::null_mut(), give)
}

/// A blocker built from `count` filter lists. `lists[i]` is a list's text; `hosts[i]` is true for a hosts file (null:
/// none are). Never null; free it with `bay_blocker_free`.
///
/// # Safety
/// `lists` must point to `count` valid NUL-terminated strings (or be null when `count` is 0), and `hosts` to `count`
/// bools or be null.
#[no_mangle]
pub unsafe extern "C" fn bay_blocker_new(
    lists: *const *const c_char,
    hosts: *const bool,
    count: usize,
) -> *mut Blocker {
    let lists: Vec<FilterList> = (0..count)
        .map(|i| FilterList {
            text: borrow(*lists.add(i)),
            hosts: !hosts.is_null() && *hosts.add(i),
        })
        .collect();
    Box::into_raw(Box::new(Blocker::from_lists(&lists)))
}

/// A blocker `bay_blocker_serialize` wrote, or null when the data is damaged or from another adblock-rust.
///
/// # Safety
/// `data` must point to `length` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn bay_blocker_deserialize(data: *const u8, length: usize) -> *mut Blocker {
    if data.is_null() {
        return std::ptr::null_mut();
    }
    Blocker::deserialize(std::slice::from_raw_parts(data, length))
        .map_or(std::ptr::null_mut(), |blocker| {
            Box::into_raw(Box::new(blocker))
        })
}

/// The blocker's engine as bytes (`length` set to their count), for `bay_blocker_deserialize`. Free with
/// `bay_bytes_free`.
///
/// # Safety
/// `blocker` must come from this library and not be freed; `length` must be writable.
#[no_mangle]
pub unsafe extern "C" fn bay_blocker_serialize(
    blocker: *const Blocker,
    length: *mut usize,
) -> *mut u8 {
    let bytes = (*blocker).serialize().into_boxed_slice();
    *length = bytes.len();
    Box::into_raw(bytes).cast()
}

/// # Safety
/// `data` and `length` must come from one `bay_blocker_serialize` call, freed once.
#[no_mangle]
pub unsafe extern "C" fn bay_bytes_free(data: *mut u8, length: usize) {
    if !data.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            data, length,
        )));
    }
}

/// # Safety
/// `blocker` must be null or come from this library, freed once, with no call using it still running.
#[no_mangle]
pub unsafe extern "C" fn bay_blocker_free(blocker: *mut Blocker) {
    if !blocker.is_null() {
        drop(Box::from_raw(blocker));
    }
}

/// Whether to block a request. `source_url` is the URL (or origin) of the document or worker that makes it; `type` is
/// an adblock resource type (`script`, `image`, `stylesheet`, `font`, `media`, `subdocument`, `xmlhttprequest`,
/// `ping`, `websocket`, `object`, `other`…). Thread-safe.
///
/// # Safety
/// `blocker` must be live; the strings valid NUL-terminated strings.
#[no_mangle]
pub unsafe extern "C" fn bay_blocker_should_block(
    blocker: *const Blocker,
    url: *const c_char,
    source_url: *const c_char,
    kind: *const c_char,
) -> bool {
    (*blocker).should_block(borrow(url), borrow(source_url), borrow(kind))
}

/// A page's cosmetic resources as JSON: `{"hide": [selector], "exceptions": [selector], "generichide": bool,
/// "script": scriptlet code}`.
///
/// # Safety
/// `blocker` must be live; `url` a valid NUL-terminated string.
#[no_mangle]
pub unsafe extern "C" fn bay_blocker_cosmetic(
    blocker: *const Blocker,
    url: *const c_char,
) -> *mut c_char {
    give_json(&(*blocker).page_resources(borrow(url)))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct SelectorQuery {
    classes: Vec<String>,
    ids: Vec<String>,
    exceptions: Vec<String>,
}

/// Generic hiding selectors (a JSON array) for a page's classes and ids. `query` is JSON: `{"classes": [name],
/// "ids": [name], "exceptions": [selector]}`, the exceptions from `bay_blocker_cosmetic`.
///
/// # Safety
/// `blocker` must be live; `query` a valid NUL-terminated string.
#[no_mangle]
pub unsafe extern "C" fn bay_blocker_hidden_selectors(
    blocker: *const Blocker,
    query: *const c_char,
) -> *mut c_char {
    let query: SelectorQuery = serde_json::from_str(borrow(query)).unwrap_or_default();
    give_json(&(*blocker).hidden_selectors(&query.classes, &query.ids, &query.exceptions))
}

/// Each list's rule counts as JSON, in `bay_blocker_new` order: `[{"networkFilters": n, "cosmeticFilters": n}]`.
///
/// # Safety
/// `blocker` must be live.
#[no_mangle]
pub unsafe extern "C" fn bay_blocker_list_counts(blocker: *const Blocker) -> *mut c_char {
    give_json(&(*blocker).list_counts())
}

/// Gives the blocker redirect and scriptlet resources (adblock-rust's `Resource` JSON array). False when unreadable.
///
/// # Safety
/// `blocker` must be live; `json` a valid NUL-terminated string.
#[no_mangle]
pub unsafe extern "C" fn bay_blocker_use_resources(
    blocker: *const Blocker,
    json: *const c_char,
) -> bool {
    (*blocker).use_resources(borrow(json))
}

/// The engine cached at `cache` for `version`, or one built from the `count` list files (then cached), with the
/// resources file loaded; null when the lists can't be read. `platform`: 0 desktop, 1 Android, 2 iOS. Free with
/// `bay_blocker_free`.
///
/// # Safety
/// `files` must point to `count` valid strings; `cache`, `version` must be valid strings; `resources` may be null.
#[no_mangle]
pub unsafe extern "C" fn bay_blocker_load(
    files: *const *const c_char,
    count: usize,
    cache: *const c_char,
    version: *const c_char,
    resources: *const c_char,
    platform: u8,
) -> *mut Blocker {
    let paths: Vec<String> = (0..count).filter_map(|i| read(*files.add(i))).collect();
    let platform = match platform {
        1 => crate::Platform::AndroidWebView,
        2 => crate::Platform::IosWebKit,
        _ => crate::Platform::DesktopChromium,
    };
    let (Some(cache), Some(version)) = (read(cache), read(version)) else {
        return std::ptr::null_mut();
    };
    let resources = read(resources).map(std::path::PathBuf::from);
    crate::load_cached(
        &paths,
        std::path::Path::new(&cache),
        &version,
        platform,
        resources.as_deref(),
    )
    .map_or(std::ptr::null_mut(), |blocker| {
        Box::into_raw(Box::new(blocker))
    })
}

/// The page's scriptlets as one script to run in its main world at document start ("" when none).
///
/// # Safety
/// `blocker` must come from this library and not be freed; `url` must be a valid string.
#[no_mangle]
pub unsafe extern "C" fn bay_blocker_scriptlets(
    blocker: *const Blocker,
    url: *const c_char,
) -> *mut c_char {
    let (Some(blocker), Some(url)) = (blocker.as_ref(), read(url)) else {
        return give(String::new());
    };
    give(blocker.scriptlets(&url))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn take(text: *mut c_char) -> String {
        assert!(!text.is_null());
        let value = unsafe { CStr::from_ptr(text) }
            .to_string_lossy()
            .into_owned();
        unsafe { bay_string_free(text) };
        value
    }

    #[test]
    fn drives_a_blocker_through_the_c_abi() {
        let easylist = CString::new("||ads.example^\nexample.com##.banner\n##.ad-slot\n").unwrap();
        let hosts = CString::new("0.0.0.0 tracker.example\n").unwrap();
        let lists = [easylist.as_ptr(), hosts.as_ptr()];
        let formats = [false, true];
        unsafe {
            let blocker = bay_blocker_new(lists.as_ptr(), formats.as_ptr(), 2);
            let url = CString::new("https://tracker.example/t.gif").unwrap();
            let source = CString::new("https://site.example/").unwrap();
            let image = CString::new("image").unwrap();
            assert!(bay_blocker_should_block(
                blocker,
                url.as_ptr(),
                source.as_ptr(),
                image.as_ptr()
            ));

            let page = CString::new("https://example.com/").unwrap();
            let cosmetic: serde_json::Value =
                serde_json::from_str(&take(bay_blocker_cosmetic(blocker, page.as_ptr()))).unwrap();
            assert_eq!(cosmetic["hide"], serde_json::json!([".banner"]));
            assert_eq!(cosmetic["generichide"], serde_json::json!(false));

            let query = CString::new(r#"{"classes":["ad-slot","story"],"ids":[]}"#).unwrap();
            assert_eq!(
                take(bay_blocker_hidden_selectors(blocker, query.as_ptr())),
                r#"[".ad-slot"]"#
            );
            assert_eq!(
                take(bay_blocker_list_counts(blocker)),
                r#"[{"networkFilters":1,"cosmeticFilters":2},{"networkFilters":1,"cosmeticFilters":0}]"#
            );

            let mut length = 0;
            let bytes = bay_blocker_serialize(blocker, &mut length);
            let copy = bay_blocker_deserialize(bytes, length);
            bay_bytes_free(bytes, length);
            assert!(!copy.is_null());
            assert!(bay_blocker_should_block(
                copy,
                url.as_ptr(),
                source.as_ptr(),
                image.as_ptr()
            ));
            assert!(bay_blocker_deserialize([1u8, 2, 3].as_ptr(), 3).is_null());

            bay_blocker_free(copy);
            bay_blocker_free(blocker);
        }
    }

    #[test]
    fn an_empty_blocker_blocks_nothing() {
        unsafe {
            let blocker = bay_blocker_new(std::ptr::null(), std::ptr::null(), 0);
            let url = CString::new("https://ads.example/").unwrap();
            assert!(!bay_blocker_should_block(
                blocker,
                url.as_ptr(),
                url.as_ptr(),
                std::ptr::null()
            ));
            bay_blocker_free(blocker);
        }
    }
}
