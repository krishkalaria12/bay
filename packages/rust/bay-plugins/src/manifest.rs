//! A plugin's `manifest.json`: what it is, what it may reach, the settings it asks for and what it adds to Bay. The
//! hosts hand the app the manifest as [`check`] returns it, with every default filled in, so the app reads one shape.

use serde::Serialize;
use serde_json::{Map, Value};

/// The manifest format this Bay reads.
pub const MANIFEST_VERSION: u64 = 1;

/// How many of each thing a plugin can add.
const MAX_ITEMS: usize = 20;
const MAX_HOSTS: usize = 20;
const MAX_KEYWORDS: usize = 10;
const MAX_THEME_COLORS: usize = 3;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// The script the sandbox runs, relative to the plugin's folder.
    pub main: String,
    pub permissions: Permissions,
    pub settings: Vec<Setting>,
    pub contributes: Contributes,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    /// Origins the plugin may fetch from through Bay: `https://host`, `https://*.host`, an optional port.
    pub hosts: Vec<String>,
    /// The address and title of the page a command runs on.
    pub tabs: bool,
    /// Deciding where links from other apps open.
    pub links: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    pub key: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// "text", "secret" (kept in the system's keychain), "toggle" or "choice".
    #[serde(rename = "type")]
    pub kind: String,
    /// The value before the person sets one; null for a secret.
    pub default: Value,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<SettingOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SettingOption {
    pub value: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contributes {
    pub commands: Vec<Command>,
    pub toolbar: Vec<ToolbarButton>,
    pub tab_menu: Vec<MenuItem>,
    pub sidebar_views: Vec<SidebarView>,
    pub live_sources: Vec<LiveSource>,
    pub themes: Vec<Theme>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub id: String,
    pub title: String,
    pub icon: String,
    pub keywords: Vec<String>,
    /// Offered only on a web page.
    pub page: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolbarButton {
    pub id: String,
    pub title: String,
    pub icon: String,
    /// What a click does: run a command, or open a sidebar view. Exactly one is set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MenuItem {
    pub id: String,
    pub title: String,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SidebarView {
    pub id: String,
    pub title: String,
    pub icon: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LiveSource {
    pub id: String,
    pub name: String,
    /// The live folder kind it fills: "pullRequests" or "documents".
    pub kind: String,
    /// The site its items come from, for the folder's icon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Theme {
    pub id: String,
    pub name: String,
    /// One to three colours, "#RRGGBB".
    pub colors: Vec<String>,
}

/// Why a manifest was refused, in a sentence for Settings.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal(pub String);

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn refuse<T>(message: impl Into<String>) -> Result<T, Refusal> {
    Err(Refusal(message.into()))
}

/// A plugin's id: its folder's name and part of its sandbox's address.
pub fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();

    (2..=40).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && !id.ends_with('-')
}

/// The id of something a plugin adds (a command, a button, a setting's key…).
fn valid_item_id(id: &str) -> bool {
    let bytes = id.as_bytes();

    (1..=40).contains(&bytes.len())
        && bytes[0].is_ascii_alphabetic()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_')
}

/// A symbol's name, as the app's icons take them ("hand.wave", "tray.full").
fn valid_icon(icon: &str) -> bool {
    (1..=60).contains(&icon.len())
        && icon
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.')
}

fn valid_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// A host pattern as Bay keeps it, or None if it isn't one: lowercase, scheme and host (with `*.` for subdomains)
/// and a port when given. Plain http only for this computer.
pub fn host_pattern(pattern: &str) -> Option<String> {
    let lower = pattern.trim().to_ascii_lowercase();
    let (scheme, rest) = lower.split_once("://")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);

    if rest.is_empty() || rest.contains(['/', '?', '#', '@', '\\']) {
        return None;
    }

    let (host, port) = match rest.strip_prefix("[::1]") {
        Some(port) => ("[::1]", port),
        None => rest.find(':').map_or((rest, ""), |i| rest.split_at(i)),
    };
    let port = match port {
        "" => None,
        port => Some(
            port.strip_prefix(':')?
                .parse::<u16>()
                .ok()
                .filter(|p| *p > 0)?,
        ),
    };
    let bare = host.strip_prefix("*.").unwrap_or(host);
    let local = matches!(bare, "localhost" | "127.0.0.1" | "[::1]");

    if bare.is_empty()
        || bare.contains('*')
        || (host.starts_with("*.") && local)
        || !(local
            || bare.split('.').count() >= 2
                && bare.split('.').all(|label| {
                    !label.is_empty()
                        && label.len() <= 63
                        && label
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                }))
    {
        return None;
    }

    match scheme {
        "https" => {}
        "http" if local => {}
        _ => return None,
    }

    Some(match port {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    })
}

struct Fields<'a> {
    map: &'a Map<String, Value>,
    what: String,
}

impl<'a> Fields<'a> {
    fn new(value: &'a Value, what: impl Into<String>) -> Result<Self, Refusal> {
        let what = what.into();
        match value.as_object() {
            Some(map) => Ok(Self { map, what }),
            None => refuse(format!("{what} isn't an object")),
        }
    }

    /// Fails on a field the format doesn't have, which is usually a typo.
    fn only(&self, known: &[&str]) -> Result<(), Refusal> {
        match self.map.keys().find(|key| !known.contains(&key.as_str())) {
            Some(key) => refuse(format!("{} has an unknown field \"{key}\"", self.what)),
            None => Ok(()),
        }
    }

    fn text(&self, key: &str, max: usize) -> Result<Option<String>, Refusal> {
        match self.map.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => {
                let text = text.trim();
                if text.is_empty() {
                    return Ok(None);
                }
                if text.chars().count() > max || text.chars().any(char::is_control) {
                    return refuse(format!(
                        "{}'s {key} is longer than {max} characters or has control characters",
                        self.what
                    ));
                }
                Ok(Some(text.to_owned()))
            }
            Some(_) => refuse(format!("{}'s {key} isn't text", self.what)),
        }
    }

    fn required(&self, key: &str, max: usize) -> Result<String, Refusal> {
        self.text(key, max)?
            .map_or_else(|| refuse(format!("{} has no {key}", self.what)), Ok)
    }

    fn flag(&self, key: &str) -> Result<bool, Refusal> {
        match self.map.get(key) {
            None | Some(Value::Null) => Ok(false),
            Some(Value::Bool(on)) => Ok(*on),
            Some(_) => refuse(format!("{}'s {key} isn't true or false", self.what)),
        }
    }

    fn list(&self, key: &str, max: usize) -> Result<&'a [Value], Refusal> {
        match self.map.get(key) {
            None | Some(Value::Null) => Ok(&[]),
            Some(Value::Array(items)) if items.len() <= max => Ok(items),
            Some(Value::Array(_)) => refuse(format!("{} has more than {max} {key}", self.what)),
            Some(_) => refuse(format!("{}'s {key} isn't a list", self.what)),
        }
    }

    fn id(&self) -> Result<String, Refusal> {
        let id = self.required("id", 40)?;
        if !valid_item_id(&id) {
            return refuse(format!(
                "{}'s id \"{id}\" should be letters, digits, - or _",
                self.what
            ));
        }
        Ok(id)
    }

    fn icon(&self, fallback: &str) -> Result<String, Refusal> {
        let icon = self
            .text("icon", 60)?
            .unwrap_or_else(|| fallback.to_owned());
        if !valid_icon(&icon) {
            return refuse(format!(
                "{}'s icon \"{icon}\" isn't a symbol name",
                self.what
            ));
        }
        Ok(icon)
    }
}

