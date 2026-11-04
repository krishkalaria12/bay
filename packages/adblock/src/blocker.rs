use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use adblock::engine::{SharedBytes, SERIALIZED_HEADER_LENGTH};
use adblock::lists::{FilterFormat, FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::resources::{InMemoryResourceStorage, PermissionMask, ResourceType};
use adblock::Engine;
use serde::Serialize;

use crate::modifiers::{self, Modifiers, ResponseMatch, Spec};

/// A network and cosmetic filter engine built from filter list text. Safe to share between threads.
pub struct Blocker {
    // The engine's default single-thread build is not `Sync`; matching takes microseconds, so a lock is cheap.
    engine: Mutex<Engine>,
    /// The lists' `$popup` rules as `$document` rules (crate::adapt), asked about pages a page opens.
    popups: Mutex<Engine>,
    /// The rules adblock-rust can't represent (crate::modifiers): URL skips, response headers, addresses, permissions.
    modifiers: Modifiers,
    /// Data URLs of the resources response rules answer with, which the engine's storage doesn't hand out.
    stand_ins: Mutex<HashMap<String, String>>,
}

/// [`Blocker::serialize`]'s format: this tag, three lengths (u64, little-endian: main engine, popup engine, modifier
/// spec JSON), then those pieces, each engine after the zero bytes of [`engine_padding`]. `BAY5` engines aren't aligned
/// and are rebuilt.
const SERIALIZED_TAG: &[u8; 4] = b"BAY6";

/// How many zero bytes put an engine written at `offset` where its rules start on an 8-byte boundary, for
/// `Engine::deserialize_shared` to read them in place.
fn engine_padding(offset: usize) -> usize {
    offset.wrapping_add(SERIALIZED_HEADER_LENGTH).wrapping_neg() % 8
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
    /// Permission bit 1 allows uBO's trusted scriptlets; grant only to Bay's uAssets catalogue entries.
    pub permissions: u8,
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
    /// Parsed procedural/action filters for the page's content script.
    pub procedural: Vec<serde_json::Value>,
}

#[derive(Default)]
pub struct RequestMatch {
    pub blocked: bool,
    /// A replacement resource as a data URL. Applies only when `blocked` is true.
    pub redirect: Option<String>,
    /// The URL to load instead, without the parameters `$removeparam` rules strip. Only when `blocked` is false.
    pub rewrite: Option<String>,
    /// Whether the rewrite may load from another origin (`$urlskip`), rather than the request's own.
    pub rewrite_any_origin: bool,
}

impl Blocker {
    /// Builds an engine from one or more filter lists joined into one text. Only uBO's own lists are trusted with
    /// `$urlskip`; use [`Blocker::from_lists`] to mark them.
    pub fn new(lists: &str) -> Self {
        let extracted = crate::modifiers::extract(lists, false);
        let adapted = crate::adapt::adapt(&extracted.list);
        let mut set = FilterSet::new(false);
        set.add_filter_list(adapted.main, ParseOptions::default());
        Self::from_engines(
            Engine::new_with_filter_set(set),
            plain_engine(&adapted.popups),
            Modifiers::new(extracted.spec),
        )
    }

    /// Builds an engine from separate lists, so each list's rule count can be read back ([`Blocker::list_counts`]).
    /// uBO's `!#if` blocks are resolved as uBO resolves them on Chromium.
    pub fn from_lists(lists: &[FilterList]) -> Self {
        let mut set = FilterSet::new(false);
        let mut popups = String::new();
        let mut spec = Spec::default();
        for list in lists {
            let format = if list.hosts {
                FilterFormat::Hosts
            } else {
                FilterFormat::Standard
            };
            if list.hosts {
                set.add_filter_list(
                    list.text.to_owned(),
                    ParseOptions {
                        format,
                        permissions: PermissionMask::from_bits(list.permissions),
                        ..ParseOptions::default()
                    },
                );
                continue;
            }
            let text = crate::preprocess::preprocess(list.text).into_owned();
            let extracted = crate::modifiers::extract(&text, list.permissions & 1 != 0);
            spec.merge(extracted.spec);
            let adapted = crate::adapt::adapt(&extracted.list);
            popups.push_str(&adapted.popups);
            let text = crate::adapt::block_documents_of_hostname_rules(&adapted.main);
            set.add_filter_list(
                text,
                ParseOptions {
                    format,
                    permissions: PermissionMask::from_bits(list.permissions),
                    ..ParseOptions::default()
                },
            );
        }
        Self::from_engines(
            Engine::new_with_filter_set(set),
            plain_engine(&popups),
            Modifiers::new(spec),
        )
    }

    fn from_engines(engine: Engine, popups: Engine, modifiers: Modifiers) -> Self {
        Self {
            engine: Mutex::new(engine),
            popups: Mutex::new(popups),
            modifiers,
            stand_ins: Mutex::new(HashMap::new()),
        }
    }

    fn engine(&self) -> std::sync::MutexGuard<'_, Engine> {
        lock(&self.engine)
    }

    /// The engine in adblock-rust's binary format, to cache and load with [`Blocker::deserialize`].
    pub fn serialize(&self) -> Vec<u8> {
        let main = self.engine().serialize();
        let popups = lock(&self.popups).serialize();
        let spec = serde_json::to_vec(self.modifiers.spec()).unwrap_or_default();
        // At most 7 bytes of padding before each engine.
        let mut data = Vec::with_capacity(
            SERIALIZED_TAG.len() + 24 + 2 * 7 + main.len() + popups.len() + spec.len(),
        );
        data.extend_from_slice(SERIALIZED_TAG);
        for length in [main.len(), popups.len(), spec.len()] {
            data.extend_from_slice(&(length as u64).to_le_bytes());
        }
        for engine in [&main, &popups] {
            data.resize(data.len() + engine_padding(data.len()), 0);
            data.extend_from_slice(engine);
        }
        data.extend_from_slice(&spec);
        data
    }

    /// An engine [`Blocker::serialize`] wrote, or `None` when the data is damaged or from another adblock-rust. It keeps
    /// `file` and reads its rules from there instead of copying them.
    pub fn deserialize(file: SharedBytes) -> Option<Self> {
        let data: &[u8] = (*file).as_ref();
        let rest = data.strip_prefix(SERIALIZED_TAG)?;
        let (main_length, rest) = rest.split_first_chunk::<8>()?;
        let (popup_length, rest) = rest.split_first_chunk::<8>()?;
        let (spec_length, _) = rest.split_first_chunk::<8>()?;
        let section = |start: usize, length: &[u8; 8]| {
            let length = usize::try_from(u64::from_le_bytes(*length)).ok()?;
            Some(start..start.checked_add(length)?)
        };

        let header = SERIALIZED_TAG.len() + 24;
        let main = section(header + engine_padding(header), main_length)?;
        let popups = section(
            main.end.checked_add(engine_padding(main.end))?,
            popup_length,
        )?;
        let spec = data.get(section(popups.end, spec_length)?)?;
        let read = |range| {
            let mut engine = Engine::default();
            engine
                .deserialize_shared(file.clone(), range)
                .ok()
                .map(|()| engine)
        };
        Some(Self::from_engines(
            read(main)?,
            read(popups)?,
            Modifiers::new(serde_json::from_slice(spec).ok()?),
        ))
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
        // Engine::use_resources silently ignores bad entries; reject the bundle whole instead.
        let mut storage = InMemoryResourceStorage::default();
        let wanted: HashSet<&str> = self.modifiers.stand_ins().collect();
        let mut stand_ins = HashMap::new();
        for resource in resources {
            for name in std::iter::once(&resource.name).chain(&resource.aliases) {
                if let (true, ResourceType::Mime(mime)) =
                    (wanted.contains(name.as_str()), &resource.kind)
                {
                    let mime: &str = mime.into();
                    let url = format!("data:{mime};base64,{}", resource.content);
                    stand_ins.insert(name.clone(), url);
                }
            }
            if storage.add_resource(resource).is_err() {
                return false;
            }
        }
        self.engine().use_resource_storage(storage);
        *lock(&self.stand_ins) = stand_ins;
        true
    }

    /// The page's cosmetic resources, its scriptlets included.
    pub fn page_resources(&self, url: &str) -> PageResources {
        let resources = self.engine().url_cosmetic_resources(url);
        let mut hide: Vec<String> = resources.hide_selectors.into_iter().collect();
        hide.sort();
        let mut exceptions: Vec<String> = resources.exceptions.into_iter().collect();
        exceptions.extend(self.modifiers.cosmetic_exceptions().iter().cloned());
        exceptions.sort();
        exceptions.dedup();
        let mut procedural: Vec<String> = resources.procedural_actions.into_iter().collect();
        procedural.sort();
        let script = scriptlet_source(resources.injected_script);
        PageResources {
            hide,
            exceptions,
            generichide: resources.generichide,
            script,
            procedural: procedural
                .into_iter()
                .filter_map(|rule| serde_json::from_str(&rule).ok())
                .collect(),
        }
    }

    /// Only the page's scriptlet code ([`Blocker::page_resources`]'s `script`), for a document about to start.
    pub fn scriptlets(&self, url: &str) -> String {
        let script = self.engine().url_cosmetic_resources(url).injected_script;
        scriptlet_source(script)
    }

    /// Whether a request should be blocked. `kind` is a resource type such as `script`, `image` or `xhr`.
    pub fn should_block(&self, url: &str, source_url: &str, kind: &str, method: &str) -> bool {
        self.match_request(url, source_url, kind, method).blocked
    }

    /// The Content-Security-Policy `$csp` rules add to a document's response, if any. `kind` is `document` or
    /// `subdocument`.
    pub fn content_security_policy(
        &self,
        url: &str,
        source_url: &str,
        kind: &str,
    ) -> Option<String> {
        let request = Request::new(url, source_url, kind, "GET").ok()?;
        self.engine().get_csp_directives(&request)
    }

    /// Whether a page may not open `url` in a new tab or window: a `$popup` rule, or a rule that blocks it as a document
    /// (uBO would show its block page in the new tab). A `$popup` exception decides first. `source_url` is the opener.
    fn blocks_popup(&self, url: &str, source_url: &str, method: &str) -> bool {
        let Ok(request) = Request::new(url, source_url, "document", method) else {
            return false;
        };
        let popup = lock(&self.popups).check_network_request(&request);
        if popup.exception.is_some() {
            return false;
        }
        popup.should_block() || self.engine().check_network_request(&request).should_block()
    }

    pub fn match_request(
        &self,
        url: &str,
        source_url: &str,
        kind: &str,
        method: &str,
    ) -> RequestMatch {
        if kind == "popup" {
            return RequestMatch {
                blocked: self.blocks_popup(url, source_url, method),
                ..RequestMatch::default()
            };
        }
        let Ok(request) = Request::new(url, source_url, kind, method) else {
            return RequestMatch::default();
        };
        let result = self.engine().check_network_request(&request);
        let engine_blocked = result.should_block();
        // A redirect-rule without a matching block must not redirect an allowed request.
        let redirect = if engine_blocked {
            result.redirect
        } else {
            None
        };
        let (blocked, rewrite, rewrite_any_origin) = self.modifiers.request(
            url,
            source_url,
            kind,
            method,
            engine_blocked,
            result.rewritten_url,
        );
        RequestMatch {
            blocked,
            redirect: if blocked { redirect } else { None },
            rewrite,
            rewrite_any_origin,
        }
    }

    /// Whether [`Blocker::response`] can change a response: `$header`, `$ipaddress`, `$permissions` or
    /// `##^responseheader`.
    pub fn has_response_modifiers(&self) -> bool {
        self.modifiers.has_response_rules()
    }

    /// Whether a response body can be rewritten: `$replace` or HTML `##^` filtering.
    pub fn has_body_modifiers(&self) -> bool {
        self.modifiers.has_body_rules()
    }

    /// Whether [`Blocker::filter_body`] should see this response (uBO's MIME, method and disposition gates, and a
    /// matching body rule). `status` is 0 when there is no response.
    #[allow(clippy::too_many_arguments)]
    pub fn body_filter_applies(
        &self,
        url: &str,
        source_url: &str,
        kind: &str,
        method: &str,
        status: i32,
        content_type: &str,
        content_disposition: &str,
    ) -> bool {
        self.modifiers.body_filter_applies(
            url,
            source_url,
            kind,
            method,
            status,
            content_type,
            content_disposition,
        )
    }

    /// The response body after `$replace` and HTML filtering, or `None` when it is unchanged.
    pub fn filter_body(
        &self,
        url: &str,
        source_url: &str,
        kind: &str,
        method: &str,
        content_type: &str,
        body: &[u8],
    ) -> Option<Vec<u8>> {
        self.modifiers
            .filter_body(url, source_url, kind, method, content_type, body)
    }

    /// Whether any `$requestheader` rule exists: every request would otherwise ask.
    pub fn has_request_header_modifiers(&self) -> bool {
        self.modifiers.has_request_header_rules()
    }

    /// The request headers `$requestheader` rules would look at for this request; none for most requests.
    pub fn request_header_names(
        &self,
        url: &str,
        source_url: &str,
        kind: &str,
        method: &str,
    ) -> Vec<String> {
        self.modifiers
            .request_header_names(url, source_url, kind, method)
    }

    /// Whether `$requestheader` blocks a request with these headers.
    pub fn request_headers_blocked(
        &self,
        url: &str,
        source_url: &str,
        kind: &str,
        method: &str,
        headers: &[(String, String)],
    ) -> bool {
        self.modifiers
            .request_headers_blocked(url, source_url, kind, method, headers)
    }

    /// Whether a response is blocked by what its hostname's CNAME `alias` points to, as uBO uncloaks one with its
    /// default settings: the replay is `scheme://alias/` (`cnameReplayFullURL` off), and a main frame
    /// (`cnameIgnoreRootDocument`), an alias of the same site (`cnameIgnore1stParty`) and a request an exception let
    /// through (`cnameIgnoreExceptions`) aren't uncloaked. A `$cname` exception lifts all but `$important` blocks.
    pub fn cname_blocked(
        &self,
        url: &str,
        alias: &str,
        source_url: &str,
        kind: &str,
        method: &str,
    ) -> bool {
        let host = modifiers::host_of(url);
        let alias = alias.trim_end_matches('.').to_ascii_lowercase();
        if kind == "document"
            || alias.is_empty()
            || alias == host
            || psl::domain_str(&alias).is_none()
            || psl::domain_str(&alias) == psl::domain_str(&host)
        {
            return false;
        }
        let Some(at) = url.find(host.as_str()) else {
            return false;
        };
        let rest = &url[at + host.len()..];
        let port = rest.find(['/', '?', '#']).map_or(rest, |end| &rest[..end]);
        let replay = format!("{}{alias}{port}/", &url[..at]);
        let (Ok(original), Ok(request)) = (
            Request::new(url, source_url, kind, method),
            Request::new(&replay, source_url, kind, method),
        ) else {
            return false;
        };
        let engine = self.engine();
        if engine.check_network_request(&original).exception.is_some() {
            return false;
        }
        let result = engine.check_network_request(&request);
        result.should_block() && (result.important || !self.modifiers.cname_excepted(source_url))
    }

    /// The response rules for a request: whether the response is blocked, headers to add, and headers to remove.
    /// `ip` is the response's remote address when the engine has one.
    pub fn response(
        &self,
        url: &str,
        source_url: &str,
        kind: &str,
        method: &str,
        ip: Option<&str>,
        headers: &[(String, String)],
    ) -> ResponseMatch {
        let mut matched = self
            .modifiers
            .response(url, source_url, kind, method, ip, headers);
        // A resource by name, as a data URL the engine can answer with.
        matched.stand_in = matched
            .stand_in
            .take()
            .and_then(|name| lock(&self.stand_ins).get(&name).cloned());
        matched
    }

    pub fn cosmetic_resources(&self, url: &str) -> CosmeticResources {
        let resources = self.engine().url_cosmetic_resources(url);
        let mut exceptions: Vec<String> = resources.exceptions.into_iter().collect();
        exceptions.extend(self.modifiers.cosmetic_exceptions().iter().cloned());
        exceptions.sort();
        exceptions.dedup();
        CosmeticResources {
            hide: resources.hide_selectors.into_iter().collect(),
            exceptions,
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

fn scriptlet_source(script: String) -> String {
    if script.is_empty() {
        return script;
    }
    // uBO's function resources read this object; scope it to this document's injection.
    format!("(function() {{\nconst scriptletGlobals = Object.create(null);\n{script}\n}})();")
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn plain_engine(rules: &str) -> Engine {
    let mut set = FilterSet::new(false);
    set.add_filter_list(rules.to_owned(), ParseOptions::default());
    Engine::new_with_filter_set(set)
}

/// WebKit content-blocking rules for the lists, as a JSON array. WebKit compiles them itself.
pub fn content_blocking_rules(lists: &str) -> String {
    let mut set = FilterSet::new(true);
    set.add_filter_list(lists.to_owned(), ParseOptions::default());
    let rules = set
        .into_content_blocking()
        .map(|(rules, _)| rules)
        .unwrap_or_default();
    serde_json::to_string(&rules).unwrap_or_else(|_| "[]".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const LIST: &str =
        "||ads.example^\n@@||ads.example/allowed^\nexample.com##.banner\n##.ad-slot\n";

    fn blocks_the_ad(blocker: &Blocker) -> bool {
        blocker.should_block(
            "https://ads.example/x.png",
            "https://news.example/",
            "image",
            "GET",
        )
    }

    #[test]
    fn a_deserialized_blocker_reads_its_rules_in_place_until_it_is_freed() {
        let file = Arc::new(Blocker::new(LIST).serialize());
        let blocker = Blocker::deserialize(file.clone()).expect("deserializes");
        // Both engines hold the file; neither took a copy.
        assert!(Arc::strong_count(&file) > 2);
        assert!(blocks_the_ad(&blocker));
        drop(blocker);
        assert_eq!(Arc::strong_count(&file), 1);
    }

    #[test]
    fn an_unaligned_file_is_copied_and_still_works() {
        // A byte past a Vec's start, which is aligned.
        struct Shifted(Vec<u8>);
        impl AsRef<[u8]> for Shifted {
            fn as_ref(&self) -> &[u8] {
                &self.0[1..]
            }
        }
        let mut shifted = vec![0];
        shifted.extend_from_slice(&Blocker::new(LIST).serialize());
        let file = Arc::new(Shifted(shifted));
        let blocker = Blocker::deserialize(file.clone()).expect("deserializes");
        assert_eq!(Arc::strong_count(&file), 1);
        assert!(blocks_the_ad(&blocker));
    }

    #[test]
    fn a_length_past_the_end_of_the_file_is_refused() {
        let bytes = Blocker::new(LIST).serialize();
        for field in 0..3 {
            let mut damaged = bytes.clone();
            let at = SERIALIZED_TAG.len() + field * 8;
            damaged[at..at + 8].copy_from_slice(&u64::MAX.to_le_bytes());
            assert!(Blocker::deserialize(Arc::new(damaged)).is_none());
        }
    }

    #[test]
    fn blocks_listed_hosts_and_honours_exceptions() {
        let blocker = Blocker::new(LIST);
        assert!(blocker.should_block(
            "https://ads.example/pixel.js",
            "https://site.example/",
            "script",
            "GET"
        ));
        assert!(!blocker.should_block(
            "https://ads.example/allowed/x.js",
            "https://site.example/",
            "script",
            "GET"
        ));
        assert!(!blocker.should_block(
            "https://cdn.example/app.js",
            "https://site.example/",
            "script",
            "GET"
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
                permissions: 0,
            },
            FilterList {
                text: "# hosts\n127.0.0.1 localhost\n0.0.0.0 tracker.example\n",
                hosts: true,
                permissions: 0,
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
            "image",
            "GET"
        ));
    }

    #[test]
    fn survives_serialization() {
        let blocker = Blocker::from_lists(&[FilterList {
            text: LIST,
            hosts: false,
            permissions: 0,
        }]);
        let copy = Blocker::deserialize(Arc::new(blocker.serialize())).expect("deserializes");
        assert!(copy.should_block(
            "https://ads.example/pixel.js",
            "https://site.example/",
            "script",
            "GET"
        ));
        assert_eq!(copy.list_counts(), blocker.list_counts());
        assert_eq!(
            copy.page_resources("https://example.com/").hide,
            vec![".banner".to_owned()]
        );
        assert!(Blocker::deserialize(Arc::new(b"not an engine".to_vec())).is_none());
    }

    #[test]
    fn injects_scriptlets_from_resources() {
        let blocker = Blocker::from_lists(&[FilterList {
            text: "example.com##+js(bay-test)\n",
            hosts: false,
            permissions: 0,
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
        assert!(!blocker.use_resources(r#"[{"name":"broken.js","kind":{"mime":"application/javascript"},"content":"not base64!"}]"#));
        assert!(blocker
            .page_resources("https://example.com/")
            .script
            .contains("console.log(1)"));
    }

    #[test]
    fn removes_tracking_parameters_from_allowed_documents_only() {
        let blocker = Blocker::new(
            "$removeparam=fbclid\n||ads.example^$document\n@@||keep.example^$removeparam\n",
        );
        let document = |url: &str| blocker.match_request(url, url, "document", "GET");
        assert_eq!(
            document("https://news.example/story?id=1&fbclid=abc")
                .rewrite
                .as_deref(),
            Some("https://news.example/story?id=1")
        );
        assert!(document("https://news.example/story?id=1")
            .rewrite
            .is_none());
        assert!(document("https://keep.example/?fbclid=abc")
            .rewrite
            .is_none());
        let blocked = document("https://ads.example/?fbclid=abc");
        assert!(blocked.blocked && blocked.rewrite.is_none());
    }

    #[test]
    fn removeparam_exceptions_survive_serialization() {
        let blocker = Blocker::from_lists(&[FilterList {
            text: "$removeparam=fbclid\n@@||web.archive.org/*/http$removeparam\n",
            hosts: false,
            permissions: 0,
        }]);
        let copy = Blocker::deserialize(Arc::new(blocker.serialize())).expect("deserializes");
        let archived = "https://web.archive.org/web/2020/https://site.example/?fbclid=abc";
        for engine in [&blocker, &copy] {
            assert!(engine
                .match_request(archived, archived, "document", "GET")
                .rewrite
                .is_none());
            let page = "https://site.example/?fbclid=abc";
            assert_eq!(
                engine
                    .match_request(page, page, "document", "GET")
                    .rewrite
                    .as_deref(),
                Some("https://site.example/")
            );
        }
        assert!(Blocker::deserialize(Arc::new(b"BAY3".to_vec())).is_none());
        assert!(Blocker::deserialize(Arc::new(vec![1, 2, 3])).is_none());
    }

    #[test]
    fn visits_are_blocked_by_hostname_doc_and_all_rules_and_not_others() {
        let blocker = Blocker::from_lists(&[
            FilterList {
                text: "||host.example^\n||doc.example/page$doc\n||all.example^$all\n||path.example/ad^\n\
                       ||script.example^$script\n||off.example^\n@@||off.example^$document\n",
                hosts: false,
                permissions: 0,
            },
            FilterList {
                text: "0.0.0.0 hosts.example\n",
                hosts: true,
                permissions: 0,
            },
        ]);
        let visit = |url: &str| blocker.match_request(url, url, "document", "GET").blocked;
        assert!(visit("https://host.example/"));
        assert!(visit("https://www.host.example/any"));
        assert!(visit("https://doc.example/page"));
        assert!(!visit("https://doc.example/other"));
        assert!(visit("https://all.example/"));
        assert!(visit("https://hosts.example/"));
        assert!(!visit("https://path.example/ad/"));
        assert!(!visit("https://script.example/"));
        assert!(!visit("https://off.example/"));
        // A page's requests to the host are blocked as before.
        assert!(blocker.should_block(
            "https://host.example/a.js",
            "https://site.example/",
            "script",
            "GET"
        ));
    }

    #[test]
    fn popups_follow_popup_rules_and_their_exceptions() {
        let blocker = Blocker::from_lists(&[FilterList {
            text: "||pop.example^$popup\n||both.example^$all\n||doc.example^$doc\n||pop.example/ok/$popup,~third-party\n\
                   @@||pop.example/allowed^$popup\n||script.example^$script\n",
            hosts: false,
            permissions: 0,
        }]);
        let opener = "https://site.example/";
        let popup = |url: &str| blocker.match_request(url, opener, "popup", "GET").blocked;
        assert!(popup("https://pop.example/x"));
        assert!(popup("https://both.example/"));
        assert!(popup("https://doc.example/"));
        assert!(!popup("https://pop.example/allowed/x"));
        assert!(!popup("https://script.example/"));
        assert!(!popup("https://site.example/next"));
        // A `$popup` rule says nothing about the host's other requests.
        assert!(!blocker.should_block("https://pop.example/x.js", opener, "script", "GET"));
        let copy = Blocker::deserialize(Arc::new(blocker.serialize())).expect("deserializes");
        assert!(
            copy.match_request("https://pop.example/x", opener, "popup", "GET")
                .blocked
        );
    }

    #[test]
    fn denyallow_rules_block_all_but_their_hosts() {
        let blocker =
            Blocker::new("*$script,3p,denyallow=good.example|cdn.example,domain=site.example\n");
        let page = "https://site.example/";
        assert!(blocker.should_block("https://ads.example/a.js", page, "script", "GET"));
        assert!(!blocker.should_block("https://good.example/a.js", page, "script", "GET"));
        assert!(!blocker.should_block("https://www.cdn.example/a.js", page, "script", "GET"));
        assert!(!blocker.should_block(
            "https://ads.example/a.js",
            "https://other.example/",
            "script",
            "GET"
        ));
    }

    #[test]
    fn csp_rules_answer_for_documents_only_and_honour_exceptions() {
        let blocker = Blocker::new(
            "||site.example^$doc,csp=worker-src 'none'\n*$csp=script-src 'none',domain=other.example\n\
             @@||site.example/free^$csp=worker-src 'none'\n",
        );
        let policy = |url: &str, kind: &str| blocker.content_security_policy(url, url, kind);
        assert_eq!(
            policy("https://site.example/", "document").as_deref(),
            Some("worker-src 'none'")
        );
        assert_eq!(
            policy("https://other.example/", "subdocument").as_deref(),
            Some("script-src 'none'")
        );
        assert_eq!(policy("https://site.example/free", "document"), None);
        assert_eq!(policy("https://site.example/a.js", "script"), None);
        assert_eq!(policy("https://none.example/", "document"), None);
    }

    #[test]
    fn scriptlets_are_only_the_page_script() {
        let blocker = Blocker::new(
            "example.com##+js(bay-test)\nexample.com##.banner\n\
             example.com##div:has-text(Sponsored):remove()\n",
        );
        assert!(blocker.use_resources(r#"[{"name":"bay-test.js","kind":{"mime":"application/javascript"},"content":"Y29uc29sZS5sb2coMSk="}]"#));
        assert!(blocker
            .scriptlets("https://example.com/")
            .contains("console.log(1)"));
        assert!(blocker.scriptlets("https://other.example/").is_empty());
        let page = blocker.page_resources("https://example.com/");
        assert!(!page.hide.is_empty());
        assert!(!page.procedural.is_empty());
        assert_eq!(blocker.scriptlets("https://example.com/"), page.script);
    }

    #[test]
    fn returns_procedural_actions_and_respects_site_exceptions() {
        let blocker = Blocker::new(
            "example.com##div:has-text(Sponsored):remove()\nexample.com##.notice:style(color: red)\n\
             except.example.com#@#div:has-text(Sponsored):remove()\n",
        );
        let rules = blocker.page_resources("https://example.com/").procedural;
        assert!(rules.iter().any(|rule| rule["action"]["type"] == "remove"));
        assert!(
            rules
                .iter()
                .any(|rule| rule["action"]["type"] == "style"
                    && rule["action"]["arg"] == "color: red")
        );
        assert!(!blocker
            .page_resources("https://except.example.com/")
            .procedural
            .iter()
            .any(|rule| rule["action"]["type"] == "remove"));
    }

    #[test]
    fn trusted_scriptlets_require_list_permission() {
        let resource = r#"[{"name":"trusted-probe.js","kind":{"mime":"application/javascript"},"content":"Y29uc29sZS5sb2coMSk=","permission":1}]"#;
        for permissions in [0, 1] {
            let blocker = Blocker::from_lists(&[FilterList {
                text: "example.com##+js(trusted-probe)",
                hosts: false,
                permissions,
            }]);
            assert!(blocker.use_resources(resource));
            let script = blocker.page_resources("https://example.com/").script;
            assert_eq!(!script.is_empty(), permissions == 1);
        }
    }

    #[test]
    fn redirects_only_a_blocked_request_and_never_an_exception() {
        let blocker = Blocker::new(
            "||ads.example^$script,redirect=noopjs\n@@||ads.example/allowed^\n\
             ||cdn.example^$script,redirect-rule=noopjs\n",
        );
        assert!(blocker.use_resources(r#"[{"name":"noop.js","aliases":["noopjs"],"kind":{"mime":"application/javascript"},"content":"Lyogbm9vcCAqLw=="}]"#));
        let blocked = blocker.match_request(
            "https://ads.example/ad.js",
            "https://site.example/",
            "script",
            "GET",
        );
        assert!(blocked.blocked);
        assert_eq!(
            blocked.redirect.as_deref(),
            Some("data:application/javascript;base64,Lyogbm9vcCAqLw==")
        );
        for url in [
            "https://ads.example/allowed/script.js",
            "https://cdn.example/ad.js",
        ] {
            let allowed = blocker.match_request(url, "https://site.example/", "script", "GET");
            assert!(!allowed.blocked);
            assert!(allowed.redirect.is_none());
        }
    }

    #[test]
    fn response_rules_block_add_and_remove_headers() {
        let blocker = Blocker::new(
            "||cdn.example^$script,header=server:nginx\n@@||cdn.example/ok.js^$script\n\
             *$doc,permissions=compute-pressure=()|idle-detection=()\n\
             stream.example##^responseheader(set-cookie)\n",
        );
        assert!(blocker.has_response_modifiers());
        let headers = [("Server".to_owned(), "nginx".to_owned())];
        let blocked = blocker.response(
            "https://cdn.example/ad.js",
            "https://site.example/",
            "script",
            "GET",
            None,
            &headers,
        );
        assert!(blocked.blocked);
        // A plain exception allows the request, and with it the response.
        let allowed = blocker.response(
            "https://cdn.example/ok.js",
            "https://site.example/",
            "script",
            "GET",
            None,
            &headers,
        );
        assert!(!allowed.blocked);
        let policy = blocker.response(
            "https://page.example/",
            "https://page.example/",
            "document",
            "GET",
            None,
            &[],
        );
        assert_eq!(
            policy.headers,
            [(
                "permissions-policy".to_owned(),
                "compute-pressure=(), idle-detection=()".to_owned()
            )]
        );
        let stream = blocker.response(
            "https://stream.example/",
            "https://stream.example/",
            "document",
            "GET",
            None,
            &[],
        );
        assert_eq!(stream.removed_headers, ["set-cookie"]);

        let copy = Blocker::deserialize(Arc::new(blocker.serialize())).expect("deserializes");
        assert!(copy.has_response_modifiers());
        assert!(
            copy.response(
                "https://cdn.example/ad.js",
                "https://site.example/",
                "script",
                "GET",
                None,
                &headers,
            )
            .blocked
        );
    }

    #[test]
    fn converts_lists_to_webkit_rules() {
        let rules: serde_json::Value = serde_json::from_str(&content_blocking_rules(LIST)).unwrap();
        let text = rules.to_string();
        assert!(rules.as_array().is_some_and(|rules| !rules.is_empty()));
        assert!(text.contains("ads\\\\.example") || text.contains("ads\\.example"));
        assert!(text.contains("css-display-none"));
    }
}
