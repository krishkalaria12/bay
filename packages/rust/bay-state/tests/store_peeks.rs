//! apps/browser/src/store/peeks.test.mjs: Arc's Peek, a link from a pinned tab opened over its page in a card, in no
//! list until it's kept as a tab or put beside its opener in a split.

mod support;

use bay_state::Browser;
use bay_state::store::{CreateWindow, LivePatch, NewTab, Peek};
use serde_json::json;
use support::browser;

fn short(b: &Browser, id: &str) -> String {
    let url = &b.tabs[id].url;
    let url = url.strip_prefix("https://").unwrap_or(url);
    url.strip_suffix(".com").unwrap_or(url).to_owned()
}

fn order(b: &Browser, w: &str) -> Vec<String> {
    b.list_ids(&b.window_list_key(&b.windows[w]))
        .iter()
        .map(|id| short(b, id))
        .collect()
}

fn shown(b: &Browser, w: &str) -> String {
    short(b, &b.active_tab_id(w, None).unwrap())
}

struct Setup {
    b: Browser,
    w: String,
    mail: String,
    a: String,
    tb: String,
}

/// A window with a favourite ("mail") and two tabs.
fn setup() -> Setup {
    let mut b = browser();
    b.update_settings([("newTabPosition".to_owned(), json!("bottom"))]);
    let w = b.create_window(CreateWindow {
        url: Some("https://mail.com".into()),
        ..Default::default()
    });
    let mail = b.active_tab_id(&w, None).unwrap();
    let open = |b: &mut Browser, url: &str| {
        b.new_tab(
            &w,
            NewTab {
                url: Some(url.into()),
                ..Default::default()
            },
        )
        .unwrap()
    };
    let a = open(&mut b, "https://a.com");
    let tb = open(&mut b, "https://b.com");
    b.pin_tabs(std::slice::from_ref(&mail), true);
    b.activate(&mail, Some(&w));
    Setup { b, w, mail, a, tb }
}

fn route(b: &mut Browser, rule: serde_json::Value) {
    b.update_settings([("externalLinkRules".to_owned(), json!([rule]))]);
}

#[test]
fn a_link_from_a_favourite_or_a_pinned_row_opens_in_a_peek_and_one_from_a_tab_doesnt() {
    let Setup {
        mut b, mail, a, tb, ..
    } = setup();
    assert!(b.opens_in_peek(&mail, "https://news.com/story"));
    assert!(!b.opens_in_peek(&a, "https://news.com/story"));
    b.pin_rows(std::slice::from_ref(&tb), true);
    assert!(b.opens_in_peek(&tb, "https://news.com/story"));
    assert!(!b.opens_in_peek(&mail, "mailto:someone@example.com"));
    assert!(!b.opens_in_peek(&mail, "https://mail.com/inbox/2"));
    assert!(!b.opens_in_peek(&mail, "https://accounts.mail.com/login"));
    b.update_settings([("peekLinksFromPinnedTabs".to_owned(), json!(false))]);
    assert!(!b.opens_in_peek(&mail, "https://news.com/story"));
}

#[test]
fn a_peek_is_over_its_opener_in_no_list_and_its_own_tab() {
    let Setup { mut b, w, mail, .. } = setup();
    let before = order(&b, &w);
    let id = b
        .open_peek(&mail, "https://news.com", Some("tab:7"), None)
        .unwrap();
    assert_eq!(order(&b, &w), before);
    assert_eq!(b.tabs[&id].peek_of.as_ref(), Some(&mail));
    assert_eq!(b.tabs[&id].opener_id.as_ref(), Some(&mail));
    assert_eq!(b.tabs[&id].adopt_id.as_deref(), Some("tab:7"));
    assert_eq!(b.tabs[&id].navigation, None);
    assert_eq!(
        b.shown_peek(&w),
        Some(&Peek {
            tab_id: id,
            from_id: mail,
            at: None
        })
    );
    assert_eq!(shown(&b, &w), "mail");
}

#[test]
fn a_peek_shows_only_while_its_opener_does_and_comes_back_with_it() {
    let Setup {
        mut b, w, mail, a, ..
    } = setup();
    let id = b.open_peek(&mail, "https://news.com", None, None).unwrap();
    b.activate(&a, Some(&w));
    assert_eq!(b.shown_peek(&w), None);
    b.activate(&mail, Some(&w));
    assert_eq!(b.shown_peek(&w).map(|p| &p.tab_id), Some(&id));
}

#[test]
fn another_link_replaces_the_peek_one_per_window() {
    let Setup { mut b, w, mail, .. } = setup();
    let first = b.open_peek(&mail, "https://news.com", None, None).unwrap();
    let second = b.open_peek(&mail, "https://docs.com", None, None).unwrap();
    assert!(!b.tabs.contains_key(&first));
    assert_eq!(b.peeks[&w].tab_id, second);
}

