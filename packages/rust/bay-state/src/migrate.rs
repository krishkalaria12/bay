//! Sessions from older builds into today's shape (lib/persist.ts `migrateProfileSession`): before spaces had that
//! name, a space was a "profile" (`profiles`, `profileOrder`), records named it `profileId`, and its native profile
//! was `dataId`. Closed windows parked their pinned pages outside the tabs (`parkedPins`).

use std::collections::HashSet;

use serde_json::{Map, Value, json};

/// A record that named its space by its old field: the space it belongs to now.
fn located_in_space(value: &mut Value) {
    let Some(record) = value.as_object_mut() else {
        return;
    };
    let old = record.shift_remove("profileId");
    if record.get("spaceId").is_none_or(Value::is_null)
        && let Some(old) = old
    {
        record.insert("spaceId".into(), old);
    }
}

fn each(value: &mut Value, key: &str, f: impl Fn(&mut Value)) {
    if let Some(Value::Array(list)) = value.get_mut(key) {
        list.iter_mut().for_each(f);
    }
}

pub(crate) fn profile_session(session: &mut Value, now: f64) {
    let Some(doc) = session.as_object_mut() else {
        return;
    };
    let profiles = doc
        .shift_remove("profiles")
        .and_then(|p| p.as_object().cloned())
        .unwrap_or_default();
    let mut spaces = Map::new();
    for (id, profile) in profiles {
        let mut space = profile.as_object().cloned().unwrap_or_default();
        let data_id = space.shift_remove("dataId");
        if space.get("profileId").is_none()
            && let Some(data_id) = data_id
        {
            space.insert("profileId".into(), data_id);
            if space.get("sharesSignIns").is_none() {
                space.insert("sharesSignIns".into(), json!(true));
            }
        }
        spaces.insert(id, Value::Object(space));
    }
    doc.insert("spaces".into(), Value::Object(spaces));
    let order = doc
        .shift_remove("profileOrder")
        .unwrap_or_else(|| json!([]));
    doc.insert("spaceOrder".into(), order);
    let parked = doc.shift_remove("parkedPins");

    for key in ["windows", "tabs", "groups"] {
        let list = doc.entry(key).or_insert_with(|| json!([]));
        if let Value::Array(records) = list {
            records.iter_mut().for_each(located_in_space);
        } else {
            *list = json!([]);
        }
    }
    let tab_entry = |entry: &mut Value| {
        if let Some(tab) = entry.get_mut("tab") {
            located_in_space(tab);
        }
    };
    for key in ["closedTabs", "cleanedTabs"] {
        if let Some(Value::Array(list)) = doc.get_mut(key) {
            list.iter_mut().for_each(tab_entry);
        }
    }
    if let Some(Value::Array(list)) = doc.get_mut("closedWindows") {
        for entry in list {
            if let Some(window) = entry.get_mut("window") {
                located_in_space(window);
            }
            each(entry, "tabs", located_in_space);
            each(entry, "groups", located_in_space);
        }
    }
    for key in ["closedGroups", "deletedGroups"] {
        if let Some(Value::Array(list)) = doc.get_mut(key) {
            for entry in list {
                each(entry, "tabs", located_in_space);
            }
        }
    }

    // Closed windows used to park their pinned pages outside the live tabs; their spaces' lists keep them now, with
    // no window showing them.
    let Some(Value::Object(parked)) = parked else {
        return;
    };
    let mut ids: HashSet<String> = doc["tabs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    for (space_id, pins) in parked {
        let mut members: Vec<(String, Vec<String>)> = Vec::new();
        for pin in pins
            .get("tabs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let mut snapshot = pin.clone();
            located_in_space(&mut snapshot);
            let id = snapshot
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if id.is_empty() || ids.contains(&id) {
                continue;
            }
            let group = snapshot
                .get("groupId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let field = |k: &str, default: Value| snapshot.get(k).cloned().unwrap_or(default);
            let mut tab = json!({
                "id": id,
                "windowId": "",
                "spaceId": space_id,
                "url": field("url", json!("")),
                "title": field("title", json!("")),
                "favicon": field("favicon", Value::Null),
                "pinned": group.is_none(),
                "muted": field("muted", json!(false)),
                "zoom": field("zoom", json!(1)),
                "customTitle": field("customTitle", Value::Null),
                "customIcon": field("customIcon", Value::Null),
                "pinnedUrl": field("pinnedUrl", Value::Null),
                "openerId": null,
                "createdAt": now,
                "lastActiveAt": now,
                "unloaded": true,
            });
            for k in ["pinnedRow", "engine", "enginePick"] {
                if let Some(v) = snapshot.get(k) {
                    tab[k] = v.clone();
                }
            }
            if let Some(Value::Array(tabs)) = doc.get_mut("tabs") {
                tabs.push(tab);
            }
            ids.insert(id.clone());
            if let Some(group) = group {
                match members.iter_mut().find(|(g, _)| *g == group) {
                    Some((_, list)) => list.push(id),
                    None => members.push((group, vec![id])),
                }
            }
        }
        for group in pins
            .get("groups")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let gid = group.get("id").and_then(Value::as_str).unwrap_or_default();
            let Some((_, tab_ids)) = members.iter().find(|(g, _)| g == gid) else {
                continue;
            };
            let known = doc["groups"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|g| g.get("id").and_then(Value::as_str) == Some(gid));
            if known {
                continue;
            }
            let mut g = group.clone();
            g["spaceId"] = json!(space_id);
            g["pinned"] = json!(true);
            g["tabIds"] = json!(tab_ids);
            g["createdAt"] = json!(now);
            if let Some(Value::Array(groups)) = doc.get_mut("groups") {
                groups.push(g);
            }
        }
    }
}
