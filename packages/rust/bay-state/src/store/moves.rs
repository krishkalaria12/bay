//! Moving tabs between windows and spaces, merging windows, and bringing closed tabs, windows and groups back
//! (store/windows.ts, store/tabTidying.ts `restoringGroup`).

use std::collections::HashSet;

use indexmap::IndexMap;

use super::groups::{GroupOptions, leave_groups, order_sections, sync_group_order};
use super::model::{TabList, is_incognito_space, pinned_first};
use super::splits::remove_from_splits;
use super::tabs::Successors;
use super::{Browser, NewTab, TabLive};
use crate::model::{
    BrowserWindow, ClosedGroup, ClosedTab, ClosedWindow, Tab, TabGroup, TabSnapshot,
};
use crate::number::JsNumber;

/// A closed tab's back/forward list is the engine's (TabRestoreService), found by the closed tab's id.
fn restore_id(tab_id: &str) -> String {
    format!("restore:{tab_id}")
}

/// The tab's page moves to the window; a loaded one loads there.
fn page_to(browser: &Browser, t: &mut Tab, window_id: &str) {
    if t.window_id == window_id {
        return;
    }
    let loaded = t.is_loaded();
    t.adopt_id = None;
    t.window_id = window_id.to_owned();
    t.navigation = loaded.then(|| browser.navigation_to(&t.url, false));
}

impl Browser {
    /// The group back under its id, or a new one when a group has that id now.
    fn restore_group(&mut self, mut g: TabGroup, tab_ids: Vec<String>) {
        if self.groups.contains_key(&g.id) {
            g.id = self.new_id("g");
        }
        g.tab_ids = tab_ids;
        self.groups.insert(g.id.clone(), g);
    }

    fn can_restore_tab_into(&self, c: &ClosedTab, window_id: Option<&str>) -> bool {
        if is_incognito_space(&c.tab.space_id) {
            return Some(c.window_id.as_str()) == window_id;
        }
        !window_id
            .and_then(|w| self.windows.get(w))
            .is_some_and(|w| w.incognito)
    }

