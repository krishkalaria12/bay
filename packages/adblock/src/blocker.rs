use std::collections::HashSet;
use std::sync::Mutex;

use adblock::lists::{FilterFormat, FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::resources::{InMemoryResourceStorage, PermissionMask};
use adblock::Engine;
use serde::Serialize;

/// A network and cosmetic filter engine built from filter list text. Safe to share between threads.
pub struct Blocker {
    // The engine's default single-thread build is not `Sync`; matching takes microseconds, so a lock is cheap.
    engine: Mutex<Engine>,
    /// The lists' `$removeparam` exceptions as plain rules (crate::removeparam): a request one matches isn't rewritten.
    keep_params: Mutex<Engine>,
    /// The lists' `$popup` rules as `$document` rules (crate::adapt), asked about pages a page opens.
    popups: Mutex<Engine>,
}

/// [`Blocker::serialize`]'s format: this tag, the lengths of the main and `$removeparam` engines (u64, little-endian),
/// then those engines and the popup engine.
const SERIALIZED_TAG: &[u8; 4] = b"BAY3";

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
}

impl Blocker {
    /// Builds an engine from one or more filter lists joined into one text.
    pub fn new(lists: &str) -> Self {
        let adapted = crate::adapt::adapt(lists);
        let keep_params = crate::removeparam::exceptions(&adapted.main);
        let mut set = FilterSet::new(false);
        set.add_filter_list(adapted.main, ParseOptions::default());
        Self::from_engines(
            Engine::new_with_filter_set(set),
            plain_engine(&keep_params),
            plain_engine(&adapted.popups),
        )
    }

    /// Builds an engine from separate lists, so each list's rule count can be read back ([`Blocker::list_counts`]).
    /// uBO's `!#if` blocks are resolved as uBO resolves them on Chromium.
    pub fn from_lists(lists: &[FilterList]) -> Self {
        let mut set = FilterSet::new(false);
        let mut keep_params = String::new();
        let mut popups = String::new();
        for list in lists {
            let format = if list.hosts {
                FilterFormat::Hosts
            } else {
                FilterFormat::Standard
            };
            let mut text = crate::preprocess::preprocess(list.text).into_owned();
            if !list.hosts {
                let adapted = crate::adapt::adapt(&text);
                keep_params.push_str(&crate::removeparam::exceptions(&adapted.main));
                popups.push_str(&adapted.popups);
                text = crate::adapt::block_documents_of_hostname_rules(&adapted.main);
            }
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
            plain_engine(&keep_params),
            plain_engine(&popups),
        )
    }

    fn from_engines(engine: Engine, keep_params: Engine, popups: Engine) -> Self {
        Self {
            engine: Mutex::new(engine),
            keep_params: Mutex::new(keep_params),
            popups: Mutex::new(popups),
        }
    }

    fn engine(&self) -> std::sync::MutexGuard<'_, Engine> {
        lock(&self.engine)
    }

    /// The engine in adblock-rust's binary format, to cache and load with [`Blocker::deserialize`].
    pub fn serialize(&self) -> Vec<u8> {
        let main = self.engine().serialize();
        let keep = lock(&self.keep_params).serialize();
        let popups = lock(&self.popups).serialize();
        let mut data =
            Vec::with_capacity(SERIALIZED_TAG.len() + 16 + main.len() + keep.len() + popups.len());
        data.extend_from_slice(SERIALIZED_TAG);
        data.extend_from_slice(&(main.len() as u64).to_le_bytes());
        data.extend_from_slice(&(keep.len() as u64).to_le_bytes());
        data.extend_from_slice(&main);
        data.extend_from_slice(&keep);
        data.extend_from_slice(&popups);
        data
    }

    /// An engine [`Blocker::serialize`] wrote, or `None` when the data is damaged or from another adblock-rust.
    pub fn deserialize(data: &[u8]) -> Option<Self> {
        let rest = data.strip_prefix(SERIALIZED_TAG)?;
        let (main_length, rest) = rest.split_first_chunk::<8>()?;
        let (keep_length, rest) = rest.split_first_chunk::<8>()?;
        let (main, rest) =
            rest.split_at_checked(usize::try_from(u64::from_le_bytes(*main_length)).ok()?)?;
        let (keep, popups) =
            rest.split_at_checked(usize::try_from(u64::from_le_bytes(*keep_length)).ok()?)?;
        let read = |bytes: &[u8]| {
            let mut engine = Engine::default();
            engine.deserialize(bytes).ok().map(|()| engine)
        };
        Some(Self::from_engines(read(main)?, read(keep)?, read(popups)?))
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
        for resource in resources {
            if storage.add_resource(resource).is_err() {
                return false;
            }
        }
        self.engine().use_resource_storage(storage);
        true
    }

    /// The page's cosmetic resources, its scriptlets included.
    pub fn page_resources(&self, url: &str) -> PageResources {
        let resources = self.engine().url_cosmetic_resources(url);
        let mut hide: Vec<String> = resources.hide_selectors.into_iter().collect();
        hide.sort();
        let mut exceptions: Vec<String> = resources.exceptions.into_iter().collect();
        exceptions.sort();
        let mut procedural: Vec<String> = resources.procedural_actions.into_iter().collect();
        procedural.sort();
        let script = if resources.injected_script.is_empty() {
            String::new()
        } else {
            // uBO's function resources read this object; keep it scoped to this document's injection.
            format!(
                "(function() {{\nconst scriptletGlobals = Object.create(null);\n{}\n}})();",
                resources.injected_script
            )
        };
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
        self.page_resources(url).script
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
        let blocked = result.should_block();
        RequestMatch {
            blocked,
            // A redirect-rule without a matching block must not redirect an allowed request.
            redirect: if blocked { result.redirect } else { None },
            // adblock-rust ignores `$removeparam` exceptions: one that matches keeps the URL as it is.
            rewrite: result.rewritten_url.filter(|_| {
                !blocked
                    && !lock(&self.keep_params)
                        .check_network_request(&request)
                        .should_block()
            }),
        }
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

fn lock(engine: &Mutex<Engine>) -> std::sync::MutexGuard<'_, Engine> {
    engine
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

    const LIST: &str =
        "||ads.example^\n@@||ads.example/allowed^\nexample.com##.banner\n##.ad-slot\n";

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
        let copy = Blocker::deserialize(&blocker.serialize()).expect("deserializes");
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
        assert!(Blocker::deserialize(b"not an engine").is_none());
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
        let copy = Blocker::deserialize(&blocker.serialize()).expect("deserializes");
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
        assert!(Blocker::deserialize(b"BAY3").is_none());
        assert!(Blocker::deserialize(&[1, 2, 3]).is_none());
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
        let copy = Blocker::deserialize(&blocker.serialize()).expect("deserializes");
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
        let blocker = Blocker::new("example.com##+js(bay-test)\n");
        assert!(blocker.use_resources(r#"[{"name":"bay-test.js","kind":{"mime":"application/javascript"},"content":"Y29uc29sZS5sb2coMSk="}]"#));
        assert!(blocker
            .scriptlets("https://example.com/")
            .contains("console.log(1)"));
        assert!(blocker.scriptlets("https://other.example/").is_empty());
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
    fn converts_lists_to_webkit_rules() {
        let rules: serde_json::Value = serde_json::from_str(&content_blocking_rules(LIST)).unwrap();
        let text = rules.to_string();
        assert!(rules.as_array().is_some_and(|rules| !rules.is_empty()));
        assert!(text.contains("ads\\\\.example") || text.contains("ads\\.example"));
        assert!(text.contains("css-display-none"));
    }
}
