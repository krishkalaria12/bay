//! apps/browser/src/store/tabs.test.mjs: where tabs open, which tab shows when one closes, and the structures that must
//! stay whole (groups, splits).

mod support;

use bay_state::store::{CreateWindow, GroupPatch, NewTab};
use bay_state::{Browser, Session};
use serde_json::json;
use support::{browser, ids};

// A window's list: its space's tabs, in sidebar order.
fn tabs_of(b: &Browser, w: &str) -> Vec<String> {
    b.list_ids(&b.window_list_key(&b.windows[w])).to_vec()
}

fn short(url: &str) -> String {
    let url = url.strip_prefix("https://").unwrap_or(url);
    url.strip_suffix(".com").unwrap_or(url).to_owned()
}

fn hosts(b: &Browser, w: &str) -> Vec<String> {
    tabs_of(b, w)
        .iter()
        .map(|id| short(&b.tabs[id].url))
        .collect()
}

fn shown(b: &Browser, w: &str) -> String {
    short(&b.tabs[&b.active_tab_id(w, None).unwrap()].url)
}

// Chrome's opener rules (store/openerOrder.ts).
fn reset(cmd_click_groups: bool) -> Browser {
    let mut b = browser();
    b.update_settings([
        (
            "cmdClickCreatesTabGroup".to_owned(),
            json!(cmd_click_groups),
        ),
        ("newTabPosition".to_owned(), json!("bottom")),
    ]);
    b
}

fn open(b: &mut Browser, w: &str, url: &str, opener: &str, background: bool) -> String {
    b.new_tab(
        w,
        NewTab {
            url: Some(format!("{url}.com")),
            opener_id: Some(opener.to_owned()),
            background,
            ..Default::default()
        },
    )
    .unwrap()
}

fn url_tab(url: &str) -> NewTab {
    NewTab {
        url: Some(format!("{url}.com")),
        ..Default::default()
    }
}

fn url_window(url: &str) -> CreateWindow {
    CreateWindow {
        url: Some(format!("{url}.com")),
        ..Default::default()
    }
}

/// A window with a tab for each address, its first one shown: the window and the tabs.
fn setup(b: &mut Browser, urls: &[&str]) -> (String, Vec<String>) {
    let w = b.create_window(url_window(urls[0]));
    let mut tabs = vec![tabs_of(b, &w)[0].clone()];
    for url in &urls[1..] {
        tabs.push(b.new_tab(&w, url_tab(url)).unwrap());
    }
    b.activate(&tabs[0], None);
    (w, tabs)
}

#[test]
fn links_opened_behind_line_up_after_their_opener_in_order() {
    let mut b = reset(false);
    let (w, t) = setup(&mut b, &["a", "b"]);
    for url in ["c1", "c2", "c3"] {
        open(&mut b, &w, url, &t[0], true);
    }
    assert_eq!(hosts(&b, &w), ["a", "c1", "c2", "c3", "b"]);
    assert_eq!(
        shown(&b, &w),
        "a",
        "opened behind: the opener stays in front"
    );
}

#[test]
fn closing_a_page_opened_in_front_returns_to_its_opener_unless_you_moved_away() {
    let mut b = reset(false);
    let (w, t) = setup(&mut b, &["a", "b"]);
    let c = open(&mut b, &w, "c", &t[0], false);
    b.close_tab(&c);
    assert_eq!(shown(&b, &w), "a");

    let d = open(&mut b, &w, "d", &t[0], false);
    b.activate(&t[1], None);
    b.activate(&d, None);
    b.close_tab(&d);
    assert_eq!(shown(&b, &w), "b", "after moving away, the tab after it");
}

#[test]
fn closing_goes_to_the_pages_own_tabs_then_its_siblings_then_its_opener() {
    let mut b = reset(false);
    let (w, t) = setup(&mut b, &["a", "b"]);
    let a = &t[0];
    let c1 = open(&mut b, &w, "c1", a, true);
    let c2 = open(&mut b, &w, "c2", a, true);
    b.activate(&c1, None);
    let g = open(&mut b, &w, "g", &c1, true);
    b.close_tab(&c1);
    assert_eq!(shown(&b, &w), "g", "a tab it opened");
    assert_eq!(
        b.tabs[&g].opener_id.as_ref(),
        Some(a),
        "a closed tab's tabs take its opener"
    );
    b.activate(a, None);
    b.activate(&c2, None);
    b.close_tab(&c2);
    assert_eq!(shown(&b, &w), "g", "a sibling");
    b.close_tab(&g);
    assert_eq!(shown(&b, &w), "a", "no siblings left: the opener");
}

