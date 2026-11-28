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

/// Which side of its anchor a new pane opens on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SplitSide {
    Left,
    #[default]
    Right,
    Top,
    Bottom,
}

/// Why a pane didn't open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaneRefused {
    /// The split has three panes.
    Max,
    Invalid,
}

/// How `open_split_pane` opens a pane: a tab (else a new one at `url`) beside `anchor_tab_id` (else the shown tab).
#[derive(Clone, Debug, Default)]
pub struct OpenPane {
    pub tab_id: Option<String>,
    pub url: Option<String>,
    pub anchor_tab_id: Option<String>,
    pub side: SplitSide,
    pub background: bool,
    /// A link opened in the new pane: the tab the engine already made for it.
    pub adopt_id: Option<String>,
}

impl Browser {
    fn with_pane(
        &self,
        existing: Option<&SplitView>,
        anchor_id: &str,
        tab_id: &str,
        side: SplitSide,
    ) -> Option<SplitView> {
        let horizontal = matches!(side, SplitSide::Left | SplitSide::Right);
        let before = matches!(side, SplitSide::Left | SplitSide::Top);
        let Some(existing) = existing else {
            let ids = if before {
                [tab_id, anchor_id]
            } else {
                [anchor_id, tab_id]
            };
            return Some(SplitView {
                id: self.new_id("split"),
                tab_ids: ids.iter().map(|s| (*s).to_owned()).collect(),
                orientation: if horizontal { "horizontal" } else { "vertical" }.to_owned(),
                sizes: vec![JsNumber(0.5), JsNumber(0.5)],
                stack: None,
                extra: Default::default(),
            });
        };
        if existing.tab_ids.len() >= MAX_SPLIT_PANES {
            return None;
        }
        let mut slots = slots_of(existing);
        let k = slots
            .iter()
            .position(|slot| slot.iter().any(|id| id == anchor_id))?;
        if (existing.orientation == "horizontal") == horizontal {
            slots.insert(if before { k } else { k + 1 }, vec![tab_id.to_owned()]);
            return Some(from_slots(existing, &slots, None));
        }
        slots[k] = if before {
            vec![tab_id.to_owned(), anchor_id.to_owned()]
        } else {
            vec![anchor_id.to_owned(), tab_id.to_owned()]
        };
        let index = slots[..k].iter().map(Vec::len).sum::<usize>();
        let mut split = from_slots(existing, &slots, Some(existing.sizes.clone()));
        split.stack = Some(SplitStack {
            index: JsNumber(index as f64),
            sizes: [JsNumber(0.5), JsNumber(0.5)],
            extra: Default::default(),
        });
        Some(split)
    }

    /// A pane joining a pinned split becomes a row in the anchor's folder.
    fn pinned_along(&mut self, tab_id: &str, anchor_folder: Option<String>) {
        let Some(t) = self.tabs.get_mut(tab_id).filter(|t| !t.pinned) else {
            return;
        };
        t.pinned_url = if t.pinned_page() {
            t.pinned_url.clone()
        } else {
            (!t.url.is_empty()).then(|| t.url.clone())
        };
        t.pinned_row = Some(true);
        t.folder_id = anchor_folder;
    }

    /// Opens a pane beside the anchor: a split of two, or a third pane. The pane's tab and the split.
    pub fn open_split_pane(
        &mut self,
        window_id: &str,
        o: OpenPane,
    ) -> Result<(String, String), PaneRefused> {
        let w = self.windows.get(window_id).ok_or(PaneRefused::Invalid)?;
        let anchor_id = o
            .anchor_tab_id
            .clone()
            .or_else(|| w.active_tab_ids.get(&w.space_id).cloned())
            .ok_or(PaneRefused::Invalid)?;
        let anchor = self
            .tabs
            .get(&anchor_id)
            .filter(|a| a.space_id == w.space_id)
            .cloned()
            .ok_or(PaneRefused::Invalid)?;
        let existing = self.split_of(&anchor.id).cloned();
        if existing
            .as_ref()
            .is_some_and(|v| v.tab_ids.len() >= MAX_SPLIT_PANES)
        {
            return Err(PaneRefused::Max);
        }
        let pinned = existing.as_ref().is_some_and(|v| self.is_pinned_split(v));
        let tab_id = match &o.tab_id {
            Some(id) => {
                if !self
                    .tabs
                    .get(id)
                    .is_some_and(|t| *id != anchor.id && t.space_id == anchor.space_id)
                {
                    return Err(PaneRefused::Invalid);
                }
                remove_from_splits(&mut self.splits, &HashSet::from([id.clone()]));
                id.clone()
            }
            None => self
                .with_new_tab(
                    window_id,
                    &super::NewTab {
                        url: o.url.clone(),
                        adopt_id: o.url.as_ref().and(o.adopt_id.clone()),
                        space_id: Some(anchor.space_id.clone()),
                        opener_id: o.url.as_ref().map(|_| anchor.id.clone()),
                        background: true,
                        ..Default::default()
                    },
                )
                .ok_or(PaneRefused::Invalid)?,
        };
        let current = existing
            .as_ref()
            .and_then(|v| self.splits.get(&v.id))
            .cloned();
        let split = self
            .with_pane(current.as_ref(), &anchor.id, &tab_id, o.side)
            .ok_or(PaneRefused::Max)?;
        if pinned {
            self.pinned_along(&tab_id, anchor.folder_id.clone());
        }
        let split_id = split.id.clone();
        let members = split.tab_ids.clone();
        self.splits.insert(split_id.clone(), split);
        self.gather(&anchor.id, &members);
        if !o.background {
            self.activate_in(&tab_id, Some(window_id));
        }
        Ok((tab_id, split_id))
    }

