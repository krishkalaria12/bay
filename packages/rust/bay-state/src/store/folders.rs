//! Folders of the Pinned section (store/folders.ts): nested up to five deep, each holding pinned rows (its space's
//! tabs with its id, in their list's order) and child folders; it stays when emptied. Moves can be undone.

use std::collections::HashSet;

use indexmap::IndexMap;

use super::groups::{leave_groups, order_sections, sync_group_order};
use super::model::TabList;
use super::{Browser, TabPlacement, keep_last};
use crate::model::{PinnedFolder, TabGroup};
use crate::number::JsNumber;

pub const MAX_FOLDER_DEPTH: usize = 5;
const MAX_FOLDER_UNDO: usize = 30;

/// A tab's place in the Pinned section, as an undo restores it.
#[derive(Clone, Debug, PartialEq)]
pub struct PinState {
    pub pinned: bool,
    pub pinned_row: Option<bool>,
    pub folder_id: Option<String>,
    pub pinned_url: Option<String>,
}

/// What undoing a folder move or a placement puts back.
#[derive(Clone, Debug, PartialEq)]
pub struct FolderMove {
    pub id: Option<String>,
    pub parent_id: Option<String>,
    pub before_id: Option<String>,
    pub space_id: String,
    pub tab_ids: Vec<String>,
    pub folder_ids: Vec<String>,
    pub tabs: Vec<(String, PinState)>,
    /// Groups as they were, and the tabs that left each.
    pub groups: Vec<(TabGroup, Vec<String>)>,
}

/// Repairs missing parents, cross-space links, cycles and too-deep nesting without dropping rows.
pub fn normalize_pinned_folders(folders: &mut IndexMap<String, PinnedFolder>) {
    let mut ids: Vec<String> = folders.keys().cloned().collect();
    ids.sort();
    for id in ids {
        let Some(parent) = folders[&id].parent_id.clone() else {
            continue;
        };
        let fine = folders
            .get(&parent)
            .is_some_and(|p| p.space_id == folders[&id].space_id)
            && folder_depth(folders, &id) <= MAX_FOLDER_DEPTH;
        if !fine && let Some(f) = folders.get_mut(&id) {
            f.parent_id = None;
        }
    }
}

/// How deep the folder is (a root folder is 1); a cycle is infinitely deep.
pub fn folder_depth(folders: &IndexMap<String, PinnedFolder>, id: &str) -> usize {
    let mut depth = 0;
    let mut seen = HashSet::new();
    let mut at = folders.get(id);
    while let Some(f) = at {
        if !seen.insert(f.id.clone()) {
            return usize::MAX;
        }
        depth += 1;
        at = f.parent_id.as_ref().and_then(|p| folders.get(p));
    }
    depth
}

impl Browser {
    /// The folders directly in `parent_id` (the root for None), of a space if given, in the map's order.
    pub fn child_folder_ids(&self, parent_id: Option<&str>, space_id: Option<&str>) -> Vec<String> {
        self.pinned_folders
            .values()
            .filter(|f| {
                f.parent_id.as_deref() == parent_id && space_id.is_none_or(|s| f.space_id == s)
            })
            .map(|f| f.id.clone())
            .collect()
    }

    pub fn folder_root_id(&self, id: &str) -> Option<String> {
        let mut f = self.pinned_folders.get(id)?;
        let mut seen = HashSet::new();
        while let Some(parent) = f
            .parent_id
            .as_ref()
            .and_then(|p| self.pinned_folders.get(p))
            .filter(|p| !seen.contains(&p.id))
        {
            seen.insert(f.id.clone());
            f = parent;
        }
        Some(f.id.clone())
    }

    fn subtree_ids(&self, id: &str) -> HashSet<String> {
        let mut ids = HashSet::new();
        let mut stack = vec![id.to_owned()];
        while let Some(at) = stack.pop() {
            if !self.pinned_folders.contains_key(&at) || !ids.insert(at.clone()) {
                continue;
            }
            stack.extend(self.child_folder_ids(Some(&at), None));
        }
        ids
    }

