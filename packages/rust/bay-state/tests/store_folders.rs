//! apps/browser/src/store/nestedFolders.test.mjs: the Pinned section's folders, nested up to five deep, their moves
//! and undo; and localFiles.test.mjs's ordering.

mod support;

use std::collections::HashSet;

use bay_state::Browser;
use bay_state::store::{
    CreateWindow, FileDescriptor, NewTab, TabPatch, TabPlacement, folder_depth,
};
use serde_json::json;
use support::browser;

struct Setup {
    b: Browser,
    w: String,
    a: String,
    tb: String,
    c: String,
    space: String,
}

fn setup() -> Setup {
    let mut b = browser();
    b.update_settings([("newTabPosition".to_owned(), json!("bottom"))]);
    let w = b.create_window(CreateWindow {
        url: Some("https://first.example".into()),
        ..Default::default()
    });
    let a = b.active_tab_id(&w, None).unwrap();
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
    let tb = open(&mut b, "https://second.example");
    let c = open(&mut b, "https://third.example");
    let space = b.windows[&w].space_id.clone();
    Setup {
        b,
        w,
        a,
        tb,
        c,
        space,
    }
}

fn folder(b: &mut Browser, w: &str, tabs: &[&String], parent: Option<&str>) -> String {
    let ids: Vec<String> = tabs.iter().map(|t| (*t).clone()).collect();
    b.new_pinned_folder(w, &ids, "", parent, None, None)
        .unwrap()
}

fn row_into(folder: Option<&str>) -> TabPlacement {
    TabPlacement {
        pinned: false,
        row: Some(true),
        folder_id: folder.map(str::to_owned),
        ..Default::default()
    }
}

fn set(ids: Vec<String>) -> HashSet<String> {
    ids.into_iter().collect()
}

#[test]
fn nested_folders_cap_the_subtree_at_five_levels_and_reject_cycles_and_cross_space_moves() {
    let Setup { mut b, w, .. } = setup();
    let mut chain = vec![folder(&mut b, &w, &[], None)];
    for _ in 1..5 {
        let parent = chain.last().unwrap().clone();
        chain.push(folder(&mut b, &w, &[], Some(&parent)));
    }
    let last = chain.last().unwrap().clone();
    assert_eq!(folder_depth(&b.pinned_folders, &last), 5);
    assert_eq!(b.folder_root_id(&last).as_ref(), Some(&chain[0]));
    assert_eq!(
        b.new_pinned_folder(&w, &[], "", Some(&last), None, None),
        None
    );
    assert!(!b.can_move_folder(&chain[0], Some(&chain[2])));
    let other = folder(&mut b, &w, &[], None);
    assert!(
        !b.can_move_folder(&chain[0], Some(&other)),
        "moving a subtree counts all descendants"
    );
    let other_space = b.create_space("Other", None, None, None, None);
    let foreign = b
        .new_pinned_folder(&w, &[], "", None, Some(&other_space), None)
        .unwrap();
    assert!(!b.can_move_folder(&other, Some(&foreign)));
    b.move_pinned_folder(&chain[0], None, Some(Some(&chain[2])));
    assert_eq!(b.pinned_folders[&chain[0]].parent_id, None);
}

#[test]
fn subtree_moves_preserve_direct_memberships_move_empty_folders_and_undo_parent_and_ordering() {
    let Setup {
        mut b,
        w,
        a,
        tb,
        c,
        space,
    } = setup();
    let root = folder(&mut b, &w, &[&a], None);
    let child = folder(&mut b, &w, &[&tb], Some(&root));
    let target = folder(&mut b, &w, &[&c], None);
    assert_eq!(
        set(b.folder_tab_ids(&root, true)),
        set(vec![a.clone(), tb.clone()])
    );
    assert_eq!(b.folder_tab_ids(&root, false), std::slice::from_ref(&a));
    let prior = b.list_ids(&space).to_vec();
    b.move_pinned_folder(&root, None, Some(Some(&target)));
    assert_eq!(b.pinned_folders[&root].parent_id.as_ref(), Some(&target));
    assert_eq!(b.pinned_folders[&child].parent_id.as_ref(), Some(&root));
    assert_eq!(b.tabs[&tb].folder_id.as_ref(), Some(&child));
    assert!(b.undo_pinned_folder_move());
    assert_eq!(b.pinned_folders[&root].parent_id, None);
    assert_eq!(b.list_ids(&space), prior);
    b.move_pinned_folder(&child, None, Some(Some(&target)));
    b.move_pinned_folder(&child, Some(&a), None);
    assert_eq!(
        b.pinned_folders[&child].parent_id.as_ref(),
        Some(&target),
        "omitting parent keeps the existing parent"
    );
    b.move_pinned_folder(&child, None, Some(None));
    assert_eq!(b.pinned_folders[&child].parent_id, None);
    let empty = folder(&mut b, &w, &[], Some(&root));
    b.move_pinned_folder(&empty, None, Some(Some(&target)));
    assert_eq!(
        b.child_folder_ids(Some(&target), None),
        std::slice::from_ref(&empty)
    );
    assert!(b.undo_pinned_folder_move());
    assert_eq!(b.pinned_folders[&empty].parent_id.as_ref(), Some(&root));
}

