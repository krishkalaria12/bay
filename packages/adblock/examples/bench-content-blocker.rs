//! Offline macOS C ABI benchmark. Build the release library before running this example.
//!
//! cargo build --release --locked --manifest-path packages/adblock/Cargo.toml
//! cargo run --release --locked --manifest-path packages/adblock/Cargo.toml --example bench-content-blocker -- [options]

use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::error::Error;
use std::ffi::{c_char, c_int, c_void, CStr, CString, OsStr, OsString};
use std::fs;
use std::hint::black_box;
use std::path::{Path, PathBuf};
use std::time::Instant;

type Result<T> = std::result::Result<T, Box<dyn Error>>;
type Blocker = *mut c_void;

#[repr(C)]
struct Match {
    blocked: bool,
    redirect: *mut c_char,
    rewrite: *mut c_char,
    rewrite_any_origin: bool,
}

type New = unsafe extern "C" fn(*const *const c_char, *const bool, *const u8, usize) -> Blocker;
type Free = unsafe extern "C" fn(Blocker);
type StringFree = unsafe extern "C" fn(*mut c_char);
type Request = unsafe extern "C" fn(
    Blocker,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
) -> Match;
type Response = unsafe extern "C" fn(
    Blocker,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
) -> *mut c_char;
type Gate = unsafe extern "C" fn(
    Blocker,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
    i32,
    *const c_char,
    *const c_char,
) -> bool;
type Page = unsafe extern "C" fn(Blocker, *const c_char) -> *mut c_char;
type Resources = unsafe extern "C" fn(Blocker, *const c_char) -> bool;
type Body = unsafe extern "C" fn(
    Blocker,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
    *const u8,
    usize,
    *mut usize,
) -> *mut u8;
type BytesFree = unsafe extern "C" fn(*mut u8, usize);

#[cfg_attr(target_os = "linux", link(name = "dl"))]
extern "C" {
    fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn dlerror() -> *const c_char;
    fn dlclose(handle: *mut c_void) -> c_int;
}

struct Library(*mut c_void);

impl Library {
    fn open(path: &Path) -> Result<Self> {
        let path = CString::new(path.as_os_str().as_encoded_bytes())?;
        // RTLD_NOW is 2 on macOS and Linux. Symbols are resolved against this handle only.
        let handle = unsafe { dlopen(path.as_ptr(), 2) };
        if handle.is_null() {
            return Err(Self::error().into());
        }
        Ok(Self(handle))
    }

    fn symbol(&self, name: &CStr) -> Result<*mut c_void> {
        let pointer = unsafe { dlsym(self.0, name.as_ptr()) };
        if pointer.is_null() {
            return Err(Self::error().into());
        }
        Ok(pointer)
    }

    fn error() -> String {
        let error = unsafe { dlerror() };
        if error.is_null() {
            "dynamic library lookup failed".to_owned()
        } else {
            unsafe { CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned()
        }
    }
}

impl Drop for Library {
    fn drop(&mut self) {
        unsafe { dlclose(self.0) };
    }
}

struct Api {
    new: New,
    free: Free,
    string_free: StringFree,
    request: Request,
    response: Response,
    gate: Gate,
    scriptlets: Page,
    cosmetic: Page,
    resources: Resources,
    body: Body,
    bytes_free: BytesFree,
    _library: Library,
}

impl Api {
    fn load(path: &Path) -> Result<Self> {
        let library = Library::open(path)?;
        // Each signature mirrors include/bay_adblock.h. Keep the library alive for all calls.
        macro_rules! load {
            ($name:literal, $signature:ty) => {
                unsafe {
                    std::mem::transmute::<*mut c_void, $signature>(
                        library
                            .symbol(CStr::from_bytes_with_nul(concat!($name, "\0").as_bytes())?)?,
                    )
                }
            };
        }
        Ok(Self {
            new: load!("bay_blocker_new_with_permissions", New),
            free: load!("bay_blocker_free", Free),
            string_free: load!("bay_string_free", StringFree),
            request: load!("bay_blocker_match", Request),
            response: load!("bay_blocker_response", Response),
            gate: load!("bay_blocker_body_filter_applies", Gate),
            scriptlets: load!("bay_blocker_scriptlets", Page),
            cosmetic: load!("bay_blocker_cosmetic", Page),
            resources: load!("bay_blocker_use_resources", Resources),
            body: load!("bay_blocker_body_filter", Body),
            bytes_free: load!("bay_bytes_free", BytesFree),
            _library: library,
        })
    }