    /// Whether the folder can move into `parent_id` (the root for None): same space, not into itself, and no deeper
    /// than five.
    pub fn can_move_folder(&self, id: &str, parent_id: Option<&str>) -> bool {
        let Some(f) = self.pinned_folders.get(id) else {
            return false;
        };
        let parent = parent_id.and_then(|p| self.pinned_folders.get(p));
        if parent_id.is_some() && parent.is_none_or(|p| p.space_id != f.space_id) {
            return false;
        }
        let subtree = self.subtree_ids(id);
        if parent_id.is_some_and(|p| subtree.contains(p)) {
            return false;
        }
        let base = folder_depth(&self.pinned_folders, id);
        let height = subtree
            .iter()
            .map(|child| folder_depth(&self.pinned_folders, child).saturating_sub(base) + 1)
            .max()
            .unwrap_or(1);
        parent.map_or(0, |p| folder_depth(&self.pinned_folders, &p.id)) + height <= MAX_FOLDER_DEPTH
    }

    /// The folder's rows in list order, its descendants' too unless `recursive` is false.
    pub fn folder_tab_ids(&self, folder_id: &str, recursive: bool) -> Vec<String> {
        let Some(f) = self.pinned_folders.get(folder_id) else {
            return Vec::new();
        };
        self.list_ids(&self.space_list_key(&f.space_id))
            .iter()
            .filter(|id| {
                let Some(t) = self
                    .tabs
                    .get(*id)
                    .filter(|t| t.is_row() && t.space_id == f.space_id)
                else {
                    return false;
                };
                let Some(own) = &t.folder_id else {
                    return false;
                };
                if !recursive {
                    return own == folder_id;
                }
                let mut seen = HashSet::new();
                let mut at = self.pinned_folders.get(own);
                while let Some(x) = at.filter(|x| seen.insert(x.id.clone())) {
                    if x.id == folder_id {
                        return true;
                    }
                    at = x
                        .parent_id
                        .as_ref()
                        .and_then(|p| self.pinned_folders.get(p));
                }
                false
            })
            .cloned()
            .collect()
    }

    /// Where an empty folder receives its first rows, following sibling anchors through empty folders.
    pub fn folder_insertion_before_id(
        &self,
        folder_id: &str,
        excluding: &[String],
    ) -> Option<String> {
        let rows = |id: &str| -> Vec<String> {
            self.folder_tab_ids(id, true)
                .into_iter()
                .filter(|t| !excluding.contains(t))
                .collect()
        };
        let mut seen: HashSet<String> = HashSet::new();
        let mut next = Some(folder_id.to_owned());
        while let Some(id) = next.take() {
            let f = self
                .pinned_folders
                .get(&id)
                .filter(|_| seen.insert(id.clone()))?;
            if let Some(before) = &f.before_id {
                let tab = self.tabs.get(before);
                if let Some(t) = tab
                    && t.space_id == f.space_id
                    && t.is_row()
                    && !excluding.contains(before)
                    && t.folder_id == f.parent_id
                {
                    return Some(before.clone());
                }
                let mut sibling = self.pinned_folders.get(before).or_else(|| {
                    tab.and_then(|t| t.folder_id.as_ref())
                        .and_then(|x| self.pinned_folders.get(x))
                });
                let mut ancestors = HashSet::new();
                while let Some(s) = sibling.filter(|s| {
                    s.space_id == f.space_id
                        && s.parent_id != f.parent_id
                        && ancestors.insert(s.id.clone())
                }) {
                    sibling = s
                        .parent_id
                        .as_ref()
                        .and_then(|p| self.pinned_folders.get(p));
                }
                if let Some(s) = sibling.filter(|s| {
                    s.id != id && s.space_id == f.space_id && s.parent_id == f.parent_id
                }) {
                    if let Some(first) = rows(&s.id).into_iter().next() {
                        return Some(first);
                    }
                    if !seen.contains(&s.id) {
                        next = Some(s.id.clone());
                        continue;
                    }
                }
            }
            let Some(parent) = &f.parent_id else {
                return None;
            };
            if let Some(last) = rows(parent).last() {
                let list: Vec<&String> = self
                    .list_ids(&self.space_list_key(&f.space_id))
                    .iter()
                    .filter(|t| !excluding.contains(t))
                    .collect();
                let at = list.iter().position(|t| *t == last).map_or(0, |i| i + 1);
                return list.get(at).map(|t| (*t).clone());
            }
            next = Some(parent.clone());
        }
        None
    }