#[test]
fn closing_a_peek_throws_its_page_away_and_nothing_is_listed_or_recorded() {
    let Setup { mut b, w, mail, .. } = setup();
    let before = order(&b, &w);
    let closed = b.closed_tabs.len();
    let id = b.open_peek(&mail, "https://news.com", None, None).unwrap();
    b.close_peek(&w);
    assert!(!b.tabs.contains_key(&id));
    assert!(!b.peeks.contains_key(&w));
    assert_eq!(order(&b, &w), before);
    assert_eq!(b.closed_tabs.len(), closed);
    assert_eq!(shown(&b, &w), "mail");
}

#[test]
fn open_as_tab_lists_the_peek_where_its_openers_links_go_and_shows_it() {
    let Setup { mut b, w, mail, .. } = setup();
    let id = b.open_peek(&mail, "https://news.com", None, None).unwrap();
    b.keep_peek(&w);
    assert!(!b.peeks.contains_key(&w));
    assert_eq!(b.tabs[&id].peek_of, None);
    assert_eq!(shown(&b, &w), "news");
    assert_eq!(order(&b, &w), ["mail", "news", "a", "b"]);
}

#[test]
fn open_as_tab_routes_a_peek_to_the_matching_space_and_its_existing_window() {
    let Setup { mut b, w, mail, .. } = setup();
    let work = b.create_space("Work", None, None, None, None);
    let target = b.create_window(CreateWindow {
        space_id: Some(work.clone()),
        url: Some("https://work.com".into()),
        ..Default::default()
    });
    b.set_focused_window(&w);
    route(
        &mut b,
        json!({ "id": "reports", "matchType": "contains", "pattern": "report=weekly", "destination": { "kind": "space", "spaceId": work } }),
    );
    let id = b
        .open_peek(
            &mail,
            "https://docs.com/report?report=weekly",
            Some("tab:7"),
            None,
        )
        .unwrap();
    assert_eq!(b.keep_peek(&w).as_ref(), Some(&target));
    assert!(!b.peeks.contains_key(&w));
    assert_eq!(b.tabs[&id].space_id, work);
    assert_eq!(b.tabs[&id].window_id, target);
    assert_eq!(b.tabs[&id].peek_of, None);
    assert_eq!(
        b.tabs[&id].adopt_id, None,
        "a different profile cannot reuse the opener's page"
    );
    assert!(b.tabs[&id].navigation.is_some());
    assert_eq!(b.active_tab_id(&target, None).as_ref(), Some(&id));
    assert_eq!(b.active_tab_id(&w, None).as_ref(), Some(&mail));
}

#[test]
fn peek_routing_uses_its_current_url_first_match_priority_and_no_desktop_sender() {
    let Setup { mut b, w, mail, .. } = setup();
    let work = b.create_space("Work", None, None, None, None);
    b.update_settings([(
        "externalLinkRules".to_owned(),
        json!([
            { "id": "source", "pattern": "docs.com", "matchType": "contains", "sourceApp": "com.apple.mail", "destination": { "kind": "newWindow" } },
            { "id": "exact", "pattern": "https://docs.com/final#report", "matchType": "equals", "destination": { "kind": "space", "spaceId": work } },
            { "id": "fallback", "pattern": "docs.com", "matchType": "contains", "destination": { "kind": "newWindow" } },
        ]),
    )]);
    let id = b
        .open_peek(&mail, "https://docs.com/initial", None, None)
        .unwrap();
    b.navigated(
        &id,
        "https://docs.com/final#report",
        "Final report",
        LivePatch::default(),
    );
    let count = b.window_order.len();
    assert_eq!(b.keep_peek(&w).as_ref(), Some(&w));
    assert_eq!(b.tabs[&id].space_id, work);
    assert_eq!(b.window_order.len(), count);
}

#[test]
fn an_explicit_peek_split_stays_beside_its_opener_while_open_as_tab_honours_little_bay_and_new_windows()
 {
    for kind in ["littleBay", "newWindow", "mostRecentSpace"] {
        let Setup { mut b, w, mail, .. } = setup();
        route(
            &mut b,
            json!({ "id": "route", "matchType": "contains", "pattern": "news.com", "destination": { "kind": kind } }),
        );
        let id = b.open_peek(&mail, "https://news.com", None, None).unwrap();
        b.split_peek(&w);
        assert_eq!(
            b.split_of(&mail).map(|v| v.tab_ids.clone()),
            Some(vec![mail.clone(), id])
        );
        let next = b
            .open_peek(&mail, "https://news.com/story", None, None)
            .unwrap();
        let target = b.keep_peek(&w).unwrap();
        assert!(!b.peeks.contains_key(&w));
        if kind == "mostRecentSpace" {
            assert_eq!(target, w);
            assert_eq!(b.tabs[&next].space_id, b.tabs[&mail].space_id);
        } else {
            assert_ne!(target, w);
            assert_eq!(b.windows[&target].is_small(), kind == "littleBay");
            assert_eq!(
                b.tabs[&b.active_tab_id(&target, None).unwrap()].url,
                "https://news.com/story"
            );
        }
        assert!(
            !b.closed_peeks.contains_key(&w),
            "opening is not recorded as closing the Peek"
        );
    }
}

