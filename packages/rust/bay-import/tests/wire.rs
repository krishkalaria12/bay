//! Every reader gives what the C++ readers gave for the shared fixtures (`packages/import/fixtures/wire`, written by
//! `packages/import/scripts/record-wire.py`). The fixtures are copied first, as a profile another browser has open.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use bay_import::{Cancel, HistoryOptions};
use serde_json::Value;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../import/fixtures")
}

fn golden(name: &str) -> Value {
    let path = fixtures().join("wire").join(format!("{name}.json"));
    serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("no {}", path.display())),
    )
    .unwrap()
}

fn copy(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

struct Profiles(tempfile::TempDir);

impl Profiles {
    fn new() -> Self {
        Self(tempfile::tempdir().unwrap())
    }

    fn copied(&self, from: &Path, name: &str) -> PathBuf {
        let to = self.0.path().join(name);
        copy(from, &to);
        to
    }
}

fn support(relative: &str) -> PathBuf {
    fixtures()
        .join("home/Library/Application Support")
        .join(relative)
}

fn same(name: &str, value: &Value) {
    assert!(
        *value == golden(name),
        "{name} differs from the C++ readers'"
    );
}

const CHROMIUM: [(&str, &str); 8] = [
    ("chrome-default", "Google/Chrome/Default"),
    ("chrome-profile-1", "Google/Chrome/Profile 1"),
    ("brave-default", "BraveSoftware/Brave-Browser/Default"),
    ("dia-default", "Dia/User Data/Default"),
    ("dia-profile-2", "Dia/User Data/Profile 2"),
    ("arc-default", "Arc/User Data/Default"),
    ("opera", "com.operasoftware.Opera"),
    ("helium-default", "net.imput.helium/Default"),
];

#[test]
fn exported_files_read_as_before() {
    for name in ["chrome-passwords", "bitwarden", "firefox-passwords"] {
        let text =
            std::fs::read_to_string(fixtures().join("csv").join(format!("{name}.csv"))).unwrap();
        same(
            &format!("csv-{name}"),
            &bay_import::parse_passwords_csv(&text).unwrap(),
        );
    }
    let html = std::fs::read_to_string(fixtures().join("html/chrome-bookmarks.html")).unwrap();
    same(
        "html-chrome-bookmarks",
        &bay_import::parse_netscape_bookmarks(&html),
    );
    let refused = std::fs::read_to_string(fixtures().join("csv/not-passwords.csv")).unwrap();
    assert!(bay_import::parse_passwords_csv(&refused).is_err());
}

#[test]
fn chromium_profiles_read_as_before() {
    let profiles = Profiles::new();
    let stop = AtomicBool::new(false);
    for (name, relative) in CHROMIUM {
        let profile = profiles.copied(&support(relative), name);
        if profile.join("Bookmarks").exists() {
            same(
                &format!("bookmarks-{name}"),
                &bay_import::chromium_bookmarks(&profile).unwrap(),
            );
        }
        if profile.join("History").exists() {
            let (rows, count) = bay_import::history(
                &profile,
                false,
                &HistoryOptions::default(),
                &mut |_| {},
                Cancel(&stop),
            )
            .unwrap();
            assert_eq!(count as usize, rows.as_array().unwrap().len());
            same(&format!("history-{name}"), &rows);
        }
        same(
            &format!("extensions-{name}"),
            &bay_import::extensions(&profile).unwrap(),
        );
    }
    let extensions = profiles.copied(
        &fixtures().join("extensions/Default"),
        "chromium-extensions",
    );
    same(
        "extensions-chromium-extensions",
        &bay_import::extensions(&extensions).unwrap(),
    );
}

#[test]
fn firefox_profiles_read_as_before() {
    let profiles = Profiles::new();
    let stop = AtomicBool::new(false);
    let firefox = profiles.copied(
        &support("Firefox/Profiles/abcd1234.default-release"),
        "firefox-default",
    );
    let wal = std::fs::read(firefox.join("places.sqlite-wal")).unwrap();
    same(
        "bookmarks-firefox-default",
        &bay_import::firefox_bookmarks(&firefox, Cancel(&stop)).unwrap(),
    );
    let (rows, _) = bay_import::history(
        &firefox,
        true,
        &HistoryOptions::default(),
        &mut |_| {},
        Cancel(&stop),
    )
    .unwrap();
    same("history-firefox-default", &rows);
    same(
        "extensions-firefox-default",
        &bay_import::extensions(&firefox).unwrap(),
    );
    // The profile is left as it was: no checkpointed WAL, no -shm beside it.
    assert_eq!(
        std::fs::read(firefox.join("places.sqlite-wal")).unwrap(),
        wal
    );
    assert!(!firefox.join("places.sqlite-shm").exists());
}

#[test]
fn arc_sidebars_read_as_before() {
    same(
        "arc-sidebar",
        &bay_import::arc_sidebar(&support("Arc/StorableSidebar.json")).unwrap(),
    );
    same(
        "arc-nested-sidebar",
        &bay_import::arc_sidebar(&fixtures().join("arc/nested-sidebar.json")).unwrap(),
    );
}

#[test]
fn history_streams_in_chunks_stops_at_its_limit_and_can_be_cancelled() {
    let profiles = Profiles::new();
    let profile = profiles.copied(&support("Google/Chrome/Default"), "chrome");
    let all = golden("history-chrome-default");
    let stop = AtomicBool::new(false);
    let mut events = Vec::new();
    let options = HistoryOptions {
        chunk_size: 2,
        stream: true,
        ..HistoryOptions::default()
    };
    let (rows, count) = bay_import::history(
        &profile,
        false,
        &options,
        &mut |event| events.push(event),
        Cancel(&stop),
    )
    .unwrap();
    assert_eq!(rows, Value::Array(vec![]));
    let streamed: Vec<Value> = events
        .iter()
        .filter(|event| event["type"] == "history")
        .flat_map(|event| {
            serde_json::from_str::<Vec<Value>>(event["entries"].as_str().unwrap()).unwrap()
        })
        .collect();
    assert_eq!(Value::Array(streamed), all);
    assert_eq!(events.last().unwrap()["total"], count);

    let limited = HistoryOptions {
        limit: 2,
        ..HistoryOptions::default()
    };
    let (rows, _) =
        bay_import::history(&profile, false, &limited, &mut |_| {}, Cancel(&stop)).unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 2);

    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let cancelled = bay_import::history(
        &profile,
        false,
        &HistoryOptions::default(),
        &mut |_| {},
        Cancel(&stop),
    );
    assert_eq!(cancelled.unwrap_err().code, "cancelled");
}

