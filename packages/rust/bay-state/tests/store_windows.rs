//! apps/browser/src/store/spaceTabs.test.mjs and session.test.mjs: tabs are their space's, not a window's (as Arc's);
//! what survives a quit, a relaunch and a closed window.

mod support;

use bay_state::store::{CreateWindow, GroupPatch, NewTab, TabPatch};
use bay_state::{Browser, DataDir, Session};
use serde_json::json;
use support::browser;

fn short(url: &str) -> String {
    let url = url.strip_prefix("https://").unwrap_or(url);
    let url = url.strip_suffix('/').unwrap_or(url);
    url.strip_suffix(".com").unwrap_or(url).to_owned()
}

fn listed(b: &Browser, w: &str) -> Vec<String> {
    b.view_tab_ids(w, None)
        .iter()
        .map(|id| short(&b.tabs[id].url))
        .collect()
}

fn shown(b: &Browser, w: &str) -> String {
    short(&b.tabs[&b.active_tab_id(w, None).unwrap()].url)
}

fn window(b: &mut Browser, url: &str) -> String {
    b.create_window(CreateWindow {
        url: Some(url.into()),
        ..Default::default()
    })
}

struct Two {
    one: String,
    two: String,
    a: String,
    b: String,
}

/// Two windows on the default space: the first made a.com and b.com, the second shows c.com. New tabs go to the bottom.
fn setup() -> (Browser, Two) {
    let mut br = browser();
    br.update_settings([("newTabPosition".to_owned(), json!("bottom"))]);
    let one = window(&mut br, "https://a.com");
    let a = br.active_tab_id(&one, None).unwrap();
    let b = br
        .new_tab(
            &one,
            NewTab {
                url: Some("https://b.com".into()),
                background: true,
                ..Default::default()
            },
        )
        .unwrap();
    let two = window(&mut br, "https://c.com");
    (br, Two { one, two, a, b })
}

/// The session saved to a scratch data folder, then loaded as a launch (or a reload) of the app.
fn relaunch(b: &mut Browser, reloaded: bool) -> tempfile::TempDir {
    let scratch = tempfile::tempdir().unwrap();
    let dir = DataDir::new(scratch.path());
    b.to_session().save(&dir).unwrap();
    b.launch(&dir, reloaded).unwrap();
    scratch
}

#[test]
fn every_window_on_a_space_lists_its_tabs_the_ones_another_window_opened_too() {
    let (mut b, t) = setup();
    assert_eq!(listed(&b, &t.one), ["a", "b", "c"]);
    assert_eq!(listed(&b, &t.two), ["a", "b", "c"]);
    b.new_tab(
        &t.two,
        NewTab {
            url: Some("https://d.com".into()),
            ..Default::default()
        },
    );
    assert_eq!(listed(&b, &t.one), ["a", "b", "c", "d"]);
}

#[test]
fn showing_a_tab_in_another_window_moves_its_page_there_and_the_window_it_left_says_so() {
    let (mut b, t) = setup();
    b.activate(&t.a, Some(&t.two));
    assert_eq!(
        b.tabs[&t.a].window_id, t.two,
        "its page is in the window that shows it"
    );
    assert_eq!(shown(&b, &t.two), "a");
    assert_eq!(
        b.windows[&t.one].active_tab_ids["default"], t.a,
        "the first window still shows it"
    );
    assert!(
        b.shown_elsewhere(&t.a, &t.one),
        "so it shows that it's open in another window"
    );
    b.activate(&t.a, Some(&t.one));
    assert_eq!(b.tabs[&t.a].window_id, t.one, "Show Here brings it back");
}

#[test]
fn closing_a_window_keeps_its_tabs_their_pages_unload_and_the_next_window_shows_them() {
    let (mut b, t) = setup();
    b.close_window(&t.one);
    assert!(!b.windows.contains_key(&t.one));
    assert_eq!(listed(&b, &t.two), ["a", "b", "c"]);
    assert_eq!(b.tabs[&t.a].window_id, "");
    assert!(b.tabs[&t.a].is_unloaded() && b.tabs[&t.a].navigation.is_none());
    assert!(b.tabs.contains_key(&t.b));
    let next = b.create_window(CreateWindow::default());
    assert_eq!(listed(&b, &next)[..3], ["a", "b", "c"]);
}

