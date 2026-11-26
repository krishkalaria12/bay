//! C ABI (`include/bay_lists.h`), linked into both desktop hosts through `bay-desktop`. Strings returned to the caller
//! are owned by Rust; release them with `bay_string_free` (`bay_adblock.h`). JSON goes in and out as text.
//!
//! A `BayLists` holds the catalogue and the settings behind a lock, so any thread may call it; nothing on it touches
//! the disk except `bay_lists_open` and `bay_lists_save`. The functions that take a directory instead of a handle work
//! on the list files and block on the disk.

use std::ffi::{CStr, CString, c_char};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use bay_adblock::{Blocker, ListCounts};
use serde_json::{Value, json};

use crate::files::{self, Built, ListSource, Stored};
use crate::{Catalogue, FIRST_UPDATE_SECONDS, Settings, UPDATE_EVERY_SECONDS, VERSION};

pub struct BayLists {
    directory: PathBuf,
    catalogue: Catalogue,
    languages: Vec<String>,
    state: Mutex<State>,
}

struct State {
    settings: Settings,
    counts: Vec<(String, ListCounts)>,
    parse_ms: f64,
    ready: bool,
}

/// A built engine on its way to the host, which applies it ([`bay_lists_apply`]) or drops it.
pub struct BayListsBuilt(Built);

/// # Safety
/// `text` must be null or a valid NUL-terminated string.
unsafe fn read(text: *const c_char) -> Option<String> {
    // SAFETY: the caller passes null or a valid string.
    (!text.is_null()).then(|| {
        unsafe { CStr::from_ptr(text) }
            .to_string_lossy()
            .into_owned()
    })
}

fn give(text: String) -> *mut c_char {
    CString::new(text).map_or(std::ptr::null_mut(), CString::into_raw)
}

fn give_json(value: &Value) -> *mut c_char {
    give(value.to_string())
}

/// A JSON array of strings; anything else reads as empty.
///
/// # Safety
/// `text` must be null or a valid NUL-terminated string.
unsafe fn read_ids(text: *const c_char) -> Vec<String> {
    // SAFETY: as the caller's.
    unsafe { read(text) }
        .and_then(|text| serde_json::from_str::<Vec<Value>>(&text).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|id| id.as_str().map(str::to_owned))
        .collect()
}

impl BayLists {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl State {
    fn stats(&self, timing: &Value) -> Value {
        let (network, cosmetic) =
            self.counts
                .iter()
                .fold((0.0, 0.0), |(network, cosmetic), (_, count)| {
                    (
                        network + f64::from(count.network_filters),
                        cosmetic + f64::from(count.cosmetic_filters),
                    )
                });
        let timed = |key: &str| timing.get(key).and_then(Value::as_f64).unwrap_or(0.0);
        json!({
            "ready": self.ready,
            "enabled": self.settings.enabled,
            "networkFilters": network,
            "cosmeticFilters": cosmetic,
            "parseMs": self.parse_ms.round(),
            "lookups": timed("lookups"),
            "averageLookupMicros": timed("averageLookupMicros"),
            "maxLookupMicros": timed("maxLookupMicros"),
        })
    }
}

/// Opens the blocker's settings in `directory` (`<data>/Content Blocker`) with the catalogue at `catalogue`
/// (`filter_lists.json`); `languages` is a JSON array of the person's languages, for the regional lists on by default.
/// A missing or unreadable catalogue opens empty (`bay_lists_catalogue_size` is 0). Null only when `directory` is.
/// Free with `bay_lists_free`.
///
/// # Safety
/// `directory` and `catalogue` must be valid strings (`catalogue` may be null); `languages` null or a valid string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_open(
    directory: *const c_char,
    catalogue: *const c_char,
    languages: *const c_char,
) -> *mut BayLists {
    // SAFETY: as the caller's.
    let Some(directory) = (unsafe { read(directory) }).map(PathBuf::from) else {
        return std::ptr::null_mut();
    };
    // SAFETY: as the caller's.
    let catalogue = unsafe { read(catalogue) }
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|text| Catalogue::parse(&text))
        .unwrap_or_default();
    // SAFETY: as the caller's.
    let languages = unsafe { read_ids(languages) };
    let saved = std::fs::read_to_string(directory.join("settings.json")).ok();
    let settings = Settings::load(saved.as_deref(), &catalogue, &languages);
    Box::into_raw(Box::new(BayLists {
        directory,
        catalogue,
        languages,
        state: Mutex::new(State {
            settings,
            counts: Vec::new(),
            parse_ms: 0.0,
            ready: false,
        }),
    }))
}

