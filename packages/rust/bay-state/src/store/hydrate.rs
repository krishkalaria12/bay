//! The saved session into the store and back (store/browserStore.ts `hydrate`, lib/persist.ts `sessionJson`).

use std::collections::HashSet;

use indexmap::IndexMap;
use serde_json::Value;

use super::groups::{kept_deleted_groups, place_folders};
use super::model::{is_incognito_space, pinned_first};
use super::splits::sanitize_splits;
use super::{Browser, DEFAULT_SPACE_ID, NewTab, Settings, TabLive, Ui};
use crate::model::{BrowserWindow, Space, SpaceTheme, Tab};
use crate::number::JsNumber;
use crate::session::{SESSION_VERSION, Session};

/// The space a first launch has: Personal, in Bay's own colours.
pub fn default_space() -> Space {
    Space {
        id: DEFAULT_SPACE_ID.to_owned(),
        name: "Personal".to_owned(),
        color: "purple".to_owned(),
        icon: Some("🏠".to_owned()),
        created_at: JsNumber(0.0),
        profile_id: None,
        shares_sign_ins: None,
        theme: Some(Some(SpaceTheme {
            colors: vec!["#3A6073".into(), "#733A43".into(), "#736A3A".into()],
            intensity: JsNumber(0.5),
            grain: JsNumber(0.3),
            extra: Default::default(),
        })),
        follow_site: None,
        clean_up_after_hours: None,
        folded: None,
        extra: Default::default(),
    }
}

/// The space's native profile folder: "" for the default one.
fn engine_id_of(space: &Space) -> &str {
    let id = space
        .profile_id
        .as_deref()
        .filter(|p| !p.is_empty())
        .unwrap_or(&space.id);
    if id == DEFAULT_SPACE_ID { "" } else { id }
}

/// A list key as `tabListKey` reads it from the saved windows (Little Bay's own list, else its space's).
fn saved_list_key(windows: &IndexMap<String, BrowserWindow>, t: &Tab) -> String {
    if windows
        .get(&t.window_id)
        .is_some_and(BrowserWindow::is_small)
    {
        t.window_id.clone()
    } else {
        t.space_id.clone()
    }
}

fn empty_session() -> Session {
    Session {
        version: SESSION_VERSION,
        spaces: IndexMap::new(),
        space_order: Vec::new(),
        orphaned_profile_data: Vec::new(),
        settings: Default::default(),
        windows: Vec::new(),
        window_order: Vec::new(),
        focused_window_id: None,
        tabs: Vec::new(),
        tab_lists: IndexMap::new(),
        groups: Vec::new(),
        pinned_folders: Vec::new(),
        local_files: Vec::new(),
        splits: Vec::new(),
        closed_tabs: Vec::new(),
        closed_windows: Vec::new(),
        closed_groups: Vec::new(),
        deleted_groups: Vec::new(),
        cleaned_tabs: Vec::new(),
        extra: Default::default(),
    }
}

impl Default for Session {
    fn default() -> Self {
        empty_session()
    }
}

