//! Opening, closing and switching windows (store/windows.ts, store/littleBay.ts).

use super::model::{incognito_space_id, unique_ids};
use super::{Browser, Effect, MAX_CLOSED_WINDOWS, NewTab, TabLive, keep_last};
use crate::model::{BrowserWindow, ClosedWindow, ClosedWindowPlacement};
use crate::number::JsNumber;

/// How `create_window` opens a window.
#[derive(Clone, Debug, Default)]
pub struct CreateWindow {
    pub space_id: Option<String>,
    pub incognito: bool,
    pub url: Option<String>,
    pub adopt_id: Option<String>,
    pub frame: Option<[JsNumber; 4]>,
    pub size: Option<[JsNumber; 2]>,
    pub maximized: Option<bool>,
    /// Little Bay.
    pub small: bool,
    /// Opened behind: the focused window keeps focus.
    pub background: bool,
    /// Tabs the window shows: their pages move there.
    pub tab_ids: Vec<String>,
}

fn valid_size(size: &[JsNumber]) -> bool {
    size.len() == 2
        && size
            .iter()
            .all(|v| v.0.is_finite() && v.0 > 0.0 && v.0 <= 1_000_000.0)
}

impl Browser {
    /// The frontmost main window on the space, else the frontmost main window: where a Little Bay page goes.
    pub fn main_window_for(&self, space_id: Option<&str>) -> Option<String> {
        let order: Vec<&String> = unique_ids(&self.ui.focus_order, &self.window_order)
            .into_iter()
            .filter(|id| {
                self.windows
                    .get(*id)
                    .is_some_and(|w| !w.incognito && !w.is_small())
            })
            .collect();
        space_id
            .and_then(|space| order.iter().find(|id| self.windows[**id].space_id == space))
            .or(order.first())
            .map(|id| (*id).clone())
    }

    /// A new Little Bay uses the space the frontmost main window shows, else the default space.
    pub(crate) fn little_bay_space(&self) -> String {
        self.main_window_for(None).map_or_else(
            || self.settings.default_space_id().to_owned(),
            |w| self.windows[&w].space_id.clone(),
        )
    }

    pub(crate) fn empty_window(
        &self,
        id: &str,
        space_id: &str,
        incognito: bool,
        frame: Option<[JsNumber; 4]>,
    ) -> BrowserWindow {
        BrowserWindow {
            id: id.to_owned(),
            space_id: space_id.to_owned(),
            incognito,
            active_tab_ids: Default::default(),
            sidebar_open: true,
            tab_layout: None,
            frame,
            size: None,
            maximized: None,
            created_at: JsNumber(self.now()),
            kind: None,
            extra: Default::default(),
        }
    }

    /// Little Bay opens centred at its remembered size, so it keeps no frame.
    pub(crate) fn small_window(&self, id: &str, space_id: &str) -> BrowserWindow {
        BrowserWindow {
            sidebar_open: false,
            kind: Some("small".to_owned()),
            ..self.empty_window(id, space_id, false, None)
        }
    }

    pub(crate) fn with_window(&mut self, w: BrowserWindow) {
        let id = w.id.clone();
        self.windows.insert(id.clone(), w);
        self.window_order.push(id.clone());
        self.ui.focus_order.insert(0, id.clone());
        self.ui.focused_window_id = Some(id);
    }

    pub(crate) fn without_windows(&mut self, ids: &[String]) {
        if ids.is_empty() {
            return;
        }
        for id in ids {
            self.windows.shift_remove(id);
            self.window_ui.remove(id);
        }
        self.window_order.retain(|w| !ids.contains(w));
        self.ui.focus_order.retain(|w| !ids.contains(w));
        if self
            .ui
            .focused_window_id
            .as_ref()
            .is_some_and(|f| ids.contains(f))
        {
            self.ui.focused_window_id = self.ui.focus_order.first().cloned();
        }
        self.forget_closed_private_windows();
    }

    pub fn create_window(&mut self, o: CreateWindow) -> String {
        let id = self.new_id("w");
        let small = o.small && !o.incognito;
        let space_id = match &o.space_id {
            _ if o.incognito => incognito_space_id(&id),
            Some(space) if self.spaces.contains_key(space) => space.clone(),
            _ if small => self.little_bay_space(),
            _ => self.settings.default_space_id().to_owned(),
        };
        // macOS places windows in global coordinates: the frame is kept, a size and maximized beside it.
        let size = o.size.filter(|s| valid_size(s));
        let w = if small {
            self.small_window(&id, &space_id)
        } else {
            BrowserWindow {
                size,
                maximized: o.maximized,
                ..self.empty_window(&id, &space_id, o.incognito, o.frame)
            }
        };
        let focused = self
            .ui
            .focused_window_id
            .clone()
            .filter(|f| self.windows.contains_key(f));
        self.with_window(w);
        if !o.tab_ids.is_empty() {
            self.move_tabs_into(&o.tab_ids, &id);
        }
        let shown = o
            .tab_ids
            .iter()
            .rev()
            .find(|t| self.tabs.get(*t).is_some_and(|t| t.window_id == id))
            .cloned();
        match shown {
            Some(shown) => self.activate_in(&shown, Some(&id)),
            None => {
                self.with_new_tab(
                    &id,
                    &NewTab {
                        url: o.url,
                        adopt_id: o.adopt_id,
                        ..Default::default()
                    },
                );
            }
        }
        if let Some(focused) = focused.filter(|_| o.background) {
            self.ui.focus_order.retain(|w| *w != focused && *w != id);
            self.ui
                .focus_order
                .splice(0..0, [focused.clone(), id.clone()]);
            self.ui.focused_window_id = Some(focused);
        }
        id
    }

