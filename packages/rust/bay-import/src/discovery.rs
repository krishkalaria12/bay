//! A browser's profiles, read from its data folder: Chromium's (`Local State` and its profile folders) and Firefox's
//! (`profiles.ini` and `installs.ini`), each with what it has to import, and Arc's spaces. One copy for every desktop;
//! each host keeps its own table of where browsers live (Application Support, `%LOCALAPPDATA%` and `%APPDATA%`, XDG,
//! Snap and Flatpak) and what only it shows (installed apps, macOS's profile pictures and extensions).
//!
//! A profile is a folder inside the data folder (a registered Firefox one may be anywhere else) that looks like one;
//! a link that leaves the data folder, a `..` and an empty folder are not profiles.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::sessions::{chromium_session_file, firefox_session_file};

/// What a host's profile listing differs in.
pub struct DiscoveryOptions<'a> {
    pub firefox: bool,
    /// Opera keeps its main profile in the data folder itself.
    pub root_is_profile: bool,
    /// The id the data folder gets as a profile (each host names it as it always has).
    pub root_id: &'a str,
    /// Whether Chromium cookies can be imported here (only macOS has the source browser's key for them).
    pub chromium_cookies: bool,
    /// Arc's sidebar, for its spaces and favorites.
    pub arc_sidebar: Option<&'a Path>,
}

fn file(path: &Path) -> bool {
    path.is_file()
}

/// `path` inside `root` (both canonical), and not `root` itself.
fn inside(root: &Path, path: &Path) -> bool {
    path != root && path.starts_with(root)
}

/// A relative folder in the data folder, resolved, or `None` when it leaves it, isn't a folder or is the folder.
fn relative_directory(root: &Path, relative: &Path) -> Option<PathBuf> {
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return None;
    }
    let base = root.canonicalize().ok()?;
    let resolved = root.join(relative).canonicalize().ok()?;
    (inside(&base, &resolved) && resolved.is_dir()).then_some(resolved)
}

fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// What a profile has to import.
pub fn available(profile: &Path, firefox: bool, chromium_cookies: bool) -> Value {
    let has = |names: &[&str]| names.iter().any(|name| file(&profile.join(name)));
    let mut kinds = Vec::new();
    let mut add = |kind: &str, present: bool| {
        if present {
            kinds.push(json!(kind));
        }
    };
    if firefox {
        add("bookmarks", has(&["places.sqlite"]));
        add("history", has(&["places.sqlite"]));
        add("passwords", has(&["logins.json"]));
        add("tabs", firefox_session_file(profile).is_some());
        add("cookies", has(&["cookies.sqlite"]));
    } else {
        add("bookmarks", has(&["Bookmarks", "AccountBookmarks"]));
        add("history", has(&["History"]));
        add("passwords", has(&["Login Data", "Login Data For Account"]));
        add("tabs", chromium_session_file(profile).is_some());
        add(
            "cookies",
            chromium_cookies && has(&["Network/Cookies", "Cookies"]),
        );
        add("autofill", has(&["Web Data"]));
    }
    Value::Array(kinds)
}

/// Whether a Chromium folder looks like a profile: one it has used keeps at least one of these.
fn chromium_profile(path: &Path) -> bool {
    [
        "Preferences",
        "Secure Preferences",
        "Bookmarks",
        "AccountBookmarks",
        "History",
        "Login Data",
        "Login Data For Account",
        "Web Data",
    ]
    .iter()
    .any(|name| file(&path.join(name)))
}

/// An SkColor (ARGB) as `#RRGGBB`; opaque black is Chromium's "no colour".
fn sk_color(value: &Value) -> Option<String> {
    let color = value.as_i64()? as u32;
    (color != 0xFF00_0000).then(|| {
        format!(
            "#{:02X}{:02X}{:02X}",
            (color >> 16) & 0xFF,
            (color >> 8) & 0xFF,
            color & 0xFF
        )
    })
}

fn numbered(value: &str, prefix: &str) -> bool {
    value
        .strip_prefix(prefix)
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit()))
}

