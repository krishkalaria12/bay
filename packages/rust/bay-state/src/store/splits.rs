//! Split View: two or three tabs side by side, one row in their list (store/splits.ts).

use std::collections::HashSet;

use indexmap::IndexMap;

use super::groups::{leave_groups, sync_group_order};
use super::model::TabList;
use super::{Browser, MAX_SPLIT_PANES};
use crate::model::{SplitStack, SplitView, Tab};
use crate::number::JsNumber;

/// A split's slots: one pane each, or two stacked (`stack`).
pub(crate) fn slots_of(split: &SplitView) -> Vec<Vec<String>> {
    let mut slots = Vec::new();
    let stack_at = split.stack.as_ref().map(|s| s.index.0);
    let mut i = 0;
    while i < split.tab_ids.len() {
        if stack_at == Some(i as f64) && i + 1 < split.tab_ids.len() {
            slots.push(vec![split.tab_ids[i].clone(), split.tab_ids[i + 1].clone()]);
            i += 2;
        } else {
            slots.push(vec![split.tab_ids[i].clone()]);
            i += 1;
        }
    }
    slots
}

fn equal(n: usize) -> Vec<JsNumber> {
    vec![JsNumber(1.0 / n as f64); n]
}

fn from_slots(split: &SplitView, slots: &[Vec<String>], sizes: Option<Vec<JsNumber>>) -> SplitView {
    let tab_ids: Vec<String> = slots.iter().flatten().cloned().collect();
    let stack = slots.iter().position(|slot| slot.len() == 2).map(|at| {
        let index = slots[..at].iter().map(Vec::len).sum::<usize>();
        match &split.stack {
            Some(old) => SplitStack {
                index: JsNumber(index as f64),
                ..old.clone()
            },
            None => SplitStack {
                index: JsNumber(index as f64),
                sizes: [JsNumber(0.5), JsNumber(0.5)],
                extra: Default::default(),
            },
        }
    });
    SplitView {
        tab_ids,
        sizes: sizes
            .filter(|s| s.len() == slots.len())
            .unwrap_or_else(|| equal(slots.len())),
        stack,
        ..split.clone()
    }
}

