//! Tab groups: making, joining, closing and keeping them together in their list (store/groups.ts and the group
//! parts of store/tabTidying.ts).

use std::collections::HashSet;

use indexmap::IndexMap;

use super::model::{TabList, is_incognito_space, snapshot_tab};
use super::{Browser, DELETED_GROUP_MS, MAX_CLOSED_GROUPS, NewTab, keep_last};
use crate::model::{ClosedGroup, ClosedGroupRef, PinnedFolder, Tab, TabGroup};
use crate::number::JsNumber;

/// What `update_group` changes.
#[derive(Clone, Debug, Default)]
pub struct GroupPatch {
    pub name: Option<String>,
    pub icon: Option<Option<String>>,
    pub color: Option<Option<String>>,
    pub collapsed: Option<bool>,
    pub pinned: Option<bool>,
}

/// The groups' members, in the list's order.
pub(crate) fn sync_group_order(groups: &mut IndexMap<String, TabGroup>, list: &TabList) {
    let in_list: HashSet<&String> = list.tab_ids.iter().collect();
    for g in groups.values_mut() {
        if !g.tab_ids.iter().any(|id| in_list.contains(id)) {
            continue;
        }
        let members: HashSet<&String> = g.tab_ids.iter().collect();
        let tab_ids: Vec<String> = list
            .tab_ids
            .iter()
            .filter(|id| members.contains(id))
            .cloned()
            .collect();
        g.tab_ids = tab_ids;
    }
}

/// The Essentials, the pinned rows (each folder's together), the pinned groups, then the rest.
pub(crate) fn order_sections(
    ids: &[String],
    tabs: &IndexMap<String, Tab>,
    groups: &IndexMap<String, TabGroup>,
    folders: &IndexMap<String, PinnedFolder>,
) -> Vec<String> {
    let pinned_group: HashSet<&String> = groups
        .values()
        .filter(|g| g.pinned)
        .flat_map(|g| &g.tab_ids)
        .collect();
    let rank = |id: &String| match tabs.get(id) {
        Some(t) if t.pinned => 0,
        Some(t) if t.is_row() => 1,
        _ if pinned_group.contains(id) => 2,
        _ => 3,
    };
    let mut out = ids.to_vec();
    out.sort_by_key(rank);
    place_folders(&out, tabs, folders)
}

/// Keeps each folder's rows together, its own rows free to sit before and after its child folders.
pub(crate) fn place_folders(
    ids: &[String],
    tabs: &IndexMap<String, Tab>,
    folders: &IndexMap<String, PinnedFolder>,
) -> Vec<String> {
    let mut blocks: IndexMap<String, (usize, HashSet<String>)> = IndexMap::new();
    for id in ids {
        let Some(tab) = tabs.get(id) else {
            continue;
        };
        let Some(folder) = tab.folder_id.as_ref().filter(|_| tab.is_row()) else {
            continue;
        };
        let mut path: Vec<String> = Vec::new();
        let mut at = Some(folder.clone());
        while let Some(f) = at.take().filter(|f| !path.contains(f)) {
            let parent = folders.get(&f).and_then(|x| x.parent_id.clone());
            at = parent.filter(|p| folders.get(p).is_some_and(|x| x.space_id == tab.space_id));
            path.insert(0, f);
        }
        for (depth, folder_id) in path.into_iter().enumerate() {
            blocks
                .entry(folder_id)
                .or_insert_with(|| (depth, HashSet::new()))
                .1
                .insert(id.clone());
        }
    }
    let mut ordered: Vec<&(usize, HashSet<String>)> = blocks.values().collect();
    ordered.sort_by_key(|(depth, _)| *depth);
    let mut out = ids.to_vec();
    for (_, members) in ordered {
        let block: Vec<String> = out
            .iter()
            .filter(|id| members.contains(*id))
            .cloned()
            .collect();
        out = place_block(&out, &block, None);
    }
    out
}

/// The block together, where its first tab in the list is, or where `anchor` is.
pub(crate) fn place_block(
    tab_ids: &[String],
    block: &[String],
    anchor: Option<&str>,
) -> Vec<String> {
    let members: HashSet<&String> = block.iter().collect();
    let at = anchor
        .and_then(|a| tab_ids.iter().position(|id| id == a))
        .or_else(|| tab_ids.iter().position(|id| members.contains(id)));
    // Without a place, the TypeScript's slice(0, -1): all but the last.
    let end = at.unwrap_or(tab_ids.len().saturating_sub(1));
    let mut rest: Vec<String> = tab_ids
        .iter()
        .filter(|id| !members.contains(id))
        .cloned()
        .collect();
    let before = tab_ids[..end]
        .iter()
        .filter(|id| !members.contains(id))
        .count();
    rest.splice(before..before, block.iter().cloned());
    rest
}