fn chromium_profiles(root: &Path, options: &DiscoveryOptions<'_>) -> Vec<Value> {
    let state: Value = std::fs::read_to_string(root.join("Local State"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let profile = state.get("profile").filter(|profile| profile.is_object());
    let info = profile
        .and_then(|profile| profile.get("info_cache"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let order: Vec<String> = profile
        .and_then(|profile| profile.get("profiles_order"))
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let mut last_used = profile
        .map(|profile| string(profile, "last_used"))
        .unwrap_or("")
        .to_owned();

    // Each candidate once, in Chromium's own order, then the rest by name.
    let mut ids: Vec<String> = Vec::new();
    let push = |id: String, ids: &mut Vec<String>| {
        if !ids.contains(&id) {
            ids.push(id);
        }
    };
    for id in order {
        push(id, &mut ids);
    }
    let mut cached: Vec<&String> = info.keys().collect();
    cached.sort();
    for id in cached
        .into_iter()
        .filter(|id| info[id.as_str()].is_object())
    {
        push(id.clone(), &mut ids);
    }
    let mut folders: Vec<String> = std::fs::read_dir(root)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name == "Default" || numbered(name, "Profile "))
                .collect()
        })
        .unwrap_or_default();
    folders.sort();
    for id in folders {
        push(id, &mut ids);
    }
    if options.root_is_profile {
        // Opera's side profiles, each a folder of its own.
        let mut side: Vec<String> = std::fs::read_dir(root.join("_side_profiles"))
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| format!("_side_profiles/{}", entry.file_name().to_string_lossy()))
                    .collect()
            })
            .unwrap_or_default();
        side.sort();
        for id in side {
            push(id, &mut ids);
        }
    }

    let mut paths: Vec<(String, PathBuf)> = Vec::new();
    let root_profile = options.root_is_profile && chromium_profile(root);
    if root_profile && let Ok(path) = root.canonicalize() {
        paths.push((options.root_id.to_owned(), path));
    }
    let mut seen: HashSet<PathBuf> = paths.iter().map(|(_, path)| path.clone()).collect();
    let mut by_id: HashMap<String, PathBuf> = paths.iter().cloned().collect();
    for id in ids {
        if id.contains('\0') {
            continue;
        }
        let Some(path) = relative_directory(root, Path::new(&id)) else {
            continue;
        };
        if !chromium_profile(&path) {
            continue;
        }
        // An alias of a listed profile still names it, for the last-used default.
        by_id.entry(id.clone()).or_insert_with(|| path.clone());
        if seen.insert(path.clone()) {
            paths.push((id, path));
        }
    }
    if !by_id.contains_key(&last_used) {
        last_used = if by_id.contains_key("Default") {
            "Default".to_owned()
        } else if root_profile {
            options.root_id.to_owned()
        } else {
            String::new()
        };
    }
    let default = by_id.get(&last_used);

    paths
        .into_iter()
        .map(|(id, path)| {
            let metadata = info
                .get(&id)
                .or_else(|| {
                    (id == options.root_id)
                        .then(|| info.get("Default"))
                        .flatten()
                })
                .cloned()
                .unwrap_or(Value::Null);
            let name = string(&metadata, "name");
            let mut profile = Map::new();
            profile.insert(
                "name".into(),
                json!(if !name.is_empty() {
                    name.to_owned()
                } else if id == options.root_id {
                    "Default".to_owned()
                } else {
                    id.clone()
                }),
            );
            profile.insert("path".into(), json!(path.to_string_lossy()));
            let email = string(&metadata, "user_name");
            if !email.is_empty() {
                profile.insert("email".into(), json!(email));
            }
            if let Some(color) = metadata
                .get("profile_highlight_color")
                .or_else(|| metadata.get("default_avatar_fill_color"))
                .and_then(sk_color)
            {
                profile.insert("color".into(), json!(color));
            }
            profile.insert("isDefault".into(), json!(default == Some(&path)));
            profile.insert(
                "available".into(),
                available(&path, false, options.chromium_cookies),
            );
            profile.insert("id".into(), json!(id));
            Value::Object(profile)
        })
        .collect()
}

type Ini = BTreeMap<String, BTreeMap<String, String>>;

/// An INI file's sections (a BOM, comments, blank lines and unsectioned keys ignored).
fn ini(path: &Path) -> Ini {
    let mut sections = Ini::new();
    let Ok(text) = std::fs::read_to_string(path) else {
        return sections;
    };
    let mut section = String::new();
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(rest) = line.strip_prefix('[') {
            section = rest
                .strip_suffix(']')
                .map(str::trim)
                .unwrap_or("")
                .to_owned();
            continue;
        }
        if let (false, Some((key, value))) = (section.is_empty(), line.split_once('=')) {
            sections
                .entry(section.clone())
                .or_default()
                .insert(key.trim().to_owned(), value.trim().to_owned());
        }
    }
    sections
}