/// # Safety
/// `lists` must be null or come from `bay_lists_open`, and not be used again.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_free(lists: *mut BayLists) {
    if !lists.is_null() {
        // SAFETY: as the caller's.
        drop(unsafe { Box::from_raw(lists) });
    }
}

/// How many lists the catalogue has.
///
/// # Safety
/// `lists` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_catalogue_size(lists: *const BayLists) -> usize {
    // SAFETY: as the caller's.
    unsafe { &*lists }.catalogue.lists.len()
}

/// Whether the catalogue has the list `id`.
///
/// # Safety
/// `lists` must be live; `id` a valid string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_known(lists: *const BayLists, id: *const c_char) -> bool {
    // SAFETY: as the caller's.
    let lists = unsafe { &*lists };
    // SAFETY: as the caller's.
    unsafe { read(id) }.is_some_and(|id| lists.catalogue.list(&id).is_some())
}

/// The chosen lists in catalogue order, for `bay_lists_build`: `[{"id": "…", "hosts": bool}]`.
///
/// # Safety
/// `lists` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_selected(lists: *const BayLists) -> *mut c_char {
    // SAFETY: as the caller's.
    let lists = unsafe { &*lists };
    let selected = lists.lock().settings.selected.clone();
    let chosen: Vec<Value> = lists
        .catalogue
        .in_order(&selected)
        .map(|list| json!({ "id": list.id, "hosts": list.hosts }))
        .collect();
    give_json(&Value::Array(chosen))
}

/// The ids of the chosen lists in catalogue order: a JSON array, for `bay_lists_seed`, `bay_lists_absent` and
/// `bay_lists_due`.
///
/// # Safety
/// `lists` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_selected_ids(lists: *const BayLists) -> *mut c_char {
    // SAFETY: as the caller's.
    let lists = unsafe { &*lists };
    give_json(&json!(
        lists.lock().settings.selected_in_order(&lists.catalogue)
    ))
}

/// The URLs to download list `id` from, first choice first: a JSON array, or null for a list the catalogue lacks.
///
/// # Safety
/// `lists` must be live; `id` a valid string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_urls(lists: *const BayLists, id: *const c_char) -> *mut c_char {
    // SAFETY: as the caller's.
    let lists = unsafe { &*lists };
    // SAFETY: as the caller's.
    let Some(list) = unsafe { read(id) }.and_then(|id| lists.catalogue.list(&id).cloned()) else {
        return std::ptr::null_mut();
    };
    give_json(&json!(list.urls))
}

/// What the request filter needs: `{"enabled": bool, "allowed": [hosts], "pages": [hosts]}`.
///
/// # Safety
/// `lists` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_live(lists: *const BayLists) -> *mut c_char {
    // SAFETY: as the caller's.
    let live = unsafe { &*lists }.lock().settings.live();
    give_json(&json!(live))
}

/// # Safety
/// `lists` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_enabled(lists: *const BayLists) -> bool {
    // SAFETY: as the caller's.
    unsafe { &*lists }.lock().settings.enabled
}

/// Turns the blocker on or off. True when that turned it back on, so its lists may have gone stale meanwhile.
///
/// # Safety
/// `lists` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_set_enabled(lists: *const BayLists, enabled: bool) -> bool {
    // SAFETY: as the caller's.
    let mut state = unsafe { &*lists }.lock();
    let was = std::mem::replace(&mut state.settings.enabled, enabled);
    enabled && !was
}

