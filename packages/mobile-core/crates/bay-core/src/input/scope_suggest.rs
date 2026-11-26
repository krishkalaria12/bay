//! Results from the site being searched, while the field shows its chip: IMDb's titles, Wikipedia's articles and
//! YouTube's searches. The core says where to ask and reads the answer; the apps only fetch it.

use serde_json::Value;

use super::site_search::{SearchScope, is_on_site, sample_address, scoped_search_url};
use super::suggest::Suggestion;
use super::url::host_of;
use crate::js;

/// How many results a site adds under the typed text.
const RESULTS: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    Imdb,
    Wikipedia,
    YouTube,
}

fn source_of(scope: &SearchScope) -> Option<Source> {
    let on = |site: &str| is_on_site(&scope.host, site);
    if on("imdb.com") {
        Some(Source::Imdb)
    } else if on("wikipedia.org") {
        Some(Source::Wikipedia)
    } else if on("youtube.com") {
        Some(Source::YouTube)
    } else {
        None
    }
}

/// Wikipedia's host for the scope: the language its search address names ("en.wikipedia.org"), else English.
fn wikipedia_host(scope: &SearchScope) -> String {
    let host = host_of(&sample_address(&scope.url));
    if host.ends_with(".wikipedia.org") {
        host
    } else {
        "en.wikipedia.org".into()
    }
}

/// Where to ask the site for results for `query`, when Bay knows how to read its answer.
#[uniffi::export]
pub fn scope_suggest_request(scope: SearchScope, query: String) -> Option<String> {
    let query = js::trim(&query);
    if query.is_empty() {
        return None;
    }
    let q = js::encode_uri_component(query);
    Some(match source_of(&scope)? {
        Source::Imdb => format!(
            "https://v3.sg.media-imdb.com/suggestion/x/{}.json",
            js::encode_uri_component(&query.to_lowercase())
        ),
        Source::Wikipedia => format!(
            "https://{}/w/rest.php/v1/search/title?limit={RESULTS}&q={q}",
            wikipedia_host(&scope)
        ),
        Source::YouTube => {
            format!("https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q={q}")
        }
    })
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(js::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// An https image address: Wikipedia's start with `//`.
fn image(value: Option<&str>) -> Option<String> {
    let url = value?;
    let url = if url.starts_with("//") {
        format!("https:{url}")
    } else {
        url.to_owned()
    };
    url.starts_with("https://").then_some(url)
}

fn imdb(body: &Value) -> Vec<Suggestion> {
    let Some(items) = body.get("d").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let id = text(item, "id")?;
            let title = text(item, "l")?;
            let path = match &id[..2.min(id.len())] {
                "tt" => "title",
                "nm" => "name",
                _ => return None,
            };
            let year = item.get("y").and_then(Value::as_i64).map(|y| y.to_string());
            let detail = [year, text(item, "s")]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" · ");
            Some(Suggestion::Result {
                title,
                detail,
                image: image(item.pointer("/i/imageUrl").and_then(Value::as_str)),
                url: format!("https://www.imdb.com/{path}/{id}/"),
            })
        })
        .take(RESULTS)
        .collect()
}

fn wikipedia(body: &Value, host: &str) -> Vec<Suggestion> {
    let Some(pages) = body.get("pages").and_then(Value::as_array) else {
        return Vec::new();
    };
    pages
        .iter()
        .filter_map(|page| {
            let key = text(page, "key")?;
            Some(Suggestion::Result {
                title: text(page, "title").unwrap_or_else(|| key.replace('_', " ")),
                detail: text(page, "description").unwrap_or_default(),
                image: image(page.pointer("/thumbnail/url").and_then(Value::as_str)),
                url: format!(
                    "https://{host}/wiki/{}",
                    js::encode_uri_component(&key)
                        .replace("%2F", "/")
                        .replace("%3A", ":")
                ),
            })
        })
        .take(RESULTS)
        .collect()
}

fn youtube(body: &Value, scope: &SearchScope) -> Vec<Suggestion> {
    super::engines::parse_suggestions(body)
        .into_iter()
        .take(RESULTS)
        .map(|query| Suggestion::Search {
            url: scoped_search_url(scope.clone(), query.clone(), String::new()),
            query,
            engine: scope.name.clone(),
            suggested: true,
        })
        .collect()
}