#[test]
fn a_window_coming_to_a_space_doesnt_take_the_tab_another_window_shows() {
    let (mut b, t) = setup();
    let work = b.create_space("Work", None, None, None, None);
    b.switch_space(&t.two, &work);
    b.switch_space(&t.two, "default");
    assert_eq!(shown(&b, &t.two), "c", "the tab it showed there");
    b.activate(&t.b, Some(&t.one));
    let third = b.create_window(CreateWindow {
        space_id: Some(work),
        ..Default::default()
    });
    b.switch_space(&third, "default");
    assert_ne!(b.active_tab_id(&third, None), b.active_tab_id(&t.one, None));
    assert_ne!(b.active_tab_id(&third, None), b.active_tab_id(&t.two, None));
}

#[test]
fn moving_a_tab_to_another_window_shows_it_there_and_the_window_it_left_shows_its_next_one() {
    let (mut b, t) = setup();
    b.move_tabs_to_window(std::slice::from_ref(&t.a), Some(&t.two));
    assert_eq!(b.tabs[&t.a].window_id, t.two);
    assert_eq!(shown(&b, &t.two), "a");
    assert_eq!(shown(&b, &t.one), "b");
    assert_eq!(
        listed(&b, &t.one),
        ["a", "b", "c"],
        "it's still the space's"
    );
}

#[test]
fn a_private_windows_tabs_are_its_own_and_go_with_it() {
    let (mut b, t) = setup();
    let p = b.create_window(CreateWindow {
        incognito: true,
        url: Some("https://secret.com".into()),
        ..Default::default()
    });
    let secret = b.active_tab_id(&p, None).unwrap();
    assert!(!listed(&b, &t.one).contains(&"secret".to_owned()));
    assert_eq!(listed(&b, &p), ["secret"]);
    b.close_window(&p);
    assert!(!b.tabs.contains_key(&secret));
}

#[test]
fn little_bays_page_isnt_its_spaces_until_it_moves_to_a_main_window() {
    let (mut b, t) = setup();
    let little = b.create_window(CreateWindow {
        small: true,
        url: Some("https://quick.com".into()),
        ..Default::default()
    });
    let page = b.active_tab_id(&little, None).unwrap();
    assert!(!listed(&b, &t.one).contains(&"quick".to_owned()));
    b.move_tabs_to_window(&[page], Some(&t.one));
    assert!(
        !b.windows.contains_key(&little),
        "Little Bay goes with its page"
    );
    assert!(listed(&b, &t.one).contains(&"quick".to_owned()));
    assert_eq!(shown(&b, &t.one), "quick");
}

#[test]
fn each_space_lists_only_its_own_tabs_and_favorites() {
    let (mut b, t) = setup();
    b.pin_tabs(std::slice::from_ref(&t.a), true);
    let work = b.create_space("Work", None, None, None, None);
    b.switch_space(&t.one, &work);
    let w = b.active_tab_id(&t.one, None).unwrap();
    assert!(b.favorite_tab_ids(&t.one, Some(&work)).is_empty());
    assert_eq!(b.space_tab_ids(&work), [w]);
    let urls: Vec<String> = b
        .space_tab_ids("default")
        .iter()
        .map(|id| short(&b.tabs[id].url))
        .collect();
    assert_eq!(urls, ["a", "b", "c"]);
}

#[test]
fn a_session_keeps_each_spaces_tabs_in_order_and_none_of_a_private_windows_or_little_bays() {
    let (mut b, t) = setup();
    b.update_settings([("launchTab".to_owned(), json!("lastTab"))]);
    let shown_tab = b.active_tab_id(&t.one, None).unwrap();
    b.pin_tabs(&[shown_tab], true);
    b.create_window(CreateWindow {
        incognito: true,
        url: Some("https://secret.com".into()),
        ..Default::default()
    });
    b.create_window(CreateWindow {
        small: true,
        url: Some("https://quick.com".into()),
        ..Default::default()
    });
    let _dir = relaunch(&mut b, false);
    let mut urls: Vec<String> = b.tabs.values().map(|t| short(&t.url)).collect();
    urls.sort();
    assert_eq!(urls, ["a", "b", "c"]);
    let order: Vec<String> = b
        .space_tab_ids("default")
        .iter()
        .map(|id| short(&b.tabs[id].url))
        .collect();
    assert_eq!(order, ["a", "b", "c"]);
    assert_eq!(b.window_order.len(), 2);
}