/// Turns list `id` on or off: 1 when the selection changed, 0 when it already was, -1 for a list the catalogue lacks.
///
/// # Safety
/// `lists` must be live; `id` a valid string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_set_list(
    lists: *const BayLists,
    id: *const c_char,
    enabled: bool,
) -> i32 {
    // SAFETY: as the caller's.
    let lists = unsafe { &*lists };
    // SAFETY: as the caller's.
    let Some(id) = unsafe { read(id) }.filter(|id| lists.catalogue.list(id).is_some()) else {
        return -1;
    };
    i32::from(lists.lock().settings.set_list(&id, enabled))
}

/// Whether the blocker is paused on `host` (a URL or host) or a site covering it.
///
/// # Safety
/// `lists` must be live; `host` a valid string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_is_allowed(lists: *const BayLists, host: *const c_char) -> bool {
    // SAFETY: as the caller's.
    let lists = unsafe { &*lists };
    // SAFETY: as the caller's.
    unsafe { read(host) }.is_some_and(|host| lists.lock().settings.is_allowed(&host))
}

/// Pauses the blocker on a site, or blocks there again (ending every pause that covers it). False when `host` has no
/// host.
///
/// # Safety
/// `lists` must be live; `host` a valid string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_set_allowed(
    lists: *const BayLists,
    host: *const c_char,
    allowed: bool,
) -> bool {
    // SAFETY: as the caller's.
    let lists = unsafe { &*lists };
    // SAFETY: as the caller's.
    unsafe { read(host) }
        .is_some_and(|host| lists.lock().settings.set_allowed(&host, allowed).is_ok())
}

/// Visit Anyway on a blocked page, for this session or always (`remember`); taking it back ends both. False when
/// `host` has no host.
///
/// # Safety
/// `lists` must be live; `host` a valid string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_set_page_allowed(
    lists: *const BayLists,
    host: *const c_char,
    allowed: bool,
    remember: bool,
) -> bool {
    // SAFETY: as the caller's.
    let lists = unsafe { &*lists };
    // SAFETY: as the caller's.
    unsafe { read(host) }.is_some_and(|host| {
        lists
            .lock()
            .settings
            .set_page_allowed(&host, allowed, remember)
            .is_ok()
    })
}

/// Writes `settings.json`. Blocks on the disk. False when it couldn't.
///
/// # Safety
/// `lists` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_save(lists: *const BayLists) -> bool {
    // SAFETY: as the caller's.
    let lists = unsafe { &*lists };
    let text = lists.lock().settings.to_json();
    std::fs::create_dir_all(&lists.directory).is_ok()
        && std::fs::write(lists.directory.join("settings.json"), text).is_ok()
}

/// The blocker's numbers for Settings: `{"ready", "enabled", "networkFilters", "cosmeticFilters", "parseMs",
/// "lookups", "averageLookupMicros", "maxLookupMicros"}`. `timing`: the host's request-filter timing,
/// `{"lookups", "averageLookupMicros", "maxLookupMicros"}`, or null.
///
/// # Safety
/// `lists` must be live; `timing` null or a valid string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_stats(
    lists: *const BayLists,
    timing: *const c_char,
) -> *mut c_char {
    // SAFETY: as the caller's.
    let timing = unsafe { read(timing) }
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    // SAFETY: as the caller's.
    give_json(&unsafe { &*lists }.lock().stats(&timing))
}

