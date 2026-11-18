//! `BrowserStore`: the object both apps hold. It keeps the browsing state, applies actions through the reducer,
//! tells the app what changed, and saves `browser.json` the way the Expo app's persistence service did: written to a
//! temporary file and moved over the saved one, once the store has been still for a moment, and at once on `flush`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use serde_json::Value;

use super::Action;
use super::bookmarks::{BookmarkListing, bookmark_listing, empty_bookmarks, is_bookmarked};
use super::model::{
    PERSONAL_SPACE_ID, create_tab, initial_browser_data, persisted_browser_data, reduce,
    unused_space_icon,
};
use super::parse::parse_browser_data;
use super::types::*;
use crate::js::site_host;

/// The saved browsing state, in the app's documents.
pub const STATE_FILE: &str = "browser.json";

/// The version of the document this store writes.
const VERSION: u64 = 2;

/// How long the store has to stay still before its state is written.
const SAVE_DELAY: Duration = Duration::from_millis(400);

/// Hears that the state changed. Called on the thread that dispatched; the apps hop to their main thread.
#[uniffi::export(with_foreign)]
pub trait StoreObserver: Send + Sync {
    fn changed(&self, revision: u64);
}

/// How the saved state was found when the store opened.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum LoadOutcome {
    /// Read from `browser.json`.
    Loaded,
    /// No saved state: a fresh install.
    Fresh,
    /// A file was there but couldn't be read or decoded; the store starts fresh and leaves it in place.
    Unreadable { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum StoreError {
    #[error("Couldn't save the browsing state: {reason}")]
    Save { reason: String },
}

struct State {
    data: BrowserData,
    revision: u64,
    saved_revision: u64,
}

#[derive(uniffi::Object)]
pub struct BrowserStore {
    state: Arc<Mutex<State>>,
    file: PathBuf,
    observers: Mutex<Vec<Arc<dyn StoreObserver>>>,
    saver: Mutex<Sender<()>>,
    outcome: LoadOutcome,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn load(file: &Path, fallback: &BrowserData) -> (BrowserData, LoadOutcome) {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (fallback.clone(), LoadOutcome::Fresh);
        }
        Err(error) => {
            return (
                fallback.clone(),
                LoadOutcome::Unreadable {
                    reason: error.to_string(),
                },
            );
        }
    };
    let parsed = serde_json::from_str::<Value>(&text)
        .map_err(|error| error.to_string())
        .and_then(|value| parse_browser_data(&value, fallback).map_err(|error| error.to_string()));
    match parsed {
        Ok(data) => (data, LoadOutcome::Loaded),
        Err(reason) => (fallback.clone(), LoadOutcome::Unreadable { reason }),
    }
}

/// Writes the state as the version-2 document, atomically.
fn write(file: &Path, data: &BrowserData) -> Result<(), StoreError> {
    let fail = |error: &dyn std::fmt::Display| StoreError::Save {
        reason: error.to_string(),
    };
    let mut document = match serde_json::to_value(persisted_browser_data(data)) {
        Ok(Value::Object(map)) => map,
        Ok(_) => return Err(fail(&"the state isn't an object")),
        Err(error) => return Err(fail(&error)),
    };
    document.insert("version".into(), VERSION.into());
    let text = serde_json::to_vec(&document).map_err(|error| fail(&error))?;
    let draft = file.with_extension("json.tmp");
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| fail(&error))?;
    }
    fs::write(&draft, text).map_err(|error| fail(&error))?;
    fs::rename(&draft, file).map_err(|error| fail(&error))
}

/// Saves the newest state when it changed since the last save.
fn save_if_changed(state: &Mutex<State>, file: &Path) -> Result<(), StoreError> {
    let (data, revision) = {
        let state = lock(state);
        if state.revision == state.saved_revision {
            return Ok(());
        }
        (state.data.clone(), state.revision)
    };
    write(file, &data)?;
    let mut state = lock(state);
    state.saved_revision = state.saved_revision.max(revision);
    Ok(())
}

