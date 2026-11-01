use std::collections::HashSet;
use std::sync::Mutex;

use adblock::lists::{FilterFormat, FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::Engine;
use serde::Serialize;

/// A network and cosmetic filter engine built from filter list text. Safe to share between threads.
pub struct Blocker {
    // The engine's default single-thread build is not `Sync`; matching takes microseconds, so a lock is cheap.
    engine: Mutex<Engine>,
}

#[derive(Serialize)]
pub struct CosmeticResources {
    /// Site-specific selectors to hide.
    pub hide: Vec<String>,
    /// Class and id selectors exempt from generic hiding on this site; pass back to [`Blocker::hidden_selectors`].
    pub exceptions: Vec<String>,
    /// True when the site turns generic hiding off (`$generichide`).
    pub generichide: bool,
}

/// One filter list for [`Blocker::from_lists`]: its text, in Adblock Plus syntax or as a hosts file.
pub struct FilterList<'a> {
    pub text: &'a str,
    pub hosts: bool,
}

/// How many rules of each kind a list gave the engine, in [`Blocker::from_lists`] order.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCounts {
    pub network_filters: u32,
    pub cosmetic_filters: u32,
}

/// What a page needs from the cosmetic filters, with its scriptlets ([`Blocker::page_resources`]).
#[derive(Serialize)]
pub struct PageResources {
    pub hide: Vec<String>,
    pub exceptions: Vec<String>,
    pub generichide: bool,
    /// Scriptlet code to run in the page's main world; empty without resources ([`Blocker::use_resources`]).
    pub script: String,
}

impl Blocker {
    /// Builds an engine from one or more filter lists joined into one text.
    pub fn new(lists: &str) -> Self {
        let mut set = FilterSet::new(false);
        set.add_filter_list(lists.to_owned(), ParseOptions::default());
        Self::from_engine(Engine::new_with_filter_set(set))
    }

    /// Builds an engine from separate lists, so each list's rule count can be read back ([`Blocker::list_counts`]).
    /// uBO's `!#if` blocks are resolved as uBO resolves them on Chromium.
    pub fn from_lists(lists: &[FilterList]) -> Self {
        Self::from_lists_for(lists, crate::Platform::DesktopChromium)
    }

    /// [`Blocker::from_lists`], resolving uBO's `!#if` blocks for `platform`.
    pub fn from_lists_for(lists: &[FilterList], platform: crate::Platform) -> Self {
        let mut set = FilterSet::new(false);
        for list in lists {
            let format = if list.hosts {
                FilterFormat::Hosts
            } else {
                FilterFormat::Standard
            };
            set.add_filter_list(
                crate::preprocess::preprocess_for(list.text, platform).into_owned(),
                ParseOptions {
                    format,
                    permissions: list_permissions(list.text),
                    ..ParseOptions::default()
                },
            );
        }
        Self::from_engine(Engine::new_with_filter_set(set))
    }

    fn from_engine(engine: Engine) -> Self {
        Self {
            engine: Mutex::new(engine),
        }
    }

    fn engine(&self) -> std::sync::MutexGuard<'_, Engine> {
        self.engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The engine in adblock-rust's binary format, to cache and load with [`Blocker::deserialize`].
    pub fn serialize(&self) -> Vec<u8> {
        self.engine().serialize()
    }

    /// An engine [`Blocker::serialize`] wrote, or `None` when the data is damaged or from another adblock-rust.
    pub fn deserialize(data: &[u8]) -> Option<Self> {
        let mut engine = Engine::default();
        engine.deserialize(data).ok()?;
        Some(Self::from_engine(engine))
    }

    /// Each list's rule counts, in the order the lists were given (kept through serialization).
    pub fn list_counts(&self) -> Vec<ListCounts> {
        self.engine()
            .get_debug_info()
            .source_info
            .iter()
            .map(|source| ListCounts {
                network_filters: source.network_filter_count,
                cosmetic_filters: source.cosmetic_filter_count,
            })
            .collect()
    }

