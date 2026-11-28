//! What each window shows besides its tabs (store/windowUi.ts): the command bar, the Downloads panel, Find in a tab,
//! focus, and the downloads list.

use super::model::is_incognito_space;
use super::{Browser, NewTab, Panel, WindowUi};
use crate::model::Download;

pub const MAX_DOWNLOADS: usize = 100;

/// Find in a tab's page.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FindState {
    pub open: bool,
    pub query: String,
    /// Matches, once the engine has counted.
    pub count: Option<u32>,
    pub active: u32,
    pub focus_request: Option<u64>,
    pub replace: Option<bool>,
}

/// A download shows in the window: a private window's own, else every one not private.
pub fn download_visible_in(d: &Download, window: Option<&crate::model::BrowserWindow>) -> bool {
    let Some(w) = window else {
        return false;
    };
    let private = d.profile.as_deref().is_some_and(is_incognito_space);
    if w.incognito {
        d.profile.as_deref() == Some(w.space_id.as_str())
    } else {
        !private
    }
}

impl Browser {
    fn window_ui_mut(&mut self, window_id: &str) -> Option<&mut WindowUi> {
        self.windows
            .contains_key(window_id)
            .then(|| self.window_ui.entry(window_id.to_owned()).or_default())
    }

    pub fn set_focused_window(&mut self, id: &str) {
        if !self.windows.contains_key(id) || self.ui.focused_window_id.as_deref() == Some(id) {
            return;
        }
        self.ui.focus_order.retain(|w| w != id);
        self.ui.focus_order.insert(0, id.to_owned());
        self.ui.focused_window_id = Some(id.to_owned());
    }

    /// Opens the command bar to navigate; one of it and the Downloads panel at a time.
    pub fn open_panel(&mut self, window_id: &str, initial_text: &str) {
        let session = self.new_id("panel");
        if let Some(ui) = self.window_ui_mut(window_id) {
            ui.panel = Panel {
                open: true,
                initial_text: initial_text.to_owned(),
                mode: Some("navigate".to_owned()),
                session_id: Some(session),
                group_id: None,
            };
            ui.downloads_open = false;
        }
    }

    /// Opens the command bar for a new tab, in `group_id` if given (a group of the window's space).
    pub fn open_new_tab_panel(&mut self, window_id: &str, group_id: Option<&str>) {
        let Some(w) = self.windows.get(window_id) else {
            return;
        };
        if w.is_small()
            || group_id.is_some_and(|g| self.groups.get(g).is_none_or(|g| g.space_id != w.space_id))
        {
            return;
        }
        let session = self.new_id("panel");
        if let Some(ui) = self.window_ui_mut(window_id) {
            ui.panel = Panel {
                open: true,
                initial_text: String::new(),
                mode: Some("newTab".to_owned()),
                session_id: Some(session),
                group_id: group_id.map(str::to_owned),
            };
            ui.downloads_open = false;
        }
    }

    /// The new tab command bar's address opens: in its group if it has one. The tab's id.
    pub fn submit_new_tab_panel(&mut self, window_id: &str, url: &str) -> Option<String> {
        let w = self.windows.get(window_id)?;
        let panel = self.window_ui.get(window_id).map(|ui| ui.panel.clone())?;
        if w.is_small()
            || url.trim().is_empty()
            || !panel.open
            || panel.mode.as_deref() != Some("newTab")
        {
            return None;
        }
        let space = w.space_id.clone();
        // Closed first: an app address can open a fresh command bar.
        self.close_panel(window_id);
        match panel.group_id {
            Some(group) if self.groups.get(&group).is_some_and(|g| g.space_id == space) => {
                self.new_tab_in_group(&group, Some(url))
            }
            Some(_) => None,
            None => self.new_tab(
                window_id,
                NewTab {
                    url: Some(url.to_owned()),
                    ..Default::default()
                },
            ),
        }
    }

    /// The command bar closes.
    pub fn close_panel(&mut self, window_id: &str) {
        if let Some(ui) = self.window_ui_mut(window_id) {
            ui.panel = Panel::default();
        }
    }

    pub fn set_downloads_open(&mut self, window_id: &str, open: bool) {
        if let Some(ui) = self.window_ui_mut(window_id) {
            ui.downloads_open = open;
            if open {
                ui.panel = Panel::default();
            }
        }
    }

    /// Changes the tab's Find; the fields of `patch` that are set win.
    pub fn set_find(&mut self, tab_id: &str, patch: impl FnOnce(&mut FindState)) {
        if self.tabs.contains_key(tab_id) {
            patch(self.find.entry(tab_id.to_owned()).or_default());
        }
    }

    /// The engine's report of a download: a new one goes first (the list keeps a hundred).
    pub fn upsert_download(&mut self, d: Download) {
        if let Some(at) = self.downloads.iter().position(|x| x.id == d.id) {
            let old = &self.downloads[at];
            // The engine still names the path it saved after Tidy Downloads renamed the file; the renamed one stands.
            let next = if old.renamed_from.is_some()
                && old.renamed_from.as_deref() == Some(d.path.as_str())
            {
                Download {
                    filename: old.filename.clone(),
                    path: old.path.clone(),
                    renamed_from: old.renamed_from.clone(),
                    ..d
                }
            } else {
                d
            };
            self.downloads[at] = next;
            return;
        }
        // A private window's downloads leave with it; the engine's late "cancelled" mustn't bring one back.
        if let Some(profile) = d.profile.as_deref().filter(|p| is_incognito_space(p))
            && !self.windows.values().any(|w| w.space_id == profile)
        {
            return;
        }
        self.downloads.insert(0, d);
        self.downloads.truncate(MAX_DOWNLOADS);
    }

    /// Tidy Downloads renamed or moved the file.
    pub fn update_download_file(&mut self, id: &str, filename: &str, path: &str) {
        if let Some(d) = self.downloads.iter_mut().find(|d| d.id == id) {
            let saved = d.renamed_from.take().unwrap_or_else(|| d.path.clone());
            d.filename = filename.to_owned();
            d.path = path.to_owned();
            d.renamed_from = (path != saved).then_some(saved);
        }
    }

    pub fn remove_download(&mut self, id: &str) {
        self.downloads.retain(|d| d.id != id);
    }

    /// Clears finished downloads: those the window shows, or every one.
    pub fn clear_downloads(&mut self, window_id: Option<&str>) {
        let window = window_id.and_then(|w| self.windows.get(w)).cloned();
        self.downloads.retain(|d| {
            d.state == "downloading"
                || (window_id.is_some() && !download_visible_in(d, window.as_ref()))
        });
    }

    pub fn forget_downloads(&mut self, profile: &str) {
        self.downloads
            .retain(|d| d.profile.as_deref() != Some(profile));
    }

    pub fn downloads_in(&self, window_id: &str) -> Vec<&Download> {
        let w = self.windows.get(window_id);
        self.downloads
            .iter()
            .filter(|d| download_visible_in(d, w))
            .collect()
    }

    /// The downloads document to save: none of a private window's, and one still downloading as failed (the
    /// engine won't resume it after a quit).
    pub fn to_downloads(&self) -> crate::Downloads {
        crate::Downloads {
            version: crate::downloads::DOWNLOADS_VERSION,
            downloads: self
                .downloads
                .iter()
                .filter(|d| d.profile.as_deref().is_none_or(|p| !is_incognito_space(p)))
                .map(|d| {
                    let mut d = d.clone();
                    if d.state == "downloading" {
                        d.state = "failed".to_owned();
                    }
                    d
                })
                .collect(),
            extra: Default::default(),
        }
    }
}
