//! Chrome's opener model (TabStripModel), which Dia keeps (store/openerOrder.ts): a tab opened from a link remembers
//! its opener (`Tab::opener_id`) until the person starts something else. While it holds, links opened behind line up
//! after the opener in the order they were opened, and closing the page goes back to the opener's other tabs, then to
//! the opener. Switching to an unrelated tab, typing an address or opening a link in front forgets every opener in
//! the list.

use std::collections::HashSet;

use super::Browser;
use super::model::TabList;
use crate::model::Tab;

/// Just past the last of `ids` in `list`, or None when none of them is there.
fn past_last_of(list: &[String], ids: &[String]) -> Option<usize> {
    ids.iter()
        .filter_map(|id| list.iter().position(|t| t == id))
        .max()
        .map(|i| i + 1)
}

impl Browser {
    fn regular(&self, id: &str) -> bool {
        !self.in_pinned_container(id)
    }

    /// Where a new unpinned tab goes: next to its opener, else at the top or bottom of the list (the setting).
    pub(crate) fn insertion_index(&self, w: &TabList, tab: &Tab, background: bool) -> usize {
        let opener = tab.opener_id.as_ref().and_then(|id| self.tabs.get(id));
        let in_list = opener.is_some_and(|o| w.tab_ids.contains(&o.id));
        let index = match opener {
            Some(opener)
                if in_list && opener.space_id == tab.space_id && self.regular(&opener.id) =>
            {
                // A split is one row: its tabs go after its last pane.
                let panes = self
                    .split_of(&opener.id)
                    .map_or_else(|| vec![opener.id.clone()], |v| v.tab_ids.clone());
                let at = past_last_of(&w.tab_ids, &panes).unwrap_or(0);
                if background {
                    self.after_family(w, tab, at, &opener.id)
                } else {
                    at
                }
            }
            Some(opener) if in_list && opener.space_id == tab.space_id => {
                // From a pinned tab: just below the pinned tabs, after the links it opened before (Dia gathers them).
                match self.pinned_child_group(&opener.id, &tab.space_id) {
                    Some(gathered) => past_last_of(&w.tab_ids, &gathered.tab_ids).unwrap_or(0),
                    None => self.after_family(w, tab, self.first_regular(w, tab), &opener.id),
                }
            }
            _ => {
                let start = self.list_start(w, tab);
                // An opener in another list (Little Bay) still keeps its tabs in order.
                match opener {
                    Some(opener) => self.after_family(w, tab, start, &opener.id),
                    None => start,
                }
            }
        };
        self.outside_split(w, index)
    }

    fn first_regular(&self, w: &TabList, tab: &Tab) -> usize {
        w.tab_ids
            .iter()
            .position(|id| {
                self.tabs
                    .get(id)
                    .is_some_and(|t| t.space_id == tab.space_id)
                    && self.regular(id)
            })
            .unwrap_or(w.tab_ids.len())
    }

    fn list_start(&self, w: &TabList, tab: &Tab) -> usize {
        if self.settings.new_tabs_at_top() {
            self.first_regular(w, tab)
        } else {
            w.tab_ids.len()
        }
    }

    /// Past the tabs the opener opened, and the tabs those opened, that follow `from` in the same group.
    fn after_family(&self, w: &TabList, tab: &Tab, from: usize, opener_id: &str) -> usize {
        let mut family: HashSet<&str> = HashSet::from([opener_id]);
        let group = if w.tab_ids.iter().any(|id| id == opener_id) && self.regular(opener_id) {
            self.group_of(opener_id).map(|g| g.id.clone())
        } else {
            None
        };
        let mut index = from;
        for (i, id) in w.tab_ids.iter().enumerate().skip(from) {
            let Some(t) = self.tabs.get(id) else {
                continue;
            };
            if t.space_id != tab.space_id {
                continue;
            }
            let joined = t.opener_id.as_deref().is_some_and(|o| family.contains(o));
            if !joined || self.group_of(&t.id).map(|g| g.id.clone()) != group {
                break;
            }
            family.insert(&t.id);
            index = i + 1;
        }
        index
    }

    /// A split's panes stay next to each other in the list.
    fn outside_split(&self, w: &TabList, index: usize) -> usize {
        let (Some(before), Some(after)) = (
            index.checked_sub(1).and_then(|i| w.tab_ids.get(i)),
            w.tab_ids.get(index),
        ) else {
            return index;
        };
        let Some(split) = self.split_of(before) else {
            return index;
        };
        if !split.tab_ids.contains(after) {
            return index;
        }
        past_last_of(&w.tab_ids, &split.tab_ids).unwrap_or(index)
    }

    /// Forgets the openers of a list's tabs, but `keep`'s.
    pub(crate) fn forget_openers(&mut self, list_key: &str, keep: Option<&str>) {
        let ids: Vec<String> = self
            .list_ids(list_key)
            .iter()
            .filter(|id| Some(id.as_str()) != keep)
            .cloned()
            .collect();
        for id in ids {
            if let Some(t) = self.tabs.get_mut(&id) {
                t.opener_id = None;
            }
        }
    }

    /// Chrome keeps the openers when the person moves between a tab and a tab it opened, or between two tabs that
    /// share an opener (TabStripModel::SetSelection).
    pub(crate) fn switch_keeps_openers(&self, from: &str, to: &str) -> bool {
        let a = self.tabs.get(from).and_then(|t| t.opener_id.as_deref());
        let b = self.tabs.get(to).and_then(|t| t.opener_id.as_deref());
        a == b || b == Some(from) || a == Some(to)
    }

    /// What to show when the shown tab `closed` goes: a tab it opened, then another tab its opener opened, then the
    /// opener (TabStripModel::DetermineNewSelectedIndex). `order` is the list before the close, `left` what stays.
    pub(crate) fn opener_successor(
        &self,
        closed: &str,
        order: &[String],
        left: &[String],
    ) -> Option<String> {
        let at = order.iter().position(|id| id == closed);
        let position = |id: &String| order.iter().position(|o| o == id);
        let after = left.iter().filter(|id| position(id) > at);
        let before = left.iter().filter(|id| position(id) < at).rev();
        let candidates: Vec<&String> = after
            .chain(before)
            .filter(|id| {
                !self.tabs[*id].is_unloaded() && !self.group_of(id).is_some_and(|g| g.collapsed)
            })
            .collect();
        let opened_by = |opener: &str| {
            candidates
                .iter()
                .find(|id| self.tabs[**id].opener_id.as_deref() == Some(opener))
                .map(|id| (*id).clone())
        };
        if let Some(child) = opened_by(closed) {
            return Some(child);
        }
        let opener = self.tabs.get(closed)?.opener_id.as_deref()?;
        opened_by(opener).or_else(|| {
            candidates
                .iter()
                .any(|id| *id == opener)
                .then(|| opener.to_owned())
        })
    }
}
