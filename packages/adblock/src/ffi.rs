//! C ABI (`include/bay_adblock.h`): the iOS engine calls it through `BayAdblock.xcframework`, and desktop's native core
//! links it as a static library (`bay_blocker_*`). Strings returned to the caller are owned by Rust; release them with
//! `bay_string_free`, and bytes with `bay_bytes_free`.

use std::ffi::{c_char, CStr, CString};
use std::sync::RwLock;

use serde::Deserialize;

use crate::{content_blocking_rules, Blocker, FilterList, TrackingParams};

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
    bay_blocker_new_with_permissions(lists, hosts, std::ptr::null(), count)
}

/// Builds lists with explicit scriptlet permissions. A null permissions array grants none.
///
/// # Safety
/// Same as `bay_blocker_new`; `permissions` must point to `count` bytes or be null.
#[no_mangle]
pub unsafe extern "C" fn bay_blocker_new_with_permissions(
    lists: *const *const c_char,
    hosts: *const bool,
    permissions: *const u8,
    count: usize,
) -> *mut Blocker {
    // Lossy, so a list with a stray byte that isn't UTF-8 still gives its rules (a strict read would give none).
    let texts: Vec<String> = (0..count)
        .map(|i| read(*lists.add(i)).unwrap_or_default())
        .collect();
    let lists: Vec<FilterList> = (0..count)
        .map(|i| FilterList {
            text: &texts[i],
            hosts: !hosts.is_null() && *hosts.add(i),
            permissions: if permissions.is_null() {
                0
            } else {
                *permissions.add(i)
            },
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
/// `ping`, `websocket`, `object`, `other`…). Thread-safe. Through `bay_blocker_match`, `popup` asks about a page a page
/// opens (`source_url` the opener).
///
/// # Safety
/// `blocker` must be live; the strings valid NUL-terminated strings.
#[no_mangle]
pub unsafe extern "C" fn bay_blocker_should_block(
    blocker: *const Blocker,
    url: *const c_char,
    source_url: *const c_char,
    kind: *const c_char,
    method: *const c_char,
) -> bool {
    (*blocker).should_block(
        borrow(url),
        borrow(source_url),
        borrow(kind),
        borrow(method),
    )
}

/// A matched request: for a blocked one optionally a replacement resource (`redirect`, a data URL), for an allowed one
/// optionally the URL to load instead (`rewrite`, its `$removeparam` parameters gone). Free both with `bay_string_free`.
#[repr(C)]
pub struct BayBlockerMatch {
    pub blocked: bool,
    pub redirect: *mut c_char,
    pub rewrite: *mut c_char,
    pub rewrite_any_origin: bool,
}

/// The JSON `bay_blocker_response` returns.
#[derive(serde::Serialize)]
struct ResponseAnswer<'a> {
    blocked: bool,
    add: &'a [(String, String)],
    remove: &'a [String],
}

/// # Safety
/// `blocker` must be live; the strings must be valid NUL-terminated strings.
#[no_mangle]
pub unsafe extern "C" fn bay_blocker_match(
    blocker: *const Blocker,
    url: *const c_char,
    source_url: *const c_char,
    kind: *const c_char,
    method: *const c_char,
) -> BayBlockerMatch {
    let result = (*blocker).match_request(
        borrow(url),
        borrow(source_url),
        borrow(kind),
        borrow(method),
    );
    BayBlockerMatch {
        blocked: result.blocked,
        redirect: result.redirect.map_or(std::ptr::null_mut(), give),
        rewrite: result.rewrite.map_or(std::ptr::null_mut(), give),
        rewrite_any_origin: result.rewrite_any_origin,
    }
}

/// Whether [`bay_blocker_response`] can change a response. Thread-safe.
///
/// # Safety
/// `blocker` must be live.
#[no_mangle]
pub unsafe extern "C" fn bay_blocker_has_response_modifiers(blocker: *const Blocker) -> bool {
    (*blocker).has_response_modifiers()
}

/// Applies response rules. `headers_json` is `[["Name","value"], ...]`; `ip` is the remote address or null. Returns
/// `{"blocked": bool, "add": [[name, value]], "remove": [name]}` as JSON, or null when nothing applies. Free with
/// `bay_string_free`.
///
/// # Safety
/// `blocker` must be live; the strings must be valid NUL-terminated strings (or null where noted).
#[no_mangle]
pub unsafe extern "C" fn bay_blocker_response(
    blocker: *const Blocker,
    url: *const c_char,
    source_url: *const c_char,
    kind: *const c_char,
    method: *const c_char,
    ip: *const c_char,
    headers_json: *const c_char,
) -> *mut c_char {
    let headers: Vec<(String, String)> =
        serde_json::from_str(borrow(headers_json)).unwrap_or_default();
    let ip = (!ip.is_null()).then(|| borrow(ip));
    let result = (*blocker).response(
        borrow(url),
        borrow(source_url),
        borrow(kind),
        borrow(method),
        ip,
        &headers,
    );
    if !result.blocked && result.headers.is_empty() && result.removed_headers.is_empty() {
        return std::ptr::null_mut();
    }
    give_json(&ResponseAnswer {
        blocked: result.blocked,
        add: &result.headers,
        remove: &result.removed_headers,
    })
}

/// The Content-Security-Policy `$csp` rules add to a document's response, or null for none. `kind` is `document` or
/// `subdocument`. Free with `bay_string_free`.
///
/// # Safety
/// `blocker` must be live; the strings valid NUL-terminated strings.
#[no_mangle]
pub unsafe extern "C" fn bay_blocker_content_security_policy(
    blocker: *const Blocker,
    url: *const c_char,
    source_url: *const c_char,
    kind: *const c_char,
) -> *mut c_char {
    (*blocker)
        .content_security_policy(borrow(url), borrow(source_url), borrow(kind))
        .map_or(std::ptr::null_mut(), give)
}

/// The page's scriptlet code, or null when it has none. Free with `bay_string_free`.
///
/// # Safety
/// `blocker` must be live; `url` a valid NUL-terminated string.
#[no_mangle]
pub unsafe extern "C" fn bay_blocker_scriptlets(
    blocker: *const Blocker,
    url: *const c_char,
) -> *mut c_char {
    let script = (*blocker).scriptlets(borrow(url));
    if script.is_empty() {
        std::ptr::null_mut()
    } else {
        give(script)
    }
}

/// A page's cosmetic resources as JSON: `{"hide": [selector], "exceptions": [selector], "generichide": bool,
/// "script": scriptlet code, "procedural": [parsed procedural/action AST]}`.
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
                image.as_ptr(),
                c"GET".as_ptr()
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
                image.as_ptr(),
                c"GET".as_ptr()
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
                std::ptr::null(),
                c"GET".as_ptr()
            ));
            bay_blocker_free(blocker);
        }
    }

    #[test]
    fn c_abi_preserves_method_specific_rules() {
        // A POST-only rule from uBlock's privacy list must not block GET requests.
        let list = c"||perplexity.ai/rest/metrics/collect^$xhr,1p,method=post";
        let lists = [list.as_ptr()];
        unsafe {
            let blocker = bay_blocker_new(lists.as_ptr(), std::ptr::null(), 1);
            let url = c"https://perplexity.ai/rest/metrics/collect";
            let source = c"https://perplexity.ai/";
            for (method, expected) in [(c"POST", true), (c"GET", false)] {
                assert_eq!(
                    bay_blocker_should_block(
                        blocker,
                        url.as_ptr(),
                        source.as_ptr(),
                        c"xmlhttprequest".as_ptr(),
                        method.as_ptr(),
                    ),
                    expected,
                );
            }
            bay_blocker_free(blocker);
        }
    }

    #[test]
    fn c_abi_reads_lists_that_are_not_utf8_and_returns_rewrites() {
        unsafe {
            // A Latin-1 byte in a comment must not cost the list its rules.
            let list = b"! caf\xe9\n||ads.example^\n$removeparam=fbclid\n\0";
            let lists = [list.as_ptr().cast::<c_char>()];
            let blocker = bay_blocker_new(lists.as_ptr(), std::ptr::null(), 1);
            let page = c"https://site.example/";
            assert!(bay_blocker_should_block(
                blocker,
                c"https://ads.example/a.js".as_ptr(),
                page.as_ptr(),
                c"script".as_ptr(),
                c"GET".as_ptr(),
            ));
            let url = c"https://news.example/?a=1&fbclid=x";
            let result = bay_blocker_match(
                blocker,
                url.as_ptr(),
                url.as_ptr(),
                c"document".as_ptr(),
                c"GET".as_ptr(),
            );
            assert!(!result.blocked && result.redirect.is_null());
            assert_eq!(take(result.rewrite), "https://news.example/?a=1");
            assert!(bay_blocker_scriptlets(blocker, page.as_ptr()).is_null());
            bay_blocker_free(blocker);
        }
    }

    #[test]
    fn c_abi_applies_response_rules() {
        unsafe {
            let list = c"||cdn.example^$script,header=server:nginx\nstream.example##^responseheader(set-cookie)";
            let blocker = bay_blocker_new([list.as_ptr()].as_ptr(), std::ptr::null(), 1);
            assert!(bay_blocker_has_response_modifiers(blocker));
            let script = c"https://cdn.example/ad.js";
            let source = c"https://site.example/";
            let answer = take(bay_blocker_response(
                blocker,
                script.as_ptr(),
                source.as_ptr(),
                c"script".as_ptr(),
                c"GET".as_ptr(),
                std::ptr::null(),
                c"[[\"Server\",\"nginx\"]]".as_ptr(),
            ));
            let answer: serde_json::Value = serde_json::from_str(&answer).unwrap();
            assert_eq!(answer["blocked"], true);
            assert!(bay_blocker_response(
                blocker,
                script.as_ptr(),
                source.as_ptr(),
                c"script".as_ptr(),
                c"GET".as_ptr(),
                std::ptr::null(),
                c"[]".as_ptr(),
            )
            .is_null());
            let stream = c"https://stream.example/";
            let answer = take(bay_blocker_response(
                blocker,
                stream.as_ptr(),
                stream.as_ptr(),
                c"document".as_ptr(),
                c"GET".as_ptr(),
                std::ptr::null(),
                c"[[\"Set-Cookie\",\"a=b\"]]".as_ptr(),
            ));
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&answer).unwrap()["remove"],
                serde_json::json!(["set-cookie"])
            );
            bay_blocker_free(blocker);
        }
    }

    #[test]
    fn c_abi_returns_and_frees_redirect_resources() {
        unsafe {
            let list = c"||ads.example^$script,redirect=noopjs";
            let blocker = bay_blocker_new([list.as_ptr()].as_ptr(), std::ptr::null(), 1);
            assert!(bay_blocker_use_resources(blocker, c"[{\"name\":\"noop.js\",\"aliases\":[\"noopjs\"],\"kind\":{\"mime\":\"application/javascript\"},\"content\":\"Lyogbm9vcCAqLw==\"}]".as_ptr()));
            let result = bay_blocker_match(
                blocker,
                c"https://ads.example/a.js".as_ptr(),
                c"https://site.example/".as_ptr(),
                c"script".as_ptr(),
                c"GET".as_ptr(),
            );
            assert!(result.blocked);
            assert_eq!(
                take(result.redirect),
                "data:application/javascript;base64,Lyogbm9vcCAqLw=="
            );
            bay_blocker_free(blocker);
        }
    }
}