#[test]
fn folder_placement_undo_preserves_navigation_new_tabs_and_later_folder_renames() {
    let Setup {
        mut b, w, a, tb, ..
    } = setup();
    let f = folder(&mut b, &w, &[&a], None);
    b.place_tabs(std::slice::from_ref(&tb), row_into(Some(&f)));
    b.update_tab(
        &tb,
        TabPatch {
            url: Some("https://changed.example".into()),
            title: Some("Changed".into()),
            ..Default::default()
        },
        None,
    );
    b.update_pinned_folder(&f, Some("Renamed".into()), None, None);
    let added = b
        .new_tab(
            &w,
            NewTab {
                url: Some("https://added.example".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(b.undo_pinned_folder_move());
    assert_eq!(b.tabs[&tb].pinned_row, None);
    assert_eq!(b.tabs[&tb].folder_id, None);
    assert_eq!(b.tabs[&tb].url, "https://changed.example");
    assert!(b.tabs.contains_key(&added));
    assert_eq!(b.pinned_folders[&f].name, "Renamed");
    b.place_tabs(std::slice::from_ref(&a), row_into(None));
    assert_eq!(b.tabs[&a].folder_id, None);
    assert!(b.undo_pinned_folder_move());
    assert_eq!(b.tabs[&a].folder_id.as_ref(), Some(&f));
}

#[test]
fn deleting_a_folder_promotes_direct_rows_and_child_folders_without_deleting_the_subtree() {
    let Setup {
        mut b, w, a, tb, ..
    } = setup();
    let root = folder(&mut b, &w, &[], None);
    let middle = folder(&mut b, &w, &[&a], Some(&root));
    let child = folder(&mut b, &w, &[&tb], Some(&middle));
    b.delete_pinned_folder(&middle);
    assert_eq!(b.tabs[&a].folder_id.as_ref(), Some(&root));
    assert_eq!(b.pinned_folders[&child].parent_id.as_ref(), Some(&root));
    assert_eq!(b.tabs[&tb].folder_id.as_ref(), Some(&child));
    b.delete_pinned_folder(&root);
    assert_eq!(b.tabs[&a].folder_id, None);
    assert_eq!(b.tabs[&a].pinned_row, Some(true));
    assert_eq!(b.pinned_folders[&child].parent_id, None);
}

#[test]
fn hydrate_preserves_flat_and_nested_sessions_and_repairs_malformed_parents_without_losing_rows() {
    let Setup {
        mut b, w, a, tb, ..
    } = setup();
    let root = folder(&mut b, &w, &[&a], None);
    let child = folder(&mut b, &w, &[&tb], Some(&root));
    let data = b.to_session();
    b.hydrate(data.clone(), false);
    assert_eq!(b.pinned_folders[&child].parent_id.as_ref(), Some(&root));
    assert_eq!(
        set(b.folder_tab_ids(&root, true)),
        set(vec![a.clone(), tb.clone()])
    );
    assert!(b.folder_move_undo.is_empty());
    let mut flat = data.clone();
    for f in &mut flat.pinned_folders {
        f.parent_id = None;
    }
    b.hydrate(flat, false);
    assert_eq!(b.pinned_folders[&child].parent_id, None);
    let mut cycle = data.clone();
    cycle
        .pinned_folders
        .iter_mut()
        .find(|f| f.id == root)
        .unwrap()
        .parent_id = Some(child.clone());
    b.hydrate(cycle, false);
    for id in [&root, &child] {
        assert!(folder_depth(&b.pinned_folders, id) <= 5);
    }
    assert!(b.tabs.contains_key(&a) && b.tabs.contains_key(&tb));
    let mut missing = data;
    missing
        .pinned_folders
        .iter_mut()
        .find(|f| f.id == child)
        .unwrap()
        .parent_id = Some("missing".into());
    b.hydrate(missing, false);
    assert_eq!(b.pinned_folders[&child].parent_id, None);
}

#[test]
fn placing_and_undo_retain_source_group_membership_including_deleted_auto_ungroup_groups() {
    let Setup {
        mut b, w, a, tb, c, ..
    } = setup();
    let f = folder(&mut b, &w, &[], None);
    let group = b
        .group_tabs(&[a.clone(), tb.clone()], false, None, false)
        .unwrap();
    b.place_tabs(std::slice::from_ref(&a), row_into(Some(&f)));
    b.groups[&group].name = "Renamed".into();
    b.add_tabs_to_group(&group, std::slice::from_ref(&c));
    assert!(b.undo_pinned_folder_move());
    assert_eq!(
        set(b.groups[&group].tab_ids.clone()),
        set(vec![a.clone(), tb.clone(), c.clone()])
    );
    assert_eq!(b.groups[&group].name, "Renamed");
    b.groups[&group].name = "Original".into();
    b.groups[&group].tab_ids = vec![a.clone(), tb.clone()];
    b.groups[&group].auto_ungroup = Some(true);
    b.place_tabs(std::slice::from_ref(&a), row_into(Some(&f)));
    assert!(!b.groups.contains_key(&group));
    assert!(b.undo_pinned_folder_move());
    assert_eq!(set(b.groups[&group].tab_ids.clone()), set(vec![a, tb]));
}

#[test]
fn child_folders_can_stay_between_their_parents_direct_rows_through_movement_and_hydration() {
    let Setup {
        mut b,
        w,
        a,
        tb,
        c,
        space,
    } = setup();
    b.place_tabs(&[a.clone(), tb.clone(), c.clone()], row_into(None));
    let root = folder(&mut b, &w, &[&a, &tb, &c], None);
    let child = folder(&mut b, &w, &[&tb], Some(&root));
    assert_eq!(b.list_ids(&space), [a.clone(), tb.clone(), c.clone()]);
    assert_eq!(b.folder_tab_ids(&root, false), [a.clone(), c.clone()]);
    b.move_pinned_folder(&child, Some(&c), None);
    assert_eq!(b.list_ids(&space), [a.clone(), tb.clone(), c.clone()]);
    let data = b.to_session();
    b.hydrate(data, false);
    assert_eq!(b.list_ids(&space), [a, tb, c]);
}

#[test]
fn dropping_a_row_into_a_parent_appends_after_the_entire_subtree() {
    let Setup {
        mut b,
        w,
        a,
        tb,
        c,
        space,
    } = setup();
    let root = folder(&mut b, &w, &[&a], None);
    folder(&mut b, &w, &[&tb], Some(&root));
    b.place_tabs(std::slice::from_ref(&c), row_into(Some(&root)));
    assert_eq!(b.list_ids(&space), [a, tb, c.clone()]);
    assert_eq!(b.tabs[&c].folder_id.as_ref(), Some(&root));
}

#[test]
fn filling_anchored_empty_folders_retains_their_header_position_including_empty_sibling_chains() {
    let Setup {
        mut b,
        w,
        a,
        tb,
        c,
        space,
    } = setup();
    let root = folder(&mut b, &w, &[&a], None);
    let empty = b
        .new_pinned_folder(&w, &[], "", Some(&root), None, Some(&a))
        .unwrap();
    let leading = b
        .new_pinned_folder(&w, &[], "", Some(&root), None, Some(&empty))
        .unwrap();
    b.place_tabs(std::slice::from_ref(&tb), row_into(Some(&leading)));
    assert_eq!(b.list_ids(&space), [tb.clone(), a.clone(), c.clone()]);
    assert!(b.undo_pinned_folder_move());
    let incoming = folder(&mut b, &w, &[&c], None);
    b.move_pinned_folder(&incoming, None, Some(Some(&empty)));
    assert_eq!(b.folder_tab_ids(&root, true), [c, a.clone()]);
    assert!(b.undo_pinned_folder_move());
    assert_eq!(b.folder_tab_ids(&root, true), [a]);
}

#[test]
fn local_files_pin_once_per_space_and_keep_their_order() {
    let Setup { mut b, w, .. } = setup();
    let file = |path: &str, kind: &str| FileDescriptor {
        path: path.into(),
        name: path.split('/').rfind(|p| !p.is_empty()).unwrap().into(),
        kind: kind.into(),
    };
    let ids = b.pin_local_files(
        &w,
        &[
            file("/Users/me/Notes", "folder"),
            file("/Users/me/a.txt", "file"),
            file("/Users/me//Notes/", "folder"),
        ],
        None,
    );
    assert_eq!(ids.len(), 3);
    assert_eq!(
        ids[2], ids[0],
        "the same folder, its path tidied, is the pin it has"
    );
    assert_eq!(b.local_files.len(), 2);
    b.move_local_file(&ids[1], Some(&ids[0]));
    let order: Vec<&str> = b
        .local_file_pins(&b.windows[&w].space_id)
        .iter()
        .map(|p| p.name.as_str())
        .collect();
    assert_eq!(order, ["a.txt", "Notes"]);
    assert!(
        b.pin_local_files(&w, &[file("relative/path", "file")], None)
            .is_empty(),
        "only absolute paths"
    );
}
