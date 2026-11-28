//! apps/browser/src/store/cleanUp.test.mjs, tidyTabs.test.mjs and tidyTabTitles.test.mjs: the automatic clean-up
//! (Arc's archive), Tidy Tabs, and tidied pinned-row titles.

mod support;

use bay_state::Browser;
use bay_state::model::{SplitView, Tab, TabGroup};
use bay_state::store::{CreateWindow, NewTab, SpacePatch, TabLive, TabPatch, TabTidyPlan};
use indexmap::IndexMap;
use serde_json::json;
use support::browser;

const HOUR: f64 = 3_600_000.0;

fn urls(b: &Browser, w: &str, space: &str) -> Vec<String> {
    b.view_tab_ids(w, Some(space))
        .iter()
        .map(|id| b.tabs[id].url.clone())
        .collect()
}

fn behind(b: &mut Browser, w: &str, url: &str) -> String {
    b.new_tab(
        w,
        NewTab {
            url: Some(url.into()),
            background: true,
            ..Default::default()
        },
    )
    .unwrap()
}

/// Personal with an active page (a.com) and one unused for `hours` (b.com); Work with the same, c.com and d.com. The
/// window ends on Personal.
fn setup(hours: f64) -> (Browser, String, String, String) {
    let mut b = browser();
    b.update_settings([("newTabPosition".to_owned(), json!("bottom"))]);
    let personal = b.settings.default_space_id().to_owned();
    let work = b.create_space("Work", None, None, None, None);
    let w = b.create_window(CreateWindow {
        space_id: Some(personal.clone()),
        url: Some("https://a.com".into()),
        ..Default::default()
    });
    let tb = behind(&mut b, &w, "https://b.com");
    b.switch_space(&w, &work);
    let shown = b.windows[&w].active_tab_ids[&work].clone();
    b.navigate(&shown, "https://c.com", true);
    let d = behind(&mut b, &w, "https://d.com");
    b.switch_space(&w, &personal);
    let old = b.now() - hours * HOUR;
    for id in [tb, d] {
        b.update_tab(
            &id,
            TabPatch {
                last_active_at: Some(old),
                ..Default::default()
            },
            None,
        );
    }
    (b, personal, work, w)
}

#[test]
fn a_new_install_cleans_up_tabs_unused_for_12_hours() {
    let b = browser();
    assert_eq!(b.clean_up_hours(b.settings.default_space_id()), Some(12.0));
}

#[test]
fn a_saved_choice_to_never_clean_up_stays() {
    let mut b = browser();
    b.update_settings([("cleanUpInactiveTabsAfterHours".to_owned(), json!(null))]);
    assert_eq!(b.clean_up_hours(b.settings.default_space_id()), None);
}

#[test]
fn the_automatic_clean_up_reaches_the_spaces_a_window_isnt_showing() {
    let (mut b, personal, work, w) = setup(13.0);
    assert_eq!(b.clean_up_inactive_tabs(), 2);
    assert_eq!(urls(&b, &w, &personal), ["https://a.com"]);
    assert_eq!(
        urls(&b, &w, &work),
        ["https://c.com"],
        "Work's active tab stays"
    );
    assert_eq!(
        b.windows[&w].space_id, personal,
        "the window stays on its space"
    );
}

#[test]
fn a_spaces_own_time_overrides_the_apps_and_never_keeps_its_tabs() {
    let (mut b, personal, work, w) = setup(30.0);
    let hours = |h: Option<f64>| SpacePatch {
        clean_up_after_hours: Some(h),
        ..Default::default()
    };
    b.update_space(&personal, hours(Some(168.0)));
    b.update_space(&work, hours(None));
    assert_eq!(b.clean_up_inactive_tabs(), 0);
    b.update_space(&personal, hours(Some(24.0)));
    b.update_settings([("cleanUpInactiveTabsAfterHours".to_owned(), json!(null))]);
    assert_eq!(
        b.clean_up_inactive_tabs(),
        1,
        "Personal's 24 hours, with the app's turned off"
    );
    assert_eq!(urls(&b, &w, &work), ["https://c.com", "https://d.com"]);
}

#[test]
fn clean_up_tabs_from_the_menu_cleans_the_space_on_screen_only() {
    let (mut b, _, work, w) = setup(13.0);
    assert_eq!(b.clean_up_tabs(&w, None, None), 1);
    assert_eq!(urls(&b, &w, &work).len(), 2);
}

