//! The documents the React Native app writes, read and written back by this crate. The fixtures are that app's own
//! output (apps/browser/scripts/state-fixtures.mjs): `seed` is the benchmark's 200-tab session, `rich` holds every
//! optional field, nulls beside missing fields, and fields no build knows yet.

use std::path::PathBuf;

use bay_state::model::SpaceTheme;
use bay_state::{DataDir, DocumentError, Downloads, JsNumber, Session};
use serde_json::{Value, json};

fn fixtures(name: &str) -> DataDir {
    DataDir::new(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
}

fn written(dir: &DataDir, name: &str) -> Value {
    serde_json::from_str(&dir.read(name).unwrap().unwrap()).unwrap()
}

fn rich() -> Session {
    Session::load(&fixtures("rich")).unwrap().unwrap()
}

#[test]
fn the_apps_sessions_come_back_as_they_were_written() {
    for name in ["seed", "rich"] {
        let dir = fixtures(name);
        let session = Session::load(&dir).unwrap().unwrap();
        let again: Value = serde_json::from_str(&session.to_json().unwrap()).unwrap();
        assert_eq!(again, written(&dir, "session.json"), "{name}/session.json");
    }
}

#[test]
fn the_apps_downloads_come_back_as_they_were_written() {
    for name in ["seed", "rich"] {
        let dir = fixtures(name);
        let downloads = Downloads::load(&dir).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(&downloads).unwrap(),
            written(&dir, "downloads.json"),
            "{name}/downloads.json"
        );
    }
}

#[test]
fn the_seed_reads_as_its_spaces_windows_and_tabs() {
    let session = Session::load(&fixtures("seed")).unwrap().unwrap();
    assert_eq!(session.space_order, ["default", "work"]);
    assert_eq!(session.windows.len(), 1);
    assert_eq!(session.tabs.len(), 201);
    assert_eq!(session.groups.len(), 3);
    let window = &session.windows[0];
    assert_eq!(
        session.focused_window_id.as_deref(),
        Some(window.id.as_str())
    );
    assert!(
        session
            .tabs
            .iter()
            .all(|tab| session.spaces.contains_key(&tab.space_id))
    );
}

#[test]
fn fields_this_build_doesnt_know_are_kept() {
    let session = rich();
    assert_eq!(
        session.spaces["work"].extra["futureField"],
        json!({ "kept": [1, 2] })
    );
    let tab = session.tabs.iter().find(|tab| tab.id == "e").unwrap();
    assert_eq!(tab.extra["futureField"], "kept");
    assert_eq!(
        session.settings["futureSetting"],
        json!([1, { "nested": true }])
    );
}

#[test]
fn a_null_stays_null_and_a_missing_field_stays_missing() {
    let session = rich();
    let theme = SpaceTheme {
        colors: vec!["#3A6073".into(), "#733A43".into()],
        intensity: JsNumber(0.5),
        grain: JsNumber(0.3),
        extra: Default::default(),
    };
    assert_eq!(session.spaces["default"].theme, Some(Some(theme)));
    assert_eq!(session.spaces["work"].theme, Some(None));
    assert_eq!(session.spaces["shared"].theme, None);
    assert_eq!(session.spaces["work"].clean_up_after_hours, Some(None));

    let spaces = serde_json::to_value(&session.spaces).unwrap();
    assert_eq!(spaces["work"]["theme"], Value::Null);
    assert!(spaces["shared"].get("theme").is_none());
    assert!(spaces["shared"].get("cleanUpAfterHours").is_none());
}

#[test]
fn optional_records_read_as_the_app_wrote_them() {
    let session = rich();
    let nested = session
        .pinned_folders
        .iter()
        .find(|folder| folder.id == "f2")
        .unwrap();
    assert_eq!(nested.parent_id.as_deref(), Some("f1"));
    assert_eq!(
        session.splits[0].stack.as_ref().map(|stack| stack.index),
        Some(JsNumber(1.0))
    );
    assert_eq!(session.local_files[0].kind, "folder");
    assert_eq!(
        session.closed_windows[0].tabs[0].tab_id.as_deref(),
        Some("y")
    );
    assert!(session.closed_windows[0].tabs[0].active);
    assert_eq!(session.cleaned_tabs[0].group, None);
    let webkit = session.tabs.iter().find(|tab| tab.id == "c").unwrap();
    assert_eq!(
        webkit.engine_pick.as_ref().map(|pick| pick.site.as_str()),
        Some("netflix.com")
    );
}

#[test]
fn a_saved_session_reads_back_the_same() {
    let scratch = tempfile::tempdir().unwrap();
    let dir = DataDir::new(scratch.path());
    let session = rich();
    session.save(&dir).unwrap();
    assert_eq!(Session::load(&dir).unwrap(), Some(session));
    let leftovers: Vec<_> = std::fs::read_dir(scratch.path())
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name())
        .filter(|name| name != "session.json")
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn no_session_or_another_version_starts_afresh() {
    let scratch = tempfile::tempdir().unwrap();
    let dir = DataDir::new(scratch.path());
    assert_eq!(Session::load(&dir).unwrap(), None);
    dir.write("session.json", r#"{"version":3,"spaces":{}}"#)
        .unwrap();
    assert_eq!(Session::load(&dir).unwrap(), None);
}

#[test]
fn a_session_from_before_spaces_reads_as_spaces() {
    let scratch = tempfile::tempdir().unwrap();
    let dir = DataDir::new(scratch.path());
    dir.write(
        "session.json",
        r#"{"version":2,"profiles":{"default":{"id":"default","name":"Personal","color":"plum","icon":null,"createdAt":0}},"profileOrder":["default"]}"#,
    )
    .unwrap();
    let session = Session::load(&dir).unwrap().unwrap();
    assert_eq!(session.space_order, ["default"]);
    assert_eq!(session.spaces["default"].name, "Personal");
    assert!(session.extra.get("profiles").is_none());
}

#[test]
fn a_broken_document_is_an_error_not_an_empty_session() {
    let scratch = tempfile::tempdir().unwrap();
    let dir = DataDir::new(scratch.path());
    dir.write("session.json", "{ half a document").unwrap();
    assert!(matches!(
        Session::load(&dir),
        Err(DocumentError::Unreadable { .. })
    ));
}

#[test]
fn only_plain_names_are_documents() {
    let dir = DataDir::new("/tmp/bay-state-names");
    for name in ["", ".", "..", "../session.json", "a/b.json"] {
        assert!(
            matches!(dir.path(name), Err(DocumentError::BadName(_))),
            "{name:?}"
        );
    }
    assert!(dir.path("session.json").is_ok());
}
