//! What a tab's page does: navigating, the engine's reports of it, its icon (store/tabs.ts).

use super::{Browser, Effect, TabLive};
use crate::model::{EnginePick, Navigation, NewTabHistory, Tab};
use crate::number::JsNumber;

/// What `update_tab` changes; a field left `None` stays as it is. `Some(None)` clears an optional field.
#[derive(Clone, Debug, Default)]
pub struct TabPatch {
    pub url: Option<String>,
    pub title: Option<String>,
    pub favicon: Option<Option<String>>,
    pub navigation: Option<Option<Navigation>>,
    pub adopt_id: Option<Option<String>>,
    pub wake_adopt_id: Option<Option<String>>,
    pub last_active_at: Option<f64>,
    pub pinned_row: Option<Option<bool>>,
    pub kept: Option<Option<bool>>,
    pub muted: Option<bool>,
    pub zoom: Option<f64>,
    pub custom_title: Option<Option<String>>,
    pub custom_icon: Option<Option<String>>,
    pub pinned_url: Option<Option<String>>,
    pub opener_id: Option<Option<String>>,
    pub unloaded: Option<Option<bool>>,
    pub engine: Option<Option<String>>,
    pub engine_pick: Option<Option<EnginePick>>,
    pub new_tab_history: Option<Option<NewTabHistory>>,
}

/// What `update_live` changes.
#[derive(Clone, Debug, Default)]
pub struct LivePatch {
    pub is_loading: Option<bool>,
    pub progress: Option<f64>,
    pub can_go_back: Option<bool>,
    pub can_go_forward: Option<bool>,
    pub playing_audio: Option<bool>,
    pub theme_color: Option<Option<String>>,
}

fn set<T>(field: &mut T, value: Option<T>) {
    if let Some(value) = value {
        *field = value;
    }
}

fn apply(t: &mut Tab, p: TabPatch) {
    set(&mut t.url, p.url);
    set(&mut t.title, p.title);
    set(&mut t.favicon, p.favicon);
    set(&mut t.navigation, p.navigation);
    set(&mut t.adopt_id, p.adopt_id);
    set(&mut t.wake_adopt_id, p.wake_adopt_id);
    set(&mut t.last_active_at, p.last_active_at.map(JsNumber));
    set(&mut t.pinned_row, p.pinned_row);
    set(&mut t.kept, p.kept);
    set(&mut t.muted, p.muted);
    set(&mut t.zoom, p.zoom.map(JsNumber));
    set(&mut t.custom_title, p.custom_title);
    set(&mut t.custom_icon, p.custom_icon);
    set(&mut t.pinned_url, p.pinned_url);
    set(&mut t.opener_id, p.opener_id);
    set(&mut t.unloaded, p.unloaded);
    set(&mut t.engine, p.engine);
    set(&mut t.engine_pick, p.engine_pick);
    set(&mut t.new_tab_history, p.new_tab_history);
}

fn apply_live(l: &mut TabLive, p: LivePatch) {
    set(&mut l.is_loading, p.is_loading);
    set(&mut l.progress, p.progress);
    set(&mut l.can_go_back, p.can_go_back);
    set(&mut l.can_go_forward, p.can_go_forward);
    set(&mut l.playing_audio, p.playing_audio);
    set(&mut l.theme_color, p.theme_color);
}

impl Browser {
    /// The app opens these addresses itself (settings, the new tab panel, a shared collection's link) instead of a
    /// tab loading them: `handles` answers which, and each goes out as `Effect::OpenAppUrl`.
    pub fn set_app_urls(&mut self, handles: fn(&str) -> bool) {
        self.app_urls = Some(handles);
    }

    pub(crate) fn opens_app_url(&mut self, url: &str, window_id: &str) -> bool {
        let handled = self.app_urls.is_some_and(|handles| handles(url));
        if handled {
            self.effects.push(Effect::OpenAppUrl {
                url: url.to_owned(),
                window_id: window_id.to_owned(),
            });
        }
        handled
    }

