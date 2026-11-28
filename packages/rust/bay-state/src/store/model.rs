//! Reading the state: which list a tab is in, what a window shows, which tab it shows next (store/model.ts).

use indexmap::IndexMap;

use super::Browser;
use crate::model::{BrowserWindow, Tab, TabSnapshot};
use crate::number::JsNumber;

pub fn incognito_space_id(window_id: &str) -> String {
    format!("incognito:{window_id}")
}

pub fn is_incognito_space(space_id: &str) -> bool {
    space_id.starts_with("incognito:")
}

/// A list's key and its tabs, in order.
#[derive(Clone, Debug, PartialEq)]
pub struct TabList {
    pub key: String,
    pub tab_ids: Vec<String>,
}

/// What a closed tab keeps of its tab.
pub fn snapshot_tab(t: &Tab) -> TabSnapshot {
    TabSnapshot {
        url: t.url.clone(),
        title: t.title.clone(),
        favicon: t.favicon.clone(),
        pinned: t.pinned,
        muted: t.muted,
        zoom: t.zoom,
        custom_title: t.custom_title.clone(),
        custom_icon: t.custom_icon.clone(),
        space_id: t.space_id.clone(),
        pinned_url: Some(t.pinned_url.clone()),
        pinned_row: t.is_row().then_some(true),
        engine: t.engine.clone(),
        engine_pick: t.engine_pick.clone(),
        extra: Default::default(),
    }
}

/// A list's order keeps the Essentials first, then the pinned rows, then every other tab.
pub fn pinned_first(ids: &[String], tabs: &IndexMap<String, Tab>) -> Vec<String> {
    let rank = |id: &String| match tabs.get(id) {
        Some(t) if t.pinned => 0,
        Some(t) if t.is_row() => 1,
        _ => 2,
    };
    let mut out = ids.to_vec();
    out.sort_by_key(rank);
    out
}

