//! Spaces (store/spaces.ts): their looks, their native profiles (sign-ins), making, changing and deleting them.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;

use super::{Browser, DEFAULT_SPACE_ID, NewTab};
use crate::model::{Space, SpaceTheme};
use crate::number::JsNumber;

const DEFAULT_INTENSITY: f64 = 0.5;
const DEFAULT_GRAIN: f64 = 0.3;

/// The preset colours a new space takes in turn when no gradient is free (lib/spaceSwatches.ts).
const COLORS: [&str; 7] = ["blue", "green", "orange", "purple", "red", "yellow", "pink"];

/// Each preset colour's swatch.
pub fn swatch(color: &str) -> Option<&'static str> {
    Some(match color {
        "blue" => "#4691C3",
        "purple" => "#7873AF",
        "pink" => "#D37B8B",
        "red" => "#C1575C",
        "orange" => "#D87249",
        "yellow" => "#E3AC38",
        "green" => "#3EB489",
        "plum" => "#C07A98",
        "neutral" => "#8E8E93",
        _ => return None,
    })
}

/// The theme editor's gradients (lib/spaceTheme.ts THEME_PRESETS).
pub const THEME_PRESETS: [(&str, [&str; 2]); 4] = [
    ("Sunset", ["#FF7E5F", "#FEB47B"]),
    ("Twilight", ["#7F5AF0", "#E84393"]),
    ("Aurora", ["#16F2B3", "#0DB4F7"]),
    ("Dusk", ["#3A6073", "#F3904F"]),
];

/// The gradients a new space takes in turn, each with the preset colour nearest it.
const LOOKS: [(&str, &str); 4] = [
    ("Twilight", "purple"),
    ("Sunset", "orange"),
    ("Aurora", "green"),
    ("Dusk", "blue"),
];

/// yab's emoji for a space: the space picker offers them, and a new space gets one.
pub const SPACE_EMOJI: [&str; 35] = [
    "🏠", "✨", "📁", "🎯", "💡", "🧭", "🛍️", "🛒", "🎁", "🧪", "🔭", "💰", "🧾", "📈", "✈️", "🗺️",
    "🏝️", "📚", "🎧", "🎨", "🪴", "⌨️", "🤝", "🎓", "🏋️", "🍜", "☕️", "🎮", "🍿", "🚀", "💼", "🌱",
    "🧠", "📸", "🗃️",
];

fn theme(colors: &[&str]) -> SpaceTheme {
    SpaceTheme {
        colors: colors.iter().map(|c| (*c).to_owned()).collect(),
        intensity: JsNumber(DEFAULT_INTENSITY),
        grain: JsNumber(DEFAULT_GRAIN),
        extra: Default::default(),
    }
}

fn preset_theme(name: &str) -> SpaceTheme {
    let colors = THEME_PRESETS
        .iter()
        .find(|(n, _)| *n == name)
        .map_or(&[][..], |(_, c)| &c[..]);
    theme(colors)
}

/// A space's look from a preset colour: its swatch, as a theme.
pub fn theme_of_color(color: &str) -> (String, SpaceTheme) {
    (
        color.to_owned(),
        theme(&[swatch(color).unwrap_or("#4691C3")]),
    )
}

pub fn unused_space_color(spaces: &IndexMap<String, Space>) -> String {
    COLORS
        .iter()
        .find(|c| !spaces.values().any(|s| s.color == **c))
        .unwrap_or(&"blue")
        .to_string()
}

/// A new space's look, so no two spaces look alike: the first gradient no space wears, then a theme of a colour no
/// space has. Always a theme, so the space shows as itself over any page.
pub fn unused_space_look(spaces: &IndexMap<String, Space>) -> (String, SpaceTheme) {
    let worn: HashSet<String> = spaces
        .values()
        .filter_map(|s| {
            s.theme
                .as_ref()
                .and_then(Option::as_ref)
                .map(|t| t.colors.join(","))
        })
        .collect();
    LOOKS
        .iter()
        .find(|(name, _)| !worn.contains(&preset_theme(name).colors.join(",")))
        .map_or_else(
            || theme_of_color(&unused_space_color(spaces)),
            |(name, color)| ((*color).to_owned(), preset_theme(name)),
        )
}