#[test]
fn restoring_one_cleaned_up_tab_puts_it_back_in_its_space_and_returns_it() {
    let (mut b, _, work, w) = setup(13.0);
    b.clean_up_inactive_tabs();
    let entry = b
        .cleaned_tabs
        .iter()
        .find(|c| c.tab.url == "https://d.com")
        .unwrap()
        .id
        .clone();
    let id = b.restore_cleaned(Some(&entry), Some(&w)).unwrap();
    assert_eq!(b.tabs[&id].url, "https://d.com");
    assert_eq!(b.tabs[&id].space_id, work);
    assert_eq!(b.windows[&w].space_id, work);
    assert_eq!(b.windows[&w].active_tab_ids[&work], id);
    assert!(!b.cleaned_tabs.iter().any(|c| c.id == entry));
    assert_eq!(
        b.restore_cleaned(Some(&entry), Some(&w)),
        None,
        "gone once restored"
    );
}

#[test]
fn cleanup_keeps_duplicate_precedence_group_differences_other_windows_and_splits() {
    let mut base = browser();
    let space = base.settings.default_space_id().to_owned();
    base.create_space("Work", None, None, None, None);
    let window = base.create_window(CreateWindow {
        space_id: Some(space.clone()),
        url: Some("https://active.test".into()),
        ..Default::default()
    });
    let other = base.create_window(CreateWindow {
        space_id: Some(space.clone()),
        url: Some("https://other.test".into()),
        ..Default::default()
    });
    let template = base.tabs[&base.windows[&window].active_tab_ids[&space]].clone();
    let page = "https://same.test";
    let make = |id: &str, patch: serde_json::Value| {
        let mut t = serde_json::to_value(&template).unwrap();
        t["id"] = json!(id);
        t["url"] = json!(format!("https://{id}.test"));
        t["lastActiveAt"] = json!(90);
        for (k, v) in patch.as_object().unwrap() {
            t[k] = v.clone();
        }
        serde_json::from_value::<Tab>(t).unwrap()
    };
    let group = |ids: &[&str], pinned: bool| -> TabGroup {
        serde_json::from_value(
            json!({ "id": "g", "spaceId": space, "name": "", "tabIds": ids, "pinned": pinned }),
        )
        .unwrap()
    };
    let split = |ids: &[&str]| -> SplitView {
        serde_json::from_value(json!({ "id": "s", "tabIds": ids, "orientation": "horizontal" }))
            .unwrap()
    };
    struct Case {
        tabs: Vec<Tab>,
        groups: Vec<TabGroup>,
        splits: Vec<SplitView>,
        audio: Vec<&'static str>,
        threshold: f64,
        want: Vec<&'static str>,
    }
    let case = |tabs: Vec<Tab>, want: Vec<&'static str>| Case {
        tabs,
        groups: vec![],
        splits: vec![],
        audio: vec![],
        threshold: 100.0,
        want,
    };
    let cases = vec![
        case(
            vec![
                make("first", json!({ "url": page })),
                make("second", json!({ "url": page, "pinnedRow": true })),
            ],
            vec!["first"],
        ),
        case(
            vec![
                make("pinned", json!({ "url": page, "pinned": true })),
                make("active", json!({ "url": page })),
                make("newest", json!({ "url": page, "lastActiveAt": 110 })),
            ],
            vec!["newest"],
        ),
        case(
            vec![
                make("first", json!({ "url": page, "lastActiveAt": 99 })),
                make("active", json!({ "url": page })),
            ],
            vec!["first"],
        ),
        case(
            vec![
                make("first", json!({ "url": page })),
                make("second", json!({ "url": page })),
            ],
            vec!["second"],
        ),
        case(
            vec![
                make("first", json!({ "url": page })),
                make("newer", json!({ "url": page, "lastActiveAt": 99 })),
            ],
            vec!["first"],
        ),
        Case {
            audio: vec!["audio"],
            ..case(
                vec![
                    make("kept", json!({ "url": page, "kept": true })),
                    make("audio", json!({ "url": page })),
                    make("other", json!({ "url": page })),
                ],
                vec![],
            )
        },
        Case {
            groups: vec![group(&["grouped"], true)],
            ..case(
                vec![
                    make("first", json!({ "url": page })),
                    make("grouped", json!({ "url": page })),
                ],
                vec!["grouped"],
            )
        },
        Case {
            groups: vec![group(&["grouped"], false)],
            threshold: 0.0,
            ..case(vec![make("grouped", json!({}))], vec![])
        },
        Case {
            splits: vec![split(&["split"])],
            ..case(
                vec![
                    make("first", json!({ "url": page })),
                    make("split", json!({ "url": page })),
                    make("other", json!({ "url": page })),
                ],
                vec![],
            )
        },
        Case {
            threshold: 0.0,
            ..case(vec![make("future", json!({ "lastActiveAt": 101 }))], vec![])
        },
        Case {
            threshold: 10.0,
            ..case(
                vec![make("boundary", json!({ "lastActiveAt": 90 }))],
                vec!["boundary"],
            )
        },
        Case {
            threshold: 0.0,
            ..case(vec![make("blank", json!({ "url": "" }))], vec!["blank"])
        },
    ];
    for c in cases {
        let mut s = browser();
        s.hydrate(base.to_session(), false);
        s.tabs = c.tabs.iter().map(|t| (t.id.clone(), t.clone())).collect();
        s.tab_lists =
            IndexMap::from([(space.clone(), c.tabs.iter().map(|t| t.id.clone()).collect())]);
        s.windows[&window].active_tab_ids = IndexMap::from([(space.clone(), "active".to_owned())]);
        s.windows[&other].active_tab_ids = IndexMap::from([(space.clone(), "other".to_owned())]);
        s.groups = c.groups.into_iter().map(|g| (g.id.clone(), g)).collect();
        s.splits = c.splits.into_iter().map(|v| (v.id.clone(), v)).collect();
        s.live = c
            .audio
            .iter()
            .map(|id| {
                (
                    (*id).to_owned(),
                    TabLive {
                        playing_audio: true,
                        ..Default::default()
                    },
                )
            })
            .collect();
        assert_eq!(
            s.clean_up_candidates(&window, c.threshold, 100.0, None),
            c.want
        );
        assert_eq!(
            s.has_clean_up_candidates(&window, c.threshold, 100.0, None),
            !c.want.is_empty()
        );
    }
}