    /// Loads typed text or an address in the tab.
    pub fn navigate(&mut self, id: &str, input: &str, user_initiated: bool) {
        let url = self.resolve_input(input);
        let Some(tab) = self.tabs.get(id).cloned() else {
            return;
        };
        if url.is_empty() {
            return;
        }
        if self.opens_app_url(&url, &tab.window_id) {
            // An app address may open a new command bar session instead of loading the page.
            self.close_panel(&tab.window_id);
            return;
        }
        // Typing an address starts a new task (a New Tab page gets one lookup first, as in Chrome).
        if user_initiated && !tab.url.is_empty() {
            let key = self.tab_list_key(&tab);
            self.forget_openers(&key, None);
        }
        let opener = self.tabs[id].opener_id.clone();
        let mut next = tab.clone();
        // A new address supersedes a page the tab kept to load when shown.
        next.unloaded = None;
        next.wake_adopt_id = None;
        next.new_tab_history = None;
        next.opener_id = opener;
        next.navigation = Some(self.navigation_to(&url, user_initiated));
        if next.url.is_empty() {
            next.url.clone_from(&url);
        }
        // A typed address opens in its site's engine; moving engines drops the page the tab adopted.
        if user_initiated {
            let engine = self.typed_navigation_engine(&tab, &url);
            if engine != self.tab_engine(id) {
                next.adopt_id = None;
            }
            next.engine = Some(engine);
        }
        // A pick (Reopen in…) holds for its site: an address on another site drops it.
        if tab.engine_pick.is_some() && super::tab_pick(&tab, &url).is_none() {
            next.engine_pick = None;
        }
        self.tabs.insert(id.to_owned(), next);
        self.close_panel(&tab.window_id);
    }

    /// Changes the tab, and its live state in the same update.
    pub fn update_tab(&mut self, id: &str, patch: TabPatch, live: Option<LivePatch>) {
        let Some(tab) = self.tabs.get(id).cloned() else {
            return;
        };
        let url_changes = patch.url.as_ref().is_some_and(|u| *u != tab.url);
        // Loading something else supersedes the page the tab kept to load when shown.
        let supersedes = tab.wake_adopt_id.is_some()
            && patch.wake_adopt_id.is_none()
            && (matches!(patch.navigation, Some(Some(_)))
                || matches!(patch.adopt_id, Some(Some(_)))
                || url_changes);
        let mut next = tab.clone();
        if url_changes {
            let url = patch.url.clone().unwrap_or_default();
            self.on_url_change(&mut next, &url);
        }
        apply(&mut next, patch);
        if supersedes {
            next.wake_adopt_id = None;
        }
        if next != tab {
            self.tabs.insert(id.to_owned(), next);
        }
        if let Some(live) = live {
            self.update_live(id, live);
        }
    }

    pub fn update_live(&mut self, id: &str, patch: LivePatch) {
        if let Some(live) = self.live.get_mut(id) {
            apply_live(live, patch);
        }
    }

    /// The engine's report of the tab's page. The engine records the visit in its history itself.
    pub fn navigated(&mut self, id: &str, url: &str, title: &str, mut live: LivePatch) {
        // A page has no colour of its own while it reloads: it keeps the last one until the load ends, or the window
        // would flash its space's colour.
        if live.is_loading == Some(true)
            && matches!(live.theme_color, Some(None))
            && let Some(held) = self.live.get(id).and_then(|l| l.theme_color.clone())
        {
            live.theme_color = Some(Some(held));
        }
        let kept = self.tabs.get(id).and_then(|t| t.new_tab_history.clone());
        // Behind a New Tab page shown by Back, the kept page only refreshes its title; going anywhere else drops it.
        let patch = match kept {
            Some(kept) if kept.url == url => TabPatch {
                new_tab_history: Some(Some(NewTabHistory {
                    title: title.to_owned(),
                    ..kept
                })),
                ..Default::default()
            },
            kept => TabPatch {
                url: Some(url.to_owned()),
                title: Some(title.to_owned()),
                new_tab_history: kept.map(|_| None),
                ..Default::default()
            },
        };
        self.update_tab(id, patch, Some(live));
    }

    /// The page's icon. The engine keeps it with the page.
    pub fn favicon_changed(&mut self, id: &str, favicon: &str) {
        let kept = self.tabs.get(id).and_then(|t| t.new_tab_history.clone());
        let patch = match kept {
            Some(kept) => TabPatch {
                new_tab_history: Some(Some(NewTabHistory {
                    favicon: Some(favicon.to_owned()),
                    ..kept
                })),
                ..Default::default()
            },
            None => TabPatch {
                favicon: Some(Some(favicon.to_owned())),
                ..Default::default()
            },
        };
        self.update_tab(id, patch, None);
    }

    /// The command bar closes.
    pub fn close_panel(&mut self, window_id: &str) {
        if let Some(ui) = self.window_ui.get_mut(window_id).filter(|ui| ui.panel.open) {
            ui.panel = super::Panel::default();
        }
    }
}