/// The native profile a space uses: its own, or the one it shares.
pub fn profile_id_of(space: &Space) -> &str {
    space
        .profile_id
        .as_deref()
        .filter(|p| !p.is_empty())
        .unwrap_or(&space.id)
}

/// The space's engine profile folder name: "" for the default one.
pub fn engine_id_of(space: &Space) -> &str {
    let id = profile_id_of(space);
    if id == DEFAULT_SPACE_ID { "" } else { id }
}

/// What splitting older shared profiles did: each profile's owner and the spaces that used it, and the spaces split
/// off it.
#[derive(Debug, Default)]
pub struct Isolated {
    pub spaces: IndexMap<String, Space>,
    pub detached: HashSet<String>,
    pub owners: Vec<(String, Vec<String>)>,
}

/// Splits older shared profiles without discarding the original owner's native data. A space made to share its
/// sign-ins keeps sharing; only older sharing nobody chose is split.
pub fn isolate_saved_spaces(
    spaces: &IndexMap<String, Space>,
    order: &[String],
    orphaned: &[String],
) -> Isolated {
    let mut groups: IndexMap<String, Vec<String>> = IndexMap::new();
    for id in order {
        let Some(space) = spaces.get(id) else {
            continue;
        };
        groups
            .entry(profile_id_of(space).to_owned())
            .or_default()
            .push(id.clone());
    }
    let mut reserved: HashSet<String> = groups.keys().cloned().collect();
    reserved.extend(spaces.keys().cloned());
    reserved.extend(orphaned.iter().map(|id| {
        if id.is_empty() {
            DEFAULT_SPACE_ID.to_owned()
        } else {
            id.clone()
        }
    }));
    let mut next = spaces.clone();
    let mut detached = HashSet::new();
    let mut owners = Vec::new();
    for (profile, ids) in &groups {
        let owner = if ids.contains(profile) {
            profile.clone()
        } else {
            ids[0].clone()
        };
        owners.push((owner.clone(), ids.clone()));
        for id in ids {
            if *id == owner || spaces[id].shares_sign_ins == Some(true) {
                continue;
            }
            // Its former directory may belong to another space or still be queued for deletion.
            let engine = if id == DEFAULT_SPACE_ID {
                ""
            } else {
                id.as_str()
            };
            let mut native = id.clone();
            if groups.contains_key(id) || orphaned.iter().any(|o| o == engine) {
                native = format!("{id}-isolated");
                let mut suffix = 1;
                while reserved.contains(&native) {
                    native = format!("{id}-isolated-{suffix}");
                    suffix += 1;
                }
            }
            reserved.insert(native.clone());
            let space = next.get_mut(id).expect("listed spaces exist");
            space.profile_id = (native != *id).then_some(native);
            detached.insert(id.clone());
        }
    }
    Isolated {
        spaces: next,
        detached,
        owners,
    }
}

impl Browser {
    /// A new space's icon: one of the emoji no other space has, at random (any of them once all are taken).
    pub(crate) fn unused_space_icon(&self, spaces: &IndexMap<String, Space>) -> String {
        let used: HashSet<&str> = spaces.values().filter_map(|s| s.icon.as_deref()).collect();
        let free: Vec<&str> = SPACE_EMOJI
            .iter()
            .copied()
            .filter(|e| !used.contains(e))
            .collect();
        let from = if free.is_empty() {
            SPACE_EMOJI.to_vec()
        } else {
            free
        };
        from[self.random_below(from.len())].to_owned()
    }

    /// Every space shows an emoji: a saved one without gets a free one.
    pub(crate) fn with_space_emoji(&self, spaces: &mut IndexMap<String, Space>, order: &[String]) {
        for id in order {
            if spaces
                .get(id)
                .is_some_and(|s| s.icon.as_deref().is_none_or(str::is_empty))
            {
                let icon = self.unused_space_icon(spaces);
                if let Some(space) = spaces.get_mut(id) {
                    space.icon = Some(icon);
                }
            }
        }
    }