    /// Redirect and scriptlet resources, as adblock-rust's `Resource` JSON array. False when it can't be read.
    pub fn use_resources(&self, json: &str) -> bool {
        let Ok(resources) = serde_json::from_str::<Vec<adblock::resources::Resource>>(json) else {
            return false;
        };
        self.engine().use_resources(resources);
        true
    }

    /// The page's cosmetic resources, its scriptlets included.
    pub fn page_resources(&self, url: &str) -> PageResources {
        let resources = self.engine().url_cosmetic_resources(url);
        let mut hide: Vec<String> = resources.hide_selectors.into_iter().collect();
        hide.sort();
        let mut exceptions: Vec<String> = resources.exceptions.into_iter().collect();
        exceptions.sort();
        PageResources {
            hide,
            exceptions,
            generichide: resources.generichide,
            script: resources.injected_script,
        }
    }

    /// What to do with a request: let it load, block it, or answer it with a harmless stand-in (`$redirect`, as a
    /// `data:` URL), which keeps pages that expect an ad script from breaking.
    pub fn check(&self, url: &str, source_url: &str, kind: &str) -> Check {
        let Ok(request) = Request::new(url, source_url, kind, "get") else {
            return Check::Allow;
        };
        let result = self.engine().check_network_request(&request);
        match result.redirect {
            Some(redirect) if result.should_block() || result.exception.is_none() => {
                Check::Redirect(redirect)
            }
            _ if result.should_block() => Check::Block,
            _ => Check::Allow,
        }
    }

    /// Redirect and scriptlet resources from a file of adblock-rust `Resource` JSON (`resources/resources.json`).
    pub fn use_resources_file(&self, path: &std::path::Path) -> bool {
        std::fs::read_to_string(path).is_ok_and(|json| self.use_resources(&json))
    }

    /// The scriptlets (`##+js(...)`) for a page, as one script to run in its main world at document start; empty when
    /// it has none.
    pub fn scriptlets(&self, url: &str) -> String {
        self.engine().url_cosmetic_resources(url).injected_script
    }

    /// Whether a request should be blocked. `kind` is a resource type such as `script`, `image` or `xhr`.
    pub fn should_block(&self, url: &str, source_url: &str, kind: &str) -> bool {
        let Ok(request) = Request::new(url, source_url, kind, "get") else {
            return false;
        };
        self.engine().check_network_request(&request).should_block()
    }

    pub fn cosmetic_resources(&self, url: &str) -> CosmeticResources {
        let resources = self.engine().url_cosmetic_resources(url);
        CosmeticResources {
            hide: resources.hide_selectors.into_iter().collect(),
            exceptions: resources.exceptions.into_iter().collect(),
            generichide: resources.generichide,
        }
    }

    /// Generic hiding selectors for the classes and ids a page uses.
    pub fn hidden_selectors(
        &self,
        classes: &[String],
        ids: &[String],
        exceptions: &[String],
    ) -> Vec<String> {
        let exceptions: HashSet<String> = exceptions.iter().cloned().collect();
        self.engine()
            .hidden_class_id_selectors(classes, ids, &exceptions)
    }
}

/// A request's fate, from [`Blocker::check`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Check {
    Allow,
    Block,
    /// Answer with this `data:` URL instead.
    Redirect(String),
}

/// uBO's "trusted" scriptlets (cookie and storage writers…) may only come from uBO's own lists, as in uBO itself.
/// Those lists are recognised by their title; resources/resources.json marks trusted scriptlets with this bit.
pub const TRUSTED_SCRIPTLETS: u8 = 0b1;

fn list_permissions(text: &str) -> adblock::resources::PermissionMask {
    let ubo = text
        .lines()
        .take(12)
        .any(|line| line.starts_with("! Title: uBlock"));
    adblock::resources::PermissionMask::from_bits(if ubo { TRUSTED_SCRIPTLETS } else { 0 })
}

/// Loads the engine cached at `cache` for `version` (a near-instant read), or builds it from the list files and
/// writes the cache for the next launch. Building parses every rule; loading only maps adblock-rust's binary format.
/// Resources aren't part of the cache, so `resources` (if given) is loaded either way.
pub fn load_cached(
    files: &[String],
    cache: &std::path::Path,
    version: &str,
    platform: crate::Platform,
    resources: Option<&std::path::Path>,
) -> std::io::Result<Blocker> {
    let blocker = load_engine(files, cache, version, platform)?;
    if let Some(resources) = resources {
        blocker.use_resources_file(resources);
    }
    Ok(blocker)
}

