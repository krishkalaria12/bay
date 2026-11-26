//! The person's blocker settings (`settings.json`): on or off, the chosen lists, the lists they added by URL, and the
//! sites it's paused on. They apply to every profile, private ones included.

use serde::Serialize;
use serde_json::Value;

use crate::catalogue::{Catalogue, CatalogueList};
use crate::hosts::{covers, host_of};

#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub enabled: bool,
    /// The chosen lists, in the order they were picked; [`Settings::selected_in_order`] for the engine.
    pub selected: Vec<String>,
    /// Sites the blocker is paused on.
    pub allowed_hosts: Vec<String>,
    /// Visit Anyway with Always Allow: pages opened despite a block on the page itself (their requests are still
    /// filtered). Saved.
    pub allowed_pages: Vec<String>,
    /// Visit Anyway for this session. Not saved.
    pub session_pages: Vec<String>,
    /// Lists the person added by URL (Settings › Privacy › Add List), updated like the built-in ones.
    pub custom_lists: Vec<CustomList>,
}

/// A list added by URL. Its id is `custom-` and a hash of the URL, so adding the same URL twice adds it once.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CustomList {
    pub id: String,
    pub title: String,
    pub url: String,
}

/// The person's own rules (Settings › Privacy › My Filters), kept as a list file of their own.
pub const MY_FILTERS: &str = "my-filters";

const CUSTOM_PREFIX: &str = "custom-";

impl CustomList {
    /// A list for `url` (http or https), titled `title` or the URL's host. `None` for anything else.
    pub fn new(url: &str, title: &str) -> Option<Self> {
        let url = url.trim();
        let rest = url
            .strip_prefix("https://")
            .or_else(|| url.strip_prefix("http://"))?;
        let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
        if host.is_empty() || url.chars().any(char::is_whitespace) {
            return None;
        }
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in url.bytes() {
            hash = (hash ^ u64::from(byte)).wrapping_mul(0x100_0000_01b3);
        }
        let title = title.trim();
        Some(Self {
            id: format!("{CUSTOM_PREFIX}{hash:016x}"),
            title: if title.is_empty() {
                host.to_owned()
            } else {
                title.to_owned()
            },
            url: url.to_owned(),
        })
    }

    fn as_list(&self) -> CatalogueList {
        CatalogueList {
            id: self.id.clone(),
            title: self.title.clone(),
            category: "custom".to_owned(),
            urls: vec![self.url.clone()],
            default_on: false,
            lang: None,
            hosts: false,
        }
    }
}

/// The catalogue with the person's lists after it: their lists by URL, then My Filters.
pub fn with_custom(catalogue: &Catalogue, custom: &[CustomList]) -> Catalogue {
    let mut lists = catalogue.lists.clone();
    lists.extend(custom.iter().map(CustomList::as_list));
    lists.push(CatalogueList {
        id: MY_FILTERS.to_owned(),
        title: "My filters".to_owned(),
        category: "custom".to_owned(),
        urls: Vec::new(),
        default_on: false,
        lang: None,
        hosts: false,
    });
    Catalogue { lists }
}

/// What the request filter needs, read on any thread.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct LiveSettings {
    pub enabled: bool,
    pub allowed: Vec<String>,
    /// Saved and session Visit Anyway pages together.
    pub pages: Vec<String>,
}

/// `settings.json` as both hosts wrote it; keys sorted, as macOS wrote them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Saved<'a> {
    allowed_hosts: &'a [String],
    allowed_pages: &'a [String],
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    custom_lists: &'a [CustomList],
    enabled: bool,
    lists: &'a [String],
}

fn add(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

fn strings(value: Option<&Value>) -> impl Iterator<Item = &str> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|text| !text.is_empty())
}