impl Browser {
    /// The store from a saved session. `launch`: the app's launch, whose windows show what settings.launchTab says.
    pub fn hydrate(&mut self, data: Session, launch: bool) {
        let saved_spaces = if data.spaces.is_empty() {
            IndexMap::from([(DEFAULT_SPACE_ID.to_owned(), default_space())])
        } else {
            data.spaces
        };
        let mut space_order: Vec<String> = Vec::new();
        for id in data
            .space_order
            .iter()
            .filter(|id| saved_spaces.contains_key(*id))
            .chain(saved_spaces.keys())
        {
            if !space_order.contains(id) {
                space_order.push(id.clone());
            }
        }
        let spaces = saved_spaces;
        let mut settings = Settings(data.settings);
        if !spaces.contains_key(settings.default_space_id()) {
            settings.set("defaultSpaceId", space_order[0].clone());
        }

        let mut raw_windows: IndexMap<String, BrowserWindow> = data
            .windows
            .into_iter()
            .map(|w| (w.id.clone(), w))
            .collect();
        let space_ok = |p: &str| spaces.contains_key(p) || is_incognito_space(p);
        let mut tabs: IndexMap<String, Tab> = IndexMap::new();
        for mut t in data.tabs {
            let own = raw_windows.contains_key(&t.window_id);
            // A peek is thrown away with its window's session.
            if !space_ok(&t.space_id)
                || (is_incognito_space(&t.space_id) && !own)
                || t.peek_of.is_some()
            {
                continue;
            }
            // Its engine comes from its address again, so a page a website rule once moved isn't stuck there.
            t.engine = None;
            t.adopt_id = None;
            t.wake_adopt_id = None;
            t.navigation = None;
            if !own {
                t.window_id = String::new();
            }
            if t.pinned_url.is_none() && t.pinned_page() && !t.url.is_empty() {
                t.pinned_url = Some(t.url.clone());
            }
            tabs.insert(t.id.clone(), t);
        }

        // Each list: the saved one's order, then (an older session) each window's, then every other tab.
        let legacy: Vec<Vec<String>> = raw_windows
            .values_mut()
            .map(|w| match w.extra.shift_remove("tabIds") {
                Some(Value::Array(ids)) => ids
                    .into_iter()
                    .filter_map(|id| id.as_str().map(str::to_owned))
                    .collect(),
                _ => Vec::new(),
            })
            .collect();
        let mut lists: IndexMap<String, Vec<String>> = IndexMap::new();
        let order = data
            .tab_lists
            .values()
            .flatten()
            .chain(legacy.iter().flatten())
            .chain(tabs.keys())
            .cloned()
            .collect::<Vec<String>>();
        for id in order {
            let Some(t) = tabs.get(&id) else {
                continue;
            };
            let list = lists.entry(saved_list_key(&raw_windows, t)).or_default();
            if !list.contains(&id) {
                list.push(id);
            }
        }
        let saved_folders: IndexMap<String, crate::model::PinnedFolder> = data
            .pinned_folders
            .into_iter()
            .map(|f| (f.id.clone(), f))
            .collect();
        let tab_lists: IndexMap<String, Vec<String>> = lists
            .into_iter()
            .map(|(key, ids)| {
                (
                    key,
                    place_folders(&pinned_first(&ids, &tabs), &tabs, &saved_folders),
                )
            })
            .collect();

        let mut windows: IndexMap<String, BrowserWindow> = IndexMap::new();
        for (id, mut w) in raw_windows.clone() {
            let key = if w.is_small() {
                w.id.clone()
            } else {
                w.space_id.clone()
            };
            if (w.incognito || w.is_small()) && !tab_lists.contains_key(&key) {
                continue;
            }
            if !(w.incognito || w.is_small() || spaces.contains_key(&w.space_id)) {
                w.space_id = settings.default_space_id().to_owned();
            }
            let small = w.is_small();
            let wid = w.id.clone();
            w.active_tab_ids.retain(|space, tab| {
                tabs.get(tab).is_some_and(|t| {
                    if small {
                        t.window_id == wid
                    } else {
                        saved_list_key(&raw_windows, t) == *space
                    }
                })
            });
            windows.insert(id, w);
        }
        for t in tabs.values_mut() {
            if !t.window_id.is_empty() && !windows.contains_key(&t.window_id) {
                t.window_id = String::new();
            }
        }
        let mut window_order: Vec<String> = data
            .window_order
            .iter()
            .filter(|id| windows.contains_key(*id))
            .cloned()
            .collect();
        window_order.extend(
            windows
                .keys()
                .filter(|id| !data.window_order.contains(id))
                .cloned(),
        );

        let groups = data
            .groups
            .into_iter()
            .map(|mut g| {
                // Groups and pinned folders were once saved with the window they were in; they're their space's now.
                g.extra.shift_remove("windowId");
                g.tab_ids
                    .retain(|id| tabs.get(id).is_some_and(|t| t.space_id == g.space_id));
                g
            })
            .filter(|g| !g.tab_ids.is_empty())
            .map(|g| (g.id.clone(), g))
            .collect();
        let splits = sanitize_splits(
            &data.splits.into_iter().map(|v| (v.id.clone(), v)).collect(),
            &tabs,
        );
        let pinned_folders: IndexMap<String, crate::model::PinnedFolder> = saved_folders
            .into_iter()
            .filter(|(_, f)| spaces.contains_key(&f.space_id))
            .map(|(id, mut f)| {
                f.extra.shift_remove("windowId");
                (id, f)
            })
            .collect();
        // A row whose folder is gone, or another space's, leaves it.
        for t in tabs.values_mut() {
            let kept = t.folder_id.as_ref().is_some_and(|f| {
                t.pinned_row == Some(true)
                    && pinned_folders
                        .get(f)
                        .is_some_and(|x| x.space_id == t.space_id)
            });
            if !kept {
                t.folder_id = None;
            }
        }

        let focused = data
            .focused_window_id
            .filter(|f| windows.contains_key(f))
            .or_else(|| window_order.last().cloned());
        let engines: HashSet<&str> = spaces.values().map(engine_id_of).collect();
        let orphaned: Vec<String> = data
            .orphaned_profile_data
            .into_iter()
            .filter(|e| !engines.contains(e.as_str()))
            .collect();
        let focus_order = focused.as_ref().map_or_else(Vec::new, |f| {
            std::iter::once(f.clone())
                .chain(window_order.iter().filter(|id| *id != f).rev().cloned())
                .collect()
        });
        let mut deleted_groups = data.deleted_groups;
        kept_deleted_groups(&mut deleted_groups, self.now());

        self.live = tabs
            .keys()
            .map(|id| (id.clone(), TabLive::default()))
            .collect();
        self.spaces = spaces;
        self.space_order = space_order;
        self.orphaned_profile_data = orphaned;
        self.settings = settings;
        self.windows = windows;
        self.window_order = window_order;
        self.tabs = tabs;
        self.tab_lists = tab_lists;
        self.groups = groups;
        self.pinned_folders = pinned_folders;
        self.local_files = data.local_files;
        self.splits = splits;
        self.closed_tabs = data.closed_tabs;
        self.closed_windows = data.closed_windows;
        self.closed_groups = data.closed_groups;
        self.deleted_groups = deleted_groups;
        // Older builds saved private windows' cleaned tabs; drop them.
        self.cleaned_tabs = data
            .cleaned_tabs
            .into_iter()
            .filter(|c| !is_incognito_space(&c.tab.space_id))
            .collect();
        self.selection.clear();
        self.window_ui.clear();
        self.ui = Ui {
            focused_window_id: focused,
            focus_order,
        };
        self.extra = data.extra;

        // Each window shows the tab it showed, else its space's most recent one, else a new tab. A launch that starts
        // on a new tab shows a blank one, its space's tabs waiting in the sidebar.
        let blank = launch && self.settings.launch_shows_new_tab();
        let ids: Vec<(String, String)> = self
            .windows
            .values()
            .map(|w| (w.id.clone(), w.space_id.clone()))
            .collect();
        for (id, space) in ids {
            let shown = if blank {
                self.blank_tab_to_show(&id, &space)
            } else {
                self.tab_to_show(&id, &space)
            };
            match shown {
                Some(tab) => self.activate_in(&tab, Some(&id)),
                None => {
                    self.with_new_tab(&id, &NewTab::default());
                }
            }
        }
    }