/// The rows a site's answer holds: titles and articles that open directly, or searches on the site.
#[uniffi::export]
pub fn parse_scope_suggestions(scope: SearchScope, body: String) -> Vec<Suggestion> {
    let Ok(body) = serde_json::from_str::<Value>(&body) else {
        return Vec::new();
    };
    match source_of(&scope) {
        Some(Source::Imdb) => imdb(&body),
        Some(Source::Wikipedia) => wikipedia(&body, &wikipedia_host(&scope)),
        Some(Source::YouTube) => youtube(&body, &scope),
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::engines::built_in_engines;
    use crate::input::site_search::find_scope;

    fn scope(name: &str) -> SearchScope {
        find_scope(name, &built_in_engines(), Vec::new).unwrap()
    }

    #[test]
    fn each_site_is_asked_in_its_own_way() {
        assert_eq!(
            scope_suggest_request(scope("imdb"), "You Can".into()).as_deref(),
            Some("https://v3.sg.media-imdb.com/suggestion/x/you%20can.json")
        );
        assert_eq!(
            scope_suggest_request(scope("w"), "font".into()).as_deref(),
            Some("https://en.wikipedia.org/w/rest.php/v1/search/title?limit=6&q=font")
        );
        assert!(
            scope_suggest_request(scope("yt"), "lofi".into())
                .unwrap()
                .contains("ds=yt&q=lofi")
        );
        assert_eq!(scope_suggest_request(scope("gh"), "bay".into()), None);
        assert_eq!(scope_suggest_request(scope("imdb"), "  ".into()), None);
    }

    #[test]
    fn imdb_titles_open_their_page_with_year_and_cast() {
        let body = r#"{"d":[
            {"i":{"imageUrl":"https://m.media-amazon.com/images/M/a.jpg"},"id":"tt4536820","l":"You Can See Everything","s":"Amanda Seyfried, Christopher Abbott","y":2026},
            {"id":"nm0000001","l":"Fred Astaire","s":"Actor"},
            {"id":"/news/x","l":"Not a title"}
        ]}"#;
        let rows = parse_scope_suggestions(scope("imdb"), body.into());
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0],
            Suggestion::Result {
                title: "You Can See Everything".into(),
                detail: "2026 · Amanda Seyfried, Christopher Abbott".into(),
                image: Some("https://m.media-amazon.com/images/M/a.jpg".into()),
                url: "https://www.imdb.com/title/tt4536820/".into(),
            }
        );
        assert!(
            matches!(&rows[1], Suggestion::Result { url, image: None, .. } if url == "https://www.imdb.com/name/nm0000001/")
        );
    }

    #[test]
    fn wikipedia_articles_open_the_article() {
        let body = r#"{"pages":[
            {"id":1,"key":"Font","title":"Font","description":"Set of printable characters","thumbnail":{"url":"//upload.wikimedia.org/a.png"}},
            {"id":2,"key":"Fontaines_D.C.","title":"Fontaines D.C.","description":null,"thumbnail":null}
        ]}"#;
        let rows = parse_scope_suggestions(scope("w"), body.into());
        assert_eq!(
            rows[0],
            Suggestion::Result {
                title: "Font".into(),
                detail: "Set of printable characters".into(),
                image: Some("https://upload.wikimedia.org/a.png".into()),
                url: "https://en.wikipedia.org/wiki/Font".into(),
            }
        );
        assert!(
            matches!(&rows[1], Suggestion::Result { url, detail, .. } if url == "https://en.wikipedia.org/wiki/Fontaines_D.C." && detail.is_empty())
        );
    }

    #[test]
    fn youtube_searches_stay_on_youtube_and_bad_answers_are_no_rows() {
        let rows = parse_scope_suggestions(
            scope("yt"),
            r#"["lofi",["lofi hip hop","lofi girl"]]"#.into(),
        );
        assert!(
            matches!(&rows[0], Suggestion::Search { query, url, engine, suggested: true }
            if query == "lofi hip hop" && engine == "YouTube" && url == "https://www.youtube.com/results?search_query=lofi%20hip%20hop")
        );
        assert!(parse_scope_suggestions(scope("imdb"), "<html>".into()).is_empty());
        assert!(parse_scope_suggestions(scope("gh"), "[]".into()).is_empty());
    }
}
