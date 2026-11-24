//! The blocker's files in `<data>/Content Blocker`, laid out as both desktop hosts kept them:
//!
//! - `lists/<id>.txt`: each downloaded (or bundled) list.
//! - `lists.json`: when each list was fetched and how long it stays fresh, `{"<id>": {"fetched": s, "expires": s}}`.
//! - `engine.dat`, `engine.key`, `engine.lists.json`: the compiled engine, the key it was built for and its lists.
//!
//! Everything here blocks on the disk; the hosts call it off their main threads.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Instant, UNIX_EPOCH};

use bay_adblock::{Blocker, FilterList, ListCounts};
use regex::bytes::Regex;
use serde_json::{Map, Value, json};

use crate::ENGINE_FORMAT;

/// The longest list accepted, as both hosts capped downloads.
const MAX_LIST: usize = 32 * 1024 * 1024;
/// The shortest text that can be a list rather than an error.
const MIN_LIST: usize = 16;
/// How far into a list its `! Expires:` header is looked for.
const EXPIRES_HEAD: usize = 4096;

/// A list to compile: its id and whether it's a hosts file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListSource {
    pub id: String,
    pub hosts: bool,
}

/// What [`store`] did with a downloaded list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stored {
    /// Not a filter list (an error page, or empty): try the list's next URL.
    Rejected,
    /// The same as the file on disk; only its freshness was recorded.
    Unchanged,
    /// Written: rebuild the engine.
    Changed,
}

/// An engine and what it was built from.
pub struct Built {
    pub blocker: Blocker,
    /// Each compiled list with its rule counts, in compile order.
    pub counts: Vec<(String, ListCounts)>,
    pub ms: f64,
    /// Loaded from `engine.dat` rather than compiled.
    pub cached: bool,
    /// The scriptlet and redirect resources loaded.
    pub resources: bool,
}

pub fn list_path(directory: &Path, id: &str) -> PathBuf {
    directory.join("lists").join(format!("{id}.txt"))
}

/// Writes through a temporary file beside `path`, so a reader (or a mapped engine) never sees a half-written file.
fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut draft = path.as_os_str().to_owned();
    draft.push(".tmp");
    let draft = PathBuf::from(draft);
    std::fs::write(&draft, bytes)?;
    std::fs::rename(&draft, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&draft);
    })
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// How long a list stays fresh, in seconds, from its `! Expires: 4 days (update frequency)` header: 12 hours to a
/// week, else 4 days.
pub fn expires_after(text: &[u8]) -> f64 {
    static EXPIRES: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?im)^[!#]\s*Expires:\s*(\d+)\s*(h|d)").expect("valid pattern")
    });
    const DEFAULT: f64 = 4.0 * 86400.0;
    let head = &text[..text.len().min(EXPIRES_HEAD)];
    let Some(found) = EXPIRES.captures(head) else {
        return DEFAULT;
    };
    let Some(count) = std::str::from_utf8(&found[1])
        .ok()
        .and_then(|digits| digits.parse::<f64>().ok())
    else {
        return DEFAULT;
    };
    let unit = if found[2].eq_ignore_ascii_case(b"h") {
        3600.0
    } else {
        86400.0
    };
    (count * unit).clamp(12.0 * 3600.0, 7.0 * 86400.0)
}

/// A filter list, not an error page: text that doesn't start like HTML once a byte order mark and whitespace are
/// skipped. Bytes, not a decoded prefix: a prefix can end inside a multibyte character.
pub fn looks_like_list(data: &[u8]) -> bool {
    if !(MIN_LIST..=MAX_LIST).contains(&data.len()) {
        return false;
    }
    let data = data.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(data);
    let first = data
        .iter()
        .find(|byte| !matches!(byte, b' ' | b'\t' | b'\n' | 0x0B | 0x0C | b'\r'));
    first.is_some_and(|byte| *byte != b'<')
}