    /// The tab takes a pane's place in its split; the pane's tab goes.
    pub fn replace_split_pane(&mut self, pane_tab_id: &str, tab_id: &str) {
        let Some(split) = self.split_of(pane_tab_id).cloned() else {
            return;
        };
        let (Some(pane), Some(tab)) = (self.tabs.get(pane_tab_id).cloned(), self.tabs.get(tab_id))
        else {
            return;
        };
        if split.tab_ids.iter().any(|id| id == tab_id) || tab.space_id != pane.space_id {
            return;
        }
        if self.is_pinned_split(&split) {
            self.pinned_along(tab_id, pane.folder_id.clone());
        }
        remove_from_splits(&mut self.splits, &HashSet::from([tab_id.to_owned()]));
        self.gather(pane_tab_id, &[pane_tab_id.to_owned(), tab_id.to_owned()]);
        if let Some(current) = self.splits.get_mut(&split.id) {
            for id in &mut current.tab_ids {
                if id == pane_tab_id {
                    *id = tab_id.to_owned();
                }
            }
        }
        self.remove_tabs(&[pane_tab_id.to_owned()], false);
        self.activate_in(tab_id, Some(&pane.window_id));
    }

    /// The tab leaves its split, listed after the panes left.
    pub fn remove_tab_from_split(&mut self, tab_id: &str) {
        let Some(split) = self.split_of(tab_id).cloned() else {
            return;
        };
        remove_from_splits(&mut self.splits, &HashSet::from([tab_id.to_owned()]));
        let Some(list) = self.list_of_tab(tab_id) else {
            return;
        };
        if !self.splits.contains_key(&split.id) || self.tabs.get(tab_id).is_some_and(|t| t.pinned) {
            return;
        }
        let rest: Vec<&String> = split.tab_ids.iter().filter(|id| *id != tab_id).collect();
        let mut tab_ids: Vec<String> = list.tab_ids.into_iter().filter(|id| id != tab_id).collect();
        let last = rest
            .iter()
            .filter_map(|r| tab_ids.iter().position(|id| id == *r))
            .max()
            .map_or(0, |i| i + 1);
        tab_ids.insert(last, tab_id.to_owned());
        let next = TabList {
            key: list.key,
            tab_ids,
        };
        sync_group_order(&mut self.groups, &next);
        self.set_list(next);
    }

    /// New pane sizes (as many as it has slots), or the stacked pair's.
    pub fn update_split(
        &mut self,
        id: &str,
        sizes: Option<Vec<f64>>,
        stack_sizes: Option<[f64; 2]>,
    ) {
        let Some(split) = self.splits.get_mut(id) else {
            return;
        };
        if let Some(sizes) = sizes.filter(|s| s.len() == split.sizes.len()) {
            split.sizes = sizes.into_iter().map(JsNumber).collect();
        }
        if let (Some([a, b]), Some(stack)) = (stack_sizes, split.stack.as_mut()) {
            stack.sizes = [JsNumber(a), JsNumber(b)];
        }
    }

    /// The panes in reverse order.
    pub fn flip_split(&mut self, split_id: &str) {
        let Some(split) = self.splits.get(split_id) else {
            return;
        };
        let mut slots = slots_of(split);
        slots.reverse();
        let mut sizes = split.sizes.clone();
        sizes.reverse();
        let flipped = from_slots(split, &slots, Some(sizes));
        self.splits.insert(split_id.to_owned(), flipped);
    }

    pub fn toggle_split_orientation(&mut self, split_id: &str) {
        if let Some(split) = self.splits.get_mut(split_id) {
            split.orientation = if split.orientation == "horizontal" {
                "vertical"
            } else {
                "horizontal"
            }
            .to_owned();
        }
    }

    /// Swaps the pane with its neighbour (1 the next, -1 the one before).
    pub fn move_pane(&mut self, tab_id: &str, delta: isize) {
        let Some(id) = self.split_of(tab_id).map(|v| v.id.clone()) else {
            return;
        };
        let split = &mut self.splits[&id];
        let Some(i) = split.tab_ids.iter().position(|t| t == tab_id) else {
            return;
        };
        let j = i as isize + delta;
        if j >= 0 && (j as usize) < split.tab_ids.len() {
            split.tab_ids.swap(i, j as usize);
        }
    }

    /// Shows the next (1) or previous (-1) pane of the shown split, round it.
    pub fn focus_pane(&mut self, window_id: &str, delta: isize) {
        let Some(active) = self
            .windows
            .get(window_id)
            .and_then(|w| w.active_tab_ids.get(&w.space_id))
            .cloned()
        else {
            return;
        };
        let Some(split) = self.split_of(&active) else {
            return;
        };
        let n = split.tab_ids.len() as isize;
        let i = split.tab_ids.iter().position(|t| *t == active).unwrap_or(0) as isize;
        let next = split.tab_ids[((i + delta + n).rem_euclid(n)) as usize].clone();
        self.activate(&next, Some(window_id));
    }

    /// The tabs in the sidebar or along the top, for the window and as the setting.
    pub fn toggle_tab_layout(&mut self, window_id: &str) {
        let setting = self
            .settings
            .str("tabLayout")
            .unwrap_or("sidebar")
            .to_owned();
        let Some(w) = self.windows.get_mut(window_id) else {
            return;
        };
        let layout = if w.tab_layout.as_deref().unwrap_or(&setting) == "sidebar" {
            "top"
        } else {
            "sidebar"
        };
        w.tab_layout = Some(layout.to_owned());
        self.settings.set("tabLayout", layout);
    }
}