    /// The window shows these tabs: their pages move there, and a window that showed one of them shows another. A
    /// Little Bay page moves into its space's list (Little Bay goes).
    pub(crate) fn move_tabs_into(&mut self, ids: &[String], target_id: &str) {
        let Some(target) = self.windows.get(target_id).cloned() else {
            return;
        };
        let small = target.is_small();
        if small
            && (ids.len() != 1
                || !self.list_ids(target_id).is_empty()
                || self
                    .tabs
                    .get(&ids[0])
                    .is_none_or(|t| t.space_id != target.space_id))
        {
            return;
        }
        let moving: Vec<Tab> = ids
            .iter()
            .filter_map(|id| self.tabs.get(id))
            .filter(|t| {
                t.window_id != target_id
                    && is_incognito_space(&t.space_id) == target.incognito
                    && (!target.incognito || t.space_id == target.space_id)
            })
            .cloned()
            .collect();
        if moving.is_empty()
            || (small
                && (moving.len() != 1 || moving[0].pinned_page() || moving[0].peek_of.is_some()))
        {
            return;
        }
        let moving_ids: HashSet<String> = moving.iter().map(|t| t.id.clone()).collect();
        let before: IndexMap<String, BrowserWindow> = self.windows.clone();

        // A Little Bay page leaves its window for its space's list, at the list's end.
        let littles: Vec<&Tab> = moving
            .iter()
            .filter(|t| {
                self.windows
                    .get(&t.window_id)
                    .is_some_and(BrowserWindow::is_small)
            })
            .collect();
        let mut emptied: Vec<String> = Vec::new();
        for t in &littles {
            let key = self.space_list_key(&t.space_id);
            if let Some(tab) = self.tabs.get_mut(&t.id) {
                tab.window_id = String::new();
            }
            let from: Vec<String> = self
                .list_ids(&t.window_id)
                .iter()
                .filter(|id| **id != t.id)
                .cloned()
                .collect();
            self.set_list(TabList {
                key: t.window_id.clone(),
                tab_ids: from,
            });
            let mut to = self.list_ids(&key).to_vec();
            to.push(t.id.clone());
            let tab_ids = pinned_first(&to, &self.tabs);
            self.set_list(TabList { key, tab_ids });
            if !self.tab_lists.contains_key(&t.window_id) {
                emptied.push(t.window_id.clone());
            }
        }
        self.without_windows(&emptied);

        if small {
            let tab = &moving[0];
            let from = self.tab_list_key(&self.tabs[&tab.id]);
            let rest: Vec<String> = self
                .list_ids(&from)
                .iter()
                .filter(|id| **id != tab.id)
                .cloned()
                .collect();
            self.set_list(TabList {
                key: from,
                tab_ids: rest,
            });
            self.set_list(TabList {
                key: target_id.to_owned(),
                tab_ids: vec![tab.id.clone()],
            });
            leave_groups(&mut self.groups, &moving_ids);
            remove_from_splits(&mut self.splits, &moving_ids);
        } else {
            // A whole split travels together; panes pulled out leave the split behind.
            let detached: HashSet<String> = self
                .splits
                .values()
                .filter(|v| !v.tab_ids.iter().all(|id| moving_ids.contains(id)))
                .flat_map(|v| {
                    v.tab_ids
                        .iter()
                        .filter(|id| moving_ids.contains(*id))
                        .cloned()
                })
                .collect();
            remove_from_splits(&mut self.splits, &detached);
        }

        let successors: Vec<(String, Successors)> = self
            .windows
            .values()
            .filter(|w| {
                w.id != target_id && w.active_tab_ids.values().any(|id| moving_ids.contains(id))
            })
            .map(|w| (w.id.clone(), self.successors_of(w, &moving_ids)))
            .collect();
        for t in &moving {
            let mut tab = self.tabs[&t.id].clone();
            page_to(self, &mut tab, target_id);
            self.tabs.insert(t.id.clone(), tab);
            self.live.entry(t.id.clone()).or_default();
        }
        for (window_id, picks) in successors {
            self.set_window_successors(&window_id, picks);
        }
        if let Some(w) = self.windows.get_mut(target_id) {
            for m in &moving {
                w.active_tab_ids
                    .entry(m.space_id.clone())
                    .or_insert_with(|| m.id.clone());
            }
        }
        // A window whose tab moved shows its next one, woken.
        let woken: Vec<(String, String)> = self
            .windows
            .values()
            .filter(|w| w.id != target_id)
            .filter_map(|w| {
                let shown = w.active_tab_ids.get(&w.space_id)?;
                let was = before
                    .get(&w.id)
                    .and_then(|b| b.active_tab_ids.get(&w.space_id));
                (was != Some(shown)).then(|| (w.id.clone(), shown.clone()))
            })
            .collect();
        for (window_id, tab) in woken {
            self.activate_in(&tab, Some(&window_id));
        }
    }

    /// Shows the tabs in the window (a new one for None): their pages move there. The window's id.
    pub fn move_tabs_to_window(
        &mut self,
        tab_ids: &[String],
        window_id: Option<&str>,
    ) -> Option<String> {
        let Some(window_id) = window_id else {
            let first = self.tabs.get(tab_ids.first()?)?;
            if is_incognito_space(&first.space_id) {
                return None;
            }
            let space_id = first.space_id.clone();
            return Some(self.create_window(super::CreateWindow {
                space_id: Some(space_id),
                tab_ids: tab_ids.to_vec(),
                ..Default::default()
            }));
        };
        self.move_tabs_into(tab_ids, window_id);
        let last = tab_ids
            .iter()
            .rev()
            .find(|id| self.tabs.get(*id).is_some_and(|t| t.window_id == window_id))
            .cloned();
        if let Some(last) = last {
            self.activate_in(&last, Some(window_id));
        }
        Some(window_id.to_owned())
    }

