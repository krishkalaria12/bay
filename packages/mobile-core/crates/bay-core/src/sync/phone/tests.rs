//! The phone's sync against a stand-in computer on one chain, as the Expo app's `tests/phoneSync.test.ts` runs it.
//! `fixtures/phone-sync.json` is what the TypeScript phone ended with (scripts/phone-sync-vector.mjs); the Rust phone
//! must end the same: the same spaces, bookmarks, history and pins, and the same records on the computer.

use std::sync::{Arc, Mutex};

use indexmap::{IndexMap, IndexSet};
use serde_json::{Value, json};

use super::adapters::StoreAccess;
use super::engine::{CycleDeps, SyncDoc, remote_tabs, run_cycle, synced_devices};
use crate::store::model::{HISTORY_LIMIT, create_tab, initial_browser_data, reduce};
use crate::store::{Action, BrowserData, BrowserPreferences};
use crate::sync::hlc::Clock;
use crate::sync::http::RelayError;
use crate::sync::scope::{Adapter, Extraction, ScopeOptions, ScopeState, sync_scope, visible};
use crate::sync::transport::{Listing, Transport};

struct MemStore(Mutex<BrowserData>);

impl StoreAccess for MemStore {
    fn data(&self) -> BrowserData {
        self.0.lock().unwrap().clone()
    }

    fn ready(&self) -> bool {
        true
    }

    fn dispatch(&self, action: Action) {
        let mut data = self.0.lock().unwrap();
        if let Some(next) = reduce(&data, &action) {
            *data = next;
        }
    }
}

/// One chain's files in memory, as the relay keeps them.
#[derive(Default)]
struct Chain {
    files: Mutex<IndexMap<String, String>>,
    counter: Mutex<u64>,
}

#[async_trait::async_trait]
impl Transport for Chain {
    async fn write(&self, scope: &str, payload: &str) -> Result<String, RelayError> {
        let mut counter = self.counter.lock().unwrap();
        *counter += 1;
        let id = format!("f{counter}");
        self.files
            .lock()
            .unwrap()
            .insert(format!("{scope}/{id}"), payload.into());
        Ok(id)
    }

    async fn read(&self, scope: &str, known: &[String]) -> Result<Listing, RelayError> {
        let mut listing = Listing::default();
        for (name, payload) in self.files.lock().unwrap().iter() {
            let Some(id) = name.strip_prefix(&format!("{scope}/")) else {
                continue;
            };
            listing.present.push(id.into());
            if !known.iter().any(|known| known == id) {
                listing.files.push((id.into(), payload.clone()));
            }
        }
        Ok(listing)
    }

    async fn remove(&self, scope: &str, ids: &[String]) -> Result<(), RelayError> {
        let mut files = self.files.lock().unwrap();
        for id in ids {
            files.shift_remove(&format!("{scope}/{id}"));
        }
        Ok(())
    }
}

/// A computer adapter: fixed records under a prefix, never applying anything.
struct Fixed {
    prefix: String,
    values: IndexMap<String, Value>,
}

impl Adapter for Fixed {
    fn prefix(&self) -> &str {
        &self.prefix
    }

    fn extract(&mut self, _base: &dyn Fn(&str) -> Option<Value>) -> Option<Extraction> {
        let values: IndexMap<String, Value> = self
            .values
            .iter()
            .filter(|(key, _)| key.starts_with(&self.prefix))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let all: Vec<String> = self.values.keys().cloned().collect();
        Some(Extraction {
            values,
            ignore: Some(Box::new(move |key: &str, _: Option<&Value>| {
                !all.iter().any(|known| known == key)
            })),
        })
    }

    fn apply(
        &mut self,
        _visible: &IndexMap<String, Value>,
        _changed: &IndexSet<String>,
        _base: &dyn Fn(&str) -> Option<Value>,
    ) -> bool {
        true
    }
}

struct Computer {
    now: i64,
    scopes: IndexMap<String, IndexMap<String, Value>>,
    states: IndexMap<String, ScopeState>,
    clock: Clock,
}

impl Computer {
    fn new() -> Self {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../../fixtures/phone-sync-computer.json"
        ))
        .unwrap();
        let now = fixture["now"].as_i64().unwrap();
        let scopes = fixture["scopes"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(scope, records)| {
                (
                    scope.clone(),
                    records
                        .as_object()
                        .unwrap()
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect(),
                )
            })
            .collect();
        Self {
            now,
            scopes,
            states: IndexMap::new(),
            clock: Clock::new("mac", None, Box::new(move || now)),
        }
    }

    fn sync(&mut self, chain: &Chain) {
        for (scope, values) in self.scopes.clone() {
            let prefixes: IndexSet<String> = values
                .keys()
                .map(|key| key[..=key.find(':').unwrap()].to_owned())
                .collect();
            let mut adapters: Vec<Box<dyn Adapter>> = prefixes
                .into_iter()
                .map(|prefix| {
                    Box::new(Fixed {
                        prefix,
                        values: values.clone(),
                    }) as Box<dyn Adapter>
                })
                .collect();
            let state = self.states.entry(scope.clone()).or_default();
            pollster::block_on(sync_scope(
                &scope,
                state,
                chain,
                &mut adapters,
                &mut self.clock,
                "mac",
                &ScopeOptions::default(),
            ))
            .unwrap();
        }
    }

    fn sees(&self) -> Value {
        Value::Object(
            self.states
                .iter()
                .map(|(scope, state)| {
                    (
                        scope.clone(),
                        Value::Object(visible(state, "").into_iter().collect()),
                    )
                })
                .collect(),
        )
    }
}

