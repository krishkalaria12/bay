//! Keeping tabs in order (store/tabTidying.ts): cleaning up unused and duplicate tabs, Tidy Tabs, muting, pinned
//! pages' addresses, the selection, and moving, duplicating and bookmarking groups.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::groups::{GroupOptions, order_sections, place_block, sync_group_order};
use super::model::{TabList, is_incognito_space, snapshot_tab};
use super::names::host_of;
use super::tabs::same_page;
use super::{Browser, NewTab, keep_last};
use crate::model::{ClosedTab, GroupRef, Tab, TabSnapshot};
use crate::number::JsNumber;

/// How long tabs stay unused before the clean-up puts them away, unless the settings or the space say otherwise.
pub const CLEAN_UP_AFTER_MS: f64 = 12.0 * 60.0 * 60.0 * 1000.0;
pub const MAX_CLEANED: usize = 100;
/// The tabs ⌃Tab switches between: Arc's five most recent.
pub const RECENT_TABS: usize = 5;

/// The groups Tidy makes and the groups it adds to.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TabTidyPlan {
    pub new_groups: Vec<(Option<String>, Vec<String>)>,
    pub joins: Vec<(String, Vec<String>)>,
}

/// Where `move_group` puts a group.
#[derive(Clone, Debug, Default)]
pub struct GroupPlacement {
    pub pinned: bool,
    pub before_id: Option<String>,
}

/// A pinned page away from the address it was pinned at.
pub fn away_from_pin(t: &Tab) -> bool {
    t.pinned_page()
        && t.pinned_url
            .as_ref()
            .is_some_and(|p| !t.url.is_empty() && !same_page(&t.url, p))
}

/// The most recently used tab, the first of those on a tie (a stable sort's first).
fn most_recent_first<'a, 'b>(tabs: &'b [&'a Tab]) -> Option<&'b &'a Tab> {
    let mut best: Option<&&Tab> = None;
    for t in tabs {
        if best.is_none_or(|b| t.last_active_at.0 > b.last_active_at.0) {
            best = Some(t);
        }
    }
    best
}

impl Browser {
    /// The space asked for, else the one the window shows.
    fn space_or_shown(&self, window_id: &str, space_id: Option<&str>) -> String {
        match space_id {
            Some(space) => space.to_owned(),
            None => self
                .windows
                .get(window_id)
                .map_or_else(String::new, |w| w.space_id.clone()),
        }
    }

    /// How long a space's tabs stay unused before they're cleaned up automatically, in hours: never if None.
    pub fn clean_up_hours(&self, space_id: &str) -> Option<f64> {
        match self
            .spaces
            .get(space_id)
            .and_then(|s| s.clean_up_after_hours)
        {
            Some(own) => own.map(|h| h.0),
            None => self
                .settings
                .value("cleanUpInactiveTabsAfterHours")
                .and_then(Value::as_f64),
        }
    }

    /// Whether the site is muted for the tab: a private window's own choice, else the settings'.
    pub fn is_site_muted(&self, tab: &Tab, host: &str) -> bool {
        let own = is_incognito_space(&tab.space_id)
            .then(|| {
                self.private_site_mutes
                    .get(&tab.window_id)
                    .and_then(|m| m.get(host))
                    .copied()
            })
            .flatten();
        own.unwrap_or_else(|| self.settings.site_muted(host))
    }

    /// The window's cleaned-up tabs: a private window's own, else the app's.
    pub fn cleaned_tabs_for(&self, window_id: &str) -> &[ClosedTab] {
        if self.windows.get(window_id).is_some_and(|w| w.incognito) {
            self.private_cleaned_tabs
                .get(window_id)
                .map_or(&[], Vec::as_slice)
        } else {
            &self.cleaned_tabs
        }
    }

    /// The window's selected tabs in its list's order, else the tab it shows.
    pub fn selected_tab_ids(&self, window_id: &str) -> Vec<String> {
        let view = self.view_tab_ids(window_id, None);
        let chosen = self.selection.get(window_id).cloned().unwrap_or_default();
        let selected: Vec<String> = view
            .iter()
            .filter(|id| chosen.contains(id))
            .cloned()
            .collect();
        if !selected.is_empty() {
            return selected;
        }
        self.active_tab_id(window_id, None).into_iter().collect()
    }