/// Zen's spaces in the shapes Zen 1.22 writes (the session store's window, which zen-sessions.jsonlz4 shares), as
/// `packages/import/portable/tests/Readers.cpp` builds them.
#[test]
fn zen_spaces_keep_pins_folders_tabs_and_essentials_by_container() {
    use serde_json::json;
    let tab = |url: &str,
               space: Option<&str>,
               pinned: bool,
               essential: bool,
               group: Option<&str>,
               empty: bool,
               context: i64,
               loaded: bool| {
        let mut tab = json!({"pinned": pinned, "zenEssential": essential, "zenIsEmpty": empty, "userContextId": context, "index": 1, "entries": []});
        if loaded {
            tab["entries"] = json!([{"url": url, "title": url}]);
        } else {
            tab["userTypedValue"] = json!(url);
        }
        if let Some(space) = space {
            tab["zenWorkspace"] = json!(space);
        }
        if let Some(group) = group {
            tab["groupId"] = json!(group);
        }
        tab
    };
    let window = json!({
        "spaces": [
            {"uuid": "{home}", "name": "Home", "icon": "🏠", "containerTabId": 0, "theme": {"gradientColors": [{"c": [58, 96, 115]}]}},
            {"uuid": "{dev}", "name": "Dev", "icon": "chrome://browser/skin/zen-icons/selectable/code.svg", "containerTabId": 0},
            {"uuid": "{meet}", "name": "Meetings", "containerTabId": 2},
        ],
        "folders": [
            {"id": "docs", "name": "Docs", "workspaceId": "{dev}", "parentId": null},
            {"id": "react", "name": "React", "workspaceId": "{dev}", "parentId": "docs"},
        ],
        "tabs": [
            tab("https://github.com/", None, true, true, None, false, 0, true),
            tab("https://app.slack.com/", None, true, true, None, false, 0, false),
            tab("https://work.example/", None, true, true, None, false, 2, true),
            tab("https://news.ycombinator.com/", Some("{home}"), true, false, None, false, 0, true),
            tab("https://developer.mozilla.org/", Some("{dev}"), true, false, None, false, 0, true),
            tab("about:blank", None, true, false, Some("docs"), true, 0, true),
            tab("https://nodejs.org/", Some("{dev}"), true, false, Some("docs"), false, 0, true),
            tab("https://react.dev/", Some("{dev}"), true, false, Some("react"), false, 0, true),
            tab("https://linear.app/", Some("{dev}"), true, false, None, false, 0, false),
            tab("https://example.com/", Some("{home}"), false, false, None, false, 0, true),
            tab("about:blank", Some("{home}"), false, false, None, true, 0, true),
            tab("https://meet.google.com/", Some("{meet}"), true, false, None, false, 0, true),
        ],
    });
    let profile = tempfile::tempdir().unwrap();
    std::fs::write(
        profile.path().join("sessionstore.js"),
        json!({"windows": [window]}).to_string(),
    )
    .unwrap();
    let spaces = bay_import::zen_spaces(profile.path(), "Profiles/abc.Default").unwrap();
    assert_eq!(spaces.as_array().unwrap().len(), 3);
    assert_eq!(
        (spaces[0]["name"].as_str(), spaces[0]["profileId"].as_str()),
        (Some("Home"), Some("Profiles/abc.Default"))
    );
    assert_eq!(
        spaces[0]["pinned"],
        json!([{"type": "url", "title": "https://news.ycombinator.com/", "url": "https://news.ycombinator.com/"}])
    );
    assert_eq!(spaces[0]["tabs"].as_array().unwrap().len(), 1);
    assert_eq!(spaces[0]["tabs"][0]["url"], "https://example.com/");
    let dev = &spaces[1]["pinned"];
    assert_eq!(dev.as_array().unwrap().len(), 3);
    assert_eq!(
        (dev[1]["type"].as_str(), dev[1]["title"].as_str()),
        (Some("folder"), Some("Docs"))
    );
    assert_eq!(dev[1]["children"][0]["url"], "https://nodejs.org/");
    assert_eq!(dev[1]["children"][1]["title"], "React");
    assert_eq!(dev[2]["url"], "https://linear.app/");
    assert_eq!(spaces[0]["favorites"].as_array().unwrap().len(), 2);
    assert_eq!(spaces[0]["favorites"][1]["url"], "https://app.slack.com/");
    assert_eq!(
        spaces[2]["favorites"],
        json!([{"url": "https://work.example/", "title": "https://work.example/", "pinned": true, "windowIndex": 0, "active": false}])
    );
    assert_eq!(
        (spaces[0]["emoji"].as_str(), spaces[0]["color"].as_str()),
        (Some("🏠"), Some("#3A6073"))
    );
    assert!(spaces[1].get("emoji").is_none());
    let stop = AtomicBool::new(false);
    let open = bay_import::firefox_tabs(profile.path(), Cancel(&stop)).unwrap();
    assert!(
        open["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .all(|tab| tab["url"] != "about:blank")
    );
    std::fs::write(
        profile.path().join("sessionstore.js"),
        r#"{"windows":[{"tabs":[{"entries":[{"url":"https://a.test/"}],"index":1}]}]}"#,
    )
    .unwrap();
    assert_eq!(
        bay_import::zen_spaces(profile.path(), "p").unwrap(),
        json!([])
    );
}