/// Everything Settings › Privacy shows: `{"enabled", "version", "lists": [{"id", "title", "category", "enabled",
/// "defaultOn", "filters"}], "allowedHosts", "allowedPages", "stats"}`. `timing` as for `bay_lists_stats`.
///
/// # Safety
/// `lists` must be live; `timing` null or a valid string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_state(
    lists: *const BayLists,
    timing: *const c_char,
) -> *mut c_char {
    // SAFETY: as the caller's.
    let lists = unsafe { &*lists };
    // SAFETY: as the caller's.
    let timing = unsafe { read(timing) }
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let state = lists.lock();
    let rows: Vec<Value> = lists
        .catalogue
        .lists
        .iter()
        .map(|list| {
            let filters = state
                .counts
                .iter()
                .find(|(id, _)| *id == list.id)
                .map_or(0.0, |(_, count)| {
                    f64::from(count.network_filters) + f64::from(count.cosmetic_filters)
                });
            json!({
                "id": list.id,
                "title": list.title,
                "category": list.category,
                "enabled": state.settings.selected.contains(&list.id),
                "defaultOn": list.on_by_default(&lists.languages),
                "filters": filters,
            })
        })
        .collect();
    give_json(&json!({
        "enabled": state.settings.enabled,
        "version": VERSION,
        "lists": rows,
        "allowedHosts": state.settings.allowed_hosts,
        "allowedPages": state.settings.allowed_pages,
        "stats": state.stats(&timing),
    }))
}

/// When to first check for list updates after launch, in seconds.
#[unsafe(no_mangle)]
pub extern "C" fn bay_lists_first_update_seconds() -> f64 {
    FIRST_UPDATE_SECONDS
}

/// How often to check for list updates after that, in seconds.
#[unsafe(no_mangle)]
pub extern "C" fn bay_lists_update_every_seconds() -> f64 {
    UPDATE_EVERY_SECONDS
}

/// Copies bundled lists (`bundled/<id>.txt`; `bundled` may be null) in for the `ids` (a JSON array) with no file yet.
/// The ids still without one, as a JSON array. Blocks on the disk.
///
/// # Safety
/// `directory` must be a valid string; `bundled` and `ids` null or valid strings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_seed(
    directory: *const c_char,
    bundled: *const c_char,
    ids: *const c_char,
) -> *mut c_char {
    // SAFETY: as the caller's.
    let (Some(directory), bundled, ids) = (
        unsafe { read(directory) },
        unsafe { read(bundled) },
        unsafe { read_ids(ids) },
    ) else {
        return std::ptr::null_mut();
    };
    give_json(&json!(files::seed(
        Path::new(&directory),
        bundled.as_deref().map(Path::new),
        &ids
    )))
}

/// The `ids` (a JSON array) with no list file, as a JSON array. Blocks on the disk.
///
/// # Safety
/// `directory` must be a valid string; `ids` null or a valid string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_absent(
    directory: *const c_char,
    ids: *const c_char,
) -> *mut c_char {
    // SAFETY: as the caller's.
    let (Some(directory), ids) = (unsafe { read(directory) }, unsafe { read_ids(ids) }) else {
        return std::ptr::null_mut();
    };
    give_json(&json!(files::absent(Path::new(&directory), &ids)))
}

/// The `ids` (a JSON array) whose list has gone stale by `now` (seconds since 1970), or was never fetched, as a JSON
/// array. Blocks on the disk.
///
/// # Safety
/// `directory` must be a valid string; `ids` null or a valid string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_due(
    directory: *const c_char,
    ids: *const c_char,
    now: f64,
) -> *mut c_char {
    // SAFETY: as the caller's.
    let (Some(directory), ids) = (unsafe { read(directory) }, unsafe { read_ids(ids) }) else {
        return std::ptr::null_mut();
    };
    give_json(&json!(files::due(Path::new(&directory), &ids, now)))
}

/// Keeps a downloaded list `id` when it is one, and records when it was fetched (`now`, seconds since 1970): 1 when
/// its file changed, 0 when it was the same, -1 when it isn't a list (try the next URL), -2 when it couldn't be written.
/// Blocks on the disk.
///
/// # Safety
/// `directory`, `id` must be valid strings; `body` must point to `length` bytes (it may be null when `length` is 0).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_store(
    directory: *const c_char,
    id: *const c_char,
    body: *const u8,
    length: usize,
    now: f64,
) -> i32 {
    // SAFETY: as the caller's.
    let (Some(directory), Some(id)) = (unsafe { read(directory) }, unsafe { read(id) }) else {
        return -2;
    };
    let body = if body.is_null() || length == 0 {
        &[][..]
    } else {
        // SAFETY: the caller passes `length` readable bytes.
        unsafe { std::slice::from_raw_parts(body, length) }
    };
    match files::store(Path::new(&directory), &id, body, now) {
        Ok(Stored::Changed) => 1,
        Ok(Stored::Unchanged) => 0,
        Ok(Stored::Rejected) => -1,
        Err(_) => -2,
    }
}

