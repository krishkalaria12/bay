//! apps/browser/src/store/spaceProfiles.test.mjs: every sidebar space has its own native browser profile; older shared
//! profiles split on loading, and a space made to share sign-ins keeps sharing.

mod support;

use std::collections::HashMap;

use bay_state::store::{
    BookmarkNode, Bookmarks, HistoryEntry, HistoryRow, HydrateData, NewTab, Roots,
};
use bay_state::{Browser, JsNumber, Session};
use serde_json::{Value, json};
use support::browser;

fn space(id: &str, profile_id: Option<&str>) -> Value {
    let mut s = json!({ "id": id, "name": id, "color": "blue", "icon": null, "createdAt": 0 });
    if let Some(p) = profile_id {
        s["profileId"] = json!(p);
    }
    s
}

fn visited() -> Vec<HistoryEntry> {
    vec![HistoryEntry {
        url: "https://visited.example/".into(),
        title: "Visited".into(),
        favicon: None,
        visits: JsNumber(1.0),
        last_visit: JsNumber(10.0),
        visit_times: None,
    }]
}

fn row(url: &str) -> HistoryRow {
    HistoryRow {
        url: url.into(),
        title: "Visited".into(),
        visits: 1.0,
        last_visit: 10.0,
    }
}

/// A session of these fields, the rest empty.
fn session(fields: Value) -> Session {
    let mut doc = json!({ "version": 2 });
    for (k, v) in fields.as_object().unwrap() {
        doc[k] = v.clone();
    }
    serde_json::from_value(doc).unwrap()
}

/// What the TypeScript test's save() keeps: the session, the history view and the bookmarks.
fn save(b: &Browser) -> HydrateData {
    HydrateData {
        session: b.to_session(),
        launch: false,
        history: Some(b.history.clone()),
        bookmarks: Some(b.bookmarks.clone()),
    }
}

fn saved_json(b: &Browser) -> Value {
    let s = b.to_session();
    json!({
        "spaces": s.spaces, "spaceOrder": s.space_order, "tabs": s.tabs, "tabLists": s.tab_lists,
        "bookmarks": b.bookmarks, "history": b.history, "orphanedProfileData": s.orphaned_profile_data,
    })
}

fn bar_titles(b: &Browser, space: &str) -> Vec<String> {
    let bar = &b.bookmarks.roots[space].bar;
    b.bookmarks
        .folder_children(bar)
        .into_iter()
        .map(|n| match n {
            BookmarkNode::Url { title, .. } | BookmarkNode::Folder { title, .. } => title.clone(),
        })
        .collect()
}

#[test]
fn a_space_with_its_own_sign_ins_has_separate_native_history_and_bookmarks() {
    let mut b = browser();
    let personal = b.settings.default_space_id().to_owned();
    b.import_history(&personal, &[row("https://visited.example/")]);
    let bookmark = b.add_bookmark(
        &personal,
        "https://saved.example/",
        "Saved",
        None,
        None,
        None,
    );
    let work = b.create_space("Work", None, None, None, None);
    assert_ne!(b.engine_profile(&personal), b.engine_profile(&work));
    assert_ne!(b.bookmarks.roots[&personal], b.bookmarks.roots[&work]);
    assert!(!b.history.contains_key(&work));
    b.import_history(&work, &[row("https://work.example/")]);
    let urls: Vec<&str> = b.history[&personal]
        .iter()
        .map(|h| h.url.as_str())
        .collect();
    assert_eq!(urls, ["https://visited.example/"]);
    assert!(b.bookmarks.nodes.contains_key(&bookmark));
}

#[test]
fn a_space_made_to_share_sign_ins_uses_that_spaces_profile_and_still_does_after_a_reload() {
    let mut b = browser();
    let personal = b.settings.default_space_id().to_owned();
    let work = b.create_space("Work", None, None, None, Some(&personal));
    assert_eq!(b.spaces[&work].shares_sign_ins, Some(true));
    assert_eq!(b.engine_profile(&work), b.engine_profile(&personal));
    assert_eq!(
        b.bookmarks.roots[&work], b.bookmarks.roots[&personal],
        "one profile, one set of bookmarks"
    );
    let mut data = save(&b);
    data.history = None;
    b.hydrate_data(data);
    assert_eq!(
        b.engine_profile(&work),
        b.engine_profile(&personal),
        "loading keeps a chosen share"
    );
    assert_eq!(b.spaces[&work].shares_sign_ins, Some(true));
}

