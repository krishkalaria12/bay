//! The store loads the React Native app's session and saves what that app's store saves from it (lib/persist.ts
//! sessionJson after store/browserStore.ts hydrate). Each fixture's reloaded.json is that app's own output
//! (apps/browser/scripts/state-fixtures.mjs), its clock stopped at RELOAD.

mod support;

use std::cell::Cell;
use std::path::PathBuf;

use bay_state::store::Clock;
use bay_state::{Browser, DataDir, Session};
use serde_json::Value;

const RELOAD: f64 = 1_795_800_060_000.0;

fn fixtures(name: &str) -> DataDir {
    DataDir::new(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
}

#[test]
fn a_reloaded_session_saves_as_the_apps_store_saves_it() {
    for name in ["seed", "rich"] {
        let dir = fixtures(name);
        let session = Session::load(&dir).unwrap().unwrap();
        let mut browser = Browser::with_clock(support::resolve, Clock::Manual(Cell::new(RELOAD)));
        browser.hydrate(session, false);
        let ours: Value = serde_json::from_str(&browser.to_session().to_json().unwrap()).unwrap();
        let theirs: Value =
            serde_json::from_str(&dir.read("reloaded.json").unwrap().unwrap()).unwrap();
        for (key, value) in theirs.as_object().unwrap() {
            assert_eq!(&ours[key], value, "{name}: {key}");
        }
        assert_eq!(ours, theirs, "{name}");
    }
}

#[test]
fn a_saved_store_loads_back_to_the_same_session() {
    let dir = fixtures("rich");
    let mut browser = Browser::with_clock(support::resolve, Clock::Manual(Cell::new(RELOAD)));
    browser.hydrate(Session::load(&dir).unwrap().unwrap(), false);
    let saved = browser.to_session();
    let mut again = Browser::with_clock(support::resolve, Clock::Manual(Cell::new(RELOAD)));
    again.hydrate(saved.clone(), false);
    assert_eq!(again.to_session(), saved);
}
