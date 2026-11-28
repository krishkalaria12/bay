//! apps/browser/src/lib/externalLinkRules.test.mjs: where links open. (Its lone-surrogate case has no Rust string.)

use bay_state::store::{
    ExternalLinkRule, LinkDestination, LinkMatchType, matching_link_rule,
    normalize_external_link_rules, validate_link_pattern,
};
use serde_json::json;

fn rule(
    pattern: &str,
    match_type: Option<LinkMatchType>,
    source_app: Option<&str>,
) -> ExternalLinkRule {
    ExternalLinkRule {
        id: pattern.into(),
        pattern: pattern.into(),
        match_type,
        source_app: source_app.map(str::to_owned),
        destination: LinkDestination::NewWindow,
    }
}

fn matches(r: &ExternalLinkRule, url: &str) -> bool {
    matching_link_rule(std::slice::from_ref(r), url, None).is_some()
}

#[test]
fn host_path_wildcards_respect_host_boundaries_path_case_and_source_app_priority() {
    let slack = "com.tinyspeck.slackmacgap";
    let specific = rule("github.com/acme/*", None, Some(slack));
    let general = rule("github.com", None, None);
    let both = [specific.clone(), general.clone()];
    assert_eq!(
        matching_link_rule(&both, "https://GITHUB.com/acme/pr?x=1", Some(slack)),
        Some(&specific)
    );
    assert_eq!(
        matching_link_rule(
            &[general.clone(), specific.clone()],
            "https://github.com/acme/pr",
            Some(slack)
        ),
        Some(&general)
    );
    assert_eq!(
        matching_link_rule(&both, "https://github.com/acme/pr", None),
        Some(&general)
    );
    assert_eq!(
        matching_link_rule(
            std::slice::from_ref(&specific),
            "https://github.com/ACME/pr",
            Some(slack)
        ),
        None
    );
    for url in [
        "https://github.com.evil.test/acme/pr",
        "https://evil.test/github.com/acme/pr",
        "https://evil.test/?url=github.com/acme/pr",
        "not a url",
        "file:///github.com/acme/pr",
    ] {
        assert!(!matches(&general, url), "{url}");
    }
    assert!(matches(
        &rule("*.example.com/*", None, None),
        "https://docs.example.com/page"
    ));
    assert!(matches(
        &rule("example.com/files/*", None, None),
        "https://example.com/files/*draft"
    ));
    for url in [
        "https://example.com:443/page",
        "http://example.com:80/page",
        "http://127.1/page",
    ] {
        assert!(
            matches(&rule(&url.replace("page", "*"), None, None), url),
            "{url}"
        );
    }
    assert!(matches(
        &rule("example.com:443/*", None, None),
        "https://example.com/page"
    ));
    assert!(matches(
        &rule("http://*.example.com:80/*", None, None),
        "http://docs.example.com/page"
    ));
    assert!(!matches(
        &rule("https://example.com/one", None, None),
        "http://example.com/one"
    ));
    assert!(!matches(
        &rule("example.com/one", None, None),
        "https://example.com/one/two"
    ));
    for pattern in [
        "",
        "https://",
        "evil@example.com",
        "javascript:alert(1)",
        "example.com/path?query",
        "example.com\\evil",
        "[broken",
    ] {
        assert!(validate_link_pattern(pattern, None).is_some(), "{pattern}");
    }
}

#[test]
fn contains_matches_literal_text_anywhere_in_the_url_including_queries_and_fragments() {
    for (pattern, url) in [
        ("spotify.com", "https://open.spotify.com/album/123"),
        ("view=board", "https://example.com/work?view=board#today"),
        ("#today", "https://example.com/work?view=board#today"),
        ("café", "https://example.com/caf%C3%A9/report"),
        ("café", "https://example.com/café/report"),
        ("weekly report", "https://example.com/weekly%20report"),
        ("example.com", "https://other.test/?next=example.com"),
    ] {
        let route = rule(pattern, Some(LinkMatchType::Contains), None);
        assert_eq!(validate_link_pattern(pattern, route.match_type), None);
        assert!(matches(&route, url), "{pattern} matches {url}");
    }
    assert!(
        !matches(
            &rule("example.com/*", Some(LinkMatchType::Contains), None),
            "https://example.com/page"
        ),
        "stars are literal"
    );
    assert!(!matches(
        &rule("example.com", Some(LinkMatchType::Contains), None),
        "file:///example.com"
    ));
    assert!(validate_link_pattern("  ", Some(LinkMatchType::Contains)).is_some());
    assert!(validate_link_pattern("bad\ntext", Some(LinkMatchType::Contains)).is_some());
}