    /// The engine profile a space's pages run in: "" for the default one.
    pub fn engine_profile(&self, space_id: &str) -> String {
        self.spaces.get(space_id).map_or_else(
            || {
                if space_id == DEFAULT_SPACE_ID {
                    String::new()
                } else {
                    space_id.to_owned()
                }
            },
            |s| engine_id_of(s).to_owned(),
        )
    }

    /// The space that syncs its profile's data: with shared sign-ins several spaces use one profile, and only one may
    /// sync it. The one the profile is named after, else the first using it.
    pub fn owns_profile_data(&self, id: &str) -> bool {
        let Some(space) = self.spaces.get(id) else {
            return false;
        };
        let profile = profile_id_of(space);
        if let Some(named) = self
            .spaces
            .get(profile)
            .filter(|n| profile_id_of(n) == profile)
        {
            return named.id == id;
        }
        self.space_order
            .iter()
            .find(|other| {
                self.spaces
                    .get(*other)
                    .is_some_and(|s| profile_id_of(s) == profile)
            })
            .is_some_and(|first| first == id)
    }

    /// A new space. Without a colour or theme it gets a look no other space has, without an icon a free emoji;
    /// `share_with` names a space whose sign-ins it shares, else it gets its own, signed out.
    pub fn create_space(
        &mut self,
        name: &str,
        color: Option<&str>,
        theme: Option<Option<SpaceTheme>>,
        icon: Option<&str>,
        share_with: Option<&str>,
    ) -> String {
        let source = share_with
            .and_then(|s| self.spaces.get(s))
            .map(|s| profile_id_of(s).to_owned());
        let (color, theme) = if color.is_some() || theme.is_some() {
            (
                color.map_or_else(|| unused_space_color(&self.spaces), str::to_owned),
                theme.flatten(),
            )
        } else {
            let (color, theme) = unused_space_look(&self.spaces);
            (color, Some(theme))
        };
        let name = name.trim();
        let space = Space {
            id: self.new_id("p"),
            name: if name.is_empty() {
                format!("Space {}", self.space_order.len() + 1)
            } else {
                name.to_owned()
            },
            color,
            icon: Some(
                icon.filter(|i| !i.is_empty())
                    .map_or_else(|| self.unused_space_icon(&self.spaces), str::to_owned),
            ),
            created_at: JsNumber(self.now()),
            shares_sign_ins: source.is_some().then_some(true),
            profile_id: source,
            theme: theme.map(Some),
            follow_site: None,
            clean_up_after_hours: None,
            folded: None,
            extra: Default::default(),
        };
        let id = space.id.clone();
        let engine = engine_id_of(&space).to_owned();
        self.spaces.insert(id.clone(), space);
        self.space_order.push(id.clone());
        self.bookmarks.engine_roots(&id, &engine);
        id
    }

    /// Changes the space; clearing its icon leaves the one it has.
    pub fn update_space(&mut self, id: &str, patch: SpacePatch) {
        let Some(space) = self.spaces.get_mut(id) else {
            return;
        };
        if let Some(name) = patch.name {
            space.name = name;
        }
        if let Some(color) = patch.color {
            space.color = color;
        }
        if let Some(icon) = patch.icon.filter(|i| !i.is_empty()) {
            space.icon = Some(icon);
        }
        if let Some(theme) = patch.theme {
            space.theme = Some(theme);
        }
        if let Some(follow) = patch.follow_site {
            space.follow_site = Some(follow);
        }
        if let Some(hours) = patch.clean_up_after_hours {
            space.clean_up_after_hours = Some(hours.map(JsNumber));
        }
        if let Some(folded) = patch.folded {
            space.folded = Some(folded);
        }
    }