/// The splits without these tabs; a split left with one pane goes.
pub(crate) fn remove_from_splits(splits: &mut IndexMap<String, SplitView>, gone: &HashSet<String>) {
    splits.retain(|_, v| {
        if !v.tab_ids.iter().any(|id| gone.contains(id)) {
            return true;
        }
        let old = slots_of(v);
        let slots: Vec<Vec<String>> = old
            .iter()
            .map(|slot| {
                slot.iter()
                    .filter(|id| !gone.contains(*id))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .filter(|slot| !slot.is_empty())
            .collect();
        if slots.iter().map(Vec::len).sum::<usize>() < 2 {
            return false;
        }
        let sizes: Vec<f64> = old
            .iter()
            .zip(&v.sizes)
            .filter(|(slot, _)| slot.iter().any(|id| !gone.contains(id)))
            .map(|(_, size)| size.0)
            .collect();
        let total: f64 = sizes.iter().sum();
        let sizes = (total > 0.0).then(|| sizes.iter().map(|x| JsNumber(x / total)).collect());
        *v = from_slots(v, &slots, sizes);
        true
    });
}

/// Saved splits less their broken panes: a tab that's gone, of another space, or already in a split.
pub(crate) fn sanitize_splits(
    splits: &IndexMap<String, SplitView>,
    tabs: &IndexMap<String, Tab>,
) -> IndexMap<String, SplitView> {
    let mut next = IndexMap::new();
    let mut used: HashSet<String> = HashSet::new();
    for v in splits.values() {
        let first = v.tab_ids.first().and_then(|id| tabs.get(id));
        let ok = |id: &String| {
            tabs.get(id).map(|t| &t.space_id) == first.map(|t| &t.space_id)
                && tabs.contains_key(id)
                && !used.contains(id)
        };
        let gone: HashSet<String> = v.tab_ids.iter().filter(|id| !ok(id)).cloned().collect();
        let fixed = if gone.is_empty() {
            Some(v.clone())
        } else {
            let mut one = IndexMap::from([(v.id.clone(), v.clone())]);
            remove_from_splits(&mut one, &gone);
            one.shift_remove(&v.id)
        };
        let Some(fixed) = fixed.filter(|f| f.tab_ids.len() <= MAX_SPLIT_PANES) else {
            continue;
        };
        used.extend(fixed.tab_ids.iter().cloned());
        next.insert(fixed.id.clone(), fixed);
    }
    next
}

impl Browser {
    /// The first split holding the tab.
    pub fn split_of(&self, tab_id: &str) -> Option<&SplitView> {
        self.splits
            .values()
            .find(|v| v.tab_ids.iter().any(|id| id == tab_id))
    }

    /// A split pinned as one row: every pane in the Pinned section, in one folder or none.
    pub fn is_pinned_split(&self, split: &SplitView) -> bool {
        let folder = split
            .tab_ids
            .first()
            .and_then(|id| self.tabs.get(id))
            .and_then(|t| t.folder_id.as_ref());
        split.tab_ids.iter().all(|id| {
            self.tabs
                .get(id)
                .is_some_and(|t| t.is_row() && t.folder_id.as_ref() == folder)
        })
    }

    pub fn pinned_split_of(&self, tab_id: &str) -> Option<&SplitView> {
        self.split_of(tab_id).filter(|v| self.is_pinned_split(v))
    }

    /// The split that goes in and out of the Pinned section whole. An Essential stays a tile, so with one its panes
    /// go alone.
    pub(crate) fn pinnable_split(&self, tab_id: &str) -> Option<&SplitView> {
        self.split_of(tab_id).filter(|v| {
            !v.tab_ids
                .iter()
                .any(|id| self.tabs.get(id).is_some_and(|t| t.pinned))
        })
    }

    pub(crate) fn with_split_panes(&self, ids: &[String]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for id in ids {
            let panes = self
                .pinnable_split(id)
                .map_or_else(|| vec![id.clone()], |v| v.tab_ids.clone());
            for pane in panes {
                if !out.contains(&pane) {
                    out.push(pane);
                }
            }
        }
        out
    }

    /// Two or three tabs of one list side by side, `orientation` "horizontal" or "vertical".
    pub fn create_split(&mut self, tab_ids: &[String], orientation: &str) -> Option<String> {
        let mut ids: Vec<String> = Vec::new();
        for id in tab_ids {
            if self.tabs.contains_key(id) && !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        if ids.len() < 2 || ids.len() > MAX_SPLIT_PANES {
            return None;
        }
        let first = &self.tabs[&ids[0]];
        let key = self.tab_list_key(first);
        let fits = ids.iter().all(|id| {
            let t = &self.tabs[id];
            t.space_id == first.space_id && self.tab_list_key(t) == key
        });
        if !fits {
            return None;
        }
        remove_from_splits(&mut self.splits, &ids.iter().cloned().collect());
        let split = SplitView {
            id: self.new_id("split"),
            sizes: equal(ids.len()),
            tab_ids: ids.clone(),
            orientation: orientation.to_owned(),
            stack: None,
            extra: Default::default(),
        };
        let id = split.id.clone();
        self.splits.insert(id.clone(), split);
        self.gather(&ids[0].clone(), &ids);
        Some(id)
    }

    /// The members move next to the anchor in its list, and into its group.
    fn gather(&mut self, anchor_id: &str, members: &[String]) {
        let Some(anchor) = self.tabs.get(anchor_id) else {
            return;
        };
        if anchor.pinned {
            return;
        }
        let Some(list) = self.list_of_tab(anchor_id) else {
            return;
        };
        let moving: HashSet<String> = members
            .iter()
            .filter(|id| *id != anchor_id && self.tabs.get(*id).is_some_and(|t| !t.pinned))
            .cloned()
            .collect();
        if moving.is_empty() {
            return;
        }
        let block: Vec<String> = members
            .iter()
            .filter(|id| *id == anchor_id || moving.contains(*id))
            .cloned()
            .collect();
        let mut tab_ids: Vec<String> = list
            .tab_ids
            .into_iter()
            .filter(|id| !moving.contains(id))
            .collect();
        if let Some(at) = tab_ids.iter().position(|id| id == anchor_id) {
            tab_ids.splice(at..=at, block);
        }
        let next = TabList {
            key: list.key,
            tab_ids,
        };
        let group = self.group_of(anchor_id).map(|g| g.id.clone());
        leave_groups(&mut self.groups, &moving);
        if let Some(g) = group.and_then(|id| self.groups.get_mut(&id)) {
            g.tab_ids
                .extend(members.iter().filter(|id| moving.contains(*id)).cloned());
        }
        sync_group_order(&mut self.groups, &next);
        self.set_list(next);
    }

    pub fn separate_split(&mut self, split_id: &str) {
        self.splits.shift_remove(split_id);
    }
}