    pub fn set_selection(&mut self, window_id: &str, ids: &[String]) {
        let view: HashSet<String> = self.view_tab_ids(window_id, None).into_iter().collect();
        let mut next: Vec<String> = Vec::new();
        for id in ids {
            if view.contains(id) && !next.contains(id) {
                next.push(id.clone());
            }
        }
        self.selection.insert(window_id.to_owned(), next);
    }

    /// The tabs the clean-up would put away in the window's space (or `space_id`): unused for `inactive_for_ms`, and
    /// duplicates of one page, but never the shown, pinned, kept, playing, split ones (or grouped, unless duplicates).
    pub fn clean_up_candidates(
        &self,
        window_id: &str,
        inactive_for_ms: f64,
        now: f64,
        space_id: Option<&str>,
    ) -> Vec<String> {
        let view = self.view_tab_ids(window_id, space_id);
        let mut out = HashSet::new();
        self.visit_clean_up(
            &view,
            window_id,
            inactive_for_ms,
            now,
            space_id,
            &mut |id| {
                out.insert(id.to_owned());
                false
            },
        );
        view.into_iter().filter(|id| out.contains(id)).collect()
    }

    /// Whether the clean-up would put a tab away.
    pub fn has_clean_up_candidates(
        &self,
        window_id: &str,
        inactive_for_ms: f64,
        now: f64,
        space_id: Option<&str>,
    ) -> bool {
        let view = self.view_tab_ids(window_id, space_id);
        self.visit_clean_up(
            &view,
            window_id,
            inactive_for_ms,
            now,
            space_id,
            &mut |_| true,
        )
    }

    /// Whether Clear would put a tab away: the window's space has a tab besides the protected ones.
    pub fn has_clearable_tabs(&self, window_id: &str, space_id: Option<&str>) -> bool {
        self.has_clean_up_candidates(window_id, 0.0, self.now(), space_id)
    }

    // `visit` returning true stops the scan.
    fn visit_clean_up(
        &self,
        view: &[String],
        window_id: &str,
        inactive_for_ms: f64,
        now: f64,
        space_id: Option<&str>,
        visit: &mut dyn FnMut(&str) -> bool,
    ) -> bool {
        if view.is_empty() {
            return false;
        }
        // The tab any window shows for the space stays.
        let space = self.space_or_shown(window_id, space_id);
        let shown: HashSet<String> = self
            .windows
            .keys()
            .filter_map(|w| self.active_tab_id(w, Some(&space)))
            .collect();
        let active = self.active_tab_id(window_id, space_id);
        let in_split = |id: &str| self.split_of(id).is_some();
        let keep = |t: &Tab| {
            shown.contains(&t.id)
                || t.pinned_page()
                || t.kept == Some(true)
                || self.live.get(&t.id).is_some_and(|l| l.playing_audio)
        };
        for id in view {
            let t = &self.tabs[id];
            if keep(t) || self.group_of(id).is_some() || in_split(id) {
                continue;
            }
            if now - t.last_active_at.0 >= inactive_for_ms && visit(id) {
                return true;
            }
        }
        let mut by_page: Vec<(&str, Vec<&Tab>)> = Vec::new();
        for id in view {
            let t = &self.tabs[id];
            if t.url.is_empty() {
                continue;
            }
            let key = t.url.split('#').next().unwrap_or(&t.url);
            match by_page.iter_mut().find(|(k, _)| *k == key) {
                Some((_, same)) => same.push(t),
                None => by_page.push((key, vec![t])),
            }
        }
        for (_, same) in by_page {
            if same.len() < 2 {
                continue;
            }
            let keeper = same
                .iter()
                .find(|t| t.pinned_page())
                .or_else(|| same.iter().find(|t| Some(&t.id) == active.as_ref()))
                .or_else(|| most_recent_first(&same))
                .map(|t| t.id.clone());
            // Being in a group protects an unused tab, but not a duplicate.
            for t in &same {
                if Some(&t.id) != keeper.as_ref() && !keep(t) && !in_split(&t.id) && visit(&t.id) {
                    return true;
                }
            }
        }
        false
    }