#[test]
fn a_reload_keeps_each_window_on_the_tab_it_showed_and_its_other_tabs_whatever_a_launch_would_do() {
    let (mut b, t) = setup();
    b.activate(&t.b, Some(&t.one));
    b.update_settings([("restoreSession".to_owned(), json!(false))]);
    let _dir = relaunch(&mut b, true);
    assert_eq!(
        b.active_tab_id(&t.one, None).as_ref(),
        Some(&t.b),
        "not a blank tab"
    );
    let open: Vec<String> = listed(&b, &t.one)
        .into_iter()
        .filter(|u| !u.is_empty())
        .collect();
    assert_eq!(open, ["a", "b", "c"], "restoreSession closes nothing");
}

#[test]
fn a_launch_without_restoring_the_session_puts_the_tabs_in_recently_closed() {
    let (mut b, t) = setup();
    b.pin_tabs(std::slice::from_ref(&t.a), true);
    b.update_settings([("restoreSession".to_owned(), json!(false))]);
    let _dir = relaunch(&mut b, false);
    assert!(b.windows.is_empty(), "no window comes back");
    let left: Vec<String> = b.tabs.values().map(|t| short(&t.url)).collect();
    assert_eq!(left, ["a"], "the pinned tab stays the space's");
    let closed = b.closed_windows.last().unwrap();
    let urls: Vec<String> = closed.tabs.iter().map(|t| short(&t.tab.url)).collect();
    assert_eq!(urls, ["b", "c"]);
}

#[test]
fn a_launch_starts_each_window_on_a_blank_tab_and_the_next_launch_reuses_it() {
    let (mut b, t) = setup();
    let first = relaunch(&mut b, false);
    let blank = b.active_tab_id(&t.one, None).unwrap();
    assert_eq!(b.tabs[&blank].url, "");
    let other = b.active_tab_id(&t.two, None).unwrap();
    assert_eq!(b.tabs[&other].url, "");
    assert_ne!(other, blank, "each window its own");
    let open: Vec<String> = listed(&b, &t.one)
        .into_iter()
        .filter(|u| !u.is_empty())
        .collect();
    assert_eq!(
        open,
        ["a", "b", "c"],
        "the space's tabs wait in the sidebar"
    );
    drop(first);

    let count = b.tabs.len();
    let _again = relaunch(&mut b, false);
    assert_eq!(b.tabs.len(), count);

    b.update_settings([("launchTab".to_owned(), json!("lastTab"))]);
    b.activate(&t.b, Some(&t.one));
    let _last = relaunch(&mut b, false);
    assert_eq!(shown(&b, &t.one), "b");
}

#[test]
fn a_session_from_before_spaces_is_migrated_with_its_parked_pins() {
    let scratch = tempfile::tempdir().unwrap();
    let dir = DataDir::new(scratch.path());
    let old = json!({
        "version": 2,
        "profiles": { "default": { "id": "default", "name": "Personal", "color": "plum", "icon": "🏠", "createdAt": 0 },
                      "work": { "id": "work", "name": "Work", "color": "blue", "icon": "💼", "createdAt": 1, "dataId": "default" } },
        "profileOrder": ["default", "work"],
        "windows": [{ "id": "w1", "profileId": "default", "incognito": false, "activeTabIds": { "default": "t1" }, "sidebarOpen": true, "frame": null, "createdAt": 0 }],
        "windowOrder": ["w1"],
        "focusedWindowId": "w1",
        "tabs": [{ "id": "t1", "windowId": "w1", "profileId": "default", "url": "https://a.com/", "title": "A", "favicon": null, "pinned": false,
                   "muted": false, "zoom": 1, "customTitle": null, "customIcon": null, "pinnedUrl": null, "openerId": null, "createdAt": 0, "lastActiveAt": 0 }],
        "groups": [],
        "parkedPins": { "work": { "tabs": [{ "id": "p1", "groupId": null, "url": "https://mail.com/", "title": "Mail", "favicon": null, "pinned": true,
                                             "muted": false, "zoom": 1, "customTitle": null, "customIcon": null, "profileId": "work" }], "groups": [] } },
        "closedTabs": [{ "kind": "tab", "id": "ct", "tab": { "url": "https://x.com/", "title": "X", "favicon": null, "pinned": false, "muted": false, "zoom": 1,
                         "customTitle": null, "customIcon": null, "profileId": "default" }, "windowId": "w1", "index": 0, "group": null, "closedAt": 0 }],
        "closedWindows": [],
        "settings": { "launchTab": "lastTab" },
    });
    dir.write("session.json", &old.to_string()).unwrap();
    let mut b = browser();
    assert!(b.launch(&dir, false).unwrap());
    assert_eq!(b.space_order, ["default", "work"]);
    assert_eq!(
        b.spaces["work"].profile_id.as_deref(),
        Some("default"),
        "its native profile, shared"
    );
    assert_eq!(b.spaces["work"].shares_sign_ins, Some(true));
    assert_eq!(b.active_tab_id("w1", None).as_deref(), Some("t1"));
    assert_eq!(b.tabs["p1"].space_id, "work");
    assert!(
        b.tabs["p1"].pinned && b.tabs["p1"].is_unloaded(),
        "a parked pin is its space's, unloaded"
    );
    assert_eq!(b.closed_tabs[0].tab.space_id, "default");
    assert!(
        dir.read("session.before-space-isolation.json")
            .unwrap()
            .is_some(),
        "the old file is kept"
    );
    let saved = Session::load(&dir).unwrap().unwrap();
    assert!(
        saved.extra.get("profiles").is_none(),
        "and the new one is written in today's shape"
    );
    assert_eq!(saved.spaces.len(), 2);
}