/// The tabs leave their groups; a group left empty goes, as does a group made for a link left with one tab.
pub(crate) fn leave_groups(groups: &mut IndexMap<String, TabGroup>, ids: &HashSet<String>) {
    groups.retain(|_, g| {
        let before = g.tab_ids.len();
        g.tab_ids.retain(|id| !ids.contains(id));
        g.tab_ids.len() == before || g.tab_ids.len() > usize::from(g.auto_ungroup == Some(true))
    });
}

/// The deleted groups that can still be brought back.
pub(crate) fn kept_deleted_groups(list: &mut Vec<ClosedGroup>, now: f64) {
    list.retain(|c| now - c.closed_at.0 < DELETED_GROUP_MS);
}

#[derive(Default)]
pub(crate) struct GroupOptions {
    pub name: Option<String>,
    pub pinned: bool,
    pub auto_ungroup: bool,
    pub pinned_opener_id: Option<String>,
    pub in_order: bool,
}

impl Browser {
    /// The first group (in the map's order) holding the tab.
    pub fn group_of(&self, tab_id: &str) -> Option<&TabGroup> {
        self.groups
            .values()
            .find(|g| g.tab_ids.iter().any(|id| id == tab_id))
    }

    /// The group gathering the links a pinned tab opened behind.
    pub(crate) fn pinned_child_group(&self, opener_id: &str, space_id: &str) -> Option<&TabGroup> {
        self.groups.values().find(|g| {
            g.pinned_opener_id.as_deref() == Some(opener_id)
                && g.space_id == space_id
                && !g.tab_ids.is_empty()
        })
    }

    /// A name the person gave, else one from the tabs' titles.
    pub fn group_label(&self, g: &TabGroup) -> String {
        if !g.name.is_empty() {
            return g.name.clone();
        }
        let members: Vec<&Tab> = g
            .tab_ids
            .iter()
            .filter_map(|id| self.tabs.get(id))
            .filter(|t| !t.url.is_empty())
            .collect();
        let name = super::names::auto_group_name(&members);
        if name.is_empty() {
            "New Group".to_owned()
        } else {
            name
        }
    }

    pub fn create_group(
        &mut self,
        tab_ids: &[String],
        name: Option<&str>,
        icon: Option<String>,
        color: Option<String>,
    ) -> Option<String> {
        let tabs: Vec<&Tab> = tab_ids
            .iter()
            .filter_map(|id| self.tabs.get(id))
            .filter(|t| !t.pinned_page())
            .collect();
        let first = *tabs.first()?;
        let list = self.list_of_tab(&first.id)?;
        if tabs.iter().any(|t| t.space_id != first.space_id) {
            return None;
        }
        let members: HashSet<String> = tabs.iter().map(|t| t.id.clone()).collect();
        let block: Vec<String> = list
            .tab_ids
            .iter()
            .filter(|id| members.contains(*id))
            .cloned()
            .collect();
        let window = TabList {
            key: list.key,
            tab_ids: place_block(&list.tab_ids, &block, None),
        };
        let group = TabGroup {
            id: self.new_id("g"),
            space_id: first.space_id.clone(),
            name: name.unwrap_or_default().to_owned(),
            icon,
            color,
            collapsed: false,
            pinned: false,
            tab_ids: window
                .tab_ids
                .iter()
                .filter(|id| members.contains(*id))
                .cloned()
                .collect(),
            created_at: JsNumber(self.now()),
            auto_ungroup: None,
            pinned_opener_id: None,
            extra: Default::default(),
        };
        let id = group.id.clone();
        leave_groups(&mut self.groups, &members);
        self.groups.insert(id.clone(), group);
        self.set_list(window);
        Some(id)
    }