/// Each id once in a list.
fn unique<'a>(ids: impl IntoIterator<Item = &'a String>, what: &str) -> Result<(), Refusal> {
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(id) {
            return refuse(format!("Two {what} have the id \"{id}\""));
        }
    }
    Ok(())
}

/// A relative path inside the plugin's folder, made of plain names.
pub fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 512
        && !path.starts_with("__bay/")
        && path.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.starts_with('.')
                && !part.contains(['\\', ':', '\0'])
        })
}

/// The manifest in `text`, checked and with its defaults filled in.
pub fn check(text: &str) -> Result<Manifest, Refusal> {
    let value: Value = serde_json::from_str(text)
        .map_err(|error| Refusal(format!("manifest.json isn't JSON: {error}")))?;
    let root = Fields::new(&value, "The manifest")?;
    root.only(&[
        "manifestVersion",
        "id",
        "name",
        "version",
        "description",
        "author",
        "main",
        "permissions",
        "settings",
        "contributes",
    ])?;

    match value.get("manifestVersion").and_then(Value::as_u64) {
        Some(MANIFEST_VERSION) => {}
        Some(other) => {
            return refuse(format!(
                "The manifest is version {other}; this Bay reads version {MANIFEST_VERSION}"
            ));
        }
        None => return refuse("The manifest has no manifestVersion"),
    }

    let id = root.required("id", 40)?;
    if !valid_id(&id) {
        return refuse(format!(
            "The id \"{id}\" should be 2–40 lowercase letters, digits and dashes, starting with a letter"
        ));
    }

    let main = root
        .text("main", 512)?
        .unwrap_or_else(|| "main.js".to_owned());
    if !valid_path(&main) || !main.ends_with(".js") {
        return refuse(format!(
            "main \"{main}\" isn't a .js file in the plugin's folder"
        ));
    }

    let permissions = match value.get("permissions") {
        None | Some(Value::Null) => Permissions::default(),
        Some(p) => {
            let p = Fields::new(p, "permissions")?;
            p.only(&["hosts", "tabs", "links"])?;
            let mut hosts = Vec::new();
            for host in p.list("hosts", MAX_HOSTS)? {
                let pattern = host.as_str().and_then(host_pattern).map_or_else(
                    || refuse(format!("The host {host} should look like https://api.example.com or https://*.example.com")),
                    Ok,
                )?;
                if !hosts.contains(&pattern) {
                    hosts.push(pattern);
                }
            }
            Permissions {
                hosts,
                tabs: p.flag("tabs")?,
                links: p.flag("links")?,
            }
        }
    };

    let mut settings = Vec::new();
    for (i, setting) in root.list("settings", MAX_ITEMS)?.iter().enumerate() {
        settings.push(check_setting(setting, i)?);
    }
    unique(settings.iter().map(|s| &s.key), "settings")?;

    let contributes = match value.get("contributes") {
        None | Some(Value::Null) => Contributes::default(),
        Some(c) => check_contributes(c)?,
    };

    Ok(Manifest {
        name: root.required("name", 60)?,
        version: root.required("version", 20)?,
        description: root.text("description", 300)?.unwrap_or_default(),
        author: root.text("author", 100)?,
        id,
        main,
        permissions,
        settings,
        contributes,
    })
}