// session.test.mjs

#[test]
fn hydrate_repairs_dangling_references() {
    let mut b = browser();
    let tab = |id: &str, window: &str| {
        json!({ "id": id, "windowId": window, "spaceId": "default", "url": format!("https://{id}.com"), "title": "", "favicon": null,
                "pinned": false, "muted": false, "zoom": 1, "customTitle": null, "customIcon": null, "openerId": null, "createdAt": 0, "lastActiveAt": 0 })
    };
    let session: Session = serde_json::from_value(json!({
        "version": 2,
        "spaces": { "default": { "id": "default", "name": "Personal", "color": "plum", "icon": null, "createdAt": 0 } },
        "windows": [
            { "id": "w1", "spaceId": "gone", "incognito": false, "tabIds": ["t1", "missing"], "activeTabIds": { "gone": "missing" }, "sidebarOpen": true, "frame": null, "createdAt": 0 },
            { "id": "w2", "spaceId": "default", "incognito": false, "tabIds": [], "activeTabIds": {}, "sidebarOpen": true, "frame": null, "createdAt": 0 },
        ],
        "tabs": [tab("t1", "w1"), tab("t2", "nowhere")],
        "groups": [{ "id": "g", "windowId": "w1", "spaceId": "default", "name": "", "icon": null, "color": null, "collapsed": false, "pinned": false, "tabIds": ["missing"], "createdAt": 0 }],
    }))
    .unwrap();
    b.hydrate(session, false);
    assert_eq!(
        b.window_order,
        ["w1", "w2"],
        "a window with no tabs of its own still shows its space"
    );
    assert_eq!(b.windows["w1"].space_id, "default");
    assert_eq!(b.active_tab_id("w1", None).as_deref(), Some("t1"));
    assert!(
        b.tabs.contains_key("t2"),
        "a tab whose window is gone stays its space's"
    );
    assert_eq!(
        b.active_tab_id("w2", None).as_deref(),
        Some("t2"),
        "the other window shows it: not the tab w1 shows"
    );
    assert!(b.groups.is_empty());
}