    pub fn update_group(&mut self, id: &str, patch: GroupPatch) {
        let Some(g) = self.groups.get_mut(id) else {
            return;
        };
        let was_pinned = g.pinned;
        if let Some(name) = patch.name {
            g.name = name;
        }
        if let Some(icon) = patch.icon {
            g.icon = icon;
        }
        if let Some(color) = patch.color {
            g.color = color;
        }
        if let Some(collapsed) = patch.collapsed {
            g.collapsed = collapsed;
        }
        if let Some(pinned) = patch.pinned {
            g.pinned = pinned;
        }
        let first = g.tab_ids.first().cloned();
        if patch.pinned.is_none_or(|p| p == was_pinned) {
            return;
        }
        let Some(list) = first.and_then(|f| self.list_of_tab(&f)) else {
            return;
        };
        let next = TabList {
            tab_ids: order_sections(
                &list.tab_ids,
                &self.tabs,
                &self.groups,
                &self.pinned_folders,
            ),
            key: list.key,
        };
        sync_group_order(&mut self.groups, &next);
        self.set_list(next);
    }

    pub fn add_tabs_to_group(&mut self, group_id: &str, tab_ids: &[String]) {
        let Some(group) = self.groups.get(group_id) else {
            return;
        };
        let adding: Vec<String> = tab_ids
            .iter()
            .filter(|id| {
                self.tabs.get(*id).is_some_and(|t| {
                    !t.pinned_page() && t.space_id == group.space_id && !group.tab_ids.contains(id)
                })
            })
            .cloned()
            .collect();
        let Some(list) = adding.first().and_then(|id| self.list_of_tab(id)) else {
            return;
        };
        let mut members = group.tab_ids.clone();
        members.extend(adding.iter().cloned());
        let window = TabList {
            tab_ids: place_block(&list.tab_ids, &members, None),
            key: list.key,
        };
        // None of them is in this group, so it stays as it is while they leave theirs.
        leave_groups(&mut self.groups, &adding.into_iter().collect());
        if let Some(group) = self.groups.get_mut(group_id) {
            group.tab_ids = members;
        }
        self.set_list(window);
    }

    pub fn remove_tabs_from_group(&mut self, tab_ids: &[String]) {
        let leaving: HashSet<&String> = tab_ids.iter().collect();
        let ids: Vec<String> = self.groups.keys().cloned().collect();
        for gid in ids {
            let g = &self.groups[&gid];
            let kept: Vec<String> = g
                .tab_ids
                .iter()
                .filter(|id| !leaving.contains(id))
                .cloned()
                .collect();
            if kept.len() == g.tab_ids.len() {
                continue;
            }
            let list = g.tab_ids.first().and_then(|f| self.list_of_tab(f));
            let (Some(list), Some(last)) = (list, kept.last().cloned()) else {
                self.groups.shift_remove(&gid);
                continue;
            };
            let out: Vec<String> = g
                .tab_ids
                .iter()
                .filter(|id| leaving.contains(id))
                .cloned()
                .collect();
            let mut order: Vec<String> = list
                .tab_ids
                .into_iter()
                .filter(|id| !out.contains(id))
                .collect();
            let at = order.iter().position(|id| *id == last).map_or(0, |i| i + 1);
            order.splice(at..at, out);
            self.set_list(TabList {
                key: list.key,
                tab_ids: order,
            });
            if let Some(g) = self.groups.get_mut(&gid) {
                g.tab_ids = kept;
            }
        }
    }

    /// Groups the tabs (pinned unless asked otherwise); `in_order`: the group takes the first tab's place, its tabs in
    /// the order given (a tab dropped on another). The windows that had them selected select nothing.
    pub fn group_tabs(
        &mut self,
        ids: &[String],
        pinned: bool,
        name: Option<&str>,
        in_order: bool,
    ) -> Option<String> {
        let id = self.with_group(
            ids,
            GroupOptions {
                name: name.map(str::to_owned),
                pinned,
                in_order,
                ..Default::default()
            },
        )?;
        for selected in self.selection.values_mut() {
            if selected.iter().any(|t| ids.contains(t)) {
                selected.clear();
            }
        }
        Some(id)
    }

    pub fn ungroup(&mut self, group_id: &str) {
        self.groups.shift_remove(group_id);
    }

    pub fn close_group(&mut self, group_id: &str) {
        self.closing_group(group_id, false);
    }

    pub fn delete_group(&mut self, group_id: &str) {
        self.closing_group(group_id, true);
    }

