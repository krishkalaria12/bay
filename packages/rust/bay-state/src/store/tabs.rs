//! Opening, showing, closing and moving tabs (store/tabs.ts).

use std::collections::HashSet;

use super::groups::{leave_groups, order_sections, sync_group_order};
use super::model::{TabList, is_incognito_space, most_recent, pinned_first, snapshot_tab, wake};
use super::names::host_of;
use super::splits::remove_from_splits;
use super::{Browser, MAX_CLOSED_TABS, Panel, TabLive, keep_last};
use crate::model::{BrowserWindow, ClosedTab, GroupRef, Tab, TabSnapshot};
use crate::number::JsNumber;

/// How `new_tab` opens a tab.
#[derive(Clone, Debug, Default)]
pub struct NewTab {
    /// Typed text or an address; resolved with the settings' search engine.
    pub url: Option<String>,
    /// Opened behind: the window keeps showing its tab.
    pub background: bool,
    /// A page the engine already made, to adopt instead of loading `url`.
    pub adopt_id: Option<String>,
    pub opener_id: Option<String>,
    pub space_id: Option<String>,
    pub pinned: Option<bool>,
    pub snapshot: Option<TabSnapshot>,
    pub index: Option<usize>,
    /// Loads only when first shown, adopting this (a restored tab: "restore:<id>").
    pub wake_adopt_id: Option<String>,
}

/// A window's next tab for each space whose shown one goes; none when the space has no tab left there.
type Successors = Vec<(String, Option<String>)>;

impl Browser {
    /// Whether the window can show the tab: a main window any tab of a space (it switches to it), a private window
    /// its own, a Little Bay its page.
    fn can_show(&self, w: &BrowserWindow, tab: &Tab) -> bool {
        if w.is_small()
            || self
                .windows
                .get(&tab.window_id)
                .is_some_and(BrowserWindow::is_small)
        {
            return tab.window_id == w.id;
        }
        if w.incognito || is_incognito_space(&tab.space_id) {
            return tab.space_id == w.space_id;
        }
        true
    }

    /// The window a tab opens in: the one asked for, else the frontmost one on its list (the focused one first),
    /// else the focused one, else the one with its page, else any.
    pub fn window_for(&self, tab: &Tab, requested: Option<&str>) -> Option<String> {
        if let Some(asked) = requested.and_then(|id| self.windows.get(id))
            && self.can_show(asked, tab)
        {
            return Some(asked.id.clone());
        }
        let key = self.tab_list_key(tab);
        let mut seen: HashSet<&String> = HashSet::new();
        let order: Vec<&BrowserWindow> = self
            .ui
            .focus_order
            .iter()
            .chain(std::iter::once(&tab.window_id))
            .chain(&self.window_order)
            .filter(|id| seen.insert(id))
            .filter_map(|id| self.windows.get(id))
            .filter(|w| self.can_show(w, tab))
            .collect();
        let on_list = |w: &&&BrowserWindow| self.window_list_key(w) == key;
        let focused = self.ui.focused_window_id.as_ref();
        order
            .iter()
            .find(|w| on_list(w) && Some(&w.id) == focused)
            .or_else(|| order.iter().find(on_list))
            .or(order.first())
            .map(|w| w.id.clone())
    }

    /// Shows the tab in a window (`window_id`, else `window_for`'s): its page moves there, as Arc's, from a window that
    /// showed it. A tab that hasn't loaded loads.
    pub(crate) fn activate_in(&mut self, id: &str, window_id: Option<&str>) {
        let Some(tab) = self.tabs.get(id) else {
            return;
        };
        let Some(wid) = self.window_for(tab, window_id) else {
            return;
        };
        let now = JsNumber(self.now());
        let mut next = tab.clone();
        let lazy = !next.url.is_empty() && next.navigation.is_none() && next.adopt_id.is_none();
        next.unloaded = None;
        next.window_id.clone_from(&wid);
        next.last_active_at = now;
        if lazy {
            wake(self, &mut next);
        }
        let space_id = next.space_id.clone();
        self.tabs.insert(id.to_owned(), next);
        if let Some(w) = self.windows.get_mut(&wid) {
            if !w.incognito {
                w.space_id.clone_from(&space_id);
            }
            w.active_tab_ids.insert(space_id, id.to_owned());
        }
        if let Some(ui) = self.window_ui.get_mut(&wid).filter(|ui| ui.panel.open) {
            ui.panel = Panel::default();
        }
    }