    /// A window's blank tabs nobody looks at: never loaded, not shown, not pinned. It keeps at least one tab.
    pub fn abandoned_new_tabs(&self, window_id: &str) -> Vec<String> {
        let Some(w) = self.windows.get(window_id) else {
            return Vec::new();
        };
        let selected: HashSet<&String> = w.active_tab_ids.values().collect();
        let shown = w.active_tab_ids.get(&w.space_id);
        let mine = self.window_tab_ids(window_id);
        let out: Vec<String> = mine
            .iter()
            .filter(|id| {
                let t = &self.tabs[*id];
                t.url.is_empty()
                    && t.navigation.is_none()
                    && t.adopt_id.is_none()
                    && !t.pinned
                    && Some(*id) != shown
                    && !selected.contains(id)
            })
            .cloned()
            .collect();
        if out.len() >= mine.len() {
            out[..mine.len().saturating_sub(1)].to_vec()
        } else {
            out
        }
    }

    /// As Arc's ⌃Tab: the most recent tabs of every space the window can show (not one another window shows now).
    pub fn recent_tab_ids(&self, window_id: &str) -> Vec<String> {
        let Some(w) = self.windows.get(window_id) else {
            return Vec::new();
        };
        let spaces = if w.incognito || w.is_small() {
            vec![w.space_id.clone()]
        } else {
            self.space_order.clone()
        };
        let mut tabs: Vec<String> = spaces
            .iter()
            .flat_map(|space| self.view_tab_ids(window_id, Some(space)))
            .filter(|id| !self.shown_elsewhere(id, window_id))
            .collect();
        tabs.sort_by(|a, b| {
            self.tabs[b]
                .last_active_at
                .0
                .total_cmp(&self.tabs[a].last_active_at.0)
        });
        tabs.truncate(RECENT_TABS);
        tabs
    }

    /// Back to the address the pinned page was pinned at.
    pub fn return_to_pinned_url(&mut self, tab_id: &str) {
        let Some(home) = self
            .tabs
            .get(tab_id)
            .and_then(|t| t.pinned_url.clone().filter(|p| !same_page(&t.url, p)))
        else {
            return;
        };
        self.navigate(tab_id, &home, true);
    }

    /// The pinned page's address becomes `url` (it goes there) or the page it's on.
    pub fn set_pinned_url(&mut self, tab_id: &str, url: Option<&str>) {
        let Some(t) = self.tabs.get(tab_id) else {
            return;
        };
        let next = url.map_or_else(|| t.url.clone(), str::to_owned);
        if !t.pinned_page() || next.is_empty() {
            return;
        }
        let elsewhere = url.is_some_and(|u| !same_page(&t.url, u));
        if let Some(t) = self.tabs.get_mut(tab_id) {
            t.pinned_url = Some(next.clone());
        }
        if elsewhere {
            self.navigate(tab_id, &next, true);
        }
    }

    pub fn set_muted(&mut self, ids: &[String], muted: bool) {
        for id in ids {
            if let Some(t) = self.tabs.get_mut(id) {
                t.muted = muted;
            }
        }
    }

    /// Mutes the tab's site: every tab of it in the space, and the site from now on (a private window's own choice).
    pub fn set_site_muted(&mut self, tab_id: &str, muted: bool) {
        let Some(tab) = self.tabs.get(tab_id).cloned() else {
            return;
        };
        let host = host_of(&tab.url);
        if host.is_empty() {
            return self.set_muted(&[tab_id.to_owned()], muted);
        }
        let same: Vec<String> = self
            .tabs
            .values()
            .filter(|t| t.space_id == tab.space_id && host_of(&t.url) == host)
            .map(|t| t.id.clone())
            .collect();
        self.set_muted(&same, muted);
        if is_incognito_space(&tab.space_id) {
            self.private_site_mutes
                .entry(tab.window_id.clone())
                .or_default()
                .insert(host, muted);
            return;
        }
        let mut sites: Vec<String> = self
            .settings
            .value("mutedSites")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        sites.retain(|s| *s != host);
        if muted {
            sites.push(host);
        }
        self.settings.set("mutedSites", sites);
    }