    /// A group of these tabs in their list, made in place.
    pub(crate) fn with_group(&mut self, ids: &[String], o: GroupOptions) -> Option<String> {
        let tabs: Vec<&Tab> = ids
            .iter()
            .filter_map(|id| self.tabs.get(id))
            .filter(|t| !t.pinned_page())
            .collect();
        let first = *tabs.first()?;
        let w = self.list_of_tab(&first.id)?;
        if tabs
            .iter()
            .any(|t| t.space_id != first.space_id || !w.tab_ids.contains(&t.id))
        {
            return None;
        }
        let members: HashSet<String> = tabs.iter().map(|t| t.id.clone()).collect();
        let ordered: Vec<String> = if o.in_order {
            tabs.iter().map(|t| t.id.clone()).collect()
        } else {
            w.tab_ids
                .iter()
                .filter(|id| members.contains(*id))
                .cloned()
                .collect()
        };
        let anchor = o.in_order.then(|| first.id.clone());
        let tab_ids = place_block(&w.tab_ids, &ordered, anchor.as_deref());
        let group = TabGroup {
            id: self.new_id("g"),
            space_id: first.space_id.clone(),
            name: o.name.unwrap_or_default(),
            icon: None,
            color: None,
            collapsed: false,
            pinned: o.pinned,
            tab_ids: tab_ids
                .iter()
                .filter(|id| members.contains(*id))
                .cloned()
                .collect(),
            created_at: JsNumber(self.now()),
            auto_ungroup: o.auto_ungroup.then_some(true),
            pinned_opener_id: o.pinned_opener_id,
            extra: Default::default(),
        };
        let id = group.id.clone();
        leave_groups(&mut self.groups, &members);
        self.groups.insert(id.clone(), group);
        let list = TabList {
            tab_ids: order_sections(&tab_ids, &self.tabs, &self.groups, &self.pinned_folders),
            key: w.key,
        };
        sync_group_order(&mut self.groups, &list);
        self.set_list(list);
        Some(id)
    }

    /// A link joining its opener's group opens the group, so the tab is seen.
    pub(crate) fn join_group(&mut self, w: &TabList, group_id: &str, tab_id: &str) {
        let Some(group) = self.groups.get(group_id) else {
            return;
        };
        let mut members = group.tab_ids.clone();
        members.push(tab_id.to_owned());
        let block: Vec<String> = w
            .tab_ids
            .iter()
            .filter(|id| members.contains(id))
            .cloned()
            .collect();
        let list = TabList {
            key: w.key.clone(),
            tab_ids: place_block(&w.tab_ids, &block, None),
        };
        if let Some(group) = self.groups.get_mut(group_id) {
            group.collapsed = false;
            group.tab_ids = list
                .tab_ids
                .iter()
                .filter(|id| members.contains(id))
                .cloned()
                .collect();
        }
        self.set_list(list);
    }

    /// A tab opened from a link joins its opener's group, as in Chrome; opened behind from an ungrouped tab it starts
    /// one with it when the setting is on. A pinned tab's links opened behind gather in a group of their own, below
    /// the pinned tabs, as in Dia.
    pub(crate) fn group_with_opener(&mut self, tab_id: &str, opener_id: &str, background: bool) {
        let (Some(tab), Some(opener)) = (self.tabs.get(tab_id), self.tabs.get(opener_id)) else {
            return;
        };
        let space_id = tab.space_id.clone();
        let Some(w) = self.list_of_tab(tab_id) else {
            return;
        };
        if opener.space_id != space_id || !w.tab_ids.iter().any(|id| id == opener_id) {
            return;
        }
        let create = background && self.settings.cmd_click_creates_tab_group();
        if self.in_pinned_container(opener_id) {
            if let Some(gathered) = self
                .pinned_child_group(opener_id, &space_id)
                .map(|g| g.id.clone())
            {
                return self.join_group(&w, &gathered, tab_id);
            }
            if create {
                self.with_group(
                    &[tab_id.to_owned()],
                    GroupOptions {
                        auto_ungroup: true,
                        pinned_opener_id: Some(opener_id.to_owned()),
                        ..Default::default()
                    },
                );
            }
            return;
        }
        if let Some(existing) = self.group_of(opener_id).map(|g| g.id.clone()) {
            return self.join_group(&w, &existing, tab_id);
        }
        if !create {
            return;
        }
        // A split opener brings its other panes: a split is one row, inside or outside the group.
        let mut panes = self
            .splits
            .values()
            .find(|v| v.tab_ids.iter().any(|id| id == opener_id))
            .map_or_else(|| vec![opener_id.to_owned()], |v| v.tab_ids.clone());
        panes.push(tab_id.to_owned());
        self.with_group(
            &panes,
            GroupOptions {
                auto_ungroup: true,
                ..Default::default()
            },
        );
    }