/// Builds the engine for `lists` (`bay_lists_selected`'s JSON) from the files in `directory`: from the cache when
/// `use_cache` and the files are the same, else compiled and cached. `resources`: the scriptlet and redirect resources
/// file, or null. Blocks on the disk and the CPU. Apply it with `bay_lists_apply`, or free it with
/// `bay_lists_built_free`.
///
/// # Safety
/// `directory` must be a valid string; `lists` and `resources` null or valid strings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_build(
    directory: *const c_char,
    lists: *const c_char,
    resources: *const c_char,
    use_cache: bool,
) -> *mut BayListsBuilt {
    // SAFETY: as the caller's.
    let Some(directory) = (unsafe { read(directory) }) else {
        return std::ptr::null_mut();
    };
    // SAFETY: as the caller's.
    let sources = unsafe { sources_of(lists) };
    // SAFETY: as the caller's.
    let resources = unsafe { read(resources) }.map(PathBuf::from);
    let built = files::build(
        Path::new(&directory),
        &sources,
        resources.as_deref(),
        use_cache,
    );
    Box::into_raw(Box::new(BayListsBuilt(built)))
}

/// What a build did, for the host's log: `{"lists": n, "ms": n, "cached": bool, "resources": bool}`.
///
/// # Safety
/// `built` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_built_report(built: *const BayListsBuilt) -> *mut c_char {
    // SAFETY: as the caller's.
    let built = &unsafe { &*built }.0;
    give_json(&json!({
        "lists": built.counts.len(),
        "ms": built.ms,
        "cached": built.cached,
        "resources": built.resources,
    }))
}

/// Takes the built engine as the current one: its counts and timing go into the stats, and the engine to the caller,
/// who frees it with `bay_blocker_free`. Consumes `built`.
///
/// # Safety
/// `lists` must be live; `built` must come from `bay_lists_build` and not be used again.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_apply(
    lists: *const BayLists,
    built: *mut BayListsBuilt,
) -> *mut Blocker {
    // SAFETY: as the caller's.
    let Built {
        blocker,
        counts,
        ms,
        ..
    } = unsafe { Box::from_raw(built) }.0;
    // SAFETY: as the caller's.
    let mut state = unsafe { &*lists }.lock();
    state.counts = counts;
    state.parse_ms = ms;
    state.ready = true;
    Box::into_raw(Box::new(blocker))
}

/// Drops a built engine the host didn't apply (a newer selection replaced it).
///
/// # Safety
/// `built` must be null or come from `bay_lists_build`, and not be used again.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_built_free(built: *mut BayListsBuilt) {
    if !built.is_null() {
        // SAFETY: as the caller's.
        drop(unsafe { Box::from_raw(built) });
    }
}

/// The chosen lists' WebKit rules key (`files::webkit_rules_key`): `lists` as for [`bay_lists_build`], `extra` the
/// person's own rules or null. Cheap: file sizes and times.
///
/// # Safety
/// Each argument must be null or a valid NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_webkit_key(
    directory: *const c_char,
    lists: *const c_char,
    extra: *const c_char,
) -> *mut c_char {
    // SAFETY: as the caller's.
    let (Some(directory), sources, extra) = (
        unsafe { read(directory) },
        unsafe { sources_of(lists) },
        unsafe { read(extra) },
    ) else {
        return std::ptr::null_mut();
    };
    let ids: Vec<String> = sources
        .iter()
        .filter(|list| files::list_path(Path::new(&directory), &list.id).exists())
        .map(|list| list.id.clone())
        .collect();
    give(files::webkit_rules_key(
        Path::new(&directory),
        &ids,
        &extra.unwrap_or_default(),
    ))
}