    unsafe fn take(&self, pointer: *mut c_char) -> Result<Value> {
        if pointer.is_null() {
            return Ok(Value::Null);
        }
        let text = CStr::from_ptr(pointer).to_str().map(str::to_owned);
        (self.string_free)(pointer);
        Ok(Value::String(text?))
    }
}

struct OwnedBlocker<'a> {
    pointer: Blocker,
    api: &'a Api,
}

impl Drop for OwnedBlocker<'_> {
    fn drop(&mut self) {
        unsafe { (self.api.free)(self.pointer) };
    }
}

#[cfg(target_os = "macos")]
fn sha256(bytes: &[u8]) -> Result<String> {
    #[link(name = "System")]
    extern "C" {
        fn CC_SHA256(data: *const c_void, length: u32, digest: *mut u8) -> *mut u8;
    }
    let length = u32::try_from(bytes.len())?;
    let mut digest = [0; 32];
    unsafe { CC_SHA256(bytes.as_ptr().cast(), length, digest.as_mut_ptr()) };
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(not(target_os = "macos"))]
fn sha256(_: &[u8]) -> Result<String> {
    Err("this benchmark uses macOS CommonCrypto for SHA-256".into())
}

struct Options {
    library: PathBuf,
    rounds: usize,
    iterations: usize,
    documents: bool,
}

fn options(crate_root: &Path) -> Result<Option<Options>> {
    let mut options = Options {
        library: crate_root.join("target/release/libbay_adblock.dylib"),
        rounds: 7,
        iterations: 1000,
        documents: false,
    };
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        let (name, inline) = arg
            .to_str()
            .and_then(|arg| arg.split_once('='))
            .map_or((arg.as_os_str(), None), |(name, value)| {
                (OsStr::new(name), Some(OsString::from(value)))
            });
        match name.to_str() {
            Some("--library") => {
                options.library = inline
                    .or_else(|| args.next())
                    .ok_or("--library requires a path")?
                    .into();
            }
            Some("--rounds" | "--iterations") => {
                let value = inline
                    .or_else(|| args.next())
                    .ok_or("missing numeric option value")?;
                let value = value
                    .to_str()
                    .ok_or("invalid numeric option value")?
                    .parse()?;
                if value == 0 {
                    return Err("rounds and iterations must be positive".into());
                }
                if name == "--rounds" {
                    options.rounds = value;
                } else {
                    options.iterations = value;
                }
            }
            Some("--documents") if inline.is_none() => options.documents = true,
            Some("-h" | "--help") if inline.is_none() => {
                println!(
                    "Offline macOS C ABI benchmark. Build the release library first.\n\
                     Options: --library PATH --rounds N --iterations N --documents"
                );
                return Ok(None);
            }
            _ => return Err(format!("unknown option: {}", arg.to_string_lossy()).into()),
        }
    }
    Ok(Some(options))
}

#[derive(Deserialize)]
struct Catalogue {
    lists: Vec<List>,
}

#[derive(Deserialize)]
struct List {
    id: String,
    #[serde(default)]
    hosts: bool,
}

#[derive(Deserialize)]
struct Fixture {
    url: String,
    rules: Vec<String>,
    prefix: String,
    fragment: String,
    repeat: usize,
    suffix: String,
}

struct Case {
    url: CString,
    kind: CString,
    mime: CString,
}

fn cases() -> Vec<Case> {
    [
        (
            "https://example.com/app.js",
            "script",
            "application/javascript",
        ),
        ("https://cdn.example.net/site.css", "stylesheet", "text/css"),
        (
            "https://example.org/api/items?q=hello",
            "xmlhttprequest",
            "application/json",
        ),
        (
            "https://doubleclick.net/ad.js",
            "script",
            "application/javascript",
        ),
        (
            "https://example.com/?fbclid=tracker&keep=1",
            "document",
            "text/html",
        ),
        (
            "https://go.skimresources.com/?url=https%3A%2F%2Fexample.org%2F",
            "document",
            "text/html",
        ),
        ("https://www.youtube.com/watch?v=1", "document", "text/html"),
        ("https://www.twitch.tv/", "document", "text/html"),
    ]
    .into_iter()
    .map(|(url, kind, mime)| Case {
        url: CString::new(url).unwrap(),
        kind: CString::new(kind).unwrap(),
        mime: CString::new(mime).unwrap(),
    })
    .collect()
}