    /// The new tab's id, or None when the window is gone.
    pub(crate) fn with_new_tab(&mut self, window_id: &str, o: &NewTab) -> Option<String> {
        let w = self.windows.get(window_id)?.clone();
        let space_id = match &o.space_id {
            _ if w.incognito => w.space_id.clone(),
            Some(space) if self.spaces.contains_key(space) => space.clone(),
            _ => w.space_id.clone(),
        };
        let key = if w.is_small() {
            w.id.clone()
        } else {
            self.space_list_key(&space_id)
        };
        // A link opened in front starts a new task: Chrome forgets the list's other openers.
        if o.opener_id.is_some() && !o.background {
            self.forget_openers(&key, None);
        }
        let url = o
            .url
            .as_deref()
            .map_or_else(String::new, |raw| self.resolve_input(raw));
        let pinned = o
            .pinned
            .or(o.snapshot.as_ref().map(|s| s.pinned))
            .unwrap_or(false);
        let mut tab = self.make_tab(window_id, &space_id, &url, o.snapshot.as_ref(), pinned);
        if tab.navigation.is_some() && o.snapshot.is_none() {
            tab.navigation = Some(self.navigation_to(&url, true));
        }
        tab.opener_id.clone_from(&o.opener_id);
        tab.pinned_url = if tab.pinned_page() {
            tab.pinned_url
                .take()
                .filter(|u| !u.is_empty())
                .or_else(|| (!url.is_empty()).then(|| url.clone()))
        } else {
            None
        };
        if let Some(adopt) = &o.adopt_id {
            // The adopted page is already loading `url`; reloading drops POST data and opener state.
            tab.adopt_id = Some(adopt.clone());
            tab.navigation = None;
        } else if let Some(wake) = &o.wake_adopt_id {
            tab.wake_adopt_id = Some(wake.clone());
            tab.navigation = None;
        }
        let id = tab.id.clone();
        let mut list = TabList {
            key: key.clone(),
            tab_ids: self.list_ids(&key).to_vec(),
        };
        let at = o.index.unwrap_or_else(|| {
            if tab.pinned {
                list.tab_ids
                    .iter()
                    .rposition(|t| self.tabs.get(t).is_some_and(|t| t.pinned))
                    .map_or(0, |i| i + 1)
            } else {
                self.insertion_index(&list, &tab, o.background)
            }
        });
        list.tab_ids.insert(at.min(list.tab_ids.len()), id.clone());
        self.tabs.insert(id.clone(), tab);
        self.live.insert(id.clone(), TabLive::default());
        if let Some(w) = self.windows.get_mut(window_id) {
            w.active_tab_ids
                .entry(space_id)
                .or_insert_with(|| id.clone());
        }
        list.tab_ids = pinned_first(&list.tab_ids, &self.tabs);
        self.set_list(list);
        if !o.background {
            self.activate_in(&id, Some(window_id));
        }
        Some(id)
    }

    /// The window's shown tab for each space, with each of `gone` replaced by the tab it shows next: one its opener
    /// opened, else the next one (awake first), else the one before.
    fn successors(
        &self,
        w: &BrowserWindow,
        gone: &HashSet<String>,
    ) -> Vec<(String, Option<String>)> {
        w.active_tab_ids
            .iter()
            .filter(|(_, active)| gone.contains(*active))
            .map(|(space_id, active)| {
                let before = self.view_tab_ids(&w.id, Some(space_id));
                let left: Vec<String> = before
                    .iter()
                    .filter(|id| !gone.contains(*id))
                    .cloned()
                    .collect();
                let awake: Vec<&String> = left
                    .iter()
                    .filter(|id| !self.tabs[*id].is_unloaded())
                    .collect();
                let after: Vec<&String> = if awake.is_empty() {
                    left.iter().collect()
                } else {
                    awake
                };
                let index = before.iter().position(|id| id == active);
                let position = |id: &String| before.iter().position(|b| b == id);
                let next = self
                    .opener_successor(active, &before, &left)
                    .or_else(|| {
                        after
                            .iter()
                            .find(|id| position(id) > index)
                            .map(|id| (*id).clone())
                    })
                    .or_else(|| after.last().map(|id| (*id).clone()));
                (space_id.clone(), next)
            })
            .collect()
    }

    fn set_successors(&mut self, window_id: &str, picks: Successors) {
        let Some(w) = self.windows.get_mut(window_id) else {
            return;
        };
        for (space_id, next) in picks {
            match next {
                Some(id) => {
                    w.active_tab_ids.insert(space_id, id);
                }
                None => {
                    w.active_tab_ids.shift_remove(&space_id);
                }
            }
        }
    }