impl Settings {
    /// Settings from `settings.json`'s text, or the defaults when there is none (`None`) or it's unreadable: on, with
    /// the catalogue's default lists and the regional ones for `languages`. Saved lists the catalogue no longer has
    /// are dropped.
    pub fn load(saved: Option<&str>, catalogue: &Catalogue, languages: &[String]) -> Self {
        let saved = saved
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .filter(Value::is_object);
        let field = |key: &str| saved.as_ref().and_then(|saved| saved.get(key));
        let mut custom_lists: Vec<CustomList> = Vec::new();
        for entry in field("customLists")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let text = |key: &str| entry.get(key).and_then(Value::as_str).unwrap_or_default();
            if let Some(list) = CustomList::new(text("url"), text("title"))
                && !custom_lists.iter().any(|known| known.id == list.id)
            {
                custom_lists.push(list);
            }
        }
        let catalogue = &with_custom(catalogue, &custom_lists);
        let mut selected = Vec::new();
        if field("lists").is_some_and(Value::is_array) {
            for id in strings(field("lists")) {
                if catalogue.list(id).is_some() {
                    add(&mut selected, id.to_owned());
                }
            }
        } else {
            selected = catalogue
                .lists
                .iter()
                .filter(|list| list.on_by_default(languages))
                .map(|list| list.id.clone())
                .collect();
        }
        let hosts = |key: &str| {
            let mut values = Vec::new();
            for host in strings(field(key)) {
                add(&mut values, host.to_ascii_lowercase());
            }
            values
        };
        Self {
            enabled: field("enabled").and_then(Value::as_bool).unwrap_or(true),
            selected,
            allowed_hosts: hosts("allowedHosts"),
            allowed_pages: hosts("allowedPages"),
            session_pages: Vec::new(),
            custom_lists,
        }
    }

    /// The catalogue and the person's own lists, for every lookup by id.
    pub fn catalogue(&self, built_in: &Catalogue) -> Catalogue {
        with_custom(built_in, &self.custom_lists)
    }

    /// Adds a list by URL and turns it on. The list, or `None` for a URL that isn't one (an added one again is the
    /// same list).
    pub fn add_custom(&mut self, url: &str, title: &str) -> Option<CustomList> {
        let list = CustomList::new(url, title)?;
        if !self.custom_lists.iter().any(|known| known.id == list.id) {
            self.custom_lists.push(list.clone());
        }
        self.set_list(&list.id, true);
        Some(list)
    }

    /// Removes a list added by URL. Whether there was one.
    pub fn remove_custom(&mut self, id: &str) -> bool {
        let before = self.custom_lists.len();
        self.custom_lists.retain(|list| list.id != id);
        self.selected.retain(|selected| selected != id);
        self.custom_lists.len() != before
    }

    /// `settings.json`'s text for these settings.
    pub fn to_json(&self) -> String {
        let saved = Saved {
            allowed_hosts: &self.allowed_hosts,
            allowed_pages: &self.allowed_pages,
            custom_lists: &self.custom_lists,
            enabled: self.enabled,
            lists: &self.selected,
        };
        serde_json::to_string_pretty(&saved).unwrap_or_default()
    }

    /// The chosen lists in catalogue order, the person's own last.
    pub fn selected_in_order(&self, catalogue: &Catalogue) -> Vec<String> {
        self.catalogue(catalogue)
            .in_order(&self.selected)
            .map(|list| list.id.clone())
            .collect()
    }

    pub fn live(&self) -> LiveSettings {
        LiveSettings {
            enabled: self.enabled,
            allowed: self.allowed_hosts.clone(),
            pages: self
                .allowed_pages
                .iter()
                .chain(&self.session_pages)
                .cloned()
                .collect(),
        }
    }

    /// Turns a list on or off. Whether that changed the selection.
    pub fn set_list(&mut self, id: &str, enabled: bool) -> bool {
        if enabled == self.selected.iter().any(|selected| selected == id) {
            return false;
        }
        if enabled {
            self.selected.push(id.to_owned());
        } else {
            self.selected.retain(|selected| selected != id);
        }
        true
    }

    /// Whether the blocker is paused on `host` (a URL or host), or a site that covers it.
    pub fn is_allowed(&self, host: &str) -> bool {
        let name = host_of(host);
        self.allowed_hosts
            .iter()
            .any(|allowed| covers(allowed, &name))
    }

    /// Pauses the blocker on a site, or blocks there again: that ends every pause that covers it ("example.com" for
    /// "www.example.com"). `Err` when `host` has no host.
    pub fn set_allowed(&mut self, host: &str, allowed: bool) -> Result<(), &'static str> {
        let name = host_of(host);
        if name.is_empty() {
            return Err("no host");
        }
        if allowed {
            add(&mut self.allowed_hosts, name);
        } else {
            self.allowed_hosts.retain(|entry| !covers(entry, &name));
        }
        Ok(())
    }

    /// Visit Anyway on a blocked page: for this session, or always (`remember`). Taking it back ends both.
    pub fn set_page_allowed(
        &mut self,
        host: &str,
        allowed: bool,
        remember: bool,
    ) -> Result<(), &'static str> {
        let name = host_of(host);
        if name.is_empty() {
            return Err("no host");
        }
        if allowed {
            add(
                if remember {
                    &mut self.allowed_pages
                } else {
                    &mut self.session_pages
                },
                name,
            );
        } else {
            self.allowed_pages.retain(|entry| !covers(entry, &name));
            self.session_pages.retain(|entry| !covers(entry, &name));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalogue() -> Catalogue {
        Catalogue::parse(
            r#"{"lists":[
                {"id":"a","urls":["https://a.test"],"defaultOn":true},
                {"id":"b","urls":["https://b.test"],"lang":"de"},
                {"id":"c","urls":["https://c.test"]}
            ]}"#,
        )
    }

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn no_saved_settings_turn_on_the_defaults_for_the_languages() {
        let settings = Settings::load(None, &catalogue(), &ids(&["de-DE"]));
        assert!(settings.enabled);
        assert_eq!(settings.selected, ids(&["a", "b"]));
        let settings = Settings::load(Some("{broken"), &catalogue(), &ids(&["en"]));
        assert_eq!(settings.selected, ids(&["a"]));
    }

    #[test]
    fn saved_settings_drop_unknown_lists_and_lowercase_hosts() {
        let saved = r#"{"enabled":false,"lists":["c","gone","a","c"],"allowedHosts":["Example.COM",""],"allowedPages":["news.test"]}"#;
        let settings = Settings::load(Some(saved), &catalogue(), &[]);
        assert!(!settings.enabled);
        assert_eq!(settings.selected, ids(&["c", "a"]));
        assert_eq!(settings.selected_in_order(&catalogue()), ids(&["a", "c"]));
        assert_eq!(settings.allowed_hosts, ids(&["example.com"]));
        assert_eq!(settings.allowed_pages, ids(&["news.test"]));
        // An empty saved selection stays empty rather than falling back to the defaults.
        assert!(
            Settings::load(Some(r#"{"lists":[]}"#), &catalogue(), &[])
                .selected
                .is_empty()
        );
    }

    #[test]
    fn settings_save_as_both_hosts_wrote_them() {
        let mut settings = Settings::load(None, &catalogue(), &[]);
        settings
            .set_allowed("https://www.Site.test/x", true)
            .unwrap();
        let json = settings.to_json();
        assert_eq!(
            json,
            "{\n  \"allowedHosts\": [\n    \"www.site.test\"\n  ],\n  \"allowedPages\": [],\n  \"enabled\": true,\n  \"lists\": [\n    \"a\"\n  ]\n}"
        );
        assert_eq!(Settings::load(Some(&json), &catalogue(), &[]), settings);
    }

    #[test]
    fn lists_turn_on_and_off_once() {
        let mut settings = Settings::load(None, &catalogue(), &[]);
        assert!(settings.set_list("c", true));
        assert!(!settings.set_list("c", true));
        assert!(settings.set_list("a", false));
        assert_eq!(settings.selected, ids(&["c"]));
    }

    #[test]
    fn blocking_again_ends_every_pause_that_covers_the_site() {
        let mut settings = Settings::load(None, &catalogue(), &[]);
        settings.set_allowed("example.com", true).unwrap();
        settings.set_allowed("www.example.com", true).unwrap();
        settings.set_allowed("other.test", true).unwrap();
        assert!(settings.is_allowed("https://shop.example.com/"));
        settings
            .set_allowed("https://www.example.com", false)
            .unwrap();
        assert_eq!(settings.allowed_hosts, ids(&["other.test"]));
        assert_eq!(settings.set_allowed("", true), Err("no host"));
    }

    #[test]
    fn visit_anyway_pages_are_saved_or_kept_for_the_session() {
        let mut settings = Settings::load(None, &catalogue(), &[]);
        settings
            .set_page_allowed("https://kept.test/", true, true)
            .unwrap();
        settings
            .set_page_allowed("https://once.test/", true, false)
            .unwrap();
        assert_eq!(settings.live().pages, ids(&["kept.test", "once.test"]));
        assert!(!settings.to_json().contains("once.test"));
        settings
            .set_page_allowed("once.test", false, false)
            .unwrap();
        assert_eq!(settings.live().pages, ids(&["kept.test"]));
        // Taking it back on a subdomain ends the entry that covers it.
        settings
            .set_page_allowed("www.kept.test", false, true)
            .unwrap();
        assert!(settings.live().pages.is_empty());
    }

    #[test]
    fn lists_added_by_url_save_select_and_remove() {
        let mut settings = Settings::load(None, &catalogue(), &[]);
        assert!(settings.add_custom("ftp://x.test/list.txt", "").is_none());
        assert!(settings.add_custom("https://", "").is_none());
        let list = settings
            .add_custom(" https://lists.test/mine.txt ", "")
            .unwrap();
        assert_eq!(list.title, "lists.test");
        assert!(list.id.starts_with("custom-"));
        assert_eq!(
            settings.add_custom("https://lists.test/mine.txt", "Again"),
            Some(CustomList {
                title: "Again".to_owned(),
                ..list.clone()
            })
        );
        assert_eq!(settings.custom_lists.len(), 1);
        assert_eq!(
            settings.selected_in_order(&catalogue()),
            vec!["a".to_owned(), list.id.clone()]
        );
        let saved = Settings::load(Some(&settings.to_json()), &catalogue(), &[]);
        assert_eq!(saved.custom_lists, settings.custom_lists);
        assert!(saved.selected.contains(&list.id));
        assert!(settings.remove_custom(&list.id));
        assert!(!settings.remove_custom(&list.id));
        assert_eq!(settings.selected, ids(&["a"]));
    }

    #[test]
    fn my_filters_is_a_list_of_its_own_after_the_rest() {
        let mut settings = Settings::load(None, &catalogue(), &[]);
        assert!(settings.set_list(MY_FILTERS, true));
        assert_eq!(
            settings.selected_in_order(&catalogue()),
            ids(&["a", MY_FILTERS])
        );
        let saved = Settings::load(Some(&settings.to_json()), &catalogue(), &[]);
        assert!(saved.selected.contains(&MY_FILTERS.to_owned()));
    }
}