/// A registered Firefox profile's folder: relative ones must stay in the data folder; an absolute one (which
/// Firefox supports) only has to exist.
fn registered(root: &Path, text: &str, absolute: bool) -> Option<PathBuf> {
    if text.is_empty() || text.contains('\0') {
        return None;
    }
    let path = Path::new(text);
    if !absolute {
        return relative_directory(root, path);
    }
    (path.is_absolute() && path.is_dir())
        .then(|| path.canonicalize().ok())
        .flatten()
}

fn firefox_profiles(root: &Path) -> Vec<Value> {
    let sections = ini(&root.join("profiles.ini"));
    let installs = ini(&root.join("installs.ini"));
    let mut install_defaults = HashSet::new();
    let defaults = sections
        .iter()
        .filter(|(name, _)| name.starts_with("Install"))
        .chain(installs.iter())
        .filter_map(|(_, values)| values.get("Default"));
    for text in defaults {
        if let Some(path) = registered(root, text, Path::new(text).is_absolute()) {
            install_defaults.insert(path);
        }
    }
    let mut profiles: Vec<(String, String, PathBuf)> = Vec::new();
    let mut profile_defaults = HashSet::new();
    let mut seen = HashSet::new();
    let mut ordered: Vec<(&String, &BTreeMap<String, String>)> = sections
        .iter()
        .filter(|(name, _)| numbered(name, "Profile"))
        .collect();
    ordered.sort_by_key(|(name, _)| name["Profile".len()..].parse::<u64>().unwrap_or(u64::MAX));
    for (id, values) in ordered {
        let get = |key: &str| values.get(key).map(String::as_str).unwrap_or("");
        let relative = get("IsRelative");
        if !matches!(relative, "" | "0" | "1") {
            continue;
        }
        let Some(path) = registered(root, get("Path"), relative == "0") else {
            continue;
        };
        if get("Default") == "1" {
            profile_defaults.insert(path.clone());
        }
        if seen.insert(path.clone()) {
            let name = if get("Name").is_empty() {
                id.clone()
            } else {
                get("Name").to_owned()
            };
            profiles.push((id.clone(), name, path));
        }
    }
    // A stale install default must not hide a valid profile-level default.
    let defaults = if profiles
        .iter()
        .any(|(_, _, path)| install_defaults.contains(path))
    {
        install_defaults
    } else {
        profile_defaults
    };
    profiles
        .into_iter()
        .map(|(id, name, path)| {
            json!({
                "id": id,
                "name": name,
                "path": path.to_string_lossy(),
                "isDefault": defaults.contains(&path),
                "available": available(&path, true, false),
            })
        })
        .collect()
}

/// How many links a sidebar node holds.
fn links(node: &Value) -> u64 {
    if node.get("type").and_then(Value::as_str) == Some("url") {
        return 1;
    }
    node.get("children")
        .and_then(Value::as_array)
        .map_or(0, |children| children.iter().map(links).sum())
}

/// Arc's spaces and favorites, on the profiles they belong to. Arc's own tabs are its spaces', not a session's.
fn attach_arc(profiles: &mut [Value], sidebar: &Path) {
    let Ok(sidebar) = crate::arc_sidebar(sidebar) else {
        return;
    };
    let spaces = sidebar
        .get("spaces")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for profile in profiles.iter_mut() {
        let id = profile["id"].as_str().unwrap_or("").to_owned();
        let mut summaries = Vec::new();
        for space in spaces
            .iter()
            .filter(|space| space.get("profileId").and_then(Value::as_str) == Some(&id))
        {
            let mut summary = Map::new();
            for key in ["id", "name", "color", "emoji", "icon"] {
                if let Some(value) = space.get(key).filter(|value| !value.is_null()) {
                    summary.insert(key.into(), value.clone());
                }
            }
            let pinned = space
                .get("pinned")
                .and_then(Value::as_array)
                .map_or(0, |nodes| nodes.iter().map(links).sum::<u64>());
            summary.insert("pinnedCount".into(), json!(pinned));
            summary.insert(
                "tabCount".into(),
                json!(
                    space
                        .get("tabs")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len)
                ),
            );
            summaries.push(Value::Object(summary));
        }
        let available = profile["available"]
            .as_array_mut()
            .expect("profiles list what they have");
        available.retain(|kind| kind != "tabs");
        if !summaries.is_empty() {
            available.extend(["spaces", "pinnedTabs", "tabs"].map(|kind| json!(kind)));
        }
        if sidebar
            .get("favorites")
            .and_then(|favorites| favorites.get(&id))
            .and_then(Value::as_array)
            .is_some_and(|favorites| !favorites.is_empty())
        {
            available.push(json!("favorites"));
        }
        if !summaries.is_empty() {
            profile["spaces"] = Value::Array(summaries);
        }
    }
}

