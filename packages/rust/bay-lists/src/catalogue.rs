//! The lists Bay offers (`filter_lists.json`, uBO's default catalogue).

use serde_json::Value;

/// One list in the catalogue.
#[derive(Clone, Debug, PartialEq)]
pub struct CatalogueList {
    pub id: String,
    pub title: String,
    pub category: String,
    pub urls: Vec<String>,
    pub default_on: bool,
    /// Space-separated language codes for a regional list (`"de"`, `"zh"`), on by default for people who use them.
    pub lang: Option<String>,
    /// A hosts file rather than filter syntax.
    pub hosts: bool,
}

/// The catalogue's lists, in its order: the order the engine compiles them and Settings shows them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Catalogue {
    pub lists: Vec<CatalogueList>,
}

impl Catalogue {
    /// The catalogue from `filter_lists.json`'s text. Entries without an `id` or `urls` are skipped; unreadable
    /// text gives an empty catalogue.
    pub fn parse(text: &str) -> Self {
        let Ok(json) = serde_json::from_str::<Value>(text) else {
            return Self::default();
        };
        let lists = json
            .get("lists")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|list| {
                let id = list.get("id")?.as_str()?.to_owned();
                let urls = list
                    .get("urls")?
                    .as_array()?
                    .iter()
                    .filter_map(|url| url.as_str().map(str::to_owned))
                    .collect();
                let text = |key: &str| list.get(key).and_then(Value::as_str).map(str::to_owned);
                Some(CatalogueList {
                    title: text("title").unwrap_or_else(|| id.clone()),
                    category: text("category").unwrap_or_else(|| "ads".to_owned()),
                    default_on: list
                        .get("defaultOn")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    lang: text("lang").filter(|lang| !lang.is_empty()),
                    hosts: list.get("hosts").and_then(Value::as_bool).unwrap_or(false),
                    urls,
                    id,
                })
            })
            .collect();
        Self { lists }
    }

    pub fn list(&self, id: &str) -> Option<&CatalogueList> {
        self.lists.iter().find(|list| list.id == id)
    }

    /// `ids` in catalogue order, unknown ones dropped, so the engine (and its cache key) doesn't depend on the order
    /// lists were picked.
    pub fn in_order<'a>(
        &'a self,
        ids: &'a [String],
    ) -> impl Iterator<Item = &'a CatalogueList> + 'a {
        self.lists.iter().filter(|list| ids.contains(&list.id))
    }
}

impl CatalogueList {
    /// On by default: a default list, or a regional one for any of `languages` (BCP 47 tags or locales, such as
    /// `"de-CH"` or `"pt_BR"`), as uBO chose.
    pub fn on_by_default(&self, languages: &[String]) -> bool {
        if self.default_on {
            return true;
        }
        let Some(lang) = &self.lang else {
            return false;
        };
        languages.iter().any(|preferred| {
            let code = preferred
                .split(['-', '_'])
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase();
            !code.is_empty() && lang.split_whitespace().any(|listed| listed == code)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CATALOGUE: &str = r#"{"lists":[
        {"id":"ublock-filters","title":"uBlock filters","urls":["https://a.test/1.txt","https://b.test/1.txt"],"defaultOn":true},
        {"id":"DEU-0","title":"Germany","category":"regions","lang":"de dsb hsb lb rm","urls":["https://c.test/de.txt"]},
        {"id":"hosts-file","urls":["https://d.test/hosts"],"hosts":true},
        {"id":"no-urls"},
        {"title":"no id","urls":[]}
    ]}"#;

    #[test]
    fn the_catalogue_keeps_valid_entries_in_order() {
        let catalogue = Catalogue::parse(CATALOGUE);
        let ids: Vec<_> = catalogue
            .lists
            .iter()
            .map(|list| list.id.as_str())
            .collect();
        assert_eq!(ids, ["ublock-filters", "DEU-0", "hosts-file"]);
        let hosts = catalogue.list("hosts-file").unwrap();
        assert_eq!(
            (hosts.title.as_str(), hosts.category.as_str(), hosts.hosts),
            ("hosts-file", "ads", true)
        );
        assert_eq!(catalogue.list("ublock-filters").unwrap().urls.len(), 2);
        assert!(Catalogue::parse("not json").lists.is_empty());
    }

    #[test]
    fn regional_lists_follow_any_preferred_language() {
        let catalogue = Catalogue::parse(CATALOGUE);
        let german = catalogue.list("DEU-0").unwrap();
        let languages =
            |tags: &[&str]| tags.iter().map(|tag| (*tag).to_owned()).collect::<Vec<_>>();
        assert!(german.on_by_default(&languages(&["en-US", "de-CH"])));
        assert!(german.on_by_default(&languages(&["LB_lu"])));
        assert!(!german.on_by_default(&languages(&["en-US", "fr"])));
        assert!(!german.on_by_default(&[]));
        assert!(catalogue.list("ublock-filters").unwrap().on_by_default(&[]));
    }

    #[test]
    fn a_selection_comes_back_in_catalogue_order() {
        let catalogue = Catalogue::parse(CATALOGUE);
        let picked = vec![
            "hosts-file".to_owned(),
            "gone".to_owned(),
            "ublock-filters".to_owned(),
        ];
        let ids: Vec<_> = catalogue
            .in_order(&picked)
            .map(|list| list.id.as_str())
            .collect();
        assert_eq!(ids, ["ublock-filters", "hosts-file"]);
    }
}