    /// Moves the group: pinned or not, before another row (`before_id`), else to the end of its section.
    pub fn move_group(&mut self, group_id: &str, p: GroupPlacement) {
        let Some(g) = self.groups.get(group_id).cloned() else {
            return;
        };
        let Some(w) = g.tab_ids.first().and_then(|f| self.list_of_tab(f)) else {
            return;
        };
        if p.before_id.as_ref().is_some_and(|b| g.tab_ids.contains(b)) {
            return;
        }
        if let Some(group) = self.groups.get_mut(group_id) {
            group.pinned = p.pinned;
        }
        let mut rest: Vec<String> = w
            .tab_ids
            .iter()
            .filter(|id| !g.tab_ids.contains(id))
            .cloned()
            .collect();
        let at = if let Some(before) = p.before_id.as_ref().filter(|b| rest.contains(b)) {
            let anchor = self
                .group_of(before)
                .and_then(|other| other.tab_ids.iter().find(|id| rest.contains(id)).cloned())
                .unwrap_or_else(|| before.clone());
            rest.iter()
                .position(|id| *id == anchor)
                .unwrap_or(rest.len())
        } else if p.pinned {
            let pinned_group: HashSet<&String> = self
                .groups
                .values()
                .filter(|x| x.pinned && x.id != group_id)
                .flat_map(|x| &x.tab_ids)
                .collect();
            rest.iter().enumerate().fold(0, |last, (i, id)| {
                if self.tabs.get(id).is_some_and(|t| t.pinned) || pinned_group.contains(id) {
                    i + 1
                } else {
                    last
                }
            })
        } else {
            rest.len()
        };
        rest.splice(at..at, g.tab_ids.iter().cloned());
        let list = TabList {
            tab_ids: order_sections(&rest, &self.tabs, &self.groups, &self.pinned_folders),
            key: w.key,
        };
        sync_group_order(&mut self.groups, &list);
        self.set_list(list);
    }

    /// The tabs as new ones behind their tabs (in `window_id`), each where `index` says.
    pub(crate) fn restore_snapshots(
        &mut self,
        window_id: &str,
        entries: Vec<(TabSnapshot, Option<usize>)>,
    ) -> Vec<String> {
        let mut ids = Vec::new();
        for (tab, index) in entries {
            let private = self.windows.get(window_id).is_some_and(|w| w.incognito);
            let space_id = if self.spaces.contains_key(&tab.space_id) || private {
                tab.space_id.clone()
            } else {
                self.windows
                    .get(window_id)
                    .map_or_else(String::new, |w| w.space_id.clone())
            };
            let options = NewTab {
                url: (!tab.url.is_empty()).then(|| tab.url.clone()),
                space_id: Some(space_id),
                snapshot: Some(tab),
                index,
                background: true,
                ..Default::default()
            };
            if let Some(id) = self.with_new_tab(window_id, &options) {
                ids.push(id);
            }
        }
        ids
    }

    /// A copy of the group after it: its tabs, unpinned, in a group of its name, colour and icon.
    pub fn duplicate_group(&mut self, group_id: &str) -> Option<String> {
        let g = self.groups.get(group_id)?.clone();
        let window_id = self.group_window(&g)?;
        let list = self.list_of_tab(g.tab_ids.first()?)?;
        let after = list
            .tab_ids
            .iter()
            .position(|id| Some(id) == g.tab_ids.last())
            .map_or(0, |i| i + 1);
        let entries = g
            .tab_ids
            .iter()
            .enumerate()
            .map(|(i, id)| {
                (
                    TabSnapshot {
                        pinned: false,
                        ..snapshot_tab(&self.tabs[id])
                    },
                    Some(after + i),
                )
            })
            .collect();
        let ids = self.restore_snapshots(&window_id, entries);
        let copy = self.with_group(
            &ids,
            GroupOptions {
                name: Some(g.name.clone()),
                pinned: g.pinned,
                ..Default::default()
            },
        )?;
        if let Some(c) = self.groups.get_mut(&copy) {
            c.icon = g.icon;
            c.color = g.color;
        }
        Some(copy)
    }

