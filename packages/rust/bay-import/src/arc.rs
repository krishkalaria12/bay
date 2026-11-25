//! Arc's sidebar (`StorableSidebar.json`): its spaces, each with pinned tabs and folders, unpinned tabs, icon and
//! colours, and each profile's favourites. Ported from `packages/import/portable/Arc.cpp`, answer for answer.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde_json::{Map, Value, json};

use crate::failure::{Failure, Result};
use crate::readers::read_text;

fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn profile_id(value: &Value) -> String {
    let Some(object) = value.as_object() else {
        return String::new();
    };
    if object.contains_key("default") {
        return "Default".into();
    }
    object
        .get("custom")
        .filter(|custom| custom.is_object())
        .and_then(|custom| custom.get("_0"))
        .and_then(|first| string(first, "directoryBasename"))
        .unwrap_or_default()
}

/// Arc's dictionaries written as `[key, value, key, value…]`.
fn pairs(value: Option<&Value>) -> Vec<(&Value, &Value)> {
    value
        .and_then(Value::as_array)
        .map(|list| {
            list.as_chunks::<2>()
                .0
                .iter()
                .map(|[key, value]| (key, value))
                .collect()
        })
        .unwrap_or_default()
}

fn tab(item: &Value, pinned: bool) -> Option<Map<String, Value>> {
    let value = item.get("data")?.get("tab").filter(|tab| tab.is_object())?;
    let url = string(value, "savedURL").filter(|url| !url.is_empty())?;
    let mut result = Map::new();
    result.insert("url".into(), json!(url));
    result.insert(
        "title".into(),
        json!(string(value, "savedTitle").unwrap_or_default()),
    );
    result.insert("pinned".into(), json!(pinned));
    result.insert("active".into(), json!(false));
    result.insert("windowIndex".into(), json!(0));
    if let Some(title) = string(item, "title").filter(|title| !title.is_empty()) {
        result.insert("customTitle".into(), json!(title));
    }
    if let Some(time) = value.get("timeLastActiveAt").and_then(Value::as_f64) {
        result.insert("lastActive".into(), json!((time + 978_307_200.0) * 1000.0));
    }
    Some(result)
}

fn color(value: &Value) -> Option<String> {
    let channel = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_f64)
            .map(|channel| (channel.clamp(0.0, 1.0) * 255.0 + 0.5) as u32)
    };
    Some(format!(
        "#{:02X}{:02X}{:02X}",
        channel("red")?,
        channel("green")?,
        channel("blue")?
    ))
}

fn values(value: &Value) -> Vec<&Value> {
    match value {
        Value::Array(list) => list.iter().collect(),
        Value::Object(map) => map.values().collect(),
        _ => Vec::new(),
    }
}

fn first_color(theme: &Value, depth: u32) -> Option<String> {
    if depth >= 12 {
        return None;
    }
    color(theme).or_else(|| {
        values(theme)
            .into_iter()
            .find_map(|value| first_color(value, depth + 1))
    })
}

fn mid_color(theme: &Value) -> Option<String> {
    theme
        .get("primaryColorPalette")
        .filter(|palette| palette.is_object())
        .and_then(|palette| palette.get("midTone"))
        .and_then(color)
        .or_else(|| first_color(theme, 0))
}

fn gradient(theme: &Value, depth: u32) -> Vec<Value> {
    if depth >= 12 {
        return Vec::new();
    }
    if let Some(bases) = theme.get("baseColors").and_then(Value::as_array) {
        return bases
            .iter()
            .filter_map(|value| first_color(value, 0))
            .map(Value::from)
            .collect();
    }
    values(theme)
        .into_iter()
        .map(|value| gradient(value, depth + 1))
        .find(|found| !found.is_empty())
        .unwrap_or_default()
}

struct Walker<'a> {
    items: BTreeMap<String, &'a Value>,
}

impl Walker<'_> {
    fn children(&self, id: &str) -> Vec<String> {
        self.items[id]
            .get("childrenIds")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn walk(
        &self,
        id: &str,
        seen: &mut BTreeSet<String>,
        tree: bool,
        pinned: bool,
        depth: u32,
    ) -> Vec<Value> {
        let mut output = Vec::new();
        if depth >= 64 || !self.items.contains_key(id) || !seen.insert(id.to_owned()) {
            return output;
        }
        for child in self.children(id) {
            let Some(item) = self.items.get(&child).copied() else {
                continue;
            };
            if let Some(link) = tab(item, pinned) {
                if !seen.insert(child.clone()) {
                    continue;
                }
                if tree {
                    let title = link
                        .get("customTitle")
                        .or_else(|| link.get("title"))
                        .cloned()
                        .unwrap_or_else(|| json!(""));
                    let mut bookmark = Map::new();
                    bookmark.insert("type".into(), json!("url"));
                    bookmark.insert("title".into(), title);
                    bookmark.insert("url".into(), link["url"].clone());
                    if link.contains_key("customTitle") {
                        bookmark.insert("pageTitle".into(), link["title"].clone());
                    }
                    output.push(Value::Object(bookmark));
                } else {
                    output.push(Value::Object(link));
                }
            } else {
                let nested = self.walk(&child, seen, tree, pinned, depth + 1);
                if tree
                    && item
                        .get("data")
                        .is_some_and(|data| data.get("list").is_some())
                {
                    let title = string(item, "title").unwrap_or_else(|| "Folder".into());
                    output.push(json!({
                        "type": "folder",
                        "title": if title.is_empty() { "Folder".to_owned() } else { title },
                        "children": nested,
                    }));
                } else {
                    output.extend(nested);
                }
            }
        }
        output
    }
}