    /// Drops folders whose space is gone, repairs the rest, and takes rows out of folders they can't be in.
    pub(crate) fn prune_pinned_folders(&mut self) {
        let spaces = &self.spaces;
        self.pinned_folders
            .retain(|_, f| spaces.contains_key(&f.space_id));
        normalize_pinned_folders(&mut self.pinned_folders);
        let folders = &self.pinned_folders;
        for t in self.tabs.values_mut() {
            let kept = t.folder_id.as_ref().is_some_and(|f| {
                t.pinned_row == Some(true)
                    && folders.get(f).is_some_and(|x| x.space_id == t.space_id)
            });
            if !kept {
                t.folder_id = None;
            }
        }
    }

    fn pin_state(&self, id: &str) -> Option<PinState> {
        self.tabs.get(id).map(|t| PinState {
            pinned: t.pinned,
            pinned_row: t.pinned_row,
            folder_id: t.folder_id.clone(),
            pinned_url: t.pinned_url.clone(),
        })
    }

    /// Places tabs in and out of the Pinned section, its folders and groups (a split goes whole in and out of the
    /// Pinned section); a placement that touches folders can be undone.
    pub fn place_tabs(&mut self, ids: &[String], placement: TabPlacement) {
        let moving = if placement.row.is_none() {
            ids.to_vec()
        } else {
            self.with_split_panes(ids)
        };
        let Some(first) = moving
            .first()
            .and_then(|id| self.tabs.get(id))
            .map(|t| t.space_id.clone())
        else {
            return;
        };
        let touches_folders = moving
            .iter()
            .any(|id| self.tabs.get(id).is_some_and(|t| t.folder_id.is_some()));
        let before_tabs: Vec<(String, PinState)> = moving
            .iter()
            .filter_map(|id| self.pin_state(id).map(|p| (id.clone(), p)))
            .collect();
        let before_list = self.list_ids(&self.space_list_key(&first)).to_vec();
        let before_folders: Vec<String> = self.pinned_folders.keys().cloned().collect();
        let before_groups = self.groups.clone();
        self.placing(&moving, &placement);
        let into_folder = moving
            .iter()
            .any(|id| self.tabs.get(id).is_some_and(|t| t.folder_id.is_some()));
        if !touches_folders && !into_folder {
            return;
        }
        let tabs: Vec<(String, PinState)> = before_tabs
            .into_iter()
            .filter(|(id, pin)| self.pin_state(id).as_ref() != Some(pin))
            .collect();
        if tabs.is_empty() && self.list_ids(&self.space_list_key(&first)) == before_list {
            return;
        }
        let groups = before_groups
            .values()
            .filter(|g| self.groups.get(&g.id) != Some(g))
            .map(|g| {
                let removed = g
                    .tab_ids
                    .iter()
                    .filter(|id| {
                        !self
                            .groups
                            .get(&g.id)
                            .is_some_and(|x| x.tab_ids.contains(id))
                    })
                    .cloned()
                    .collect();
                (g.clone(), removed)
            })
            .collect();
        self.folder_move_undo.push(FolderMove {
            id: None,
            parent_id: None,
            before_id: None,
            space_id: first,
            tab_ids: before_list,
            folder_ids: before_folders,
            tabs,
            groups,
        });
        keep_last(&mut self.folder_move_undo, MAX_FOLDER_UNDO);
    }