#[test]
fn private_peeks_never_route_into_regular_spaces() {
    let Setup { mut b, .. } = setup();
    let w = b.create_window(CreateWindow {
        incognito: true,
        url: Some("https://private.com".into()),
        ..Default::default()
    });
    let from = b.active_tab_id(&w, None).unwrap();
    route(
        &mut b,
        json!({ "id": "route", "pattern": "news.com", "matchType": "contains", "destination": { "kind": "space", "spaceId": "default" } }),
    );
    let id = b
        .open_peek(&from, "https://news.com/private", None, None)
        .unwrap();
    assert_eq!(b.keep_peek(&w).as_ref(), Some(&w));
    assert_eq!(b.tabs[&id].space_id, b.windows[&w].space_id);
}

#[test]
fn routing_a_peek_to_little_bay_transfers_the_same_live_page() {
    let Setup { mut b, w, mail, .. } = setup();
    route(
        &mut b,
        json!({ "id": "route", "matchType": "contains", "pattern": "news.com", "destination": { "kind": "littleBay" } }),
    );
    let id = b
        .open_peek(&mail, "https://news.com/post-result", None, None)
        .unwrap();
    b.update_live(
        &id,
        LivePatch {
            progress: Some(0.4),
            ..Default::default()
        },
    );
    let live = b.live[&id].clone();
    let target = b.keep_peek(&w).unwrap();
    assert_eq!(b.active_tab_id(&target, None).as_ref(), Some(&id));
    assert_eq!(b.tabs[&id].window_id, target);
    assert_eq!(
        b.tabs[&id].navigation.as_ref().map(|n| n.url.as_str()),
        Some("https://news.com/post-result")
    );
    assert_eq!(b.live[&id], live);
    assert!(b.windows[&target].is_small());
    assert_eq!(b.active_tab_id(&w, None).as_ref(), Some(&mail));
    assert!(!b.list_ids("default").contains(&id));
}

#[test]
fn little_bay_cannot_adopt_pinned_pages_multiple_tabs_or_another_profile() {
    let Setup {
        mut b,
        w,
        mail,
        a,
        tb,
    } = setup();
    let small = |tab_ids: Vec<String>, space_id: Option<String>| CreateWindow {
        small: true,
        tab_ids,
        space_id,
        ..Default::default()
    };
    let pinned = b.create_window(small(vec![mail.clone()], None));
    assert_eq!(b.tabs[&mail].window_id, w);
    assert_ne!(b.active_tab_id(&pinned, None).as_ref(), Some(&mail));
    let multiple = b.create_window(small(vec![a.clone(), tb.clone()], None));
    assert_eq!(b.tabs[&a].window_id, w);
    assert_eq!(b.tabs[&tb].window_id, w);
    assert!(
        !b.active_tab_id(&multiple, None)
            .is_some_and(|t| t == a || t == tb)
    );
    let work = b.create_space("Work", None, None, None, None);
    let other = b.create_window(small(vec![a.clone()], Some(work)));
    assert_eq!(b.tabs[&a].space_id, "default");
    assert_eq!(b.tabs[&a].window_id, w);
    assert_ne!(b.active_tab_id(&other, None).as_ref(), Some(&a));
}

#[test]
fn open_in_split_view_puts_the_peek_beside_its_opener() {
    let Setup { mut b, w, mail, .. } = setup();
    let id = b.open_peek(&mail, "https://news.com", None, None).unwrap();
    b.split_peek(&w);
    assert!(!b.peeks.contains_key(&w));
    assert_eq!(
        b.split_of(&mail).map(|v| v.tab_ids.clone()),
        Some(vec![mail.clone(), id])
    );
    assert!(order(&b, &w).contains(&"news".to_owned()));
    assert_eq!(shown(&b, &w), "mail");
}

#[test]
fn a_saved_peek_doesnt_come_back_with_the_session() {
    let Setup { mut b, mail, .. } = setup();
    let id = b.open_peek(&mail, "https://news.com", None, None).unwrap();
    let mut data = b.to_session();
    // The session never writes a peek; one in an older file goes on load.
    let mut peek = b.tabs[&id].clone();
    peek.window_id = String::new();
    data.tabs.push(peek);
    b.hydrate(data, false);
    assert!(!b.tabs.contains_key(&id));
    assert!(b.peeks.is_empty());
}