impl BrowserStore {
    /// The whole state, for the core's own readers (sync's adapters).
    pub(crate) fn snapshot(&self) -> BrowserData {
        lock(&self.state).data.clone()
    }
}

#[uniffi::export]
impl BrowserStore {
    /// Opens the store on the app's documents directory. `new_tab_id` and `now` make the blank tab a fresh install
    /// (or an unreadable file) starts with.
    #[uniffi::constructor]
    pub fn open(documents_dir: String, new_tab_id: String, now: i64) -> Arc<Self> {
        let file = Path::new(&documents_dir).join(STATE_FILE);
        let fallback = initial_browser_data(
            create_tab(&new_tab_id, now, "", false, PERSONAL_SPACE_ID),
            BrowserPreferences::default(),
        );
        let (data, outcome) = load(&file, &fallback);
        let state = Arc::new(Mutex::new(State {
            data,
            revision: 0,
            saved_revision: 0,
        }));
        let (sender, receiver) = mpsc::channel::<()>();
        let (saver_state, saver_file) = (Arc::clone(&state), file.clone());
        thread::Builder::new()
            .name("bay-store-save".into())
            .spawn(move || {
                // Waits for a change, then for the store to be still for SAVE_DELAY, then saves.
                while receiver.recv().is_ok() {
                    loop {
                        match receiver.recv_timeout(SAVE_DELAY) {
                            Ok(()) => continue,
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    // A failed save stays dirty and is tried again after the next change or flush.
                    let _ = save_if_changed(&saver_state, &saver_file);
                }
            })
            .expect("the save thread starts");
        Arc::new(Self {
            state,
            file,
            observers: Mutex::new(Vec::new()),
            saver: Mutex::new(sender),
            outcome,
        })
    }

    /// How the saved state was found when the store opened.
    pub fn load_outcome(&self) -> LoadOutcome {
        self.outcome.clone()
    }

    /// Applies an action. Returns whether it changed anything; observers hear of each change.
    pub fn dispatch(&self, action: Action) -> bool {
        let revision = {
            let mut state = lock(&self.state);
            let Some(next) = reduce(&state.data, &action) else {
                return false;
            };
            state.data = next;
            state.revision += 1;
            state.revision
        };
        let _ = lock(&self.saver).send(());
        let observers = lock(&self.observers).clone();
        for observer in observers {
            observer.changed(revision);
        }
        true
    }

    /// Forgets every tab, page, pin and space and starts afresh on one blank tab; the preferences stay, less the
    /// elements hidden on sites. What clearing browsing data does to the store, as the Expo app's `reset`.
    pub fn reset(&self, new_tab_id: String, now: i64) {
        let revision = {
            let mut state = lock(&self.state);
            let mut preferences = state.data.preferences.clone();
            preferences.hidden_elements.clear();
            state.data = initial_browser_data(
                create_tab(&new_tab_id, now, "", false, PERSONAL_SPACE_ID),
                preferences,
            );
            state.revision += 1;
            state.revision
        };
        let _ = lock(&self.saver).send(());
        let observers = lock(&self.observers).clone();
        for observer in observers {
            observer.changed(revision);
        }
    }

    /// Writes the newest state now, when it changed since the last write: as the app leaves the foreground.
    pub fn flush(&self) -> Result<(), StoreError> {
        save_if_changed(&self.state, &self.file)
    }

    pub fn observe(&self, observer: Arc<dyn StoreObserver>) {
        lock(&self.observers).push(observer);
    }

    /// Counts every change since the store opened.
    pub fn revision(&self) -> u64 {
        lock(&self.state).revision
    }

    /// A new space to add after the others (`Action::CreateSpace`): `name`, the next colour in turn and an emoji no
    /// space wears yet, as the Expo app makes one.
    pub fn new_space(&self, id: String, name: String) -> BrowserSpace {
        let spaces = &lock(&self.state).data.spaces;
        BrowserSpace {
            id,
            name,
            color: SPACE_COLORS[spaces.len() % SPACE_COLORS.len()],
            icon: Some(unused_space_icon(spaces)),
        }
    }

    pub fn spaces(&self) -> Vec<BrowserSpace> {
        lock(&self.state).data.spaces.clone()
    }

    pub fn active_space_id(&self) -> String {
        lock(&self.state).data.active_space_id.clone()
    }

    pub fn active_tab_id(&self) -> String {
        lock(&self.state).data.active_tab_id.clone()
    }

    /// Every tab, private ones included, in list order.
    pub fn tabs(&self) -> Vec<BrowserTab> {
        lock(&self.state).data.tabs.clone()
    }

    /// A space's tabs, in list order.
    pub fn space_tabs(&self, space_id: String) -> Vec<BrowserTab> {
        lock(&self.state)
            .data
            .tabs
            .iter()
            .filter(|tab| tab.space_id == space_id)
            .cloned()
            .collect()
    }

    pub fn folders(&self, space_id: String) -> Vec<BrowserFolder> {
        lock(&self.state)
            .data
            .folders
            .iter()
            .filter(|folder| folder.space_id == space_id)
            .cloned()
            .collect()
    }

    pub fn pinned_sites(&self, space_id: String) -> Vec<PinnedSite> {
        lock(&self.state)
            .data
            .pinned_sites
            .iter()
            .filter(|site| site.space_id == space_id)
            .cloned()
            .collect()
    }

    /// A page of a space's history, newest first, narrowed to entries whose title or address holds `query`.
    pub fn history(
        &self,
        space_id: String,
        query: String,
        offset: u32,
        limit: u32,
    ) -> Vec<HistoryEntry> {
        let query = query.to_lowercase();
        lock(&self.state)
            .data
            .history
            .iter()
            .filter(|entry| entry.space_id == space_id)
            .filter(|entry| {
                query.is_empty()
                    || entry.title.to_lowercase().contains(&query)
                    || entry.url.to_lowercase().contains(&query)
            })
            .skip(offset as usize)
            .take(limit as usize)
            .cloned()
            .collect()
    }

    pub fn bookmarks(&self, space_id: String) -> Bookmarks {
        lock(&self.state)
            .data
            .bookmarks
            .get(&space_id)
            .cloned()
            .unwrap_or_else(empty_bookmarks)
    }

    /// The bookmarks sheet's rows: a folder of the space's tree, or the links matching `query` from all of it.
    pub fn bookmark_listing(
        &self,
        space_id: String,
        folder_id: String,
        query: String,
    ) -> BookmarkListing {
        let state = lock(&self.state);
        match state.data.bookmarks.get(&space_id) {
            Some(tree) => bookmark_listing(tree, &folder_id, &query),
            None => bookmark_listing(&empty_bookmarks(), &folder_id, &query),
        }
    }

    /// A space's archive, newest first.
    pub fn archive(&self, space_id: String) -> Vec<ArchivedTab> {
        lock(&self.state)
            .data
            .archive
            .iter()
            .filter(|tab| tab.tab.space_id == space_id)
            .cloned()
            .collect()
    }

    /// Newest first.
    pub fn downloads(&self) -> Vec<DownloadItem> {
        lock(&self.state).data.downloads.clone()
    }

    pub fn preferences(&self) -> BrowserPreferences {
        lock(&self.state).data.preferences.clone()
    }

    /// What a page follows: its site's own setting, else every global choice.
    pub fn site_setting(&self, url: String) -> SiteSetting {
        lock(&self.state)
            .data
            .preferences
            .site_settings
            .get(&site_host(&url))
            .cloned()
            .unwrap_or(SiteSetting::EMPTY)
    }

    /// The elements hidden on a page's site, as selectors.
    pub fn hidden_selectors(&self, url: String) -> Vec<String> {
        let host = crate::input::url::host_of(&url);
        lock(&self.state)
            .data
            .preferences
            .hidden_elements
            .get(&host)
            .cloned()
            .unwrap_or_default()
    }

    /// Whether a space's bookmarks hold this address.
    pub fn is_bookmarked(&self, space_id: String, url: String) -> bool {
        lock(&self.state)
            .data
            .bookmarks
            .get(&space_id)
            .is_some_and(|bookmarks| is_bookmarked(bookmarks, &url))
    }

    /// Each site's saved icon, by host without "www.".
    pub fn favicons(&self) -> std::collections::HashMap<String, String> {
        lock(&self.state)
            .data
            .favicons
            .iter()
            .map(|(host, uri)| (host.clone(), uri.clone()))
            .collect()
    }

    pub fn left_at(&self) -> Option<i64> {
        lock(&self.state).data.left_at
    }

    /// Back after a long time away (or launched again after it): a fresh start page, like a new day, while the tabs
    /// stay in the switcher. Takes an empty tab when there is one, else opens one (`new_tab_id`). Says whether it did;
    /// nothing changes when "start page after" is off, Bay never left, it wasn't away long enough, or the start page
    /// is showing already. The Expo app's `startFresh`.
    pub fn start_fresh(&self, now: i64, new_tab_id: String) -> bool {
        let data = self.snapshot();
        let (Some(hours), Some(left)) = (data.preferences.start_page_after_hours, data.left_at)
        else {
            return false;
        };
        if now - left < hours * 60 * 60 * 1000 {
            return false;
        }
        if data
            .tabs
            .iter()
            .any(|tab| tab.id == data.active_tab_id && tab.url.is_empty())
        {
            return false;
        }
        match data
            .tabs
            .iter()
            .find(|tab| tab.url.is_empty() && !tab.private)
        {
            Some(empty) => self.dispatch(Action::ActivateTab {
                id: empty.id.clone(),
                now,
            }),
            None => self.dispatch(Action::NewTab {
                tab: create_tab(&new_tab_id, now, "", false, &data.active_space_id),
                background: false,
            }),
        };
        true
    }
}

#[cfg(test)]
mod tests {
    use super::super::bookmarks::BOOKMARKS_ROOT;
    use super::super::model::SiteSettingInput;
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Counter(AtomicU64);

    impl StoreObserver for Counter {
        fn changed(&self, revision: u64) {
            self.0.store(revision, Ordering::SeqCst);
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bay-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn tab(id: &str, url: &str) -> BrowserTab {
        create_tab(id, 10, url, false, PERSONAL_SPACE_ID)
    }

    #[test]
    fn a_fresh_store_starts_with_one_blank_tab() {
        let dir = temp_dir("fresh");
        let store = BrowserStore::open(dir.to_string_lossy().into(), "first".into(), 5);
        assert_eq!(store.load_outcome(), LoadOutcome::Fresh);
        assert_eq!(store.active_tab_id(), "first");
        assert_eq!(store.spaces()[0].id, PERSONAL_SPACE_ID);
        // A reset leaves one blank tab in the personal space and keeps the preferences.
        store.dispatch(Action::BlockContent { enabled: false });
        store.reset("fresh".into(), 20);
        assert_eq!(
            (store.tabs().len(), store.active_tab_id()),
            (1, "fresh".to_string())
        );
        assert!(!store.preferences().block_content);
        // The second space takes the second colour and the first emoji past the house.
        let next = store.new_space("work".into(), "Space 2".into());
        assert_eq!(
            (next.color, next.icon.as_deref()),
            (SpaceColor::Green, Some("✨"))
        );
        assert!(!store.preferences().welcomed);
    }

    #[test]
    fn a_page_reads_its_site_setting_and_bookmark() {
        let dir = temp_dir("site");
        let store = BrowserStore::open(dir.to_string_lossy().into(), "first".into(), 5);
        store.dispatch(Action::SiteSettings {
            host: "example.com".into(),
            update: SiteSettingInput {
                text_size: Some(120.0),
                reader: false,
                desktop_mode: true,
                block_off: Vec::new(),
                swipe: None,
            },
        });
        let setting = store.site_setting("https://www.Example.com/a".into());
        assert_eq!((setting.text_size, setting.desktop_mode), (Some(120), true));
        assert_eq!(
            store.site_setting("https://other.org/".into()),
            SiteSetting::EMPTY
        );

        let url = "https://example.com/a";
        assert!(!store.is_bookmarked(PERSONAL_SPACE_ID.into(), url.into()));
        store.dispatch(Action::ToggleBookmark {
            space_id: PERSONAL_SPACE_ID.into(),
            bookmark: BookmarkNode::Url {
                id: "b1".into(),
                parent_id: BOOKMARKS_ROOT.into(),
                title: "A".into(),
                url: url.into(),
                added_at: 1,
            },
        });
        assert!(store.is_bookmarked(PERSONAL_SPACE_ID.into(), url.into()));
        assert!(!store.is_bookmarked("work".into(), url.into()));

        store.dispatch(Action::HiddenElements {
            host: "example.com".into(),
            selectors: vec!["#ad".into()],
        });
        assert_eq!(
            store.hidden_selectors("https://www.example.com/b".into()),
            ["#ad"]
        );
        assert!(
            store
                .hidden_selectors("https://other.org/".into())
                .is_empty()
        );
    }

    #[test]
    fn a_long_time_away_starts_on_a_fresh_start_page() {
        let dir = temp_dir("fresh");
        let store = BrowserStore::open(dir.to_string_lossy().into(), "first".into(), 5);
        let hour = 60 * 60 * 1000;
        store.dispatch(Action::UpdateTab {
            id: "first".into(),
            update: TabUpdate {
                url: Some("https://a.example/".into()),
                ..Default::default()
            },
        });
        store.dispatch(Action::Left { now: 10 });
        // "Start page after" is off by default.
        assert!(!store.start_fresh(10 + 100 * hour, "fresh".into()));
        store.dispatch(Action::Preferences {
            update: super::super::model::PreferencesUpdate {
                start_page_after_hours: Some(Some(4)),
                ..Default::default()
            },
        });
        assert!(!store.start_fresh(10 + 3 * hour, "fresh".into()));
        assert!(store.start_fresh(10 + 5 * hour, "fresh".into()));
        assert_eq!(store.active_tab_id(), "fresh");
        // On the start page already: nothing more.
        assert!(!store.start_fresh(10 + 5 * hour, "again".into()));
        assert_eq!(store.tabs().len(), 2);
    }

    #[test]
    fn the_bookmarks_sheet_lists_a_folder_or_a_search() {
        let dir = temp_dir("bookmarks");
        let store = BrowserStore::open(dir.to_string_lossy().into(), "first".into(), 5);
        let link = |id: &str, parent: &str, title: &str| BookmarkNode::Url {
            id: id.into(),
            parent_id: parent.into(),
            title: title.into(),
            url: format!("https://{id}.example/"),
            added_at: 1,
        };
        store.dispatch(Action::AddBookmarks {
            space_id: PERSONAL_SPACE_ID.into(),
            nodes: vec![
                BookmarkNode::Folder {
                    id: "f".into(),
                    parent_id: Some(BOOKMARKS_ROOT.into()),
                    title: "Work".into(),
                    children: vec!["inner".into()],
                    added_at: 1,
                },
                link("inner", "f", "Docs"),
                link("top", BOOKMARKS_ROOT, "News"),
            ],
        });
        let space = || PERSONAL_SPACE_ID.to_string();

        let top = store.bookmark_listing(space(), BOOKMARKS_ROOT.into(), String::new());
        let rows: Vec<(&str, u32)> = top
            .rows
            .iter()
            .map(|row| (row.node.id(), row.links))
            .collect();
        assert_eq!(
            (top.parent_id, top.nodes, top.links, rows),
            (None, 3, 2, vec![("f", 1), ("top", 0)])
        );

        let folder = store.bookmark_listing(space(), "f".into(), String::new());
        assert_eq!(
            (
                folder.parent_id.as_deref(),
                folder.title.as_str(),
                folder.rows.len()
            ),
            (Some(BOOKMARKS_ROOT), "Work", 1)
        );

        // A search looks through every folder; a folder that's gone shows the top.
        let found = store.bookmark_listing(space(), "f".into(), " docs ".into());
        assert_eq!(
            found
                .rows
                .iter()
                .map(|row| row.node.id())
                .collect::<Vec<_>>(),
            ["inner"]
        );
        assert_eq!(
            store
                .bookmark_listing(space(), "gone".into(), String::new())
                .folder_id,
            BOOKMARKS_ROOT
        );
    }

    #[test]
    fn changes_are_observed_saved_and_read_back() {
        let dir = temp_dir("save");
        let store = BrowserStore::open(dir.to_string_lossy().into(), "first".into(), 5);
        let counter = Arc::new(Counter(AtomicU64::new(0)));
        store.observe(counter.clone());
        assert!(store.dispatch(Action::NewTab {
            tab: tab("t2", "https://example.com/"),
            background: false
        }));
        assert!(!store.dispatch(Action::NewTab {
            tab: tab("t2", "https://example.com/"),
            background: false
        }));
        assert!(store.dispatch(Action::NewTab {
            tab: BrowserTab {
                private: true,
                ..tab("secret", "https://private.example/")
            },
            background: false
        }));
        assert_eq!(counter.0.load(Ordering::SeqCst), 2);
        store.flush().unwrap();

        let saved: Value =
            serde_json::from_str(&fs::read_to_string(dir.join(STATE_FILE)).unwrap()).unwrap();
        assert_eq!(saved["version"], 2);
        assert!(
            !saved["tabs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tab| tab["id"] == "secret"),
            "private tabs aren't saved"
        );

        let reopened = BrowserStore::open(dir.to_string_lossy().into(), "other".into(), 6);
        assert_eq!(reopened.load_outcome(), LoadOutcome::Loaded);
        assert_eq!(
            reopened
                .tabs()
                .iter()
                .map(|tab| tab.id.as_str())
                .collect::<Vec<_>>(),
            ["first", "t2"]
        );
        assert_eq!(reopened.active_tab_id(), "t2");
    }

    #[test]
    fn a_change_is_saved_once_the_store_is_still() {
        let dir = temp_dir("debounce");
        let store = BrowserStore::open(dir.to_string_lossy().into(), "first".into(), 5);
        store.dispatch(Action::Left { now: 99 });
        assert!(!dir.join(STATE_FILE).exists(), "nothing is written at once");
        thread::sleep(SAVE_DELAY * 3);
        assert!(dir.join(STATE_FILE).exists());
    }

    #[test]
    fn an_unreadable_file_starts_fresh_and_stays() {
        let dir = temp_dir("broken");
        fs::write(dir.join(STATE_FILE), "{ not json").unwrap();
        let store = BrowserStore::open(dir.to_string_lossy().into(), "first".into(), 5);
        assert!(matches!(
            store.load_outcome(),
            LoadOutcome::Unreadable { .. }
        ));
        assert_eq!(
            fs::read_to_string(dir.join(STATE_FILE)).unwrap(),
            "{ not json"
        );
    }

    #[test]
    fn a_document_the_expo_app_wrote_reads_as_it_was() {
        // A saved state from the Expo app's own tests (fixtures/store.jsonl), written the way it writes them.
        let fixtures = include_str!("../../../../fixtures/store.jsonl");
        let line = fixtures
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .find(|line| {
                line["fn"] == "parseBrowserData"
                    && line["args"][0]["version"] == 2
                    && line.get("error").is_none()
            })
            .expect("a saved document");
        let dir = temp_dir("expo");
        fs::write(
            dir.join(STATE_FILE),
            serde_json::to_string(&line["args"][0]).unwrap(),
        )
        .unwrap();
        let store = BrowserStore::open(dir.to_string_lossy().into(), "first".into(), 5);
        assert_eq!(store.load_outcome(), LoadOutcome::Loaded);
        assert_eq!(
            serde_json::to_value(store.tabs()).unwrap(),
            line["result"]["tabs"]
        );
    }
}