fn rounded(value: f64, scale: f64) -> f64 {
    (value * scale).round_ties_even() / scale
}

fn measure(
    count: usize,
    rounds: usize,
    iterations: usize,
    warmup: usize,
    mut operation: impl FnMut(usize) -> Result<Value>,
) -> Result<(Value, Value)> {
    let answers = (0..count).map(&mut operation).collect::<Result<Vec<_>>>()?;
    for _ in 0..warmup {
        for index in 0..count {
            black_box(operation(index)?);
        }
    }
    let mut samples = Vec::with_capacity(rounds);
    for _ in 0..rounds {
        let started = Instant::now();
        for _ in 0..iterations {
            for index in 0..count {
                black_box(operation(index)?);
            }
        }
        samples
            .push(started.elapsed().as_secs_f64() * 1_000_000.0 / iterations as f64 / count as f64);
    }
    let mut sorted = samples.clone();
    sorted.sort_by(f64::total_cmp);
    let median = if rounds % 2 == 0 {
        (sorted[rounds / 2 - 1] + sorted[rounds / 2]) / 2.0
    } else {
        sorted[rounds / 2]
    };
    Ok((
        json!({
            "median_us": rounded(median, 1000.0),
            "samples_us": samples.into_iter().map(|sample| rounded(sample, 1000.0)).collect::<Vec<_>>(),
        }),
        json!(answers),
    ))
}