/// A browser's profiles in its data folder, the default first:
/// `[{id, name, path, email?, color?, isDefault, available, spaces?}]`.
pub fn profiles(root: &Path, options: &DiscoveryOptions<'_>) -> Value {
    let mut profiles = if options.firefox {
        firefox_profiles(root)
    } else {
        chromium_profiles(root, options)
    };
    if let Some(sidebar) = options.arc_sidebar {
        attach_arc(&mut profiles, sidebar);
    }
    profiles.sort_by_key(|profile| !profile["isDefault"].as_bool().unwrap_or(false));
    Value::Array(profiles)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(firefox: bool) -> DiscoveryOptions<'static> {
        DiscoveryOptions {
            firefox,
            root_is_profile: false,
            root_id: "Root",
            chromium_cookies: false,
            arc_sidebar: None,
        }
    }

    fn put(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn ids(profiles: &Value) -> Vec<&str> {
        profiles
            .as_array()
            .unwrap()
            .iter()
            .map(|profile| profile["id"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn chromium_profiles_follow_local_state_and_stay_in_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Chrome");
        put(&root.join("Default/Preferences"), "{}");
        put(&root.join("Profile 1/History"), "");
        std::fs::create_dir_all(root.join("Profile 2")).unwrap();
        put(&dir.path().join("elsewhere/Preferences"), "{}");
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.path().join("elsewhere"), root.join("Profile 3")).unwrap();
        put(
            &root.join("Local State"),
            &json!({"profile": {"last_used": "Profile 1", "info_cache": {
                "Profile 1": {"name": "Work", "user_name": "w@example.test", "profile_highlight_color": -16776961},
                "../elsewhere": {},
            }}})
            .to_string(),
        );
        let profiles = profiles(&root, &options(false));
        // The empty folder, the link out and the `..` aren't profiles; the default comes first.
        assert_eq!(ids(&profiles), ["Profile 1", "Default"]);
        assert_eq!(profiles[0]["email"], "w@example.test");
        assert_eq!(profiles[0]["color"], "#0000FF");
        assert_eq!(profiles[0]["isDefault"], true);
        assert_eq!(profiles[1]["name"], "Default");
    }

    #[test]
    fn a_root_profile_needs_profile_data() {
        let dir = tempfile::tempdir().unwrap();
        let opera = DiscoveryOptions {
            root_is_profile: true,
            ..options(false)
        };
        put(&dir.path().join("Local State"), "{}");
        assert_eq!(profiles(dir.path(), &opera), json!([]));
        put(&dir.path().join("Bookmarks"), "{}");
        put(&dir.path().join("_side_profiles/abc/Preferences"), "{}");
        let found = profiles(dir.path(), &opera);
        assert_eq!(ids(&found), ["Root", "_side_profiles/abc"]);
        assert_eq!(found[0]["isDefault"], true);
    }

    #[test]
    fn firefox_install_defaults_win_unless_stale() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("a.default")).unwrap();
        std::fs::create_dir_all(root.join("b.release")).unwrap();
        put(&root.join("b.release/places.sqlite"), "");
        let registry = "\u{feff}[Profile0]\nName=Main\nIsRelative=1\nPath=a.default\nDefault=1\n\
                        [Profile1]\nName=Release\nPath=b.release\n[Profile2]\nPath=../x\n[Profile3]\nIsRelative=no\nPath=a.default\n";
        put(
            &root.join("profiles.ini"),
            &format!("{registry}[InstallX]\nDefault=b.release\n"),
        );
        let found = profiles(root, &options(true));
        assert_eq!(ids(&found), ["Profile1", "Profile0"]);
        assert_eq!(found[0]["available"], json!(["bookmarks", "history"]));
        put(
            &root.join("profiles.ini"),
            &format!("{registry}[InstallX]\nDefault=missing\n"),
        );
        assert_eq!(
            ids(&profiles(root, &options(true))),
            ["Profile0", "Profile1"]
        );
    }

    #[test]
    fn tabs_need_a_session_file_and_chromium_cookies_the_option() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path();
        std::fs::create_dir_all(profile.join("Sessions")).unwrap();
        put(&profile.join("Cookies"), "");
        assert_eq!(available(profile, false, false), json!([]));
        put(&profile.join("Sessions/Session_13300000000000000"), "");
        assert_eq!(available(profile, false, true), json!(["tabs", "cookies"]));
    }
}