fn check_setting(value: &Value, index: usize) -> Result<Setting, Refusal> {
    let s = Fields::new(value, format!("Setting {}", index + 1))?;
    s.only(&["key", "title", "description", "type", "default", "options"])?;
    let key = s.required("key", 40)?;
    if !valid_item_id(&key) {
        return refuse(format!(
            "The setting key \"{key}\" should be letters, digits, - or _"
        ));
    }
    let s = Fields {
        map: s.map,
        what: format!("The setting \"{key}\""),
    };
    let kind = s.required("type", 10)?;
    let default = value.get("default").cloned().unwrap_or(Value::Null);
    let mut options = Vec::new();

    let default = match kind.as_str() {
        "text" => match default {
            Value::Null => Value::String(String::new()),
            Value::String(text) if text.chars().count() <= 4096 => Value::String(text),
            _ => return refuse(format!("{}'s default isn't text", s.what)),
        },
        "secret" => {
            if !default.is_null() {
                return refuse(format!(
                    "{} is a secret, so it can't have a default",
                    s.what
                ));
            }
            Value::Null
        }
        "toggle" => match default {
            Value::Null => Value::Bool(false),
            Value::Bool(on) => Value::Bool(on),
            _ => return refuse(format!("{}'s default isn't true or false", s.what)),
        },
        "choice" => {
            for (i, option) in s.list("options", MAX_ITEMS)?.iter().enumerate() {
                let o = Fields::new(option, format!("{}'s option {}", s.what, i + 1))?;
                o.only(&["value", "title"])?;
                options.push(SettingOption {
                    value: o.required("value", 100)?,
                    title: o.required("title", 60)?,
                });
            }
            if options.is_empty() {
                return refuse(format!("{} is a choice with no options", s.what));
            }
            unique(options.iter().map(|o| &o.value), "options")?;
            match default {
                Value::Null => Value::String(options[0].value.clone()),
                Value::String(choice) if options.iter().any(|o| o.value == choice) => {
                    Value::String(choice)
                }
                _ => return refuse(format!("{}'s default isn't one of its options", s.what)),
            }
        }
        other => {
            return refuse(format!(
                "{}'s type \"{other}\" should be text, secret, toggle or choice",
                s.what
            ));
        }
    };

    Ok(Setting {
        title: s.required("title", 60)?,
        description: s.text("description", 300)?,
        key,
        kind,
        default,
        options,
    })
}