    /// A new folder (in `parent_id`, else the root), holding the tabs given (and their splits).
    pub fn new_pinned_folder(
        &mut self,
        window_id: &str,
        tab_ids: &[String],
        name: &str,
        parent_id: Option<&str>,
        space_id: Option<&str>,
        before_id: Option<&str>,
    ) -> Option<String> {
        let w = self.windows.get(window_id)?;
        let parent = parent_id.and_then(|p| self.pinned_folders.get(p));
        if parent_id.is_some()
            && parent.is_none_or(|p| folder_depth(&self.pinned_folders, &p.id) >= MAX_FOLDER_DEPTH)
        {
            return None;
        }
        if space_id.is_some_and(|s| !self.spaces.contains_key(s)) {
            return None;
        }
        let space = parent
            .map(|p| p.space_id.clone())
            .or_else(|| space_id.map(str::to_owned))
            .or_else(|| {
                tab_ids
                    .iter()
                    .find_map(|id| self.tabs.get(id).map(|t| t.space_id.clone()))
            })
            .unwrap_or_else(|| w.space_id.clone());
        let folder = PinnedFolder {
            id: self.new_id("pf"),
            parent_id: parent_id.map(str::to_owned),
            before_id: before_id.map(str::to_owned),
            space_id: space.clone(),
            name: name.to_owned(),
            icon: None,
            collapsed: false,
            created_at: JsNumber(self.now()),
            extra: Default::default(),
        };
        let id = folder.id.clone();
        self.pinned_folders.insert(id.clone(), folder);
        let members: Vec<String> = self
            .with_split_panes(tab_ids)
            .into_iter()
            .filter(|t| self.tabs.get(t).is_some_and(|t| t.space_id == space))
            .collect();
        if !members.is_empty() {
            let list = self.list_ids(&self.space_list_key(&space)).to_vec();
            let at = list.iter().position(|t| members.contains(t)).unwrap_or(0);
            let after = list[at..].iter().find(|t| !members.contains(t));
            let row =
                |t: Option<&String>| t.and_then(|t| self.tabs.get(t)).is_some_and(|t| t.is_row());
            let before = (row(list.get(at)) && row(after))
                .then(|| after.cloned())
                .flatten();
            self.placing(
                &members,
                &TabPlacement {
                    pinned: false,
                    row: Some(true),
                    folder_id: Some(id.clone()),
                    before_id: before,
                    group_id: None,
                },
            );
        }
        Some(id)
    }

    pub fn update_pinned_folder(
        &mut self,
        id: &str,
        name: Option<String>,
        icon: Option<Option<String>>,
        collapsed: Option<bool>,
    ) {
        if let Some(f) = self.pinned_folders.get_mut(id) {
            if let Some(name) = name {
                f.name = name;
            }
            if let Some(icon) = icon {
                f.icon = icon;
            }
            if let Some(collapsed) = collapsed {
                f.collapsed = collapsed;
            }
        }
    }