/// The chosen lists' WebKit content rules (`files::webkit_rules`), a JSON array. Blocks on the disk and the CPU.
///
/// # Safety
/// Each argument must be null or a valid NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_lists_webkit_rules(
    directory: *const c_char,
    lists: *const c_char,
    extra: *const c_char,
) -> *mut c_char {
    // SAFETY: as the caller's.
    let (Some(directory), sources, extra) = (
        unsafe { read(directory) },
        unsafe { sources_of(lists) },
        unsafe { read(extra) },
    ) else {
        return std::ptr::null_mut();
    };
    give(files::webkit_rules(
        Path::new(&directory),
        &sources,
        &extra.unwrap_or_default(),
    ))
}

/// `bay_lists_selected`'s JSON as list sources; anything else reads as none.
///
/// # Safety
/// `lists` must be null or a valid NUL-terminated string.
unsafe fn sources_of(lists: *const c_char) -> Vec<ListSource> {
    // SAFETY: as the caller's.
    unsafe { read(lists) }
        .and_then(|text| serde_json::from_str::<Vec<Value>>(&text).ok())
        .unwrap_or_default()
        .iter()
        .filter_map(|list| {
            Some(ListSource {
                id: list.get("id")?.as_str()?.to_owned(),
                hosts: list.get("hosts").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    unsafe extern "C" {
        fn bay_string_free(text: *mut c_char);
        fn bay_blocker_free(blocker: *mut std::ffi::c_void);
    }

    fn text(value: &str) -> CString {
        CString::new(value).unwrap()
    }

    fn take(raw: *mut c_char) -> Value {
        assert!(!raw.is_null());
        // SAFETY: a string this library returned.
        let value =
            serde_json::from_str(&unsafe { CStr::from_ptr(raw) }.to_string_lossy()).unwrap();
        // SAFETY: as above, released once.
        unsafe { bay_string_free(raw) };
        value
    }

    #[test]
    fn a_host_runs_the_blocker_through_the_c_functions() {
        let directory = tempfile::tempdir().unwrap();
        let resources = tempfile::tempdir().unwrap();
        let catalogue = resources.path().join("filter_lists.json");
        std::fs::write(
            &catalogue,
            r#"{"lists":[
                {"id":"ublock-filters","title":"uBlock","urls":["https://a.test/u.txt"],"defaultOn":true},
                {"id":"DEU-0","lang":"de","urls":["https://b.test/de.txt"]}
            ]}"#,
        )
        .unwrap();
        let bundled = resources.path().join("FilterLists");
        std::fs::create_dir(&bundled).unwrap();
        std::fs::write(
            bundled.join("ublock-filters.txt"),
            "! Title: u\n||ads.example^\n##.banner\n",
        )
        .unwrap();

        let dir = text(directory.path().to_str().unwrap());
        let catalogue = text(catalogue.to_str().unwrap());
        let bundled = text(bundled.to_str().unwrap());
        let languages = text(r#"["de-AT"]"#);
        // SAFETY: every pointer below is a live CString or a handle this test owns.
        unsafe {
            let lists = bay_lists_open(dir.as_ptr(), catalogue.as_ptr(), languages.as_ptr());
            assert_eq!(bay_lists_catalogue_size(lists), 2);
            let ids = take(bay_lists_selected_ids(lists));
            assert_eq!(ids, json!(["ublock-filters", "DEU-0"]));
            let ids = text(&ids.to_string());
            assert_eq!(
                take(bay_lists_seed(dir.as_ptr(), bundled.as_ptr(), ids.as_ptr())),
                json!(["DEU-0"])
            );
            assert_eq!(
                take(bay_lists_urls(lists, text("DEU-0").as_ptr())),
                json!(["https://b.test/de.txt"])
            );
            assert!(bay_lists_urls(lists, text("nope").as_ptr()).is_null());

            let body = b"! Expires: 1 d\n||werbung.example^\n";
            assert_eq!(
                bay_lists_store(
                    dir.as_ptr(),
                    text("DEU-0").as_ptr(),
                    body.as_ptr(),
                    body.len(),
                    10.0
                ),
                1
            );
            assert_eq!(
                take(bay_lists_due(dir.as_ptr(), ids.as_ptr(), 11.0)),
                json!(["ublock-filters"])
            );

            let selected = text(&take(bay_lists_selected(lists)).to_string());
            let built = bay_lists_build(dir.as_ptr(), selected.as_ptr(), std::ptr::null(), true);
            assert_eq!(take(bay_lists_built_report(built))["lists"], json!(2));
            let blocker = bay_lists_apply(lists, built);
            assert!(!blocker.is_null());
            bay_blocker_free(blocker.cast());

            let timing = text(r#"{"lookups":4,"averageLookupMicros":1.5,"maxLookupMicros":3}"#);
            let state = take(bay_lists_state(lists, timing.as_ptr()));
            assert_eq!(state["version"], json!(VERSION));
            assert_eq!(
                state["lists"][1],
                json!({"id":"DEU-0","title":"DEU-0","category":"ads","enabled":true,"defaultOn":true,"filters":1.0})
            );
            assert_eq!(state["stats"]["networkFilters"], json!(2.0));
            assert_eq!(state["stats"]["cosmeticFilters"], json!(1.0));
            assert_eq!(state["stats"]["lookups"], json!(4.0));
            assert_eq!(state["stats"]["ready"], json!(true));

            assert_eq!(bay_lists_set_list(lists, text("nope").as_ptr(), true), -1);
            assert_eq!(bay_lists_set_list(lists, text("DEU-0").as_ptr(), false), 1);
            assert_eq!(bay_lists_set_list(lists, text("DEU-0").as_ptr(), false), 0);
            assert!(bay_lists_set_allowed(
                lists,
                text("https://www.site.test/").as_ptr(),
                true
            ));
            assert!(!bay_lists_set_allowed(lists, text("").as_ptr(), true));
            assert!(bay_lists_is_allowed(lists, text("www.site.test").as_ptr()));
            assert!(bay_lists_set_page_allowed(
                lists,
                text("blocked.test").as_ptr(),
                true,
                false
            ));
            assert_eq!(
                take(bay_lists_live(lists)),
                json!({"enabled": true, "allowed": ["www.site.test"], "pages": ["blocked.test"]})
            );
            assert!(!bay_lists_set_enabled(lists, false));
            assert!(bay_lists_set_enabled(lists, true));
            assert!(bay_lists_save(lists));
            bay_lists_free(lists);

            // Reopened, the saved settings come back; the session page doesn't.
            let lists = bay_lists_open(dir.as_ptr(), catalogue.as_ptr(), languages.as_ptr());
            assert_eq!(
                take(bay_lists_selected_ids(lists)),
                json!(["ublock-filters"])
            );
            assert_eq!(take(bay_lists_live(lists))["pages"], json!([]));
            assert!(bay_lists_is_allowed(
                lists,
                text("https://www.site.test").as_ptr()
            ));
            bay_lists_free(lists);
        }
    }

    /// Every C function here is declared in the header the hosts include, and the header declares nothing else.
    #[test]
    fn the_header_declares_exactly_these_functions() {
        use std::collections::BTreeSet;

        let names = |pattern: &str, text: &str| -> BTreeSet<String> {
            let pattern = regex::Regex::new(pattern).unwrap();
            text.lines()
                .filter(|line| !line.trim_start().starts_with("//"))
                .filter_map(|line| pattern.captures(line).map(|found| found[1].to_owned()))
                .collect()
        };
        let defined = names(r#"extern "C" fn (bay_lists_\w+)\("#, include_str!("ffi.rs"));
        let declared = names(
            r"\b(bay_lists_\w+)\(",
            include_str!("../include/bay_lists.h"),
        );
        assert_eq!(defined.len(), 29);
        assert_eq!(declared, defined);
    }
}