fn phone(now: i64) -> Arc<MemStore> {
    let tab = crate::store::BrowserTab {
        url: "https://phone.example/".into(),
        title: "On the phone".into(),
        ..create_tab("phone-tab", now, "", false, "personal")
    };
    let data = initial_browser_data(tab, BrowserPreferences::default());
    let store = Arc::new(MemStore(Mutex::new(data)));
    store.dispatch(Action::Visit {
        space_id: "personal".into(),
        url: "https://phone.example/".into(),
        title: "On the phone".into(),
        favicon: None,
        now: now - 1000,
    });
    store
}

fn deps(chain: &Arc<Chain>, store: &Arc<MemStore>, now: i64) -> CycleDeps {
    CycleDeps {
        transport: chain.clone(),
        device_name: "Krish's iPhone".into(),
        store: store.clone(),
        bar_title: "Bookmarks bar".into(),
        history_limit: HISTORY_LIMIT,
        save: Arc::new(|_| Ok(())),
        new_sync_id: Arc::new(|| "phone-space".into()),
        now: Arc::new(move || now),
    }
}

#[test]
fn the_rust_phone_syncs_with_a_computer_as_the_typescript_one_does() {
    let vector: Value =
        serde_json::from_str(include_str!("../../../../../fixtures/phone-sync.json")).unwrap();
    let chain = Arc::new(Chain::default());
    let mut mac = Computer::new();
    let store = phone(mac.now);
    let deps = deps(&chain, &store, mac.now);
    let mut doc = SyncDoc::new("phone");

    mac.sync(&chain);
    pollster::block_on(run_cycle(&mut doc, &deps, false)).unwrap();
    pollster::block_on(run_cycle(&mut doc, &deps, false)).unwrap();
    store.dispatch(Action::PinSite {
        tab_id: "phone-tab".into(),
        pin_id: "phone-pin".into(),
        kind: crate::store::PinKind::Essential,
        folder_id: None,
    });
    pollster::block_on(run_cycle(&mut doc, &deps, false)).unwrap();
    mac.sync(&chain);

    let data = store.data();
    let phone = &vector["phone"];
    assert_eq!(
        serde_json::to_value(&data.spaces).unwrap(),
        phone["spaces"],
        "spaces"
    );
    assert_eq!(
        serde_json::to_value(&data.bookmarks).unwrap(),
        phone["bookmarks"],
        "bookmarks"
    );
    assert_eq!(
        serde_json::to_value(&data.history).unwrap(),
        phone["history"],
        "history"
    );
    assert_eq!(
        serde_json::to_value(&data.pinned_sites).unwrap(),
        phone["pinnedSites"],
        "pins"
    );
    assert_eq!(
        serde_json::to_value(&data.folders).unwrap(),
        phone["folders"],
        "folders"
    );
    assert_eq!(
        serde_json::to_value(&doc.spaces).unwrap(),
        phone["links"],
        "links"
    );
    assert_eq!(json!(doc.profile), phone["profile"], "profile");
    assert_eq!(
        mac.sees(),
        vector["computerSees"],
        "what the computer reads"
    );

    // What Settings › Sync shows.
    let devices: Vec<(String, bool)> = synced_devices(&doc)
        .into_iter()
        .map(|device| (device.name, device.current))
        .collect();
    assert_eq!(
        devices,
        [
            ("Krish's iPhone".to_owned(), true),
            ("Krish's MacBook".to_owned(), false)
        ]
    );
    let tabs = remote_tabs(&doc);
    assert_eq!(tabs.len(), 1);
    assert_eq!(
        (tabs[0].name.as_str(), tabs[0].tabs[0].url.as_str()),
        ("Krish's MacBook", "https://bay.example/")
    );
}

#[test]
fn a_phone_leaving_the_chain_takes_its_name_and_tabs_with_it() {
    let chain = Arc::new(Chain::default());
    let mut mac = Computer::new();
    let store = phone(mac.now);
    let deps = deps(&chain, &store, mac.now);
    let mut doc = SyncDoc::new("phone");
    mac.sync(&chain);
    pollster::block_on(run_cycle(&mut doc, &deps, false)).unwrap();
    pollster::block_on(run_cycle(&mut doc, &deps, false)).unwrap();
    mac.sync(&chain);
    assert!(mac.sees()["app"].get("dev:phone").is_some());
    pollster::block_on(run_cycle(&mut doc, &deps, true)).unwrap();
    mac.sync(&chain);
    assert!(mac.sees()["app"].get("dev:phone").is_none());
    assert!(mac.sees()["p:personal"].get("tabs:phone").is_none());
}

#[test]
fn the_doc_the_expo_app_saved_reads_and_writes_unchanged() {
    // A doc as the TypeScript phone saves it after a cycle.
    let chain = Arc::new(Chain::default());
    let mut mac = Computer::new();
    let store = phone(mac.now);
    let deps = deps(&chain, &store, mac.now);
    let mut doc = SyncDoc::new("phone");
    mac.sync(&chain);
    pollster::block_on(run_cycle(&mut doc, &deps, false)).unwrap();
    let saved = serde_json::to_value(&doc).unwrap();
    let read: SyncDoc = serde_json::from_value(saved.clone()).unwrap();
    assert_eq!(serde_json::to_value(&read).unwrap(), saved);
    assert_eq!(saved["v"], 1);
    assert!(
        saved["scopes"]["app"]["records"]
            .as_object()
            .is_some_and(|records| records.contains_key("dev:phone"))
    );
}