#[test]
fn a_closed_windows_tabs_wait_with_their_back_forward_list_and_come_back_with_the_window() {
    let mut b = browser();
    window(&mut b, "keep.com");
    let w = window(&mut b, "a.com");
    let a = b.active_tab_id(&w, None).unwrap();
    let behind = |b: &mut Browser, url: &str, snapshot: Option<bay_state::model::TabSnapshot>| {
        b.new_tab(
            &w,
            NewTab {
                url: Some(url.into()),
                background: true,
                snapshot,
                ..Default::default()
            },
        )
        .unwrap()
    };
    let tb = behind(&mut b, "b.com", None);
    let snapshot =
        serde_json::from_value(json!({ "url": "https://c.com", "spaceId": "default" })).unwrap();
    let lazy = behind(&mut b, "c.com", Some(snapshot));
    b.update_tab(
        &lazy,
        TabPatch {
            navigation: Some(None),
            ..Default::default()
        },
        None,
    );
    // A tab opened behind it was opened after it: the window still comes back on the one it showed.
    let later = b.tabs[&a].last_active_at.0 + 1.0;
    b.update_tab(
        &tb,
        TabPatch {
            last_active_at: Some(later),
            ..Default::default()
        },
        None,
    );
    b.close_window(&w);
    assert_eq!(b.tabs[&a].window_id, "", "its page closed with the window");
    assert_eq!(
        b.tabs[&tb].wake_adopt_id,
        Some(format!("restore:{tb}")),
        "it waits with its history"
    );
    assert_eq!(b.tabs[&tb].navigation, None);
    assert_eq!(
        b.tabs[&lazy].wake_adopt_id, None,
        "a tab that never loaded has none"
    );
    b.reopen_closed_window();
    let w2 = b.window_order.last().unwrap().clone();
    assert_eq!(
        b.active_tab_id(&w2, None).as_ref(),
        Some(&a),
        "the window shows what it showed"
    );
    assert_eq!(
        b.tabs[&a].adopt_id,
        Some(format!("restore:{a}")),
        "the shown tab loads with its history"
    );
    b.activate(&tb, Some(&w2));
    assert_eq!(b.tabs[&tb].adopt_id, Some(format!("restore:{tb}")));
    assert_eq!(b.tabs[&tb].wake_adopt_id, None);
}

fn with_hosts(b: &mut Browser, hosts: &[&str]) -> (String, Vec<String>) {
    b.advance(1000.0);
    let w = window(b, &format!("{}.com", hosts[0]));
    let mut ids = vec![b.view_tab_ids(&w, None)[0].clone()];
    for h in &hosts[1..] {
        b.advance(1000.0);
        ids.push(
            b.new_tab(
                &w,
                NewTab {
                    url: Some(format!("{h}.com")),
                    ..Default::default()
                },
            )
            .unwrap(),
        );
    }
    (w, ids)
}

fn select(b: &mut Browser, id: &str) {
    b.advance(1000.0);
    b.activate(id, None);
}

#[test]
fn cmd_w_on_a_pinned_tab_unloads_its_page_and_the_tile_stays_with_its_title_icon_and_pinned_url() {
    let mut b = browser();
    b.update_settings([("newTabPosition".to_owned(), json!("bottom"))]);
    let (w, ids) = with_hosts(&mut b, &["mail", "a"]);
    let (p, a) = (&ids[0], &ids[1]);
    b.toggle_pin(p);
    b.update_tab(
        p,
        TabPatch {
            title: Some("Inbox".into()),
            favicon: Some(Some("data:mail".into())),
            ..Default::default()
        },
        None,
    );
    select(&mut b, p);
    b.close_tab(p);
    let tile = &b.tabs[p];
    assert!(tile.pinned);
    assert_eq!(tile.url, "https://mail.com");
    assert_eq!(tile.title, "Inbox");
    assert_eq!(tile.favicon.as_deref(), Some("data:mail"));
    assert_eq!(tile.navigation, None, "no page: its web view unmounts");
    assert_eq!(tile.adopt_id, None);
    assert!(tile.is_unloaded());
    let urls: Vec<&str> = b
        .view_tab_ids(&w, None)
        .iter()
        .map(|id| b.tabs[id].url.as_str())
        .collect();
    assert_eq!(urls, ["https://mail.com", "https://a.com"]);
    assert_eq!(b.active_tab_id(&w, None).as_ref(), Some(a));
}

#[test]
fn holding_cmd_w_over_pinned_tiles_ends_by_closing_the_window_and_no_unloaded_page_wakes() {
    let mut b = browser();
    let (w, ids) = with_hosts(&mut b, &["x", "a"]);
    let x = &ids[0];
    b.toggle_pin(x);
    select(&mut b, x);
    let mut wakes = Vec::new();
    for i in 0..10 {
        if !b.windows.contains_key(&w) {
            break;
        }
        let before = b.tabs[x].navigation.is_some();
        let active = b.active_tab_id(&w, None).unwrap();
        b.close_tab(&active);
        if b.windows.contains_key(&w) && !before && b.tabs[x].navigation.is_some() {
            wakes.push(i);
        }
    }
    assert!(wakes.is_empty(), "x.com never loads again");
    assert!(!b.windows.contains_key(&w), "the window closed, as in Dia");
    assert!(
        b.tabs[x].pinned && b.tabs[x].is_unloaded(),
        "the tile stays the space's, unloaded, for its next window"
    );
}

