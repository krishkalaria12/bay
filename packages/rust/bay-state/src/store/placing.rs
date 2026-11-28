//! Moving tabs in and out of the Essentials, the Pinned section's rows and groups (store/tabTidying.ts `placing`).

use std::collections::{HashMap, HashSet};

use super::Browser;
use super::groups::{leave_groups, order_sections, place_block, sync_group_order};
use super::model::TabList;

/// Where `placing` puts tabs.
#[derive(Clone, Debug, Default)]
pub struct TabPlacement {
    /// An Essential (a pinned tile).
    pub pinned: bool,
    /// A pinned row; `Some(false)` unpins one, `None` keeps a pinned row one.
    pub row: Option<bool>,
    pub before_id: Option<String>,
    pub group_id: Option<String>,
}

impl Browser {
    pub(crate) fn placing(&mut self, ids: &[String], p: &TabPlacement) {
        let Some(first) = ids.first().and_then(|id| self.tabs.get(id)).cloned() else {
            return;
        };
        let Some(w) = self.list_of_tab(&first.id) else {
            return;
        };
        let order: HashMap<&String, usize> = w
            .tab_ids
            .iter()
            .enumerate()
            .map(|(i, id)| (id, i))
            .collect();
        // Favourites are shared by the spaces with one profile: a selection of them can come from several.
        let moves = |id: &String| {
            self.tabs.get(id).is_some_and(|t| {
                order.contains_key(&t.id)
                    && (t.space_id == first.space_id
                        || (p.pinned
                            && t.pinned
                            && self.shares_profile(&t.space_id, &first.space_id)))
            })
        };
        let mut moving: Vec<String> = Vec::new();
        for id in ids {
            if moves(id) && !moving.contains(id) {
                moving.push(id.clone());
            }
        }
        moving.sort_by_key(|id| order[id]);
        if moving.is_empty() {
            return;
        }
        let target = (!p.pinned && p.row != Some(true))
            .then(|| p.group_id.as_ref().and_then(|g| self.groups.get(g)))
            .flatten()
            .cloned();
        if target
            .as_ref()
            .is_some_and(|t| t.space_id != first.space_id)
        {
            return;
        }
        let moving_set: HashSet<String> = moving.iter().cloned().collect();
        let mut tabs = self.tabs.clone();
        for id in &moving {
            let t = &tabs[id];
            // A tab into a group leaves the Pinned section; one placed with no word on it keeps its row.
            let row = !p.pinned && target.is_none() && p.row.unwrap_or(t.is_row());
            let folder_id = if row && p.row != Some(true) {
                t.folder_id.clone()
            } else {
                None
            };
            if t.pinned == p.pinned && t.is_row() == row && t.folder_id == folder_id {
                continue;
            }
            let pinned_url = if p.pinned || row {
                if t.pinned_page() {
                    t.pinned_url.clone()
                } else {
                    (!t.url.is_empty()).then(|| t.url.clone())
                }
            } else {
                None
            };
            let t = &mut tabs[id];
            t.pinned = p.pinned;
            t.pinned_url = pinned_url;
            t.pinned_row = row.then_some(true);
            t.folder_id = folder_id;
        }
        let mut rest: Vec<String> = w
            .tab_ids
            .iter()
            .filter(|id| !moving_set.contains(*id))
            .cloned()
            .collect();
        let after_last = |test: &dyn Fn(&String) -> bool| {
            rest.iter()
                .enumerate()
                .fold(0, |last, (i, id)| if test(id) { i + 1 } else { last })
        };
        let at = if let Some(before) = p
            .before_id
            .as_ref()
            .and_then(|b| rest.iter().position(|id| id == b))
        {
            before
        } else if let Some(target) = &target {
            match target.tab_ids.iter().rfind(|id| !moving_set.contains(*id)) {
                Some(last) => rest.iter().position(|id| id == last).map_or(0, |i| i + 1),
                None => order
                    .get(&target.tab_ids[0])
                    .copied()
                    .unwrap_or(0)
                    .min(rest.len()),
            }
        } else if p.pinned {
            after_last(&|id| tabs.get(id).is_some_and(|t| t.pinned))
        } else if p.row == Some(true) {
            after_last(&|id| tabs.get(id).is_some_and(|t| t.pinned_page()))
        } else {
            rest.len()
        };
        rest.splice(at..at, moving.iter().cloned());

        let mut groups = self.groups.clone();
        leave_groups(&mut groups, &moving_set);
        if let Some(target) = &target {
            let members: HashSet<&String> = target.tab_ids.iter().chain(&moving).collect();
            let mut joined = target.clone();
            joined.tab_ids = rest
                .iter()
                .filter(|id| members.contains(id))
                .cloned()
                .collect();
            groups.insert(target.id.clone(), joined);
        }
        let mut tab_ids = rest;
        for g in groups.values() {
            if g.tab_ids.iter().any(|id| order.contains_key(id)) {
                let block: Vec<String> = tab_ids
                    .iter()
                    .filter(|id| g.tab_ids.contains(id))
                    .cloned()
                    .collect();
                tab_ids = place_block(&tab_ids, &block, None);
            }
        }
        let tab_ids = order_sections(&tab_ids, &tabs, &groups, &self.pinned_folders);
        let list = TabList {
            key: w.key,
            tab_ids,
        };
        sync_group_order(&mut groups, &list);
        self.tabs = tabs;
        self.groups = groups;
        self.set_list(list);
    }

    /// Pins the tabs as Essentials, or unpins them to the top of the list, below anything pinned.
    pub fn pin_tabs(&mut self, ids: &[String], pinned: bool) {
        let Some(w) = ids.first().and_then(|id| self.list_of_tab(id)) else {
            return;
        };
        let before_id = if pinned {
            None
        } else {
            w.tab_ids
                .iter()
                .find(|id| !self.in_pinned_container(id) && !ids.contains(id))
                .cloned()
        };
        self.placing(
            ids,
            &TabPlacement {
                pinned,
                before_id,
                ..Default::default()
            },
        );
    }

    /// Pins the tabs (and their splits) as rows of the Pinned section, or unpins them to the top of the list.
    pub fn pin_rows(&mut self, ids: &[String], pinned: bool) {
        let Some(w) = ids.first().and_then(|id| self.list_of_tab(id)) else {
            return;
        };
        let rows = self.with_split_panes(ids);
        let before_id = if pinned {
            None
        } else {
            w.tab_ids
                .iter()
                .find(|id| !self.in_pinned_container(id) && !rows.contains(id))
                .cloned()
        };
        self.placing(
            &rows,
            &TabPlacement {
                pinned: false,
                row: Some(pinned),
                before_id,
                group_id: None,
            },
        );
    }
}