#[test]
fn equal_routes_compare_complete_urls_including_query_fragment_and_encoded_unicode() {
    let route = rule(
        "https://example.com/café?report=weekly#today",
        Some(LinkMatchType::Equals),
        None,
    );
    assert_eq!(
        validate_link_pattern(&route.pattern, route.match_type),
        None
    );
    assert!(matches(
        &route,
        "https://EXAMPLE.com/caf%C3%A9?report=weekly#today"
    ));
    for url in [
        "http://example.com/café?report=weekly#today",
        "https://example.com/café?report=daily#today",
        "https://example.com/café?report=weekly#other",
        "https://example.com/café?report=weekly#today-extra",
    ] {
        assert!(!matches(&route, url), "{url}");
    }
    for pattern in [
        "example.com",
        "javascript:alert(1)",
        "file:///report",
        "https://",
    ] {
        assert!(
            validate_link_pattern(pattern, Some(LinkMatchType::Equals)).is_some(),
            "{pattern}"
        );
    }
    let saved = json!([
        { "id": route.id, "pattern": route.pattern, "matchType": "equals", "destination": { "kind": "newWindow" } },
        { "id": "example.com", "pattern": "example.com", "matchType": "invalid", "destination": { "kind": "newWindow" } },
    ]);
    assert_eq!(normalize_external_link_rules(Some(&saved)), [route]);
    for (pattern, other) in [
        ("https://example.com/report", "https://example.com/report/"),
        ("https://example.com/a%2Fb", "https://example.com/a/b"),
        ("https://example.com/%2541", "https://example.com/%41"),
    ] {
        let exact = rule(pattern, Some(LinkMatchType::Equals), None);
        assert!(matches(&exact, pattern));
        assert!(!matches(&exact, other));
    }
}

#[test]
fn exact_url_matching_uses_component_specific_escaping_and_normalized_unicode_hostnames() {
    let equals = |p: &str| rule(p, Some(LinkMatchType::Equals), None);
    let literal = equals("https://example.com/[a]");
    assert!(matches(&literal, "https://example.com/[a]"));
    assert!(!matches(&literal, "https://example.com/%5Ba%5D"));
    assert!(matches(
        &equals("https://example.com/?q=O'Reilly"),
        "https://example.com/?q=O%27Reilly"
    ));
    assert!(matches(
        &equals("https://example.com/a^b"),
        "https://example.com/a%5Eb"
    ));
    assert!(matches(
        &equals("https://cafe\u{301}.example/report"),
        "https://xn--caf-dma.example/report"
    ));
    let contains = rule("[a]", Some(LinkMatchType::Contains), None);
    assert!(matches(&contains, "https://example.com/[a]"));
    assert!(!matches(&contains, "https://example.com/%5Ba%5D"));
    for pattern in ["q=O'Reilly", "https://example.com/?q=O'Reilly"] {
        let route = rule(pattern, Some(LinkMatchType::Contains), None);
        for url in [
            "https://example.com/?q=O'Reilly",
            "https://example.com/?q=O%27Reilly",
        ] {
            assert!(matches(&route, url), "{pattern} {url}");
        }
    }
}

#[test]
fn saved_wildcard_routes_canonicalize_unicode_paths_and_dot_segments() {
    for (pattern, url) in [
        ("example.com/café/*", "https://example.com/caf%C3%A9/page"),
        ("example.com/a/../report", "https://example.com/report"),
    ] {
        assert_eq!(validate_link_pattern(pattern, None), None);
        assert!(matches(&rule(pattern, None, None), url), "{pattern}");
    }
    let legacy = rule("example.com/café/*", None, None);
    assert!(matches(&legacy, "https://example.com/caf%C3%A9/page"));
}