fn sidebar(b: &Browser, w: &str) -> Vec<String> {
    b.view_tab_ids(w, None)
        .into_iter()
        .filter(|id| b.in_pinned_container(id))
        .map(|id| {
            let t = &b.tabs[&id];
            let group = b
                .group_of(&id)
                .map_or(String::new(), |g| format!("{}/", g.name));
            let loaded = if t.navigation.is_some() || t.adopt_id.is_some() {
                " (loaded)"
            } else {
                ""
            };
            format!("{group}{}{loaded}", t.url)
        })
        .collect()
}

fn pinned_window(b: &mut Browser) -> (String, String, String) {
    b.update_settings([("newTabPosition".to_owned(), json!("bottom"))]);
    let (w, ids) = with_hosts(b, &["mail", "docs", "jira", "wiki", "a"]);
    b.toggle_pin(&ids[0]);
    b.toggle_pin(&ids[1]);
    let work = b.group_tabs(&ids[2..4], true, None, false).unwrap();
    b.update_group(
        &work,
        GroupPatch {
            name: Some("Work".into()),
            ..Default::default()
        },
    );
    select(b, &ids[4]);
    select(b, &ids[0]);
    (w, ids[0].clone(), work)
}

const PINS: [&str; 4] = [
    "https://mail.com",
    "https://docs.com",
    "Work/https://jira.com",
    "Work/https://wiki.com",
];

#[test]
fn cmd_w_until_the_window_closes_then_cmd_n_and_the_pinned_tabs_and_groups_are_there_in_order_unloaded()
 {
    let mut b = browser();
    let (w, mail, work) = pinned_window(&mut b);
    assert_eq!(
        sidebar(&b, &w),
        [
            "https://mail.com (loaded)",
            "https://docs.com (loaded)",
            "Work/https://jira.com (loaded)",
            "Work/https://wiki.com (loaded)"
        ]
    );
    for _ in 0..12 {
        if !b.windows.contains_key(&w) {
            break;
        }
        let active = b.active_tab_id(&w, None).unwrap();
        b.close_tab(&active);
    }
    assert!(!b.windows.contains_key(&w), "the window closed");
    let n = b.create_window(CreateWindow::default());
    assert_eq!(
        sidebar(&b, &n),
        PINS,
        "same tiles, same order, the group still pinned, nothing loaded"
    );
    assert_eq!(
        b.tabs[&b.active_tab_id(&n, None).unwrap()].url,
        "",
        "the new window shows a New Tab page"
    );
    assert!(b.tabs.contains_key(&mail), "the same tab");
    assert!(b.groups[&work].pinned);
    let n2 = b.create_window(CreateWindow::default());
    assert_eq!(
        sidebar(&b, &n2),
        PINS,
        "a second window lists the same ones: they're the space's"
    );
}

#[test]
fn reopening_after_the_close_then_cmd_n_gives_one_set_of_pinned_tabs() {
    let mut b = browser();
    let (w, _, _) = pinned_window(&mut b);
    b.close_window(&w);
    b.reopen_closed(None);
    let restored = b.ui.focused_window_id.clone().unwrap();
    assert_ne!(restored, w);
    let mut expected = vec!["https://mail.com (loaded)".to_owned()];
    expected.extend(PINS[1..].iter().map(|s| (*s).to_owned()));
    assert_eq!(
        sidebar(&b, &restored),
        expected,
        "the reopened window shows what it showed"
    );
    let rest: Vec<&str> = b
        .view_tab_ids(&restored, None)
        .into_iter()
        .filter(|id| !b.in_pinned_container(id))
        .map(|id| b.tabs[&id].url.as_str())
        .collect();
    assert_eq!(rest, ["https://a.com"]);
    let n = b.create_window(CreateWindow::default());
    assert_eq!(
        sidebar(&b, &n),
        expected,
        "⌘N lists the same tabs (mail's page is in the other window)"
    );
    assert_eq!(
        b.tabs
            .values()
            .filter(|t| t.url == "https://mail.com")
            .count(),
        1,
        "one tab"
    );
}

#[test]
fn quit_and_relaunch_after_the_window_closed_and_the_next_window_has_the_pinned_tabs_unloaded() {
    let mut b = browser();
    let (w, _, _) = pinned_window(&mut b);
    b.close_window(&w);
    let _dir = relaunch(&mut b, false);
    assert!(b.window_order.is_empty(), "no window restored");
    let n = b.create_window(CreateWindow::default());
    assert_eq!(sidebar(&b, &n), PINS);
}