    /// Moves the folder and everything in it before `before_id` (a row or folder), into `parent_id`: `None` keeps
    /// its parent, `Some(None)` the root.
    pub fn move_pinned_folder(
        &mut self,
        id: &str,
        before_id: Option<&str>,
        parent_id: Option<Option<&str>>,
    ) {
        let Some(f) = self.pinned_folders.get(id).cloned() else {
            return;
        };
        let target = parent_id
            .unwrap_or(f.parent_id.as_deref())
            .map(str::to_owned);
        if !self.can_move_folder(id, target.as_deref()) {
            return;
        }
        let subtree = self.subtree_ids(id);
        let members = self.folder_tab_ids(id, true);
        if before_id.is_some_and(|b| members.iter().any(|m| m == b) || subtree.contains(b)) {
            return;
        }
        let anchor_folder = before_id.and_then(|b| self.pinned_folders.get(b));
        let anchor_tab = before_id.and_then(|b| self.tabs.get(b));
        let valid = anchor_folder.is_some_and(|x| x.space_id == f.space_id)
            || anchor_tab.is_some_and(|t| t.space_id == f.space_id && t.is_row());
        let moved = PinnedFolder {
            parent_id: target.clone(),
            before_id: (members.is_empty() && valid)
                .then(|| before_id.map(str::to_owned))
                .flatten(),
            ..f.clone()
        };
        // The map's order also keeps empty siblings' order through saving.
        let mut others: Vec<PinnedFolder> = self
            .pinned_folders
            .values()
            .filter(|x| x.id != id)
            .cloned()
            .collect();
        let mut before_folder: Option<String> = match before_id {
            Some(b) if self.pinned_folders.contains_key(b) => Some(b.to_owned()),
            Some(b) => self.tabs.get(b).and_then(|t| t.folder_id.clone()),
            None => None,
        };
        // A row directly in the target parent is an exact anchor; a deeper row anchors its sibling subtree.
        while let Some(bf) = before_folder.clone() {
            if Some(&bf) == target.as_ref()
                || self
                    .pinned_folders
                    .get(&bf)
                    .and_then(|x| x.parent_id.clone())
                    == target
            {
                break;
            }
            before_folder = self
                .pinned_folders
                .get(&bf)
                .and_then(|x| x.parent_id.clone());
        }
        if before_folder == target {
            before_folder = None;
        }
        let at = others
            .iter()
            .position(|x| Some(&x.id) == before_folder.as_ref())
            .unwrap_or(others.len());
        others.insert(at, moved);
        let previous_folders: Vec<String> = self.pinned_folders.keys().cloned().collect();
        self.pinned_folders = others.into_iter().map(|x| (x.id.clone(), x)).collect();
        let key = self.space_list_key(&f.space_id);
        let previous_list = self.list_ids(&key).to_vec();
        let mut rest: Vec<String> = previous_list
            .iter()
            .filter(|t| !members.contains(t))
            .cloned()
            .collect();
        let anchor = match &before_folder {
            Some(bf) => self
                .folder_tab_ids(bf, true)
                .into_iter()
                .find(|t| rest.contains(t)),
            None => before_id.map(str::to_owned),
        };
        let mut at = anchor.and_then(|a| rest.iter().position(|t| *t == a));
        if at.is_none()
            && let Some(parent) = &target
        {
            let siblings: HashSet<String> = self.folder_tab_ids(parent, true).into_iter().collect();
            at = rest
                .iter()
                .rposition(|t| siblings.contains(t))
                .map(|i| i + 1);
            if at.is_none() {
                at = self
                    .folder_insertion_before_id(parent, &members)
                    .and_then(|a| rest.iter().position(|t| *t == a));
            }
        }
        let at = at.unwrap_or_else(|| {
            rest.iter().enumerate().fold(0, |last, (i, t)| {
                if self.tabs.get(t).is_some_and(|t| t.pinned_page()) {
                    i + 1
                } else {
                    last
                }
            })
        });
        rest.splice(at..at, members);
        let list = TabList {
            tab_ids: order_sections(&rest, &self.tabs, &self.groups, &self.pinned_folders),
            key,
        };
        self.folder_move_undo.push(FolderMove {
            id: Some(id.to_owned()),
            parent_id: f.parent_id.clone(),
            before_id: f.before_id.clone(),
            space_id: f.space_id.clone(),
            tab_ids: previous_list,
            folder_ids: previous_folders,
            tabs: Vec::new(),
            groups: Vec::new(),
        });
        keep_last(&mut self.folder_move_undo, MAX_FOLDER_UNDO);
        sync_group_order(&mut self.groups, &list);
        self.set_list(list);
    }