    /// The space goes with its tabs; its windows show the default space (another, if it was the default). Its native
    /// profile is queued for deletion unless another space shares it.
    pub fn delete_space(&mut self, id: &str) {
        if !self.spaces.contains_key(id) || self.space_order.len() <= 1 {
            return;
        }
        let space_order: Vec<String> = self
            .space_order
            .iter()
            .filter(|p| *p != id)
            .cloned()
            .collect();
        let fallback = if self.settings.default_space_id() == id {
            space_order[0].clone()
        } else {
            self.settings.default_space_id().to_owned()
        };
        self.settings.forget_space(id, &fallback);
        let engine = engine_id_of(&self.spaces[id]).to_owned();
        // Another space shares its sign-ins: the profile, and its bookmarks, stay theirs.
        let shared = space_order
            .iter()
            .any(|p| engine_id_of(&self.spaces[p]) == engine);
        if !shared && !self.orphaned_profile_data.contains(&engine) {
            self.orphaned_profile_data.push(engine);
        }
        // Its windows show the fallback space: the tab each showed there, else its most recent one, else a new one.
        let windows: Vec<String> = self
            .windows
            .values()
            .filter(|w| w.space_id == id && !w.is_small())
            .map(|w| w.id.clone())
            .collect();
        for w in windows {
            let tab = match self.tab_to_show(&w, &fallback) {
                Some(tab) => Some(tab),
                None => self.with_new_tab(
                    &w,
                    &NewTab {
                        space_id: Some(fallback.clone()),
                        background: true,
                        ..Default::default()
                    },
                ),
            };
            if let Some(window) = self.windows.get_mut(&w) {
                window.space_id.clone_from(&fallback);
            }
            if let Some(tab) = tab {
                self.activate_in(&tab, Some(&w));
            }
        }
        let tabs: Vec<String> = self
            .tabs
            .values()
            .filter(|t| t.space_id == id)
            .map(|t| t.id.clone())
            .collect();
        self.remove_tabs(&tabs, false);
        for w in self.windows.values_mut() {
            w.active_tab_ids.shift_remove(id);
        }
        match self.bookmarks.roots.get(id).cloned() {
            Some(roots) if !shared => self
                .bookmarks
                .remove_tree(&[roots.bar, roots.other], Some(id)),
            _ => {
                self.bookmarks.roots.shift_remove(id);
            }
        }
        self.spaces.shift_remove(id);
        self.space_order = space_order;
        self.history.remove(id);
        self.groups.retain(|_, g| g.space_id != id);
        self.closed_tabs.retain(|c| c.tab.space_id != id);
        self.cleaned_tabs.retain(|c| c.tab.space_id != id);
        self.closed_groups
            .retain(|c| c.tabs.iter().all(|t| t.space_id != id));
        self.deleted_groups
            .retain(|c| c.tabs.iter().all(|t| t.space_id != id));
        self.closed_windows.retain(|c| c.window.space_id != id);
        for c in &mut self.closed_windows {
            c.tabs.retain(|t| t.tab.space_id != id);
        }
        self.pinned_folders.retain(|_, f| f.space_id != id);
        let windows: Vec<String> = self.windows.keys().cloned().collect();
        for w in windows {
            if self.view_tab_ids(&w, None).is_empty() {
                self.new_tab(&w, NewTab::default());
            }
        }
    }

    pub fn reorder_spaces(&mut self, ids: &[String]) {
        let known: Vec<String> = ids
            .iter()
            .filter(|id| self.spaces.contains_key(*id))
            .cloned()
            .collect();
        let rest: Vec<String> = self
            .space_order
            .iter()
            .filter(|id| !known.contains(id))
            .cloned()
            .collect();
        self.space_order = known.into_iter().chain(rest).collect();
    }

    pub fn set_default_space(&mut self, id: &str) {
        if self.spaces.contains_key(id) {
            self.settings.set("defaultSpaceId", id);
        }
    }

    /// The engine deleted a profile's data: it's no longer queued.
    pub fn profile_data_deleted(&mut self, engine_id: &str) {
        self.orphaned_profile_data.retain(|e| e != engine_id);
    }

    /// The spaces' engine profiles, by space id.
    pub fn space_profiles(&self) -> HashMap<String, String> {
        self.spaces
            .values()
            .map(|s| (s.id.clone(), profile_id_of(s).to_owned()))
            .collect()
    }
}

/// What `update_space` changes.
#[derive(Clone, Debug, Default)]
pub struct SpacePatch {
    pub name: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub theme: Option<Option<SpaceTheme>>,
    pub follow_site: Option<bool>,
    /// `Some(None)`: never.
    pub clean_up_after_hours: Option<Option<f64>>,
    pub folded: Option<bool>,
}