    /// A new tab at the end of the group, which opens.
    pub fn new_tab_in_group(&mut self, group_id: &str, url: Option<&str>) -> Option<String> {
        let g = self.groups.get(group_id)?.clone();
        let window_id = self.group_window(&g)?;
        let list = self.list_of_tab(g.tab_ids.first()?)?;
        let index = list
            .tab_ids
            .iter()
            .position(|id| Some(id) == g.tab_ids.last())
            .map_or(0, |i| i + 1);
        let options = NewTab {
            url: url.map(str::to_owned),
            space_id: Some(g.space_id.clone()),
            index: Some(index),
            ..Default::default()
        };
        let id = if url.is_some() {
            self.new_tab(&window_id, options)?
        } else {
            self.with_new_tab(&window_id, &options)?
        };
        if let Some(group) = self.groups.get_mut(group_id) {
            group.collapsed = false;
            group.tab_ids.push(id.clone());
        }
        if let Some(list) = self.list_of_tab(&id) {
            sync_group_order(&mut self.groups, &list);
        }
        Some(id)
    }

    /// The group becomes a folder on the bookmarks bar, and closes.
    pub fn move_group_to_bookmarks_bar(&mut self, group_id: &str) {
        let Some(g) = self.groups.get(group_id).cloned() else {
            return;
        };
        let space_id = if is_incognito_space(&g.space_id) {
            self.settings.default_space_id().to_owned()
        } else {
            g.space_id.clone()
        };
        let title = self.group_label(&g);
        let folder = self.add_bookmark_folder(&space_id, &title, None, None);
        for id in &g.tab_ids {
            let Some(t) = self.tabs.get(id).filter(|t| !t.url.is_empty()).cloned() else {
                continue;
            };
            let title = t
                .custom_title
                .clone()
                .filter(|c| !c.is_empty())
                .unwrap_or_else(|| {
                    if t.title.is_empty() {
                        t.url.clone()
                    } else {
                        t.title.clone()
                    }
                });
            self.add_bookmark(
                &space_id,
                &t.url,
                &title,
                t.favicon.clone(),
                Some(&folder),
                None,
            );
        }
        self.close_group(group_id);
    }

    fn loose(&self, id: &str) -> bool {
        self.tabs.get(id).is_some_and(|t| !t.pinned_page())
            && self.group_of(id).is_none()
            && self.split_of(id).is_none()
    }

    /// The tabs Tidy may sort in the window's space, in sidebar order: loose web pages.
    pub fn tidy_candidates(&self, window_id: &str, space_id: Option<&str>) -> Vec<String> {
        self.view_tab_ids(window_id, space_id)
            .into_iter()
            .filter(|id| {
                let url = self.tabs[id].url.to_ascii_lowercase();
                self.loose(id)
                    && (url.starts_with("http:")
                        || url.starts_with("https:")
                        || url.starts_with("file:"))
            })
            .collect()
    }

    /// What the divider's Tidy goes by: the list's unpinned tabs, and the loose ones among them.
    pub fn tidy_tab_counts(&self, window_id: &str, space_id: Option<&str>) -> (usize, Vec<String>) {
        let count = self
            .view_tab_ids(window_id, space_id)
            .iter()
            .filter(|id| self.tabs.get(*id).is_some_and(|t| !t.pinned_page()))
            .count();
        (count, self.tidy_candidates(window_id, space_id))
    }

    /// The grouping that needs no model: a group per site with two or more tabs, the rest under "Other".
    pub fn site_tidy_plan(&self, ids: &[String]) -> TabTidyPlan {
        let mut clusters: Vec<(String, Vec<String>)> = Vec::new();
        let mut leftovers: Vec<String> = Vec::new();
        for id in ids {
            let host = host_of(&self.tabs[id].url);
            if host.is_empty() {
                leftovers.push(id.clone());
                continue;
            }
            match clusters.iter_mut().find(|(h, _)| *h == host) {
                Some((_, list)) => list.push(id.clone()),
                None => clusters.push((host, vec![id.clone()])),
            }
        }
        let mut new_groups = Vec::new();
        for (_, tab_ids) in clusters {
            if tab_ids.len() < 2 {
                leftovers.extend(tab_ids);
            } else {
                new_groups.push((None, tab_ids));
            }
        }
        if leftovers.len() >= 2 {
            new_groups.push((Some("Other".to_owned()), leftovers));
        }
        TabTidyPlan {
            new_groups,
            joins: Vec::new(),
        }
    }