#[test]
fn legacy_sharing_preserves_the_named_owner_its_native_directory_and_bookmarks() {
    let mut b = browser();
    let bookmark = b.add_bookmark(
        "default",
        "https://saved.example/",
        "Saved",
        None,
        None,
        None,
    );
    let mut bookmarks = b.bookmarks.clone();
    let default_roots = bookmarks.roots["default"].clone();
    bookmarks.roots.insert("work".into(), default_roots);
    b.hydrate_data(HydrateData {
        session: session(json!({
            "spaces": { "work": space("work", Some("default")), "default": space("default", None) },
            "spaceOrder": ["work", "default"],
            "orphanedProfileData": [""],
        })),
        history: Some(HashMap::from([
            ("default".into(), visited()),
            ("work".into(), visited()),
        ])),
        bookmarks: Some(bookmarks),
        launch: false,
    });
    assert_eq!(b.engine_profile("default"), "");
    assert_eq!(b.engine_profile("work"), "work");
    assert_eq!(b.history["default"], visited());
    assert!(!b.history.contains_key("work"));
    assert!(!b.history_ready.contains("work"));
    assert!(!b.bookmarks_ready.contains("work"));
    assert!(b.bookmarks.nodes.contains_key(&bookmark));
    assert_ne!(b.bookmarks.roots["default"], b.bookmarks.roots["work"]);
    assert!(
        b.orphaned_profile_data.is_empty(),
        "the original native directory must not be deleted"
    );
}

#[test]
fn a_legacy_profile_without_its_named_space_belongs_to_the_first_ordered_space() {
    let mut b = browser();
    b.hydrate_data(HydrateData {
        session: session(json!({
            "spaces": { "a": space("a", Some("old")), "b": space("b", Some("old")) },
            "spaceOrder": ["b", "a"],
            "orphanedProfileData": ["old"],
        })),
        history: Some(HashMap::from([("a".into(), visited())])),
        ..Default::default()
    });
    assert_eq!(
        b.engine_profile("b"),
        "old",
        "existing engine data keeps its alias"
    );
    assert_eq!(b.engine_profile("a"), "a");
    assert_eq!(
        b.history["b"],
        visited(),
        "the shared saved view stays with its native owner"
    );
    assert!(!b.history.contains_key("a"));
    assert!(b.orphaned_profile_data.is_empty());
}

#[test]
fn splitting_legacy_shared_lists_preserves_each_spaces_tab_order_and_favorites() {
    let mut b = browser();
    let work = b.create_space("Work", None, None, None, None);
    let w = b.create_window(bay_state::store::CreateWindow {
        url: Some("https://personal.example/".into()),
        ..Default::default()
    });
    let personal_tab = b.active_tab_id(&w, None).unwrap();
    b.pin_tabs(std::slice::from_ref(&personal_tab), true);
    let open = |b: &mut Browser, url: &str| {
        b.new_tab(
            &w,
            NewTab {
                space_id: Some(work.clone()),
                url: Some(url.into()),
                background: true,
                ..Default::default()
            },
        )
        .unwrap()
    };
    let pinned_row = open(&mut b, "https://row.example/");
    b.tabs[&pinned_row].pinned_row = Some(true);
    let fav = open(&mut b, "https://favorite.example/");
    b.pin_tabs(std::slice::from_ref(&fav), true);
    let page = open(&mut b, "https://page.example/");
    let mut data = save(&b);
    data.session.spaces[&work].profile_id = Some("default".into());
    data.session.tab_lists = [(
        "default".to_owned(),
        vec![
            personal_tab.clone(),
            fav.clone(),
            pinned_row.clone(),
            page.clone(),
        ],
    )]
    .into_iter()
    .collect();
    data.session
        .tabs
        .iter_mut()
        .find(|t| t.id == page)
        .unwrap()
        .wake_adopt_id = Some("restore:old-profile".into());
    b.hydrate_data(data);
    assert_eq!(b.space_tab_ids("default"), [personal_tab]);
    assert_eq!(
        b.space_tab_ids(&work),
        [fav.clone(), pinned_row.clone(), page.clone()]
    );
    assert_eq!(
        b.tabs[&page].wake_adopt_id, None,
        "restored pages cannot adopt the old native context"
    );
    assert_eq!(b.tabs[&fav].space_id, work);
    assert_eq!(b.tabs[&pinned_row].pinned_row, Some(true));
}

#[test]
fn migration_avoids_active_native_ids_and_native_data_still_queued_for_deletion() {
    let mut b = browser();
    b.hydrate(
        session(json!({
            "spaces": {
                "default": space("default", Some("shared")), "shared": space("shared", None),
                "work": space("work", Some("shared")), "other": space("other", Some("work-isolated")),
            },
            "spaceOrder": ["default", "work", "shared", "other"],
            "orphanedProfileData": ["work"],
        })),
        false,
    );
    let native: Vec<String> = b
        .space_order
        .iter()
        .map(|id| b.engine_profile(id))
        .collect();
    let unique: std::collections::HashSet<&String> = native.iter().collect();
    assert_eq!(unique.len(), native.len());
    assert_ne!(b.engine_profile("work"), "work");
    assert_ne!(b.engine_profile("work"), "work-isolated");
    assert_eq!(b.engine_profile("shared"), "shared");
    assert_eq!(b.orphaned_profile_data, ["work"]);
    let migrated = saved_json(&b);
    b.hydrate_data(save(&b));
    assert_eq!(
        saved_json(&b),
        migrated,
        "an already migrated session stays unchanged"
    );
}