/// Copies bundled lists (`bundled/<id>.txt`) in for the ids with no file yet; they count as fetched long ago, so they
/// update soon. The ids still without a file.
pub fn seed(directory: &Path, bundled: Option<&Path>, ids: &[String]) -> Vec<String> {
    let _ = std::fs::create_dir_all(directory.join("lists"));
    ids.iter()
        .filter(|id| {
            let path = list_path(directory, id);
            if path.exists() {
                return false;
            }
            let copied = bundled
                .map(|bundled| bundled.join(format!("{id}.txt")))
                .is_some_and(|source| source.exists() && std::fs::copy(source, &path).is_ok());
            !copied
        })
        .cloned()
        .collect()
}

/// The ids with no list file.
pub fn absent(directory: &Path, ids: &[String]) -> Vec<String> {
    ids.iter()
        .filter(|id| !list_path(directory, id).exists())
        .cloned()
        .collect()
}

/// The ids whose list has gone stale by `now` (seconds since 1970), or was never fetched.
pub fn due(directory: &Path, ids: &[String], now: f64) -> Vec<String> {
    let info = read_json(&directory.join("lists.json"));
    ids.iter()
        .filter(|id| {
            let entry = info.as_ref().and_then(|info| info.get(id.as_str()));
            let number = |key: &str| {
                entry
                    .and_then(|entry| entry.get(key))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
            };
            number("fetched") + number("expires") <= now
        })
        .cloned()
        .collect()
}

/// Keeps a downloaded list, when it is one, and records when it was fetched (`now`, seconds since 1970).
pub fn store(directory: &Path, id: &str, body: &[u8], now: f64) -> io::Result<Stored> {
    if !looks_like_list(body) {
        return Ok(Stored::Rejected);
    }
    std::fs::create_dir_all(directory.join("lists"))?;
    let path = list_path(directory, id);
    let changed = std::fs::read(&path).map_or(true, |old| old != body);
    if changed {
        write_atomically(&path, body)?;
    }
    let index = directory.join("lists.json");
    let mut entries = match read_json(&index) {
        Some(Value::Object(entries)) => entries,
        _ => Map::new(),
    };
    entries.insert(
        id.to_owned(),
        json!({ "fetched": now, "expires": expires_after(body) }),
    );
    let text = serde_json::to_vec_pretty(&Value::Object(entries)).map_err(io::Error::other)?;
    write_atomically(&index, &text)?;
    Ok(if changed {
        Stored::Changed
    } else {
        Stored::Unchanged
    })
}

/// The cache key for an engine of these lists: the engine format, then each list file's size and modification time.
pub fn engine_key(directory: &Path, ids: &[String]) -> String {
    let mut key = ENGINE_FORMAT.to_owned();
    for id in ids {
        let Ok(metadata) = std::fs::metadata(list_path(directory, id)) else {
            continue;
        };
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0.0, |since| since.as_secs_f64());
        key.push_str(&format!("\n{id} {} {modified:.0}", metadata.len()));
    }
    key
}

/// The cached engine, its rules read from the file rather than copied. Mapped where replacing a mapped file is safe;
/// Windows refuses to replace a file that's mapped, so there it's read whole.
fn load_engine(path: &Path) -> Option<Blocker> {
    #[cfg(not(windows))]
    let bytes: Arc<dyn AsRef<[u8]> + Send + Sync> = {
        let file = std::fs::File::open(path).ok()?;
        // SAFETY: engine.dat is only ever replaced whole (write_atomically), never written in place, so the mapped
        // pages can't change under the engine.
        Arc::new(unsafe { memmap2::Mmap::map(&file) }.ok()?)
    };
    #[cfg(windows)]
    let bytes: Arc<dyn AsRef<[u8]> + Send + Sync> = Arc::new(std::fs::read(path).ok()?);
    Blocker::deserialize(bytes)
}

fn compile(directory: &Path, lists: &[ListSource]) -> Blocker {
    // Lossy, so a list with a stray byte that isn't UTF-8 still gives its rules (a strict read would give none).
    let texts: Vec<String> = lists
        .iter()
        .map(|list| {
            std::fs::read(list_path(directory, &list.id))
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .unwrap_or_default()
        })
        .collect();
    let filters: Vec<FilterList> = lists
        .iter()
        .zip(&texts)
        .map(|(list, text)| FilterList {
            text,
            hosts: list.hosts,
            // As in uBO, only its own uAssets lists may invoke privileged scriptlets.
            permissions: u8::from(list.id.starts_with("ublock-")),
        })
        .collect();
    Blocker::from_lists(&filters)
}