    /// Sorts the loose tabs into groups as `plan` says, or by site without one; the number of groups made or added
    /// to. The plan may be seconds old (a model was thinking): only tabs still loose move.
    pub fn tidy_tabs(&mut self, window_id: &str, plan: Option<TabTidyPlan>) -> usize {
        let plan =
            plan.unwrap_or_else(|| self.site_tidy_plan(&self.tidy_candidates(window_id, None)));
        let mut made = 0;
        for (group_id, tab_ids) in &plan.joins {
            let mut joined = false;
            for id in tab_ids
                .iter()
                .filter(|id| self.loose(id))
                .cloned()
                .collect::<Vec<_>>()
            {
                let fits = self
                    .groups
                    .get(group_id)
                    .is_some_and(|g| g.space_id == self.tabs[&id].space_id);
                let Some(list) = self.list_of_tab(&id).filter(|_| fits) else {
                    continue;
                };
                self.join_group(&list, group_id, &id);
                joined = true;
            }
            made += usize::from(joined);
        }
        for (name, tab_ids) in &plan.new_groups {
            let ids: Vec<String> = tab_ids
                .iter()
                .filter(|id| self.loose(id))
                .cloned()
                .collect();
            if ids.len() < 2 {
                continue;
            }
            let options = GroupOptions {
                name: name.clone(),
                ..Default::default()
            };
            made += usize::from(self.with_group(&ids, options).is_some());
        }
        made
    }

    fn closed_entries(&self, ids: &[String]) -> Vec<ClosedTab> {
        let now = JsNumber(self.now());
        ids.iter()
            .filter_map(|id| self.tabs.get(id).filter(|t| !t.url.is_empty()))
            .map(|t| ClosedTab {
                kind: "tab".to_owned(),
                id: self.new_id("ct"),
                tab: snapshot_tab(t),
                tab_id: None,
                window_id: t.window_id.clone(),
                index: JsNumber(
                    self.list_of_tab(&t.id)
                        .and_then(|l| l.tab_ids.iter().position(|x| *x == t.id))
                        .unwrap_or(0) as f64,
                ),
                group: self.group_of(&t.id).map(|g| GroupRef {
                    id: g.id.clone(),
                    name: g.name.clone(),
                    icon: g.icon.clone(),
                    color: g.color.clone(),
                    extra: Default::default(),
                }),
                closed_at: now,
                pinned_tile: None,
                small: None,
                extra: Default::default(),
            })
            .collect()
    }

    /// Cleans up the tabs of the space the window shows (or `space_id`) unused for `inactive_for_ms` (the space's or
    /// the settings' time by default) into Recently Cleaned; how many went.
    pub fn clean_up_tabs(
        &mut self,
        window_id: &str,
        inactive_for_ms: Option<f64>,
        space_id: Option<&str>,
    ) -> usize {
        let space = self.space_or_shown(window_id, space_id);
        let after = inactive_for_ms.unwrap_or_else(|| match self.clean_up_hours(&space) {
            Some(hours) if hours != 0.0 => hours * 3_600_000.0,
            _ => CLEAN_UP_AFTER_MS,
        });
        let ids = self.clean_up_candidates(window_id, after, self.now(), Some(&space));
        if ids.is_empty() {
            return 0;
        }
        let entries = self.closed_entries(&ids);
        let private = self.windows.get(window_id).is_some_and(|w| w.incognito);
        self.close_quietly(&ids);
        if private {
            let own = self
                .private_cleaned_tabs
                .entry(window_id.to_owned())
                .or_default();
            own.extend(entries);
            keep_last(own, MAX_CLEANED);
        } else {
            self.cleaned_tabs.extend(entries);
            keep_last(&mut self.cleaned_tabs, MAX_CLEANED);
        }
        ids.len()
    }

    /// The automatic clean-up (Arc's archive): every space, each after its own time, through a main window; a
    /// private window its own.
    pub fn clean_up_inactive_tabs(&mut self) -> usize {
        let main = self
            .window_order
            .iter()
            .find(|id| {
                self.windows
                    .get(*id)
                    .is_some_and(|w| !w.incognito && !w.is_small())
            })
            .cloned();
        let mut runs: Vec<(String, String)> = main
            .map(|m| {
                self.space_order
                    .iter()
                    .map(|s| (m.clone(), s.clone()))
                    .collect()
            })
            .unwrap_or_default();
        runs.extend(
            self.windows
                .values()
                .filter(|w| w.incognito)
                .map(|w| (w.id.clone(), w.space_id.clone())),
        );
        let mut count = 0;
        for (window_id, space_id) in runs {
            if let Some(hours) = self.clean_up_hours(&space_id)
                && self.windows.contains_key(&window_id)
            {
                count += self.clean_up_tabs(&window_id, Some(hours * 3_600_000.0), Some(&space_id));
            }
        }
        count
    }

