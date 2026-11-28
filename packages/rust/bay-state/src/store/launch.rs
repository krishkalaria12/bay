//! The app's launch: the saved session read, migrated and loaded as lib/persist.ts `loadSession` does.

use serde_json::Value;

use super::model::snapshot_tab;
use super::spaces::isolate_saved_spaces;
use super::{Browser, Isolated, MAX_CLOSED_WINDOWS, keep_last};
use crate::documents::{DataDir, DocumentError};
use crate::model::{ClosedWindow, ClosedWindowPlacement, ClosedWindowTab, Tab};
use crate::number::JsNumber;
use crate::session::{SESSION, Session};

/// Where a file's copy from before splitting shared profiles goes: `session.before-space-isolation.json`.
fn backup_name(name: &str) -> String {
    format!(
        "{}.before-space-isolation.json",
        name.strip_suffix(".json").unwrap_or(name)
    )
}

/// Keeps the file as it was, once.
fn back_up(dir: &DataDir, name: &str) -> Result<(), DocumentError> {
    let backup = backup_name(name);
    if let Some(original) = dir.read(name)?
        && dir.read(&backup)?.is_none()
    {
        dir.write(&backup, &original)?;
    }
    Ok(())
}

/// Older cache files keyed records by space even when several spaces shared one native profile: those records go to
/// the profile's owner before the engine's own caches move.
fn isolate_legacy_files(dir: &DataDir, isolated: &Isolated) -> Result<(), DocumentError> {
    for name in ["history.json", "bookmarks.json"] {
        let Some(text) = dir.read(name)? else {
            continue;
        };
        let Ok(mut file) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        back_up(dir, name)?;
        for key in ["history", "bookmarks"] {
            let by_space = match (key, file.get_mut(key)) {
                ("history", Some(Value::Object(history))) => Some(history),
                ("bookmarks", Some(Value::Object(bookmarks))) => match bookmarks.get_mut("roots") {
                    Some(Value::Object(roots)) => Some(roots),
                    _ => None,
                },
                _ => None,
            };
            let Some(map) = by_space else {
                continue;
            };
            for (owner, ids) in &isolated.owners {
                let source = std::iter::once(owner)
                    .chain(ids)
                    .find(|id| map.contains_key(*id))
                    .cloned();
                if let Some(value) = source.and_then(|id| map.get(&id).cloned()) {
                    map.insert(owner.clone(), value);
                }
            }
            for id in &isolated.detached {
                map.shift_remove(id);
            }
        }
        dir.write(name, &file.to_string())?;
    }
    Ok(())
}

impl Browser {
    /// Loads the saved session at launch; whether there was one. `reloaded`: the app's interface restarted without the
    /// engine, so each window keeps the tab it showed whatever settings.launchTab and restoreSession say.
    pub fn launch(&mut self, dir: &DataDir, reloaded: bool) -> Result<bool, DocumentError> {
        let Some((mut session, migrated)) = Session::read(dir, self.now())? else {
            self.hydrate(Session::default(), !reloaded);
            return Ok(false);
        };
        let mut order: Vec<String> = Vec::new();
        for id in session
            .space_order
            .iter()
            .filter(|id| session.spaces.contains_key(*id))
            .chain(session.spaces.keys())
        {
            if !order.contains(id) {
                order.push(id.clone());
            }
        }
        let isolated =
            isolate_saved_spaces(&session.spaces, &order, &session.orphaned_profile_data);
        if !isolated.detached.is_empty() || migrated {
            back_up(dir, SESSION)?;
        }
        if !isolated.detached.is_empty() {
            isolate_legacy_files(dir, &isolated)?;
        }
        let restores = session
            .settings
            .get("restoreSession")
            .and_then(Value::as_bool)
            != Some(false);
        if !reloaded && !restores {
            self.put_away_loose_tabs(&mut session);
        }
        let saved_profiles: Vec<(String, Option<String>)> = session
            .spaces
            .iter()
            .map(|(id, s)| (id.clone(), s.profile_id.clone()))
            .collect();
        self.hydrate(session, !reloaded);
        // The session no longer matches the store (spaces split, or an older build's file): it's written again first.
        let changed = saved_profiles
            .iter()
            .any(|(id, p)| self.spaces.get(id).map(|s| &s.profile_id) != Some(p));
        if migrated || changed {
            self.to_session().save(dir)?;
        }
        Ok(true)
    }

    /// A launch that doesn't restore the last session: each space keeps its pinned tabs, and its other tabs wait in
    /// Recently Closed, one window's worth per space (where a window showed it).
    fn put_away_loose_tabs(&self, session: &mut Session) {
        let now = JsNumber(self.now());
        let pinned = |t: &Tab| {
            t.pinned_page()
                || session
                    .groups
                    .iter()
                    .any(|g| g.pinned && g.tab_ids.contains(&t.id))
        };
        let loose: Vec<&Tab> = session.tabs.iter().filter(|t| !pinned(t)).collect();
        let mut by_space: Vec<(String, Vec<&Tab>)> = Vec::new();
        for t in &loose {
            match by_space.iter_mut().find(|(s, _)| *s == t.space_id) {
                Some((_, tabs)) => tabs.push(t),
                None => by_space.push((t.space_id.clone(), vec![t])),
            }
        }
        let mut closed: Vec<ClosedWindow> = Vec::new();
        for (space_id, tabs) in by_space {
            let shown_at = session
                .windows
                .iter()
                .find(|w| w.space_id == space_id)
                .or(session.windows.first());
            let entry = ClosedWindow {
                kind: "window".to_owned(),
                id: self.new_id("cw"),
                window: ClosedWindowPlacement {
                    space_id: space_id.clone(),
                    sidebar_open: shown_at.is_none_or(|w| w.sidebar_open),
                    frame: shown_at.and_then(|w| w.frame),
                    size: shown_at.and_then(|w| w.size),
                    maximized: shown_at.and_then(|w| w.maximized),
                    shown_tab_id: None,
                    extra: Default::default(),
                },
                tabs: tabs
                    .iter()
                    .map(|t| ClosedWindowTab {
                        tab: snapshot_tab(t),
                        active: session
                            .windows
                            .iter()
                            .any(|w| w.active_tab_ids.get(&space_id) == Some(&t.id)),
                        tab_id: None,
                    })
                    .collect(),
                groups: Vec::new(),
                closed_at: now,
                extra: Default::default(),
            };
            if entry.tabs.iter().any(|t| !t.tab.url.is_empty()) {
                closed.push(entry);
            }
        }
        session.closed_windows.extend(closed);
        keep_last(&mut session.closed_windows, MAX_CLOSED_WINDOWS);
        let gone: Vec<String> = loose.iter().map(|t| t.id.clone()).collect();
        session.windows.clear();
        session.window_order.clear();
        session.tabs.retain(|t| !gone.contains(&t.id));
    }
}