#[test]
fn unique_historical_aliases_keep_their_native_data_and_tab_list_becomes_space_owned() {
    let mut b = browser();
    b.hydrate_data(HydrateData {
        session: session(json!({ "spaces": { "work": space("work", Some("historical")) }, "spaceOrder": ["work"] })),
        history: Some(HashMap::from([("work".into(), visited())])),
        ..Default::default()
    });
    assert_eq!(b.engine_profile("work"), "historical");
    assert_eq!(
        b.bookmarks.roots["work"],
        Roots {
            bar: "bar@historical".into(),
            other: "other@historical".into()
        }
    );
    assert_eq!(b.space_list_key("work"), "work");
    assert_eq!(b.history["work"], visited());
    b.hydrate(Session::default(), false);
    assert_eq!(
        b.engine_profile("work"),
        "work",
        "the native registry follows the next loaded session"
    );
}

#[test]
fn the_canonical_owner_rekeys_cached_bookmark_roots_and_detached_roots_start_empty() {
    let bar = json!({ "kind": "folder", "id": "legacy-bar", "parentId": null, "title": "Bookmarks Bar", "children": ["saved"], "addedAt": 0 });
    let other = json!({ "kind": "folder", "id": "legacy-other", "parentId": null, "title": "Other Bookmarks", "children": [], "addedAt": 0 });
    let saved = json!({ "kind": "url", "id": "saved", "parentId": "legacy-bar", "title": "Saved", "url": "https://saved.example/", "favicon": null, "addedAt": 0 });
    let mut cached = bar.clone();
    cached["id"] = json!("bar@b");
    let bookmarks: Bookmarks = serde_json::from_value(json!({
        "nodes": { "legacy-bar": bar, "legacy-other": other, "saved": saved, "bar@b": cached },
        "roots": { "a": { "bar": "legacy-bar", "other": "legacy-other" }, "b": { "bar": "legacy-bar", "other": "legacy-other" } },
    }))
    .unwrap();
    let mut b = browser();
    b.hydrate_data(HydrateData {
        session: session(json!({ "spaces": { "a": space("a", Some("old")), "b": space("b", Some("old")) }, "spaceOrder": ["a", "b"] })),
        bookmarks: Some(bookmarks),
        ..Default::default()
    });
    assert_eq!(
        b.bookmarks.roots["a"],
        Roots {
            bar: "bar@old".into(),
            other: "other@old".into()
        }
    );
    assert_eq!(b.bookmarks.nodes["bar@old"].children(), ["saved"]);
    assert_eq!(b.bookmarks.nodes["saved"].parent_id(), Some("bar@old"));
    assert!(
        !b.bookmarks.nodes.contains_key("legacy-bar"),
        "the replaced bar root is not a duplicate tree"
    );
    assert!(!b.bookmarks.nodes.contains_key("legacy-other"));
    assert_eq!(b.bookmarks.nodes.len(), 5);
    assert!(
        b.bookmarks.nodes["bar@b"].children().is_empty(),
        "an unused cached root is not another space's bookmarks"
    );
}

#[test]
fn shared_sign_ins_share_the_whole_profile_and_its_own_sign_ins_share_nothing() {
    let mut b = browser();
    let personal = b.settings.default_space_id().to_owned();
    let shared = b.create_space("Shared", None, None, None, Some(&personal));
    let own = b.create_space("Own", None, None, None, None);
    assert_eq!(b.engine_profile(&shared), b.engine_profile(&personal));
    assert_ne!(b.engine_profile(&own), b.engine_profile(&personal));

    b.add_bookmark(
        &shared,
        "https://from-shared.example/",
        "From Shared",
        None,
        None,
        None,
    );
    assert_eq!(bar_titles(&b, &personal), bar_titles(&b, &shared));
    assert!(
        bar_titles(&b, &personal).contains(&"From Shared".to_owned()),
        "a bookmark added in the shared space shows in Personal"
    );
    assert!(
        !bar_titles(&b, &own).contains(&"From Shared".to_owned()),
        "and not in the space with its own sign-ins"
    );

    let owns: Vec<bool> = [&personal, &shared, &own]
        .iter()
        .map(|id| b.owns_profile_data(id))
        .collect();
    assert_eq!(owns, [true, false, true]);

    let w = b.create_window(bay_state::store::CreateWindow {
        space_id: Some(shared.clone()),
        url: Some("https://shared-tab.example/".into()),
        ..Default::default()
    });
    let tab = b.windows[&w].active_tab_ids[&shared].clone();
    assert_eq!(b.tabs[&tab].space_id, shared);
    assert!(!b.view_tab_ids(&w, Some(&personal)).contains(&tab));

    b.delete_space(&shared);
    assert!(
        bar_titles(&b, &personal).contains(&"From Shared".to_owned()),
        "Personal keeps the shared bookmarks"
    );
    assert!(
        !b.orphaned_profile_data
            .contains(&b.engine_profile(&personal)),
        "its profile isn't queued for deletion"
    );
}