// tidyTabs.test.mjs

fn group_of(b: &Browser, id: &str) -> Option<String> {
    b.group_of(id).map(|g| g.id.clone())
}

#[test]
fn tidy_tabs_groups_the_lists_tabs_by_site_and_leaves_pinned_tabs() {
    let mut b = browser();
    let w = b.create_window(CreateWindow {
        url: Some("https://github.com/a".into()),
        ..Default::default()
    });
    let first = b.active_tab_id(&w, None).unwrap();
    let second = behind(&mut b, &w, "https://github.com/b");
    let pinned = behind(&mut b, &w, "https://github.com/c");
    b.pin_rows(std::slice::from_ref(&pinned), true);
    let old = behind(&mut b, &w, "https://github.com/d");
    b.tabs[&old].created_at = bay_state::JsNumber(0.0);
    b.tabs[&old].last_active_at = bay_state::JsNumber(0.0);
    let lone = behind(&mut b, &w, "https://example.com");
    assert_eq!(b.tidy_tabs(&w, None), 1);
    let group = b.group_of(&first).unwrap();
    let mut members = group.tab_ids.clone();
    members.sort();
    let mut want = vec![first, second, old];
    want.sort();
    assert_eq!(members, want);
    assert_eq!(group_of(&b, &pinned), None);
    assert_eq!(group_of(&b, &lone), None);
}

#[test]
fn tidy_tabs_leaves_tabs_already_in_a_group_alone() {
    let mut b = browser();
    let w = b.create_window(CreateWindow {
        url: Some("https://github.com/a".into()),
        ..Default::default()
    });
    let first = b.active_tab_id(&w, None).unwrap();
    let second = behind(&mut b, &w, "https://github.com/b");
    let group = b
        .group_tabs(&[first, second], false, Some("Mine"), false)
        .unwrap();
    let before = b.groups.clone();
    assert_eq!(b.tidy_tabs(&w, None), 0);
    assert_eq!(b.groups, before);
    assert_eq!(b.groups[&group].tab_ids.len(), 2);
}

fn list(paths: &[&str]) -> (Browser, String, Vec<String>) {
    let mut b = browser();
    let w = b.create_window(CreateWindow {
        url: Some(format!("https://example.com/{}", paths[0])),
        ..Default::default()
    });
    let mut ids = vec![b.active_tab_id(&w, None).unwrap()];
    for p in &paths[1..] {
        ids.push(behind(&mut b, &w, &format!("https://example.com/{p}")));
    }
    (b, w, ids)
}

#[test]
fn tidy_tabs_applies_a_plans_names_across_sites_and_leaves_the_rest_loose() {
    let (mut b, w, ids) = list(&["a", "b", "c", "d"]);
    let plan = TabTidyPlan {
        new_groups: vec![(Some("Trip".into()), vec![ids[0].clone(), ids[2].clone()])],
        joins: vec![],
    };
    assert_eq!(b.tidy_tabs(&w, Some(plan)), 1);
    assert_eq!(b.group_of(&ids[0]).unwrap().name, "Trip");
    assert_eq!(group_of(&b, &ids[2]), group_of(&b, &ids[0]));
    assert_eq!(group_of(&b, &ids[1]), None);
    assert_eq!(group_of(&b, &ids[3]), None);
}

