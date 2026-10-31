use std::collections::HashSet;
use std::sync::Mutex;

use adblock::lists::{FilterSet, ParseOptions};
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

impl Blocker {
    /// Builds an engine from one or more filter lists joined into one text.
    pub fn new(lists: &str) -> Self {
        let mut set = FilterSet::new(false);
        set.add_filter_list(lists.to_owned(), ParseOptions::default());
        Self {
            engine: Mutex::new(Engine::new_with_filter_set(set)),
        }
    }

    /// Whether a request should be blocked. `kind` is a resource type such as `script`, `image` or `xhr`.
    pub fn should_block(&self, url: &str, source_url: &str, kind: &str) -> bool {
        let Ok(request) = Request::new(url, source_url, kind, "get") else {
            return false;
        };
        let engine = self
            .engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        engine.check_network_request(&request).should_block()
    }

    pub fn cosmetic_resources(&self, url: &str) -> CosmeticResources {
        let engine = self
            .engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let resources = engine.url_cosmetic_resources(url);
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
        let engine = self
            .engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        engine.hidden_class_id_selectors(classes, ids, &exceptions)
    }
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
    fn converts_lists_to_webkit_rules() {
        let rules: serde_json::Value = serde_json::from_str(&content_blocking_rules(LIST)).unwrap();
        let text = rules.to_string();
        assert!(rules.as_array().is_some_and(|rules| !rules.is_empty()));
        assert!(text.contains("ads\\\\.example") || text.contains("ads\\.example"));
        assert!(text.contains("css-display-none"));
    }
}