    /// Puts cleaned-up tabs back: one entry (its tab's id), or every one.
    pub fn restore_cleaned(
        &mut self,
        entry_id: Option<&str>,
        from_window_id: Option<&str>,
    ) -> Option<String> {
        let private_id = from_window_id
            .filter(|w| self.windows.get(*w).is_some_and(|w| w.incognito))
            .map(str::to_owned)
            .or_else(|| {
                let entry = entry_id?;
                self.private_cleaned_tabs
                    .iter()
                    .find(|(_, list)| list.iter().any(|c| c.id == entry))
                    .map(|(id, _)| id.clone())
            });
        let list = match &private_id {
            Some(id) => self
                .private_cleaned_tabs
                .get(id)
                .cloned()
                .unwrap_or_default(),
            None => self.cleaned_tabs.clone(),
        };
        let entries: Vec<ClosedTab> = list
            .iter()
            .filter(|c| entry_id.is_none_or(|e| c.id == e))
            .cloned()
            .collect();
        if entries.is_empty() {
            return None;
        }
        let left: Vec<ClosedTab> = list
            .into_iter()
            .filter(|c| !entries.iter().any(|e| e.id == c.id))
            .collect();
        match &private_id {
            Some(id) => {
                self.private_cleaned_tabs.insert(id.clone(), left);
            }
            None => self.cleaned_tabs = left,
        }
        let mut restored = None;
        for e in entries {
            // A private tab only ever goes back to its own private window.
            let window_id = match &private_id {
                Some(id) => self
                    .windows
                    .get(id)
                    .filter(|w| w.incognito)
                    .map(|_| id.clone()),
                None => self.restore_target(&e.window_id, None),
            };
            let Some(window_id) = window_id else {
                continue;
            };
            if is_incognito_space(&e.tab.space_id) && e.window_id != window_id {
                continue;
            }
            let index = (window_id == e.window_id).then_some(e.index.0.max(0.0) as usize);
            let Some(id) = self
                .restore_snapshots(&window_id, vec![(e.tab.clone(), index)])
                .pop()
            else {
                continue;
            };
            if let (Some(group), Some(list)) = (
                e.group
                    .as_ref()
                    .and_then(|g| self.groups.get(&g.id))
                    .cloned(),
                self.list_of_tab(&id),
            ) && group.space_id == self.tabs[&id].space_id
            {
                let mut members = group.tab_ids.clone();
                members.push(id.clone());
                let block: Vec<String> = list
                    .tab_ids
                    .iter()
                    .filter(|t| members.contains(t))
                    .cloned()
                    .collect();
                let next = TabList {
                    tab_ids: place_block(&list.tab_ids, &block, None),
                    key: list.key,
                };
                if let Some(g) = self.groups.get_mut(&group.id) {
                    g.tab_ids = members;
                }
                sync_group_order(&mut self.groups, &next);
                self.set_list(next);
            }
            if entry_id.is_some() {
                self.activate_in(&id, Some(&window_id));
                restored = Some(id);
            }
        }
        restored
    }

    pub fn close_abandoned_new_tabs(&mut self) {
        let abandoned: Vec<String> = self
            .windows
            .keys()
            .flat_map(|w| self.abandoned_new_tabs(w))
            .collect();
        if !abandoned.is_empty() {
            self.remove_tabs(&abandoned, false);
        }
    }

    /// A closed private window's cleaned-up tabs and site mutes go with it.
    pub(crate) fn forget_closed_private_windows(&mut self) {
        let windows = &self.windows;
        self.private_cleaned_tabs
            .retain(|id, _| windows.contains_key(id));
        self.private_site_mutes
            .retain(|id, _| windows.contains_key(id));
    }
}

/// Private windows' site mutes, by window and host.
pub type PrivateSiteMutes = HashMap<String, HashMap<String, bool>>;