    /// The session to save: no private window, Little Bay or peek, nothing of a private window's.
    pub fn to_session(&self) -> Session {
        let windows: Vec<BrowserWindow> = self
            .windows
            .values()
            .filter(|w| !w.incognito && !w.is_small())
            .cloned()
            .collect();
        let kept: HashSet<&String> = windows.iter().map(|w| &w.id).collect();
        let tabs: Vec<Tab> = self
            .tabs
            .values()
            .filter(|t| {
                !is_incognito_space(&t.space_id)
                    && !self
                        .windows
                        .get(&t.window_id)
                        .is_some_and(BrowserWindow::is_small)
                    && t.peek_of.is_none()
            })
            .map(|t| {
                let mut t = t.clone();
                if !kept.contains(&t.window_id) {
                    t.window_id = String::new();
                }
                t
            })
            .collect();
        let saved: HashSet<&String> = tabs.iter().map(|t| &t.id).collect();
        let public = |space: &str| !is_incognito_space(space);
        Session {
            version: SESSION_VERSION,
            spaces: self.spaces.clone(),
            space_order: self.space_order.clone(),
            orphaned_profile_data: self.orphaned_profile_data.clone(),
            settings: self.settings.0.clone(),
            window_order: self
                .window_order
                .iter()
                .filter(|id| kept.contains(id))
                .cloned()
                .collect(),
            focused_window_id: self
                .ui
                .focus_order
                .iter()
                .find(|id| kept.contains(id))
                .cloned(),
            tab_lists: self
                .tab_lists
                .iter()
                .map(|(key, ids)| {
                    (
                        key.clone(),
                        ids.iter()
                            .filter(|id| saved.contains(id))
                            .cloned()
                            .collect::<Vec<_>>(),
                    )
                })
                .filter(|(_, ids)| !ids.is_empty())
                .collect(),
            groups: self
                .groups
                .values()
                .filter(|g| public(&g.space_id))
                .cloned()
                .collect(),
            pinned_folders: self.pinned_folders.values().cloned().collect(),
            local_files: self
                .local_files
                .iter()
                .filter(|f| self.spaces.contains_key(&f.space_id))
                .cloned()
                .collect(),
            splits: self
                .splits
                .values()
                .filter(|v| v.tab_ids.iter().all(|id| saved.contains(id)))
                .cloned()
                .collect(),
            closed_tabs: self
                .closed_tabs
                .iter()
                .filter(|c| public(&c.tab.space_id))
                .cloned()
                .collect(),
            closed_windows: self
                .closed_windows
                .iter()
                .filter(|c| c.tabs.iter().all(|t| public(&t.tab.space_id)))
                .cloned()
                .collect(),
            closed_groups: self
                .closed_groups
                .iter()
                .filter(|c| c.tabs.iter().all(|t| public(&t.space_id)))
                .cloned()
                .collect(),
            deleted_groups: self
                .deleted_groups
                .iter()
                .filter(|c| c.tabs.iter().all(|t| public(&t.space_id)))
                .cloned()
                .collect(),
            cleaned_tabs: self
                .cleaned_tabs
                .iter()
                .filter(|c| public(&c.tab.space_id))
                .cloned()
                .collect(),
            windows,
            tabs,
            extra: self.extra.clone(),
        }
    }
}