    /// The tab joins the space, shown in `window_id` (by default the window it's in, which goes to that space with it).
    pub fn move_tab_to_space(&mut self, tab_id: &str, space_id: &str, window_id: Option<&str>) {
        let Some(tab) = self.tabs.get(tab_id).cloned() else {
            return;
        };
        if is_incognito_space(&tab.space_id)
            || !self.spaces.contains_key(space_id)
            || tab.space_id == space_id
        {
            return;
        }
        let from = self.tab_list_key(&tab);
        let to = self.space_list_key(space_id);
        let same_engine = self.shares_profile(&tab.space_id, space_id);
        let gone = HashSet::from([tab_id.to_owned()]);
        let successors: Vec<(String, Successors)> = self
            .windows
            .values()
            .filter(|w| w.active_tab_ids.get(&tab.space_id).map(String::as_str) == Some(tab_id))
            .map(|w| (w.id.clone(), self.successors_of(w, &gone)))
            .collect();
        // It leaves its folder (the other space's). A tab moved to another profile reopens from its address: its live
        // page belongs to the other profile.
        let mut moved = tab.clone();
        moved.folder_id = None;
        moved.space_id = space_id.to_owned();
        moved.last_active_at = JsNumber(self.now());
        if !same_engine {
            let loaded = tab.is_loaded();
            moved.adopt_id = None;
            moved.wake_adopt_id = None;
            moved.navigation = loaded.then(|| self.navigation_to(&tab.url, false));
            self.live.insert(tab_id.to_owned(), TabLive::default());
        }
        self.tabs.insert(tab_id.to_owned(), moved);
        for (w, picks) in successors {
            self.set_window_successors(&w, picks);
        }
        leave_groups(&mut self.groups, &gone);
        remove_from_splits(&mut self.splits, &gone);
        let from_list: Vec<String> = self
            .list_ids(&from)
            .iter()
            .filter(|id| *id != tab_id)
            .cloned()
            .collect();
        self.set_list(TabList {
            key: from.clone(),
            tab_ids: from_list.clone(),
        });
        let to_list = if from == to {
            from_list
        } else {
            self.list_ids(&to).to_vec()
        };
        let ordered: Vec<String> = std::iter::once(tab_id.to_owned()).chain(to_list).collect();
        let tab_ids = order_sections(&ordered, &self.tabs, &self.groups, &self.pinned_folders);
        self.set_list(TabList { key: to, tab_ids });
        let window = window_id.map(str::to_owned).or_else(|| {
            self.windows
                .contains_key(&tab.window_id)
                .then(|| tab.window_id.clone())
        });
        self.activate_in(tab_id, window.as_deref());
    }

    /// The other main windows close; their pages move into this one.
    pub fn merge_all_windows(&mut self, window_id: &str) {
        let main = |w: Option<&BrowserWindow>| w.is_some_and(|w| !w.incognito && !w.is_small());
        let target = if main(self.windows.get(window_id)) {
            Some(window_id.to_owned())
        } else {
            self.main_window_for(None)
        };
        let Some(target) = target else {
            return;
        };
        let others: Vec<String> = self
            .window_order
            .iter()
            .filter(|id| **id != target && main(self.windows.get(*id)))
            .cloned()
            .collect();
        if others.is_empty() {
            return;
        }
        let ids: Vec<String> = self
            .tabs
            .values()
            .filter(|t| others.contains(&t.window_id))
            .map(|t| t.id.clone())
            .collect();
        for id in ids {
            let mut t = self.tabs[&id].clone();
            page_to(self, &mut t, &target);
            self.tabs.insert(id, t);
        }
        self.without_windows(&others);
    }