    /// The tabs go from their lists; `record` keeps them in Recently Closed. A private window and a Little Bay with
    /// nothing left go.
    pub(crate) fn remove_tabs(&mut self, ids: &[String], record: bool) {
        let gone: HashSet<String> = ids
            .iter()
            .filter(|id| self.tabs.contains_key(*id))
            .cloned()
            .collect();
        if gone.is_empty() {
            return;
        }
        let now = JsNumber(self.now());
        let mut closed: Vec<ClosedTab> = Vec::new();
        let keys: Vec<String> = self.tab_lists.keys().cloned().collect();
        let mut lists: Vec<TabList> = Vec::new();
        for key in keys {
            let list = &self.tab_lists[&key];
            if !list.iter().any(|id| gone.contains(id)) {
                continue;
            }
            if record {
                for (index, id) in list.iter().enumerate() {
                    let t = &self.tabs[id];
                    if !gone.contains(id) || (t.url.is_empty() && !t.pinned) {
                        continue;
                    }
                    let group = self.group_of(id).map(|g| GroupRef {
                        id: g.id.clone(),
                        name: g.name.clone(),
                        icon: g.icon.clone(),
                        color: g.color.clone(),
                        extra: Default::default(),
                    });
                    closed.push(ClosedTab {
                        kind: "tab".to_owned(),
                        id: self.new_id("ct"),
                        tab: snapshot_tab(t),
                        tab_id: Some(id.clone()),
                        window_id: t.window_id.clone(),
                        index: JsNumber(index as f64),
                        group,
                        closed_at: now,
                        pinned_tile: None,
                        small: self
                            .windows
                            .get(&key)
                            .is_some_and(BrowserWindow::is_small)
                            .then_some(true),
                        extra: Default::default(),
                    });
                }
            }
            lists.push(TabList {
                tab_ids: list
                    .iter()
                    .filter(|id| !gone.contains(*id))
                    .cloned()
                    .collect(),
                key,
            });
        }
        // Read before anything changes: the windows' next tabs, and the openers of the tabs that go.
        let successors: Vec<(String, Successors)> = self
            .windows
            .values()
            .filter(|w| w.active_tab_ids.values().any(|id| gone.contains(id)))
            .map(|w| (w.id.clone(), self.successors(w, &gone)))
            .collect();
        let openers: std::collections::HashMap<String, Option<String>> = gone
            .iter()
            .map(|id| (id.clone(), self.tabs[id].opener_id.clone()))
            .collect();
        for list in lists {
            self.set_list(list);
        }
        let removed: Vec<String> = self
            .windows
            .values()
            .filter(|w| {
                (w.incognito || w.is_small())
                    && !self.tab_lists.contains_key(&self.window_list_key(w))
            })
            .map(|w| w.id.clone())
            .collect();
        for id in &removed {
            self.windows.shift_remove(id);
            self.window_ui.remove(id);
        }
        self.window_order.retain(|id| !removed.contains(id));
        let changed: Vec<String> = successors.iter().map(|(id, _)| id.clone()).collect();
        for (window_id, picks) in successors {
            self.set_successors(&window_id, picks);
        }
        for id in &gone {
            self.tabs.shift_remove(id);
            self.live.remove(id);
        }
        // A closed tab's tabs take its opener (TabStripModel::FixOpeners).
        for t in self.tabs.values_mut() {
            let mut opener = t.opener_id.clone();
            // Bounded: closed tabs that opened each other would otherwise go round for ever.
            for _ in 0..=gone.len() {
                let Some(o) = opener.as_ref().filter(|o| gone.contains(*o)) else {
                    break;
                };
                opener = openers.get(o).cloned().flatten();
            }
            if opener != t.opener_id {
                t.opener_id = opener.filter(|o| *o != t.id);
            }
        }
        leave_groups(&mut self.groups, &gone);
        remove_from_splits(&mut self.splits, &gone);
        for selected in self.selection.values_mut() {
            selected.retain(|id| !gone.contains(id));
        }
        if !closed.is_empty() {
            self.closed_tabs.extend(closed);
            keep_last(&mut self.closed_tabs, MAX_CLOSED_TABS);
        }
        // A tab a window now shows that hasn't loaded loads; it's that window's.
        for window_id in changed {
            let Some(w) = self.windows.get(&window_id) else {
                continue;
            };
            let Some(id) = w.active_tab_ids.get(&w.space_id).cloned() else {
                continue;
            };
            if self.tabs.get(&id).is_some_and(|t| {
                !t.url.is_empty() && t.navigation.is_none() && t.adopt_id.is_none()
            }) {
                self.activate_in(&id, Some(&window_id));
            }
        }
    }