fn load_engine(
    files: &[String],
    cache: &std::path::Path,
    version: &str,
    platform: crate::Platform,
) -> std::io::Result<Blocker> {
    let header = format!("bay-adblock:{version}\n");
    if let Ok(bytes) = std::fs::read(cache) {
        if let Some(blocker) = bytes
            .strip_prefix(header.as_bytes())
            .and_then(Blocker::deserialize)
        {
            return Ok(blocker);
        }
    }
    let texts = files
        .iter()
        .map(std::fs::read_to_string)
        .collect::<std::io::Result<Vec<_>>>()?;
    let lists: Vec<FilterList> = texts
        .iter()
        .map(|text| FilterList { text, hosts: false })
        .collect();
    let blocker = Blocker::from_lists_for(&lists, platform);
    let mut bytes = header.into_bytes();
    bytes.extend(blocker.serialize());
    let draft = cache.with_extension("tmp");
    std::fs::write(&draft, &bytes)?;
    std::fs::rename(&draft, cache)?;
    Ok(blocker)
}

/// WebKit content-blocking rules for the lists, as a JSON array. WebKit compiles them itself.
#[cfg(not(target_os = "android"))]
pub fn content_blocking_rules(lists: &str) -> String {
    let mut set = FilterSet::new(true);
    let lists = crate::preprocess_for(lists, crate::Platform::IosWebKit);
    set.add_filter_list(lists.into_owned(), ParseOptions::default());
    let rules = set
        .into_content_blocking()
        .map(|(rules, _)| rules)
        .unwrap_or_default();
    serde_json::to_string(&rules).unwrap_or_else(|_| "[]".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str =
        "||ads.example^\n@@||ads.example/allowed^\nexample.com##.banner\n##.ad-slot\n";

    #[test]
    fn blocks_listed_hosts_and_honours_exceptions() {
        let blocker = Blocker::new(LIST);
        assert!(blocker.should_block(
            "https://ads.example/pixel.js",
            "https://site.example/",
            "script"
        ));
        assert!(!blocker.should_block(
            "https://ads.example/allowed/x.js",
            "https://site.example/",
            "script"
        ));
        assert!(!blocker.should_block(
            "https://cdn.example/app.js",
            "https://site.example/",
            "script"
        ));
    }

    #[test]
    fn returns_site_and_generic_cosmetic_rules() {
        let blocker = Blocker::new(LIST);
        assert_eq!(
            blocker.cosmetic_resources("https://example.com/").hide,
            vec![".banner".to_owned()]
        );
        assert_eq!(
            blocker.hidden_selectors(&["ad-slot".to_owned()], &[], &[]),
            vec![".ad-slot".to_owned()]
        );
    }

    #[test]
    fn counts_rules_per_list_and_reads_hosts_files() {
        let blocker = Blocker::from_lists(&[
            FilterList {
                text: LIST,
                hosts: false,
            },
            FilterList {
                text: "# hosts\n127.0.0.1 localhost\n0.0.0.0 tracker.example\n",
                hosts: true,
            },
        ]);
        assert_eq!(
            blocker.list_counts(),
            vec![
                ListCounts {
                    network_filters: 2,
                    cosmetic_filters: 2
                },
                ListCounts {
                    network_filters: 1,
                    cosmetic_filters: 0
                },
            ]
        );
        assert!(blocker.should_block(
            "https://tracker.example/t.gif",
            "https://site.example/",
            "image"
        ));
    }

    #[test]
    fn survives_serialization() {
        let blocker = Blocker::from_lists(&[FilterList {
            text: LIST,
            hosts: false,
        }]);
        let copy = Blocker::deserialize(&blocker.serialize()).expect("deserializes");
        assert!(copy.should_block(
            "https://ads.example/pixel.js",
            "https://site.example/",
            "script"
        ));
        assert_eq!(copy.list_counts(), blocker.list_counts());
        assert_eq!(
            copy.page_resources("https://example.com/").hide,
            vec![".banner".to_owned()]
        );
        assert!(Blocker::deserialize(b"not an engine").is_none());
    }

    #[test]
    fn injects_scriptlets_from_resources() {
        let blocker = Blocker::from_lists(&[FilterList {
            text: "example.com##+js(bay-test)\n",
            hosts: false,
        }]);
        assert!(blocker
            .page_resources("https://example.com/")
            .script
            .is_empty());
        let resources = r#"[{"name":"bay-test.js","aliases":[],"kind":{"mime":"application/javascript"},"content":"Y29uc29sZS5sb2coMSk=","dependencies":[],"permission":0}]"#;
        assert!(blocker.use_resources(resources));
        assert!(blocker
            .page_resources("https://example.com/")
            .script
            .contains("console.log(1)"));
        assert!(!blocker.use_resources("{"));
    }

    #[test]
    fn converts_lists_to_webkit_rules() {
        let rules: serde_json::Value = serde_json::from_str(&content_blocking_rules(LIST)).unwrap();
        let text = rules.to_string();
        assert!(rules.as_array().is_some_and(|rules| !rules.is_empty()));
        assert!(text.contains("ads\\\\.example") || text.contains("ads\\.example"));
        assert!(text.contains("css-display-none"));
    }

    #[test]
    fn caches_the_engine_per_version() {
        let dir = std::env::temp_dir().join(format!("bay-adblock-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let list = dir.join("list.txt");
        let cache = dir.join("engine.bin");
        std::fs::write(&list, "||ads.example^\n").unwrap();
        let files = vec![list.to_string_lossy().into_owned()];
        let built =
            load_cached(&files, &cache, "v1", crate::Platform::AndroidWebView, None).unwrap();
        assert!(built.should_block(
            "https://ads.example/a.js",
            "https://site.example/",
            "script"
        ));
        // A cached engine is used even when the lists have changed, until the version does.
        std::fs::write(&list, "||other.example^\n").unwrap();
        let cached =
            load_cached(&files, &cache, "v1", crate::Platform::AndroidWebView, None).unwrap();
        assert!(cached.should_block(
            "https://ads.example/a.js",
            "https://site.example/",
            "script"
        ));
        let rebuilt =
            load_cached(&files, &cache, "v2", crate::Platform::AndroidWebView, None).unwrap();
        assert!(!rebuilt.should_block(
            "https://ads.example/a.js",
            "https://site.example/",
            "script"
        ));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn redirects_runs_scriptlets_and_trusts_only_ublock_lists() {
        let resources = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/resources.json"
        ))
        .unwrap();
        let ubo = "! Title: uBlock filters\n||ads.example/ad.js$script,redirect=noop.js\nexample.com##+js(trusted-set-cookie, consent, accepted)\nexample.com##+js(set-constant, adsEnabled, false)\n";
        let other = "! Title: Another list\nother.example##+js(trusted-set-cookie, consent, accepted)\nother.example##+js(set-constant, adsEnabled, false)\n";
        let blocker = Blocker::from_lists(&[
            FilterList {
                text: ubo,
                hosts: false,
            },
            FilterList {
                text: other,
                hosts: false,
            },
        ]);
        assert!(blocker.use_resources(&resources));
        match blocker.check(
            "https://ads.example/ad.js",
            "https://site.example/",
            "script",
        ) {
            Check::Redirect(url) => assert!(url.starts_with("data:application/javascript;base64,")),
            other => panic!("expected a redirect, got {other:?}"),
        }
        assert_eq!(
            blocker.check(
                "https://cdn.example/app.js",
                "https://site.example/",
                "script"
            ),
            Check::Allow
        );
        // uBO's own list may use a trusted scriptlet; another list only gets the untrusted one.
        let trusted = blocker.scriptlets("https://example.com/");
        assert!(trusted.contains("consent"));
        assert!(trusted.contains("adsEnabled"));
        let untrusted = blocker.scriptlets("https://other.example/");
        assert!(untrusted.contains("adsEnabled"));
        assert!(!untrusted.contains("consent"));
    }
}