    /// Brings back the most recently closed tab, window or group (⇧⌘T).
    pub fn reopen_closed(&mut self, window_id: Option<&str>) {
        let target = self.resolve_window_id(window_id);
        let private = target
            .as_ref()
            .and_then(|t| self.windows.get(t))
            .is_some_and(|w| w.incognito);
        let last_tab = self
            .closed_tabs
            .iter()
            .rev()
            .find(|c| self.can_restore_tab_into(c, target.as_deref()));
        let candidates = [
            (!private)
                .then(|| self.closed_windows.last().map(|c| (&c.id, c.closed_at.0)))
                .flatten(),
            (!private)
                .then(|| self.closed_groups.last().map(|c| (&c.id, c.closed_at.0)))
                .flatten(),
            last_tab.map(|c| (&c.id, c.closed_at.0)),
        ];
        let mut latest: Option<(&String, f64)> = None;
        for entry in candidates.into_iter().flatten() {
            if latest.is_none_or(|(_, at)| entry.1 > at) {
                latest = Some(entry);
            }
        }
        if let Some((id, _)) = latest {
            let id = id.clone();
            self.restore_closed(&id, target.as_deref());
        }
    }

    pub fn reopen_closed_tab(&mut self, window_id: Option<&str>) {
        let target = self.resolve_window_id(window_id);
        let entry = self
            .closed_tabs
            .iter()
            .rev()
            .find(|c| self.can_restore_tab_into(c, target.as_deref()))
            .map(|c| c.id.clone());
        if let Some(id) = entry {
            self.restore_closed(&id, target.as_deref());
        }
    }

    pub fn reopen_closed_window(&mut self) {
        if let Some(id) = self.closed_windows.last().map(|c| c.id.clone()) {
            self.restore_closed(&id, None);
        }
    }

    /// Brings back a closed tab, window or group by its entry's id.
    pub fn restore_closed(&mut self, entry_id: &str, window_id: Option<&str>) {
        let little = window_id
            .and_then(|w| self.windows.get(w))
            .is_some_and(BrowserWindow::is_small);
        let window_id = if little {
            self.main_window_for(None)
        } else {
            window_id.map(str::to_owned)
        };
        if let Some(entry) = self.closed_tabs.iter().find(|c| c.id == entry_id).cloned() {
            return self.restore_tab(entry, window_id.as_deref());
        }
        if let Some(entry) = self
            .closed_windows
            .iter()
            .find(|c| c.id == entry_id)
            .cloned()
        {
            return self.restore_window(entry);
        }
        let group = self
            .closed_groups
            .iter()
            .chain(&self.deleted_groups)
            .find(|c| c.id == entry_id)
            .cloned();
        if let Some(entry) = group {
            self.restoring_group(entry, window_id.as_deref());
        }
    }