    /// Closing a pinned page unloads it, back at the page it was pinned at; a pinned split unloads whole.
    fn unload_pinned_tabs(&mut self, ids: &[String]) {
        // A pinned split stays a split, less any pane that never had a page.
        let mut whole: Vec<String> = Vec::new();
        for id in ids {
            for pane in self
                .pinned_split_of(id)
                .map(|v| v.tab_ids.clone())
                .unwrap_or_default()
            {
                if !whole.contains(&pane) {
                    whole.push(pane);
                }
            }
        }
        let blank: Vec<String> = whole
            .iter()
            .filter(|id| self.tabs[*id].url.is_empty())
            .cloned()
            .collect();
        if !blank.is_empty() {
            self.remove_tabs(&blank, false);
        }
        let mut closing: Vec<String> = ids.to_vec();
        for id in whole {
            if !closing.contains(&id) {
                closing.push(id);
            }
        }
        let pinned: Vec<String> = closing
            .iter()
            .filter(|id| self.in_pinned_container(id))
            .cloned()
            .collect();
        if pinned.is_empty() {
            return;
        }
        let gone: HashSet<String> = pinned.iter().cloned().collect();
        let closing: HashSet<String> = closing.into_iter().collect();
        let now = JsNumber(self.now());
        // Read before anything changes: each window's replacement for the pinned tabs it showed.
        let replacements: Vec<(String, String, Option<String>)> = self
            .windows
            .values()
            .flat_map(|w| {
                w.active_tab_ids
                    .iter()
                    .filter(|(_, active)| gone.contains(*active))
                    .map(|(space, active)| {
                        let pick = self
                            .last_regular_tab(w, active, &closing)
                            .or_else(|| self.last_live_pinned_tab(w, active, &closing));
                        (w.id.clone(), space.clone(), pick)
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        let alone: HashSet<String> = pinned
            .iter()
            .filter(|id| self.pinned_split_of(id).is_none())
            .cloned()
            .collect();
        for id in &pinned {
            let t = self.tabs[id].clone();
            if t.is_loaded() {
                let index = self
                    .list_ids(&self.tab_list_key(&t))
                    .iter()
                    .position(|x| x == id)
                    .unwrap_or(0);
                let entry = ClosedTab {
                    kind: "tab".to_owned(),
                    id: self.new_id("ct"),
                    tab: snapshot_tab(&t),
                    tab_id: Some(id.clone()),
                    window_id: t.window_id.clone(),
                    index: JsNumber(index as f64),
                    group: None,
                    closed_at: now,
                    pinned_tile: Some(true),
                    small: None,
                    extra: Default::default(),
                };
                self.closed_tabs.push(entry);
            }
            let mut next = self.back_to_pin(t);
            next.navigation = None;
            next.adopt_id = None;
            next.wake_adopt_id = None;
            next.unloaded = Some(true);
            self.tabs.insert(id.clone(), next);
            self.live.insert(id.clone(), TabLive::default());
        }
        remove_from_splits(&mut self.splits, &alone);
        for selected in self.selection.values_mut() {
            selected.retain(|id| !gone.contains(id));
        }
        keep_last(&mut self.closed_tabs, MAX_CLOSED_TABS);
        for (window_id, space_id, pick) in replacements {
            let shown = self
                .windows
                .get(&window_id)
                .is_some_and(|w| w.space_id == space_id);
            let pick = pick.or_else(|| {
                self.with_new_tab(
                    &window_id,
                    &NewTab {
                        space_id: Some(space_id.clone()),
                        background: !shown,
                        ..Default::default()
                    },
                )
            });
            let Some(pick) = pick else {
                continue;
            };
            if shown {
                self.activate_in(&pick, Some(&window_id));
            } else if let Some(w) = self.windows.get_mut(&window_id) {
                w.active_tab_ids.insert(space_id, pick);
            }
        }
    }

    /// A pinned page back at the address it was pinned at.
    fn back_to_pin(&self, mut t: Tab) -> Tab {
        let Some(home) = t.pinned_url.clone() else {
            return t;
        };
        if t.url.is_empty() || same_page(&t.url, &home) {
            return t;
        }
        self.on_url_change(&mut t, &home);
        t.url = home;
        t
    }

    fn last_regular_tab(
        &self,
        w: &BrowserWindow,
        id: &str,
        closing: &HashSet<String>,
    ) -> Option<String> {
        let space_id = &self.tabs[id].space_id;
        let candidates: Vec<String> = self
            .view_tab_ids(&w.id, Some(space_id))
            .into_iter()
            .filter(|t| !closing.contains(t) && !self.in_pinned_container(t))
            .collect();
        let panes: Vec<&String> = self
            .split_of(id)
            .map(|v| {
                v.tab_ids
                    .iter()
                    .filter(|t| candidates.contains(t))
                    .collect()
            })
            .unwrap_or_default();
        if panes.is_empty() {
            most_recent(&self.tabs, &candidates)
        } else {
            most_recent(&self.tabs, panes)
        }
    }

    fn last_live_pinned_tab(
        &self,
        w: &BrowserWindow,
        id: &str,
        closing: &HashSet<String>,
    ) -> Option<String> {
        let space_id = &self.tabs[id].space_id;
        let live: Vec<String> = self
            .view_tab_ids(&w.id, Some(space_id))
            .into_iter()
            .filter(|t| {
                let tab = &self.tabs[t];
                !closing.contains(t)
                    && self.in_pinned_container(t)
                    && (tab.navigation.is_some() || tab.adopt_id.is_some())
            })
            .collect();
        most_recent(&self.tabs, &live)
    }

    /// What an address change brings: a muted site's mute, and a pinned page's first address.
    pub(crate) fn on_url_change(&self, tab: &mut Tab, url: &str) {
        let before = host_of(&tab.url);
        let after = host_of(url);
        if before != after {
            if self.settings.site_muted(&after) {
                tab.muted = true;
            } else if self.settings.site_muted(&before) {
                tab.muted = false;
            }
        }
        if tab.pinned_page() && tab.pinned_url.is_none() && !url.is_empty() {
            tab.pinned_url = Some(url.to_owned());
        }
    }

    // MARK: Commands

    /// Opens a tab in the window; its id, or None when nothing opened.
    pub fn new_tab(&mut self, window_id: &str, options: NewTab) -> Option<String> {
        if let Some(small) = self.windows.get(window_id).filter(|w| w.is_small())
            && !self.list_ids(&small.id).is_empty()
        {
            // Little Bay keeps its one page; new tabs go to a main window of that space.
            let space_id = options
                .space_id
                .clone()
                .unwrap_or_else(|| small.space_id.clone());
            let Some(main) = self.main_window_for(Some(&space_id)) else {
                let created = self.create_window(super::CreateWindow {
                    space_id: Some(space_id),
                    url: options.url,
                    adopt_id: options.adopt_id.or(options.wake_adopt_id),
                    background: options.background,
                    ..Default::default()
                });
                return self.active_tab_id(&created, None);
            };
            // The Little Bay page stays the opener, so the tabs it sends keep their order.
            return self.new_tab(
                &main,
                NewTab {
                    space_id: Some(space_id),
                    index: None,
                    ..options
                },
            );
        }
        let id = self.with_new_tab(window_id, &options)?;
        if let Some(opener) = &options.opener_id {
            self.group_with_opener(&id, opener, options.background);
        }
        Some(id)
    }

    pub fn close_tab(&mut self, id: &str) {
        let Some(tab) = self.tabs.get(id) else {
            return;
        };
        if self.in_pinned_container(id) {
            return self.unload_pinned_tabs(&[id.to_owned()]);
        }
        // Its window's last open tab: the tab closes, then the window (its space keeps its other tabs).
        let last = self.closes_window(id).then(|| tab.window_id.clone());
        self.remove_tabs(&[id.to_owned()], true);
        if let Some(last) = last.filter(|w| self.windows.contains_key(w)) {
            self.close_window(&last);
        }
    }

    pub fn close_tabs(&mut self, ids: &[String]) {
        self.unload_pinned_tabs(ids);
        let closing: Vec<String> = ids
            .iter()
            .filter(|id| !self.in_pinned_container(id))
            .cloned()
            .collect();
        let windows: Vec<String> = self.windows.keys().cloned().collect();
        for w in windows {
            let view = self.view_tab_ids(&w, None);
            if view.iter().any(|id| closing.contains(id))
                && view
                    .iter()
                    .all(|id| closing.contains(id) || self.tabs[id].is_unloaded())
            {
                self.with_new_tab(&w, &NewTab::default());
            }
        }
        self.remove_tabs(&closing, true);
    }

    /// Removes the tab from its list even when it's pinned; Reopen Closed Tab brings it back.
    pub fn remove_tab(&mut self, id: &str) {
        self.remove_tabs(&[id.to_owned()], true);
    }

    /// Shows the tab: in `window_id`, else the window `window_for` picks.
    pub fn activate(&mut self, id: &str, window_id: Option<&str>) {
        let Some(tab) = self.tabs.get(id) else {
            return;
        };
        let Some(w) = self.window_for(tab, window_id) else {
            return;
        };
        let shown = self.active_tab_id(&w, None);
        let forget = shown
            .as_deref()
            .is_some_and(|s| s != id && !self.switch_keeps_openers(s, id));
        self.activate_in(id, Some(&w));
        if forget {
            let key = self.tab_list_key(&self.tabs[id]);
            self.forget_openers(&key, None);
        }
    }

    /// Shows the window's tab at `index`; a negative one counts from the end (⌘9: the last).
    pub fn activate_index(&mut self, window_id: &str, index: isize) {
        let view = self.view_tab_ids(window_id, None);
        let id = if index < 0 {
            view.last()
        } else {
            view.get(index.unsigned_abs())
        };
        if let Some(id) = id.cloned() {
            self.activate(&id, Some(window_id));
        }
    }

    /// Shows the next (1) or previous (-1) tab, round the list.
    pub fn cycle(&mut self, window_id: &str, delta: isize) {
        let view = self.view_tab_ids(window_id, None);
        if view.is_empty() {
            return;
        }
        let shown = self
            .windows
            .get(window_id)
            .and_then(|w| w.active_tab_ids.get(&w.space_id));
        let i = shown
            .and_then(|s| view.iter().position(|id| id == s))
            .map_or(-1, |i| i as isize);
        let n = view.len() as isize;
        let next = view[(i + delta + n).rem_euclid(n) as usize].clone();
        self.activate(&next, Some(window_id));
    }

    pub fn duplicate_tab(&mut self, id: &str) -> Option<String> {
        let source = self.tabs.get(id)?;
        let w = self.window_for(source, Some(&source.window_id))?;
        let mut snapshot = snapshot_tab(source);
        snapshot.pinned = false;
        snapshot.pinned_row = None;
        let index = self
            .list_ids(&self.tab_list_key(source))
            .iter()
            .position(|x| x == id)
            .map_or(0, |i| i + 1);
        let options = NewTab {
            url: (!source.url.is_empty()).then(|| source.url.clone()),
            space_id: Some(source.space_id.clone()),
            snapshot: Some(snapshot),
            index: Some(index),
            adopt_id: (!source.url.is_empty()).then(|| format!("clone:{id}")),
            ..Default::default()
        };
        self.with_new_tab(&w, &options)
    }

    pub fn toggle_pin(&mut self, id: &str) {
        if let Some(pinned) = self.tabs.get(id).map(|t| t.pinned) {
            self.pin_tabs(&[id.to_owned()], !pinned);
        }
    }

    /// Moves the tab within its section of its list (the Essentials, or everything else).
    pub fn move_tab(&mut self, id: &str, to_index: usize) {
        let (Some(tab), Some(list)) = (self.tabs.get(id), self.list_of_tab(id)) else {
            return;
        };
        let in_section = |t: &String| {
            self.tabs
                .get(t)
                .is_some_and(|x| x.space_id == tab.space_id && x.pinned == tab.pinned)
        };
        let mut moved: Vec<String> = list
            .tab_ids
            .iter()
            .filter(|t| in_section(t) && *t != id)
            .cloned()
            .collect();
        moved.insert(to_index.min(moved.len()), id.to_owned());
        let mut k = 0;
        let placed: Vec<String> = list
            .tab_ids
            .iter()
            .map(|t| {
                if in_section(t) {
                    k += 1;
                    moved[k - 1].clone()
                } else {
                    t.clone()
                }
            })
            .collect();
        // The pinned rows share a section with the list here (both aren't Essentials): neither crosses into the other.
        let next = TabList {
            tab_ids: order_sections(&placed, &self.tabs, &self.groups, &self.pinned_folders),
            key: list.key,
        };
        sync_group_order(&mut self.groups, &next);
        self.set_list(next);
    }
}

/// The same page, a fragment or a trailing slash aside.
pub(crate) fn same_page(a: &str, b: &str) -> bool {
    let norm = |u: &str| {
        let u = u.split('#').next().unwrap_or(u);
        u.strip_suffix('/').unwrap_or(u).to_owned()
    };
    norm(a) == norm(b)
}