fn check_contributes(value: &Value) -> Result<Contributes, Refusal> {
    let c = Fields::new(value, "contributes")?;
    c.only(&[
        "commands",
        "toolbar",
        "tabMenu",
        "sidebarViews",
        "liveSources",
        "themes",
    ])?;
    let mut out = Contributes::default();

    for (i, command) in c.list("commands", MAX_ITEMS)?.iter().enumerate() {
        let f = Fields::new(command, format!("Command {}", i + 1))?;
        f.only(&["id", "title", "icon", "keywords", "needs"])?;
        let mut keywords = Vec::new();
        for keyword in f.list("keywords", MAX_KEYWORDS)? {
            match keyword.as_str().map(str::trim) {
                Some(k) if !k.is_empty() && k.chars().count() <= 40 => keywords.push(k.to_owned()),
                _ => return refuse(format!("{}'s keywords should be short text", f.what)),
            }
        }
        let page = match f.text("needs", 10)?.as_deref() {
            None => false,
            Some("page") => true,
            Some(other) => {
                return refuse(format!("{}'s needs \"{other}\" should be \"page\"", f.what));
            }
        };
        out.commands.push(Command {
            id: f.id()?,
            title: f.required("title", 60)?,
            icon: f.icon("puzzlepiece.extension")?,
            keywords,
            page,
        });
    }
    unique(out.commands.iter().map(|c| &c.id), "commands")?;
    let command = |id: &Option<String>, what: &str| -> Result<(), Refusal> {
        match id {
            Some(id) if !out.commands.iter().any(|c| &c.id == id) => refuse(format!(
                "{what} runs the command \"{id}\", which the plugin doesn't add"
            )),
            _ => Ok(()),
        }
    };

    for (i, view) in c.list("sidebarViews", MAX_ITEMS)?.iter().enumerate() {
        let f = Fields::new(view, format!("Sidebar view {}", i + 1))?;
        f.only(&["id", "title", "icon"])?;
        out.sidebar_views.push(SidebarView {
            id: f.id()?,
            title: f.required("title", 60)?,
            icon: f.icon("sidebar.right")?,
        });
    }
    unique(out.sidebar_views.iter().map(|v| &v.id), "sidebar views")?;

    let mut toolbar = Vec::new();
    for (i, button) in c.list("toolbar", MAX_ITEMS)?.iter().enumerate() {
        let f = Fields::new(button, format!("Toolbar button {}", i + 1))?;
        f.only(&["id", "title", "icon", "command", "view"])?;
        let (cmd, view) = (f.text("command", 40)?, f.text("view", 40)?);
        if cmd.is_some() == view.is_some() {
            return refuse(format!("{} needs a command or a view, not both", f.what));
        }
        command(&cmd, &f.what)?;
        if let Some(view) = &view
            && !out.sidebar_views.iter().any(|v| &v.id == view)
        {
            return refuse(format!(
                "{} opens the view \"{view}\", which the plugin doesn't add",
                f.what
            ));
        }
        toolbar.push(ToolbarButton {
            id: f.id()?,
            title: f.required("title", 60)?,
            icon: f.icon("puzzlepiece.extension")?,
            command: cmd,
            view,
        });
    }
    unique(toolbar.iter().map(|b| &b.id), "toolbar buttons")?;

    let mut tab_menu = Vec::new();
    for (i, item) in c.list("tabMenu", MAX_ITEMS)?.iter().enumerate() {
        let f = Fields::new(item, format!("Tab menu item {}", i + 1))?;
        f.only(&["id", "title", "command"])?;
        let cmd = f.required("command", 40)?;
        command(&Some(cmd.clone()), &f.what)?;
        tab_menu.push(MenuItem {
            id: f.id()?,
            title: f.required("title", 60)?,
            command: cmd,
        });
    }
    unique(tab_menu.iter().map(|m| &m.id), "tab menu items")?;

    for (i, source) in c.list("liveSources", MAX_ITEMS)?.iter().enumerate() {
        let f = Fields::new(source, format!("Live source {}", i + 1))?;
        f.only(&["id", "name", "kind", "site"])?;
        let kind = f.required("kind", 20)?;
        if kind != "pullRequests" && kind != "documents" {
            return refuse(format!(
                "{}'s kind should be pullRequests or documents",
                f.what
            ));
        }
        let site = f.text("site", 200)?;
        if let Some(site) = &site
            && host_pattern(site).is_none_or(|p| p.contains('*'))
        {
            return refuse(format!(
                "{}'s site should look like https://example.com",
                f.what
            ));
        }
        out.live_sources.push(LiveSource {
            id: f.id()?,
            name: f.required("name", 60)?,
            kind,
            site: site.and_then(|s| host_pattern(&s)),
        });
    }
    unique(out.live_sources.iter().map(|s| &s.id), "live sources")?;

    for (i, theme) in c.list("themes", MAX_ITEMS)?.iter().enumerate() {
        let f = Fields::new(theme, format!("Theme {}", i + 1))?;
        f.only(&["id", "name", "colors"])?;
        let mut colors = Vec::new();
        for color in f.list("colors", MAX_THEME_COLORS)? {
            match color.as_str() {
                Some(c) if valid_color(c) => colors.push(c.to_ascii_uppercase()),
                _ => return refuse(format!("{}'s colours should look like #3A6073", f.what)),
            }
        }
        if colors.is_empty() {
            return refuse(format!("{} has no colours", f.what));
        }
        out.themes.push(Theme {
            id: f.id()?,
            name: f.required("name", 60)?,
            colors,
        });
    }
    unique(out.themes.iter().map(|t| &t.id), "themes")?;

    out.toolbar = toolbar;
    out.tab_menu = tab_menu;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest(extra: Value) -> String {
        let mut base =
            json!({ "manifestVersion": 1, "id": "hello", "name": "Hello", "version": "1.0.0" });
        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        base.to_string()
    }

    #[test]
    fn a_small_manifest_gets_its_defaults() {
        let m = check(&manifest(json!({}))).unwrap();

        assert_eq!(m.main, "main.js");
        assert_eq!(m.description, "");
        assert_eq!(m.permissions, Permissions::default());
        assert_eq!(m.contributes, Contributes::default());
    }

    #[test]
    fn ids_versions_and_unknown_fields_are_checked() {
        for (extra, expect) in [
            (json!({ "id": "Hello" }), "lowercase"),
            (json!({ "id": "a" }), "2–40"),
            (json!({ "manifestVersion": 2 }), "version 2"),
            (json!({ "nmae": "x" }), "unknown field \"nmae\""),
            (json!({ "main": "../escape.js" }), "isn't a .js file"),
            (json!({ "main": "__bay/runtime.js" }), "isn't a .js file"),
        ] {
            let error = check(&manifest(extra.clone())).unwrap_err().0;
            assert!(error.contains(expect), "{extra}: {error}");
        }
    }

    #[test]
    fn host_patterns_are_https_except_on_this_computer() {
        assert_eq!(
            host_pattern("https://API.example.com/").as_deref(),
            Some("https://api.example.com")
        );
        assert_eq!(
            host_pattern("https://*.example.com:8443").as_deref(),
            Some("https://*.example.com:8443")
        );
        assert_eq!(
            host_pattern("http://localhost:3000").as_deref(),
            Some("http://localhost:3000")
        );
        for bad in [
            "http://example.com",
            "https://*",
            "https://*.com.",
            "https://example",
            "https://example.com/path",
            "https://user@example.com",
            "https://ex*ample.com",
            "ftp://example.com",
            "https://example.com:0",
            "https://*.localhost",
        ] {
            assert_eq!(host_pattern(bad), None, "{bad}");
        }
    }

    #[test]
    fn settings_have_defaults_and_secrets_have_none() {
        let m = check(&manifest(json!({ "settings": [
            { "key": "token", "title": "Token", "type": "secret" },
            { "key": "team", "title": "Team", "type": "text" },
            { "key": "compact", "title": "Compact", "type": "toggle" },
            { "key": "mode", "title": "Mode", "type": "choice", "options": [{ "value": "a", "title": "A" }, { "value": "b", "title": "B" }], "default": "b" },
        ] })))
        .unwrap();

        let defaults: Vec<_> = m.settings.iter().map(|s| s.default.clone()).collect();
        assert_eq!(
            defaults,
            vec![Value::Null, json!(""), json!(false), json!("b")]
        );

        let secret = check(&manifest(
            json!({ "settings": [{ "key": "t", "title": "T", "type": "secret", "default": "x" }] }),
        ));
        assert!(secret.unwrap_err().0.contains("can't have a default"));
        let twice = check(&manifest(
            json!({ "settings": [{ "key": "t", "title": "T", "type": "text" }, { "key": "t", "title": "U", "type": "text" }] }),
        ));
        assert!(twice.unwrap_err().0.contains("Two settings"));
    }

    #[test]
    fn buttons_and_menu_items_name_what_the_plugin_adds() {
        let ok = check(&manifest(json!({ "contributes": {
            "commands": [{ "id": "hi", "title": "Say Hi", "needs": "page", "keywords": ["hello"] }],
            "sidebarViews": [{ "id": "inbox", "title": "Inbox", "icon": "tray" }],
            "toolbar": [{ "id": "a", "title": "Hi", "command": "hi" }, { "id": "b", "title": "Inbox", "view": "inbox" }],
            "tabMenu": [{ "id": "m", "title": "Say Hi", "command": "hi" }],
            "liveSources": [{ "id": "issues", "name": "Issues", "kind": "pullRequests", "site": "https://example.com" }],
            "themes": [{ "id": "dusk", "name": "Dusk", "colors": ["#3a6073", "#F3904F"] }],
        } })))
        .unwrap();
        assert!(ok.contributes.commands[0].page);
        assert_eq!(ok.contributes.toolbar[0].icon, "puzzlepiece.extension");
        assert_eq!(ok.contributes.themes[0].colors, vec!["#3A6073", "#F3904F"]);

        for (contributes, expect) in [
            (
                json!({ "toolbar": [{ "id": "a", "title": "Hi", "command": "nope" }] }),
                "doesn't add",
            ),
            (
                json!({ "toolbar": [{ "id": "a", "title": "Hi" }] }),
                "a command or a view",
            ),
            (
                json!({ "tabMenu": [{ "id": "m", "title": "Hi", "command": "nope" }] }),
                "doesn't add",
            ),
            (
                json!({ "liveSources": [{ "id": "s", "name": "S", "kind": "mail" }] }),
                "pullRequests or documents",
            ),
            (
                json!({ "themes": [{ "id": "t", "name": "T", "colors": ["red"] }] }),
                "#3A6073",
            ),
            (
                json!({ "themes": [{ "id": "t", "name": "T", "colors": ["#000000", "#000000", "#000000", "#000000"] }] }),
                "more than 3",
            ),
            (
                json!({ "commands": [{ "id": "a", "title": "A", "icon": "Bad Icon" }] }),
                "symbol name",
            ),
        ] {
            let error = check(&manifest(json!({ "contributes": contributes.clone() })))
                .unwrap_err()
                .0;
            assert!(error.contains(expect), "{contributes}: {error}");
        }
    }

    #[test]
    fn paths_stay_inside_the_folder() {
        assert!(valid_path("main.js"));
        assert!(valid_path("lib/util.js"));
        for bad in [
            "",
            "/main.js",
            "../x.js",
            "a/../b.js",
            "a//b.js",
            ".hidden.js",
            "a\\b.js",
            "__bay/runtime.js",
            "c:x.js",
        ] {
            assert!(!valid_path(bad), "{bad}");
        }
    }
}