    fn restore_tab(&mut self, entry: ClosedTab, requested: Option<&str>) {
        self.closed_tabs.retain(|c| c.id != entry.id);
        let adopt = entry
            .tab_id
            .as_ref()
            .filter(|_| !entry.tab.url.is_empty())
            .map(|id| restore_id(id));
        if entry.small == Some(true) && !is_incognito_space(&entry.tab.space_id) {
            let id = self.new_id("w");
            let space_id = if self.spaces.contains_key(&entry.tab.space_id) {
                entry.tab.space_id.clone()
            } else {
                self.little_bay_space()
            };
            self.with_window(self.small_window(&id, &space_id));
            let snapshot = TabSnapshot {
                pinned: false,
                space_id: space_id.clone(),
                ..entry.tab.clone()
            };
            self.with_new_tab(
                &id,
                &NewTab {
                    url: (!entry.tab.url.is_empty()).then(|| entry.tab.url.clone()),
                    space_id: Some(space_id),
                    snapshot: Some(snapshot),
                    adopt_id: adopt,
                    ..Default::default()
                },
            );
            return;
        }
        // A pinned tab closed (unloaded) comes back where it is, with its page.
        if let Some(tile_id) = entry
            .tab_id
            .as_ref()
            .filter(|id| entry.pinned_tile == Some(true) && self.tabs.contains_key(*id))
        {
            let tile_id = tile_id.clone();
            if let Some(tile) = self
                .tabs
                .get_mut(&tile_id)
                .filter(|t| t.navigation.is_none() && t.adopt_id.is_none())
            {
                tile.url.clone_from(&entry.tab.url);
                tile.title.clone_from(&entry.tab.title);
                tile.favicon.clone_from(&entry.tab.favicon);
                tile.muted = entry.tab.muted;
                tile.adopt_id = Some(restore_id(&tile_id));
            }
            let window = self.resolve_window_id(requested);
            return self.activate_in(&tile_id, window.as_deref());
        }
        let original = self
            .windows
            .get(&entry.window_id)
            .map(|w| w.id.clone())
            .filter(|w| self.can_restore_tab_into(&entry, Some(w)));
        let mut window_id = original.or_else(|| self.resolve_window_id(requested));
        if !window_id
            .as_deref()
            .is_some_and(|w| self.can_restore_tab_into(&entry, Some(w)))
        {
            if is_incognito_space(&entry.tab.space_id) {
                return;
            }
            let id = self.new_id("w");
            let space = if self.spaces.contains_key(&entry.tab.space_id) {
                entry.tab.space_id.clone()
            } else {
                self.settings.default_space_id().to_owned()
            };
            self.with_window(self.empty_window(&id, &space, false, None));
            window_id = Some(id);
        }
        let Some(window_id) = window_id else {
            return;
        };
        let w = &self.windows[&window_id];
        let space_id = if is_incognito_space(&entry.tab.space_id)
            || self.spaces.contains_key(&entry.tab.space_id)
        {
            entry.tab.space_id.clone()
        } else {
            w.space_id.clone()
        };
        // Where it was in its list, if it's back in it.
        let index = (space_id == entry.tab.space_id).then_some(entry.index.0.max(0.0) as usize);
        let Some(tab_id) = self.with_new_tab(
            &window_id,
            &NewTab {
                url: (!entry.tab.url.is_empty()).then(|| entry.tab.url.clone()),
                space_id: Some(space_id.clone()),
                snapshot: Some(entry.tab.clone()),
                index,
                adopt_id: adopt,
                ..Default::default()
            },
        ) else {
            return;
        };
        let Some(g) = entry.group else {
            return;
        };
        match self.groups.get_mut(&g.id) {
            Some(existing) if existing.space_id == space_id => {
                existing.tab_ids.push(tab_id.clone())
            }
            Some(_) => {}
            None => {
                let group = TabGroup {
                    id: g.id.clone(),
                    space_id: space_id.clone(),
                    name: g.name.clone(),
                    icon: g.icon.clone(),
                    color: g.color.clone(),
                    collapsed: false,
                    pinned: false,
                    tab_ids: Vec::new(),
                    created_at: JsNumber(self.now()),
                    auto_ungroup: None,
                    pinned_opener_id: None,
                    extra: g.extra.clone(),
                };
                self.restore_group(group, vec![tab_id.clone()]);
            }
        }
        let key = self.tab_list_key(&self.tabs[&tab_id]);
        let list = TabList {
            tab_ids: self.list_ids(&key).to_vec(),
            key,
        };
        sync_group_order(&mut self.groups, &list);
    }