fn run() -> Result<()> {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let Some(options) = options(crate_root)? else {
        return Ok(());
    };
    let root = crate_root.parent().unwrap().parent().unwrap();
    let api = Api::load(&fs::canonicalize(&options.library)?)?;
    let catalogue: Catalogue = serde_json::from_slice(&fs::read(
        root.join("packages/chromium/ios/filter_lists.json"),
    )?)?;
    let mut paths = fs::read_dir(root.join("packages/chromium/vendor/filter-lists"))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    paths.retain(|path| path.extension().is_some_and(|extension| extension == "txt"));
    paths.sort();
    if paths.is_empty() {
        return Err("no bundled lists; run packages/chromium/scripts/filter-lists.sh first".into());
    }
    let host_lists: HashSet<_> = catalogue
        .lists
        .iter()
        .filter(|list| list.hosts)
        .map(|list| list.id.as_str())
        .collect();
    let mut texts = paths
        .iter()
        .map(fs::read)
        .collect::<std::io::Result<Vec<_>>>()?;
    let mut hosts: Vec<bool> = paths
        .iter()
        .map(|path| host_lists.contains(path.file_stem().unwrap().to_str().unwrap()))
        .collect();
    let mut permissions: Vec<u8> = paths
        .iter()
        .map(|path| {
            u8::from(
                path.file_stem()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("ublock-"),
            )
        })
        .collect();
    let fixture: Option<Fixture> = if options.documents {
        let fixture: Fixture = serde_json::from_slice(&fs::read(
            crate_root.join("fixtures/html-filter-perf.json"),
        )?)?;
        texts.push(fixture.rules.join("\n").into_bytes());
        hosts.push(false);
        permissions.push(0);
        Some(fixture)
    } else {
        None
    };
    let mut hash_input = Vec::new();
    for (index, text) in texts.iter().enumerate() {
        if index != 0 {
            hash_input.push(0);
        }
        hash_input.extend_from_slice(text);
    }
    let list_sha256 = sha256(&hash_input)?;
    drop(hash_input);
    let c_texts = texts
        .iter()
        .map(|text| CString::new(text.as_slice()))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let pointers: Vec<_> = c_texts.iter().map(|text| text.as_ptr()).collect();
    let started = Instant::now();
    let pointer = unsafe {
        (api.new)(
            pointers.as_ptr(),
            hosts.as_ptr(),
            permissions.as_ptr(),
            texts.len(),
        )
    };
    let build_ms = started.elapsed().as_secs_f64() * 1000.0;
    if pointer.is_null() {
        return Err("could not create blocker".into());
    }
    let blocker = OwnedBlocker { pointer, api: &api };
    if options.documents {
        let resources = CString::new(fs::read(
            root.join("packages/chromium/vendor/blocker-resources/blocker-resources.json"),
        )?)?;
        if !unsafe { (api.resources)(blocker.pointer, resources.as_ptr()) } {
            return Err(
                "invalid scriptlet resources; run packages/chromium/scripts/blocker-resources.sh"
                    .into(),
            );
        }
    }
    let cases = cases();
    let mut timings = Map::new();
    let mut answers = Map::new();
    let operations: &[&str] = if options.documents {
        &["request", "response", "body_gate", "scriptlets", "cosmetic"]
    } else {
        &["request", "response", "body_gate"]
    };
    for &name in operations {
        let (timing, answer) = measure(
            cases.len(),
            options.rounds,
            options.iterations,
            100,
            |index| {
                let case = &cases[index];
                // Inputs outlive each call; returned allocations are copied and released via this library.
                unsafe {
                    Ok(match name {
                        "request" => {
                            let result = (api.request)(
                                blocker.pointer,
                                case.url.as_ptr(),
                                c"https://example.com/".as_ptr(),
                                case.kind.as_ptr(),
                                c"GET".as_ptr(),
                            );
                            // Release both allocations even if one unexpectedly contains invalid UTF-8.
                            let redirect = api.take(result.redirect);
                            let rewrite = api.take(result.rewrite);
                            json!([
                                result.blocked,
                                redirect?,
                                rewrite?,
                                result.rewrite_any_origin
                            ])
                        }
                        "response" => api.take((api.response)(
                            blocker.pointer,
                            case.url.as_ptr(),
                            c"https://example.com/".as_ptr(),
                            case.kind.as_ptr(),
                            c"GET".as_ptr(),
                            c"1.1.1.1".as_ptr(),
                            c"[[\"server\",\"nginx\"]]".as_ptr(),
                        ))?,
                        "body_gate" => json!((api.gate)(
                            blocker.pointer,
                            case.url.as_ptr(),
                            c"https://example.com/".as_ptr(),
                            case.kind.as_ptr(),
                            c"GET".as_ptr(),
                            200,
                            case.mime.as_ptr(),
                            c"".as_ptr(),
                        )),
                        "scriptlets" => {
                            api.take((api.scriptlets)(blocker.pointer, case.url.as_ptr()))?
                        }
                        "cosmetic" => {
                            api.take((api.cosmetic)(blocker.pointer, case.url.as_ptr()))?
                        }
                        _ => unreachable!(),
                    })
                }
            },
        )?;
        timings.insert(name.to_owned(), timing);
        answers.insert(name.to_owned(), answer);
    }
    if let Some(fixture) = fixture {
        let url = CString::new(fixture.url)?;
        let body = fixture.prefix + &fixture.fragment.repeat(fixture.repeat) + &fixture.suffix;
        let (timing, answer) = measure(1, options.rounds, options.iterations.min(5), 1, |_| {
            let mut length = 0;
            let pointer = unsafe {
                (api.body)(
                    blocker.pointer,
                    url.as_ptr(),
                    url.as_ptr(),
                    c"document".as_ptr(),
                    c"GET".as_ptr(),
                    c"text/html".as_ptr(),
                    body.as_ptr(),
                    body.len(),
                    &mut length,
                )
            };
            if pointer.is_null() {
                return Ok(Value::Null);
            }
            let digest = sha256(unsafe { std::slice::from_raw_parts(pointer, length) });
            unsafe { (api.bytes_free)(pointer, length) };
            Ok(json!({"length": length, "sha256": digest?}))
        })?;
        timings.insert("html_body".to_owned(), timing);
        answers.insert("html_body".to_owned(), answer);
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "lists": texts.len(),
            "list_sha256": list_sha256,
            "cases": cases.len(),
            "build_ms": rounded(build_ms, 10.0),
            "timings": timings,
            "answers": answers,
        }))?
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("bench-content-blocker: {error}");
        std::process::exit(1);
    }
}