/// Compiles `present` and caches the engine with its key and lists (`ids`). A failed write leaves the cache as it was.
fn compile_and_cache(
    directory: &Path,
    present: &[ListSource],
    ids: &[String],
    key: &str,
) -> Blocker {
    let compiled = compile(directory, present);
    let engine_path = directory.join("engine.dat");
    if write_atomically(&engine_path, &compiled.serialize()).is_err() {
        return compiled;
    }
    let _ = write_atomically(
        &directory.join("engine.lists.json"),
        json!(ids).to_string().as_bytes(),
    );
    let _ = write_atomically(&directory.join("engine.key"), key.as_bytes());
    if cfg!(windows) {
        return compiled;
    }
    // From the mapped file, as at the next launch: the compiled rules are on the heap, the mapped file's cost no dirty
    // memory.
    load_engine(&engine_path).unwrap_or(compiled)
}

/// The engine for `lists` (in order; those without a file are left out), from the cache when `use_cache` and it was
/// built from the same files, else compiled and cached. `resources`: the scriptlet and redirect resources, which the
/// cache doesn't hold, so they're loaded either way.
pub fn build(
    directory: &Path,
    lists: &[ListSource],
    resources: Option<&Path>,
    use_cache: bool,
) -> Built {
    let start = Instant::now();
    let present: Vec<ListSource> = lists
        .iter()
        .filter(|list| list_path(directory, &list.id).exists())
        .cloned()
        .collect();
    let ids: Vec<String> = present.iter().map(|list| list.id.clone()).collect();
    let key = engine_key(directory, &ids);
    let cache_matches = use_cache
        && std::fs::read_to_string(directory.join("engine.key")).is_ok_and(|cached| cached == key)
        && read_json(&directory.join("engine.lists.json")) == Some(json!(ids));
    let from_cache = if cache_matches {
        load_engine(&directory.join("engine.dat"))
    } else {
        None
    };
    let cached = from_cache.is_some();
    let blocker = match from_cache {
        Some(blocker) => blocker,
        None => compile_and_cache(directory, &present, &ids, &key),
    };
    let resources = resources.is_some_and(|path| blocker.use_resources_file(path));
    let counts = blocker.list_counts();
    let counts = if counts.len() == ids.len() {
        ids.into_iter().zip(counts).collect()
    } else {
        Vec::new()
    };
    Built {
        blocker,
        counts,
        ms: start.elapsed().as_secs_f64() * 1000.0,
        cached,
        resources,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &[u8] = b"! Title: Test\n! Expires: 2 days\n||ads.example^\n##.banner\n";

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn freshness_comes_from_the_expires_header_within_bounds() {
        assert_eq!(expires_after(LIST), 2.0 * 86400.0);
        assert_eq!(expires_after(b"# Expires: 6 hours\n"), 12.0 * 3600.0);
        assert_eq!(expires_after(b"! expires: 30 d\n"), 7.0 * 86400.0);
        assert_eq!(expires_after(b"! Expires: 20h\n"), 20.0 * 3600.0);
        assert_eq!(expires_after(b"||x^\n"), 4.0 * 86400.0);
        let mut late = vec![b'!'; EXPIRES_HEAD];
        late.extend_from_slice(b"\n! Expires: 1 d\n");
        assert_eq!(expires_after(&late), 4.0 * 86400.0);
    }

    #[test]
    fn error_pages_and_scraps_are_not_lists() {
        assert!(looks_like_list(LIST));
        assert!(looks_like_list(b"\xEF\xBB\xBF \n\t! a list with a BOM"));
        assert!(!looks_like_list(b"  \n<!doctype html><html>"));
        assert!(!looks_like_list(b"\xEF\xBB\xBF<html><body>error</body>"));
        assert!(!looks_like_list(b"short"));
        assert!(!looks_like_list(&[b' '; 64]));
    }

    #[test]
    fn stored_lists_record_freshness_and_whether_they_changed() {
        let directory = tempfile::tempdir().unwrap();
        let dir = directory.path();
        assert_eq!(
            store(dir, "a", b"<html>not a list</html>", 1.0).unwrap(),
            Stored::Rejected
        );
        assert!(!list_path(dir, "a").exists());
        assert_eq!(store(dir, "a", LIST, 100.0).unwrap(), Stored::Changed);
        assert_eq!(store(dir, "a", LIST, 200.0).unwrap(), Stored::Unchanged);
        assert_eq!(store(dir, "b", LIST, 300.0).unwrap(), Stored::Changed);
        let info = read_json(&dir.join("lists.json")).unwrap();
        assert_eq!(info["a"], json!({ "fetched": 200.0, "expires": 172800.0 }));
        assert_eq!(info["b"]["fetched"], json!(300.0));
        assert_eq!(
            due(dir, &ids(&["a", "b", "never"]), 200.0 + 172800.0),
            ids(&["a", "never"])
        );
    }

    #[test]
    fn bundled_lists_seed_the_missing_files() {
        let directory = tempfile::tempdir().unwrap();
        let bundled = tempfile::tempdir().unwrap();
        std::fs::write(bundled.path().join("a.txt"), LIST).unwrap();
        let dir = directory.path();
        assert_eq!(
            seed(dir, Some(bundled.path()), &ids(&["a", "b"])),
            ids(&["b"])
        );
        assert_eq!(std::fs::read(list_path(dir, "a")).unwrap(), LIST);
        assert_eq!(absent(dir, &ids(&["a", "b"])), ids(&["b"]));
        assert_eq!(seed(dir, None, &ids(&["a", "b"])), ids(&["b"]));
    }

    #[test]
    fn the_engine_compiles_once_then_loads_from_the_cache() {
        let directory = tempfile::tempdir().unwrap();
        let dir = directory.path();
        store(dir, "ublock-filters", LIST, 1.0).unwrap();
        store(
            dir,
            "hosts",
            b"0.0.0.0 tracker.example\n0.0.0.0 ads2.example\n",
            1.0,
        )
        .unwrap();
        let lists = [
            ListSource {
                id: "ublock-filters".into(),
                hosts: false,
            },
            ListSource {
                id: "hosts".into(),
                hosts: true,
            },
            ListSource {
                id: "missing".into(),
                hosts: false,
            },
        ];
        let first = build(dir, &lists, None, true);
        assert!(!first.cached);
        let counted: Vec<_> = first.counts.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(counted, ["ublock-filters", "hosts"]);
        assert_eq!(first.counts[0].1.network_filters, 1);
        assert_eq!(first.counts[0].1.cosmetic_filters, 1);
        assert_eq!(first.counts[1].1.network_filters, 2);
        assert_eq!(
            read_json(&dir.join("engine.lists.json")),
            Some(json!(["ublock-filters", "hosts"]))
        );
        assert!(
            std::fs::read_to_string(dir.join("engine.key"))
                .unwrap()
                .starts_with("bay-adblock 6\nublock-filters ")
        );

        let second = build(dir, &lists, None, true);
        assert!(second.cached);
        assert_eq!(second.counts, first.counts);
        assert!(!build(dir, &lists, None, false).cached);

        // A changed list changes the key.
        store(dir, "hosts", b"0.0.0.0 tracker.example\n", 2.0).unwrap();
        let rebuilt = build(dir, &lists, None, true);
        assert!(!rebuilt.cached);
        assert_eq!(rebuilt.counts[1].1.network_filters, 1);
    }

    #[test]
    fn a_damaged_cache_is_rebuilt() {
        let directory = tempfile::tempdir().unwrap();
        let dir = directory.path();
        store(dir, "a", LIST, 1.0).unwrap();
        let lists = [ListSource {
            id: "a".into(),
            hosts: false,
        }];
        build(dir, &lists, None, true);
        std::fs::write(dir.join("engine.dat"), b"damaged").unwrap();
        let built = build(dir, &lists, None, true);
        assert!(!built.cached);
        assert_eq!(built.counts.len(), 1);
    }
}