    /// A closed window comes back where it was, on its space. One a launch closed (settings.restoreSession) brings
    /// its tabs.
    fn restore_window(&mut self, entry: ClosedWindow) {
        let id = self.new_id("w");
        let space_ok = |b: &Self, p: &str| {
            if b.spaces.contains_key(p) {
                p.to_owned()
            } else {
                b.settings.default_space_id().to_owned()
            }
        };
        let space = space_ok(self, &entry.window.space_id);
        let mut w = self.empty_window(&id, &space, false, entry.window.frame);
        w.size = entry.window.size;
        w.maximized = entry.window.maximized;
        w.sidebar_open = entry.window.sidebar_open;
        // What it showed, as it showed it, while it's still the space's and no other window shows it.
        if let Some(shown) = entry
            .window
            .shown_tab_id
            .as_ref()
            .filter(|t| self.tabs.contains_key(*t))
        {
            w.active_tab_ids.insert(w.space_id.clone(), shown.clone());
        }
        let mut added: IndexMap<String, Vec<String>> = IndexMap::new();
        let mut ids = Vec::new();
        for closed in &entry.tabs {
            let space = space_ok(self, &closed.tab.space_id);
            let snapshot = TabSnapshot {
                space_id: space.clone(),
                ..closed.tab.clone()
            };
            let mut t = self.make_tab(&id, &space, "", Some(&snapshot), snapshot.pinned);
            if let Some(tab_id) = closed
                .tab_id
                .as_ref()
                .filter(|_| !closed.tab.url.is_empty())
            {
                t.wake_adopt_id = Some(restore_id(tab_id));
            }
            if closed.active || !w.active_tab_ids.contains_key(&t.space_id) {
                w.active_tab_ids.insert(t.space_id.clone(), t.id.clone());
            }
            added
                .entry(self.space_list_key(&t.space_id))
                .or_default()
                .push(t.id.clone());
            ids.push(t.id.clone());
            self.live.insert(t.id.clone(), TabLive::default());
            self.tabs.insert(t.id.clone(), t);
        }
        self.closed_windows.retain(|c| c.id != entry.id);
        self.with_window(w);
        for (key, list) in added {
            let mut tab_ids = self.list_ids(&key).to_vec();
            tab_ids.extend(list);
            let tab_ids = pinned_first(&tab_ids, &self.tabs);
            self.set_list(TabList { key, tab_ids });
        }
        for g in &entry.groups {
            let members: Vec<String> = g
                .tab_indexes
                .iter()
                .filter_map(|i| ids.get(i.0 as usize).cloned())
                .collect();
            if members.is_empty() {
                continue;
            }
            let group = TabGroup {
                id: g.id.clone(),
                space_id: g.space_id.clone(),
                name: g.name.clone(),
                icon: g.icon.clone(),
                color: g.color.clone(),
                collapsed: g.collapsed,
                pinned: g.pinned,
                tab_ids: Vec::new(),
                created_at: g.created_at,
                auto_ungroup: g.auto_ungroup,
                pinned_opener_id: g.pinned_opener_id.clone(),
                extra: g.extra.clone(),
            };
            self.restore_group(group, members);
        }
        // Its space's tabs are there already: it shows the most recent one no other window shows, else a new tab.
        match self.tab_to_show(&id, &space) {
            Some(shown) => self.activate_in(&shown, Some(&id)),
            None => {
                self.with_new_tab(&id, &NewTab::default());
            }
        }
    }

    /// Where a closed group comes back: its window, else the one asked for, else the frontmost one not private.
    pub(crate) fn restore_target(&self, original: &str, requested: Option<&str>) -> Option<String> {
        let ok = |id: &str| self.windows.get(id).is_some_and(|w| !w.incognito);
        if ok(original) {
            return Some(original.to_owned());
        }
        if let Some(r) = requested.filter(|r| ok(r)) {
            return Some(r.to_owned());
        }
        self.ui
            .focus_order
            .iter()
            .chain(&self.window_order)
            .find(|id| ok(id))
            .cloned()
    }

    fn restoring_group(&mut self, entry: ClosedGroup, requested: Option<&str>) {
        let Some(window_id) = self.restore_target(&entry.window_id, requested) else {
            return;
        };
        self.closed_groups.retain(|c| c.id != entry.id);
        self.deleted_groups.retain(|c| c.id != entry.id);
        let index = (window_id == entry.window_id).then_some(entry.index.0.max(0.0) as usize);
        let entries = entry
            .tabs
            .iter()
            .enumerate()
            .map(|(i, tab)| {
                (
                    TabSnapshot {
                        pinned: false,
                        ..tab.clone()
                    },
                    index.map(|at| at + i),
                )
            })
            .collect();
        let ids = self.restore_snapshots(&window_id, entries);
        let group = self.with_group(
            &ids,
            GroupOptions {
                name: Some(entry.group.name.clone()),
                pinned: entry.group.pinned,
                ..Default::default()
            },
        );
        if let Some(g) = group.and_then(|g| self.groups.get_mut(&g)) {
            g.icon.clone_from(&entry.group.icon);
            g.color.clone_from(&entry.group.color);
        }
        if let Some(first) = ids.first().cloned() {
            self.activate_in(&first, None);
        }
    }
}