    /// The window a group is in: the frontmost one on its space, else its first tab's page's.
    pub(crate) fn group_window(&self, g: &TabGroup) -> Option<String> {
        self.ui
            .focus_order
            .iter()
            .chain(&self.window_order)
            .find(|id| {
                self.windows
                    .get(*id)
                    .is_some_and(|w| w.space_id == g.space_id)
            })
            .cloned()
            .or_else(|| {
                let first = self.tabs.get(g.tab_ids.first()?)?;
                self.windows
                    .contains_key(&first.window_id)
                    .then(|| first.window_id.clone())
            })
    }

    /// Closes tabs without recording them, a window left without its space's tabs taking a new one.
    pub(crate) fn close_quietly(&mut self, ids: &[String]) {
        let windows: Vec<String> = self.windows.keys().cloned().collect();
        for w in windows {
            let view = self.view_tab_ids(&w, None);
            if !view.is_empty() && view.iter().all(|id| ids.contains(id)) {
                self.with_new_tab(&w, &NewTab::default());
            }
        }
        self.remove_tabs(ids, false);
    }

    fn closing_group(&mut self, group_id: &str, deleted: bool) {
        let Some(g) = self.groups.get(group_id).cloned() else {
            return;
        };
        let Some(list) = g.tab_ids.first().and_then(|f| self.list_of_tab(f)) else {
            return;
        };
        let entry = ClosedGroup {
            kind: "group".to_owned(),
            id: self.new_id("cg"),
            group: ClosedGroupRef {
                id: g.id.clone(),
                name: self.group_label(&g),
                icon: g.icon.clone(),
                color: g.color.clone(),
                pinned: g.pinned,
                extra: Default::default(),
            },
            tabs: g
                .tab_ids
                .iter()
                .filter_map(|id| self.tabs.get(id))
                .map(snapshot_tab)
                .collect(),
            window_id: self.group_window(&g).unwrap_or_default(),
            index: JsNumber(
                list.tab_ids
                    .iter()
                    .position(|id| *id == g.tab_ids[0])
                    .map_or(-1.0, |i| i as f64),
            ),
            closed_at: JsNumber(self.now()),
            extra: Default::default(),
        };
        let recordable =
            !is_incognito_space(&g.space_id) && entry.tabs.iter().any(|t| !t.url.is_empty());
        // Closing a group that holds the page on screen shows the tab just above the group, as in Dia; at the top of
        // the list, the one below. Each window that showed one of its tabs, read before the tabs go.
        let above: Vec<(String, Vec<String>, usize)> = self
            .windows
            .values()
            .filter(|w| {
                w.active_tab_ids
                    .get(&g.space_id)
                    .is_some_and(|was| g.tab_ids.contains(was))
            })
            .map(|w| {
                let order: Vec<String> = self
                    .view_tab_ids(&w.id, Some(&g.space_id))
                    .into_iter()
                    .filter(|id| !self.in_pinned_container(id))
                    .collect();
                let at = order.iter().position(|id| *id == g.tab_ids[0]);
                (w.id.clone(), order, at.unwrap_or(usize::MAX))
            })
            .collect();
        self.close_quietly(&g.tab_ids);
        for (window_id, order, at) in above {
            let stays = |id: &&String| {
                self.tabs.get(*id).is_some_and(|t| !t.is_unloaded()) && !g.tab_ids.contains(id)
            };
            // indexOf's -1 makes slice(0, -1) all but the last, and slice(-1) the last.
            let (head, tail) = if at == usize::MAX {
                let split = order.len().saturating_sub(1);
                order.split_at(split)
            } else {
                order.split_at(at)
            };
            let Some(pick) = head
                .iter()
                .rev()
                .find(stays)
                .or_else(|| tail.iter().find(stays))
                .cloned()
            else {
                continue;
            };
            match self.windows.get_mut(&window_id) {
                Some(window) if window.space_id != g.space_id => {
                    window.active_tab_ids.insert(g.space_id.clone(), pick);
                }
                Some(_) => self.activate_in(&pick, Some(&window_id)),
                None => {}
            }
        }
        if !recordable {
            return;
        }
        if deleted {
            let now = self.now();
            kept_deleted_groups(&mut self.deleted_groups, now);
            self.deleted_groups.push(entry);
        } else {
            self.closed_groups.push(entry);
            keep_last(&mut self.closed_groups, MAX_CLOSED_GROUPS);
        }
    }
}