/// Two id lists as one, each id once, in order.
pub(crate) fn unique_ids<'a>(first: &'a [String], then: &'a [String]) -> Vec<&'a String> {
    let mut out: Vec<&String> = Vec::new();
    for id in first.iter().chain(then) {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// The tab with the latest `lastActiveAt`; the first of those on a tie.
pub(crate) fn most_recent<'a>(
    tabs: &IndexMap<String, Tab>,
    ids: impl IntoIterator<Item = &'a String>,
) -> Option<String> {
    let mut best: Option<(&String, f64)> = None;
    for id in ids {
        let at = tabs[id].last_active_at.0;
        if best.is_none_or(|(_, top)| at > top) {
            best = Some((id, at));
        }
    }
    best.map(|(id, _)| id.clone())
}

impl Browser {
    /// Every window on a space lists that space's tabs.
    pub fn space_list_key(&self, space_id: &str) -> String {
        space_id.to_owned()
    }

    /// The list a window shows: its space's, or a Little Bay's own.
    pub fn window_list_key(&self, w: &BrowserWindow) -> String {
        if w.is_small() {
            w.id.clone()
        } else {
            self.space_list_key(&w.space_id)
        }
    }

    /// The list the tab is in.
    pub fn tab_list_key(&self, t: &Tab) -> String {
        if self
            .windows
            .get(&t.window_id)
            .is_some_and(BrowserWindow::is_small)
        {
            t.window_id.clone()
        } else {
            self.space_list_key(&t.space_id)
        }
    }

    pub fn list_ids(&self, key: &str) -> &[String] {
        self.tab_lists.get(key).map_or(&[], Vec::as_slice)
    }

    /// The list the tab is in, by key and ids.
    pub fn list_of_tab(&self, id: &str) -> Option<TabList> {
        let key = self.tab_list_key(self.tabs.get(id)?);
        let tab_ids = self.list_ids(&key).to_vec();
        Some(TabList { key, tab_ids })
    }

    /// The list's ids; an empty list goes.
    pub(crate) fn set_list(&mut self, list: TabList) {
        if list.tab_ids.is_empty() {
            self.tab_lists.shift_remove(&list.key);
        } else {
            self.tab_lists.insert(list.key, list.tab_ids);
        }
    }

    /// The tabs the window lists for a space (its shown one by default), in the list's order.
    pub fn view_tab_ids(&self, window_id: &str, space_id: Option<&str>) -> Vec<String> {
        let Some(w) = self.windows.get(window_id) else {
            return Vec::new();
        };
        let space = if w.is_small() {
            w.space_id.as_str()
        } else {
            space_id.unwrap_or(&w.space_id)
        };
        let key = if w.is_small() {
            w.id.clone()
        } else {
            self.space_list_key(space)
        };
        self.list_ids(&key)
            .iter()
            .filter(|id| self.tabs.get(*id).is_some_and(|t| t.space_id == space))
            .cloned()
            .collect()
    }

    /// A space's tabs, in their list's order.
    pub fn space_tab_ids(&self, space_id: &str) -> Vec<String> {
        self.list_ids(&self.space_list_key(space_id))
            .iter()
            .filter(|id| self.tabs.get(*id).is_some_and(|t| t.space_id == space_id))
            .cloned()
            .collect()
    }

    /// Whether another window shows the tab now.
    pub fn shown_elsewhere(&self, id: &str, window_id: &str) -> bool {
        self.windows.values().any(|w| {
            w.id != window_id && w.active_tab_ids.get(&w.space_id).map(String::as_str) == Some(id)
        })
    }

    /// The tab a window shows for a space it comes to: the one it showed there, else the space's most recent one,
    /// unless another window shows it now. None: the window takes a new tab.
    pub fn tab_to_show(&self, window_id: &str, space_id: &str) -> Option<String> {
        let view: Vec<String> = self
            .view_tab_ids(window_id, Some(space_id))
            .into_iter()
            .filter(|id| !self.shown_elsewhere(id, window_id))
            .collect();
        let remembered = self
            .windows
            .get(window_id)
            .and_then(|w| w.active_tab_ids.get(space_id));
        if let Some(id) = remembered.filter(|id| view.contains(id)) {
            return Some(id.clone());
        }
        most_recent(&self.tabs, &view)
    }

    /// A blank tab the window can show for a space, so launches don't pile up new tabs.
    pub fn blank_tab_to_show(&self, window_id: &str, space_id: &str) -> Option<String> {
        self.view_tab_ids(window_id, Some(space_id))
            .into_iter()
            .find(|id| {
                self.tabs[id].url.is_empty()
                    && !self.in_pinned_container(id)
                    && !self.shown_elsewhere(id, window_id)
            })
    }

    /// The tabs whose page is in the window, in their lists' order.
    pub fn window_tab_ids(&self, window_id: &str) -> Vec<String> {
        self.tab_lists
            .values()
            .flatten()
            .filter(|id| self.tabs.get(*id).is_some_and(|t| t.window_id == window_id))
            .cloned()
            .collect()
    }

    /// Spaces have separate native profiles, including their pinned tiles.
    pub fn shares_profile(&self, a: &str, b: &str) -> bool {
        a == b && self.spaces.contains_key(a)
    }

    /// A pinned page, or a tab of a pinned group.
    pub fn in_pinned_container(&self, id: &str) -> bool {
        let Some(tab) = self.tabs.get(id) else {
            return false;
        };
        tab.pinned_page()
            || self
                .groups
                .values()
                .any(|g| g.pinned && g.tab_ids.iter().any(|t| t == id))
    }

    /// Closing the tab closes its window: the last open tab of the space it shows.
    pub fn closes_window(&self, id: &str) -> bool {
        let Some(tab) = self.tabs.get(id) else {
            return false;
        };
        let Some(w) = self.windows.get(&tab.window_id) else {
            return false;
        };
        if tab.space_id != w.space_id || self.in_pinned_container(id) {
            return false;
        }
        self.view_tab_ids(&w.id, None)
            .iter()
            .all(|t| t == id || self.tabs[t].is_unloaded())
    }

    /// The tab the window shows for a space (its shown one by default).
    pub fn active_tab_id(&self, window_id: &str, space_id: Option<&str>) -> Option<String> {
        let w = self.windows.get(window_id)?;
        let space = space_id.unwrap_or(&w.space_id);
        let id = w.active_tab_ids.get(space)?;
        let t = self.tabs.get(id)?;
        let ok = if w.is_small() {
            t.window_id == window_id
        } else {
            !self
                .windows
                .get(&t.window_id)
                .is_some_and(BrowserWindow::is_small)
                && t.space_id == space
        };
        ok.then(|| id.clone())
    }

    /// The window named, else the most recently focused main window.
    pub fn resolve_window_id(&self, id: Option<&str>) -> Option<String> {
        if let Some(id) = id.filter(|id| self.windows.contains_key(*id)) {
            return Some(id.to_owned());
        }
        let main = |w: &&String| self.windows.get(*w).is_some_and(|w| !w.is_small());
        self.ui
            .focus_order
            .iter()
            .find(main)
            .or_else(|| self.window_order.iter().find(main))
            .cloned()
    }

    /// A new tab's record, as `makeTab` makes it: a snapshot's fields over the defaults.
    pub(crate) fn make_tab(
        &self,
        window_id: &str,
        space_id: &str,
        url: &str,
        snapshot: Option<&TabSnapshot>,
        pinned: bool,
    ) -> Tab {
        let now = JsNumber(self.now());
        let mut tab = Tab {
            id: self.new_id("tab"),
            window_id: window_id.to_owned(),
            space_id: space_id.to_owned(),
            url: url.to_owned(),
            title: String::new(),
            favicon: None,
            pinned,
            muted: false,
            zoom: JsNumber(1.0),
            custom_title: None,
            custom_icon: None,
            pinned_url: None,
            opener_id: None,
            created_at: now,
            last_active_at: now,
            pinned_row: None,
            folder_id: None,
            kept: None,
            live_item: None,
            peek_of: None,
            unloaded: None,
            engine: None,
            engine_pick: None,
            new_tab_history: None,
            navigation: None,
            adopt_id: None,
            wake_adopt_id: None,
            extra: Default::default(),
        };
        if let Some(s) = snapshot {
            tab.url.clone_from(&s.url);
            tab.title.clone_from(&s.title);
            tab.favicon.clone_from(&s.favicon);
            tab.muted = s.muted;
            tab.zoom = s.zoom;
            tab.custom_title.clone_from(&s.custom_title);
            tab.custom_icon.clone_from(&s.custom_icon);
            tab.space_id.clone_from(&s.space_id);
            if let Some(pinned_url) = &s.pinned_url {
                tab.pinned_url.clone_from(pinned_url);
            }
            tab.pinned_row = s.pinned_row;
            tab.engine.clone_from(&s.engine);
            tab.engine_pick.clone_from(&s.engine_pick);
        }
        if !url.is_empty() {
            tab.navigation = Some(self.navigation_to(url, false));
        }
        tab
    }
}

/// What loads a tab that hasn't yet: the page it's to adopt, else its address.
pub(crate) fn wake(browser: &Browser, t: &mut Tab) {
    if let Some(adopt) = t.wake_adopt_id.take() {
        t.adopt_id = Some(adopt);
    } else {
        t.navigation = Some(browser.navigation_to(&t.url, false));
    }
}