pub fn arc_sidebar(file: &Path) -> Result<Value> {
    let document: Value = serde_json::from_str(&read_text(file)?)
        .map_err(|_| Failure::new("unreadable", "Arc's sidebar file isn't valid JSON"))?;
    let mut result = json!({"spaces": [], "favorites": {}});
    let containers = document
        .get("sidebar")
        .and_then(|sidebar| sidebar.get("containers"))
        .and_then(Value::as_array);
    let Some(container) = containers.into_iter().flatten().find(|candidate| {
        candidate.is_object()
            && (candidate.get("spaces").is_some() || candidate.get("items").is_some())
    }) else {
        return Ok(result);
    };
    let mut walker = Walker {
        items: BTreeMap::new(),
    };
    for item in container
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(id) = item.get("id").and_then(Value::as_str) {
            walker.items.insert(id.to_owned(), item);
        }
    }
    let mut untitled = 0;
    for space in container
        .get("spaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = space.get("id").filter(|_| space.is_object()) else {
            continue;
        };
        let mut roots: BTreeMap<String, String> = BTreeMap::new();
        for (key, value) in pairs(space.get("newContainerIDs")) {
            if let (Some(first), Some(value)) = (
                key.as_object().and_then(|key| key.keys().next()),
                value.as_str(),
            ) {
                roots
                    .entry(first.clone())
                    .or_insert_with(|| value.to_owned());
            }
        }
        for (key, value) in pairs(space.get("containerIDs")) {
            if let (Some(key), Some(value)) = (key.as_str(), value.as_str()) {
                roots
                    .entry(key.to_owned())
                    .or_insert_with(|| value.to_owned());
            }
        }
        let mut seen = BTreeSet::new();
        let mut profile = profile_id(space.get("profile").unwrap_or(&json!({})));
        if profile.is_empty() {
            profile = "Default".into();
        }
        let mut title = string(space, "title").unwrap_or_default();
        if title.is_empty() {
            untitled += 1;
            title = format!("Space {untitled}");
        }
        let pinned = roots
            .get("pinned")
            .map(|root| walker.walk(root, &mut seen, true, true, 0))
            .unwrap_or_default();
        let tabs = roots
            .get("unpinned")
            .map(|root| walker.walk(root, &mut seen, false, false, 0))
            .unwrap_or_default();
        let mut out = Map::new();
        out.insert("id".into(), id.clone());
        out.insert("name".into(), json!(title));
        out.insert("profileId".into(), json!(profile));
        out.insert("pinned".into(), Value::Array(pinned));
        out.insert("tabs".into(), Value::Array(tabs));
        let info = space
            .get("customInfo")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let icon = info.get("iconType").cloned().unwrap_or_else(|| json!({}));
        if let Some(emoji) = icon.get("emoji_v2").filter(|emoji| emoji.is_string()) {
            out.insert("emoji".into(), emoji.clone());
        } else if let Some(emoji) = icon.get("emoji") {
            if emoji.is_string() {
                out.insert("emoji".into(), emoji.clone());
            } else if let Some(point) = emoji
                .as_u64()
                .and_then(|point| u32::try_from(point).ok())
                .and_then(char::from_u32)
            {
                out.insert("emoji".into(), json!(point.to_string()));
            }
        }
        if let Some(name) = icon.get("icon").filter(|name| name.is_string()) {
            out.insert("icon".into(), name.clone());
        }
        let theme = info.get("windowTheme").cloned().unwrap_or(Value::Null);
        if let Some(color) = mid_color(&theme) {
            out.insert("color".into(), json!(color));
        }
        let colors = gradient(&theme, 0);
        if !colors.is_empty() {
            out.insert("colors".into(), Value::Array(colors));
        }
        result["spaces"]
            .as_array_mut()
            .expect("a list")
            .push(Value::Object(out));
    }
    for (key, value) in pairs(container.get("topAppsContainerIDs")) {
        let profile = profile_id(key);
        let Some(root) = value.as_str().filter(|_| !profile.is_empty()) else {
            continue;
        };
        let mut seen = BTreeSet::new();
        let tabs = walker.walk(root, &mut seen, false, true, 0);
        if !tabs.is_empty() {
            result["favorites"][profile] = Value::Array(tabs);
        }
    }
    Ok(result)
}