    /// The window goes; its tabs stay their space's, their pages unloaded (as Arc's). A private window's tabs and a
    /// Little Bay's page go with it.
    pub fn close_window(&mut self, id: &str) {
        let Some(w) = self.windows.get(id).cloned() else {
            return;
        };
        if w.incognito || w.is_small() {
            // A Little Bay page goes to Recently Closed as a tab, so ⇧⌘T brings it back in Little Bay.
            let ids = self.list_ids(&self.window_list_key(&w)).to_vec();
            self.remove_tabs(&ids, w.is_small());
            if w.incognito {
                self.closed_tabs.retain(|c| c.window_id != id);
                // Its downloads and its pages' site data go with it.
                let running: Vec<String> = self
                    .downloads
                    .iter()
                    .filter(|d| {
                        d.profile.as_deref() == Some(w.space_id.as_str())
                            && d.state == "downloading"
                    })
                    .map(|d| d.id.clone())
                    .collect();
                self.effects
                    .extend(running.into_iter().map(|id| Effect::CancelDownload { id }));
                self.forget_downloads(&w.space_id);
                self.effects.push(Effect::EndPrivateSession {
                    space_id: w.space_id.clone(),
                });
            }
        } else {
            // Its pages close with it: each tab waits, unloaded, to come back with its back/forward list (the engine
            // keeps it under the tab's id) in the next window that shows it.
            for tid in self.window_tab_ids(id) {
                let Some(t) = self.tabs.get_mut(&tid) else {
                    continue;
                };
                let loaded = t.is_loaded();
                t.adopt_id = None;
                t.window_id = String::new();
                t.navigation = None;
                t.unloaded = Some(true);
                if loaded {
                    t.wake_adopt_id = Some(format!("restore:{tid}"));
                }
                self.live.insert(tid, TabLive::default());
            }
            let entry = ClosedWindow {
                kind: "window".to_owned(),
                id: self.new_id("cw"),
                window: ClosedWindowPlacement {
                    space_id: w.space_id.clone(),
                    sidebar_open: w.sidebar_open,
                    frame: w.frame,
                    size: if w.frame.is_none() {
                        w.size.filter(|s| valid_size(s))
                    } else {
                        None
                    },
                    maximized: if w.frame.is_none() { w.maximized } else { None },
                    shown_tab_id: w.active_tab_ids.get(&w.space_id).cloned(),
                    extra: Default::default(),
                },
                tabs: Vec::new(),
                groups: Vec::new(),
                closed_at: JsNumber(self.now()),
                extra: Default::default(),
            };
            self.closed_windows.push(entry);
            keep_last(&mut self.closed_windows, MAX_CLOSED_WINDOWS);
        }
        self.without_windows(&[id.to_owned()]);
    }

    pub fn toggle_sidebar(&mut self, window_id: &str) {
        if let Some(w) = self.windows.get_mut(window_id) {
            w.sidebar_open = !w.sidebar_open;
        }
    }

    /// The window goes to the space: the tab it showed there last, else the space's most recent one (not one another
    /// window shows), else a new one.
    pub fn switch_space(&mut self, window_id: &str, space_id: &str) {
        let Some(w) = self.windows.get(window_id) else {
            return;
        };
        if w.incognito
            || w.is_small()
            || !self.spaces.contains_key(space_id)
            || w.space_id == space_id
        {
            return;
        }
        let target = match self.tab_to_show(window_id, space_id) {
            Some(id) => id,
            None => {
                let options = NewTab {
                    space_id: Some(space_id.to_owned()),
                    background: true,
                    ..Default::default()
                };
                let Some(id) = self.with_new_tab(window_id, &options) else {
                    return;
                };
                id
            }
        };
        if let Some(w) = self.windows.get_mut(window_id) {
            w.space_id = space_id.to_owned();
        }
        // The command bar stays open across the switch (activating closes it), out of the group it was for.
        let panel = self
            .window_ui
            .get(window_id)
            .map(|ui| ui.panel.clone())
            .filter(|p| p.open);
        self.activate_in(&target, Some(window_id));
        if let (Some(mut panel), Some(ui)) = (panel, self.window_ui.get_mut(window_id)) {
            panel.group_id = None;
            ui.panel = panel;
        }
    }
}