    /// Undoes the last folder move or placement whose folder is still there; whether there was one.
    pub fn undo_pinned_folder_move(&mut self) -> bool {
        let mut history = std::mem::take(&mut self.folder_move_undo);
        let mut found = None;
        while let Some(m) = history.pop() {
            if m.id
                .as_ref()
                .is_none_or(|id| self.pinned_folders.contains_key(id))
            {
                found = Some(m);
                break;
            }
        }
        let Some(m) = found else {
            return false;
        };
        let mut folders = self.pinned_folders.clone();
        if let Some(id) = &m.id {
            let space = folders[id].space_id.clone();
            let parent = m
                .parent_id
                .clone()
                .filter(|p| folders.get(p).is_some_and(|x| x.space_id == space));
            let f = folders.get_mut(id).expect("kept above");
            f.parent_id = parent.clone();
            f.before_id = m.before_id.clone();
            let previous = std::mem::replace(&mut self.pinned_folders, folders.clone());
            let ok = self.can_move_folder(id, parent.as_deref());
            self.pinned_folders = previous;
            if !ok {
                self.folder_move_undo = history;
                self.folder_move_undo.push(m);
                return false;
            }
        }
        for (id, pin) in &m.tabs {
            let Some(t) = self.tabs.get_mut(id).filter(|t| t.space_id == m.space_id) else {
                continue;
            };
            t.pinned = pin.pinned;
            t.pinned_url.clone_from(&pin.pinned_url);
            t.pinned_row = pin.pinned_row.filter(|r| *r);
            t.folder_id = pin
                .folder_id
                .clone()
                .filter(|f| folders.get(f).is_some_and(|x| x.space_id == t.space_id));
        }
        let moved: HashSet<String> = m.tabs.iter().map(|(id, _)| id.clone()).collect();
        let pinned_now: HashSet<String> = moved
            .iter()
            .filter(|id| self.tabs.get(*id).is_some_and(|t| t.pinned_page()))
            .cloned()
            .collect();
        leave_groups(&mut self.groups, &pinned_now);
        for (before, removed) in &m.groups {
            let back: Vec<String> = removed
                .iter()
                .filter(|id| {
                    self.tabs
                        .get(*id)
                        .is_some_and(|t| t.space_id == before.space_id && !t.pinned_page())
                        && (moved.contains(*id) || self.group_of(id).is_none())
                })
                .cloned()
                .collect();
            if back.is_empty() {
                continue;
            }
            leave_groups(&mut self.groups, &back.iter().cloned().collect());
            let mut group = self
                .groups
                .get(&before.id)
                .cloned()
                .unwrap_or_else(|| TabGroup {
                    tab_ids: Vec::new(),
                    ..before.clone()
                });
            for id in back {
                if !group.tab_ids.contains(&id) {
                    group.tab_ids.push(id);
                }
            }
            self.groups.insert(before.id.clone(), group);
        }
        let order: Vec<String> = m
            .folder_ids
            .iter()
            .filter(|id| folders.contains_key(*id))
            .cloned()
            .chain(
                folders
                    .keys()
                    .filter(|id| !m.folder_ids.contains(id))
                    .cloned(),
            )
            .collect();
        self.pinned_folders = order
            .into_iter()
            .filter_map(|id| folders.shift_remove(&id).map(|f| (id, f)))
            .collect();
        let key = self.space_list_key(&m.space_id);
        let current = self.list_ids(&key).to_vec();
        let prior: Vec<&String> = m.tab_ids.iter().filter(|id| current.contains(id)).collect();
        let prior_set: HashSet<&String> = prior.iter().copied().collect();
        let mut k = 0;
        let restored: Vec<String> = current
            .iter()
            .map(|id| {
                if prior_set.contains(id) {
                    k += 1;
                    prior[k - 1].clone()
                } else {
                    id.clone()
                }
            })
            .collect();
        let list = TabList {
            tab_ids: order_sections(&restored, &self.tabs, &self.groups, &self.pinned_folders),
            key,
        };
        self.folder_move_undo = history;
        sync_group_order(&mut self.groups, &list);
        self.set_list(list);
        true
    }

    /// Removes the folder, promoting its rows and child folders to its parent.
    pub fn delete_pinned_folder(&mut self, id: &str) {
        let Some(f) = self.pinned_folders.get(id).cloned() else {
            return;
        };
        for t in self.tabs.values_mut() {
            if t.folder_id.as_deref() == Some(id) {
                t.folder_id.clone_from(&f.parent_id);
            }
        }
        let children = self.child_folder_ids(Some(id), None);
        self.pinned_folders.shift_remove(id);
        for child in children {
            if let Some(c) = self.pinned_folders.get_mut(&child) {
                c.parent_id.clone_from(&f.parent_id);
            }
        }
    }
}