#[test]
fn tidy_tabs_adds_to_a_group_the_list_already_has() {
    let (mut b, w, ids) = list(&["a", "b", "c", "d"]);
    let group = b.group_tabs(&ids[..2], false, Some("Trip"), false).unwrap();
    b.groups[&group].collapsed = true;
    let plan = TabTidyPlan {
        new_groups: vec![],
        joins: vec![(group.clone(), vec![ids[2].clone(), ids[3].clone()])],
    };
    assert_eq!(b.tidy_tabs(&w, Some(plan)), 1);
    let mut members = b.groups[&group].tab_ids.clone();
    members.sort();
    let mut want = ids.clone();
    want.sort();
    assert_eq!(members, want);
    assert!(!b.groups[&group].collapsed);
}

#[test]
fn a_plan_skips_tabs_that_were_closed_grouped_or_split_while_the_model_thought() {
    let (mut b, w, ids) = list(&["a", "b", "c", "d", "e", "f"]);
    let plan = TabTidyPlan {
        new_groups: vec![(Some("Late".into()), ids[..4].to_vec())],
        joins: vec![],
    };
    b.close_tab(&ids[0]);
    b.group_tabs(
        &[ids[1].clone(), ids[4].clone()],
        false,
        Some("Mine"),
        false,
    );
    b.create_split(&[ids[2].clone(), ids[5].clone()], "horizontal");
    assert_eq!(b.tidy_tabs(&w, Some(plan)), 0);
    assert_eq!(group_of(&b, &ids[3]), None);
}

#[test]
fn only_web_pages_are_candidates_not_pinned_grouped_or_split_tabs() {
    let (mut b, w, ids) = list(&["a", "b", "c", "d"]);
    let page = behind(&mut b, &w, "bay://history");
    b.pin_rows(std::slice::from_ref(&ids[0]), true);
    b.group_tabs(std::slice::from_ref(&ids[1]), false, Some("Mine"), false);
    let mut candidates = b.tidy_candidates(&w, None);
    candidates.sort();
    let mut want = vec![ids[2].clone(), ids[3].clone()];
    want.sort();
    assert_eq!(candidates, want);
    assert!(!candidates.contains(&page));
}

// tidyTabTitles.test.mjs

fn gmail() -> (Browser, String) {
    let mut b = browser();
    let w = b.create_window(CreateWindow {
        url: Some("https://mail.google.com".into()),
        ..Default::default()
    });
    let id = b.active_tab_id(&w, None).unwrap();
    b.update_tab(
        &id,
        TabPatch {
            title: Some("Inbox – Gmail".into()),
            ..Default::default()
        },
        None,
    );
    (b, id)
}

#[test]
fn tidy_sets_a_custom_title_on_pin_when_enabled() {
    let (mut b, id) = gmail();
    b.update_settings([("tidyTabTitles".to_owned(), json!(true))]);
    b.pin_rows(std::slice::from_ref(&id), true);
    assert_eq!(b.tabs[&id].custom_title.as_deref(), Some("Gmail"));
    b.update_tab(
        &id,
        TabPatch {
            custom_title: Some(None),
            ..Default::default()
        },
        None,
    );
    assert_eq!(b.tabs[&id].custom_title, None, "Reset Name clears it");
}

#[test]
fn tidy_off_by_default_does_nothing() {
    let (mut b, id) = gmail();
    b.pin_rows(std::slice::from_ref(&id), true);
    assert_eq!(b.tabs[&id].custom_title, None);
}

#[test]
fn a_private_windows_site_mute_is_its_own_and_goes_with_it() {
    let mut b = browser();
    let p = b.create_window(CreateWindow {
        incognito: true,
        url: Some("https://loud.com".into()),
        ..Default::default()
    });
    let tab = b.active_tab_id(&p, None).unwrap();
    b.set_site_muted(&tab, true);
    assert!(b.tabs[&tab].muted);
    assert_eq!(
        b.settings.0.get("mutedSites"),
        None,
        "nothing private reaches the settings"
    );
    let next = behind(&mut b, &p, "https://quiet.com");
    assert!(!b.tabs[&next].muted);
    b.update_tab(
        &next,
        TabPatch {
            url: Some("https://loud.com/other".into()),
            ..Default::default()
        },
        None,
    );
    assert!(
        b.tabs[&next].muted,
        "a page of the site the window muted is muted"
    );
    b.close_window(&p);
    assert!(b.private_site_mutes.is_empty());
}