#[test]
fn a_link_cmd_clicked_into_a_collapsed_group_opens_the_group_so_its_tab_is_seen() {
    let mut b = reset(true);
    let (w, t) = setup(&mut b, &["a", "b"]);
    open(&mut b, &w, "c1", &t[0], true);
    let group = b.groups.values().next().unwrap().clone();
    assert_eq!(group.tab_ids.len(), 2, "the opener and its link, together");
    b.update_group(
        &group.id,
        GroupPatch {
            collapsed: Some(true),
            ..Default::default()
        },
    );
    let c2 = open(&mut b, &w, "c2", &t[0], true);
    assert!(!b.groups[&group.id].collapsed);
    assert!(b.groups[&group.id].tab_ids.contains(&c2));
}

#[test]
fn closing_a_group_that_holds_the_shown_tab_shows_the_tab_just_above_the_group() {
    let mut b = reset(true);
    let (w, t) = setup(&mut b, &["pin", "home"]);
    let (pin, home) = (&t[0], &t[1]);
    b.toggle_pin(pin);
    b.activate(home, None);
    b.activate(pin, None);
    let c1 = open(&mut b, &w, "c1", pin, true);
    open(&mut b, &w, "c2", pin, true);
    let group = b.groups.keys().next().unwrap().clone();
    b.move_tab(home, 0);
    b.activate(&c1, None);
    b.close_group(&group);
    assert_eq!(shown(&b, &w), "home", "not the pinned opener");
}

#[test]
fn closing_a_pinned_tab_selects_the_regular_tab_the_window_showed_last_not_the_neighbour() {
    let mut b = reset(false);
    let (w, t) = setup(&mut b, &["p", "q", "a", "b", "c"]);
    let (p, q, tab_b) = (&t[0], &t[1], &t[3]);
    b.toggle_pin(p);
    b.toggle_pin(q);
    for id in [tab_b, q, p] {
        b.advance(1000.0);
        b.activate(id, None);
    }
    b.close_tab(p);
    assert_eq!(
        b.active_tab_id(&w, None).as_ref(),
        Some(tab_b),
        "back to the regular tab used before the pinned ones"
    );
    assert!(b.tabs[tab_b].navigation.is_some());
    assert!(
        b.tabs[q].navigation.is_some(),
        "the other pinned tab keeps its page"
    );
}

#[test]
fn groups_stay_contiguous_and_splits_need_two_panes() {
    let mut b = reset(false);
    let w = b.create_window(url_window("a"));
    let tb = b.new_tab(&w, url_tab("b")).unwrap();
    let c = b.new_tab(&w, url_tab("c")).unwrap();
    let a = b.view_tab_ids(&w, None)[0].clone();
    let g = b
        .create_group(&ids(&[&a, &c]), Some("G"), None, None)
        .unwrap();
    assert_eq!(tabs_of(&b, &w), ids(&[&a, &c, &tb]));
    assert_eq!(b.groups[&g].tab_ids, ids(&[&a, &c]));
    b.add_tabs_to_group(&g, &ids(&[&tb]));
    assert_eq!(b.groups[&g].tab_ids, ids(&[&a, &c, &tb]));
    b.close_tab(&c);
    assert_eq!(b.groups[&g].tab_ids, ids(&[&a, &tb]));
    let sp = b.create_split(&ids(&[&a, &tb]), "horizontal").unwrap();
    b.close_tab(&tb);
    assert!(!b.splits.contains_key(&sp));
    // The window's last tab: it closes with its group's name kept for ⇧⌘T, and the window goes.
    b.close_tab(&a);
    assert_eq!(
        b.closed_tabs
            .last()
            .unwrap()
            .group
            .as_ref()
            .map(|g| g.name.as_str()),
        Some("G")
    );
    assert!(!b.windows.contains_key(&w));
}

#[test]
fn hydrate_drops_broken_splits() {
    let mut b = reset(false);
    let w = b.create_window(url_window("a"));
    let a = b.view_tab_ids(&w, None)[0].clone();
    let tb = b.new_tab(&w, url_tab("b")).unwrap();
    let mut session: Session = b.to_session();
    session.splits = serde_json::from_value(json!([
        { "id": "ok", "windowId": w, "tabIds": [a, tb], "orientation": "horizontal", "sizes": [0.5, 0.5] },
        { "id": "stale", "windowId": w, "tabIds": [a, "gone"], "orientation": "horizontal", "sizes": [0.5, 0.5] },
    ]))
    .unwrap();
    b.hydrate(session, false);
    assert_eq!(b.splits.keys().collect::<Vec<_>>(), ["ok"]);
}
