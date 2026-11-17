//! The scope merge's tests, ported from `packages/sync/src/scope.test.ts`: devices on one folder converge whatever
//! order they sync in, through deletes, clock skew, late and cut-short files, crashes and compaction.

use std::collections::HashSet;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use indexmap::{IndexMap, IndexSet};
use serde_json::{Value, json};

use super::hlc::Clock;
use super::http::RelayError;
use super::scope::*;
use super::transport::{Listing, Transport};

struct Entry {
    payload: String,
    hidden_from: HashSet<String>,
    partial_for: HashSet<String>,
}

#[derive(Default)]
struct Folder {
    scopes: Mutex<IndexMap<String, IndexMap<String, Entry>>>,
    counter: AtomicI64,
    now: Arc<AtomicI64>,
}

impl Folder {
    fn now(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }

    fn advance(&self, by: i64) {
        self.now.fetch_add(by, Ordering::SeqCst);
    }

    fn with_scope<T>(&self, scope: &str, f: impl FnOnce(&mut IndexMap<String, Entry>) -> T) -> T {
        f(self.scopes.lock().unwrap().entry(scope.into()).or_default())
    }
}

/// One device's view of the folder, with a write that can fail before or after it lands and a hook after reads.
/// Runs once, after the next read.
type ReadHook = Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>;

struct FolderTransport {
    folder: Arc<Folder>,
    device: String,
    fail_write: Arc<Mutex<Option<&'static str>>>,
    on_read: ReadHook,
}

#[async_trait::async_trait]
impl Transport for FolderTransport {
    async fn write(&self, scope: &str, payload: &str) -> Result<String, RelayError> {
        let fail = self.fail_write.lock().unwrap().take();
        if fail == Some("before") {
            return Err(RelayError::Offline);
        }
        let id = format!(
            "f{}",
            self.folder.counter.fetch_add(1, Ordering::SeqCst) + 1
        );
        self.folder.with_scope(scope, |files| {
            files.insert(
                id.clone(),
                Entry {
                    payload: payload.into(),
                    hidden_from: HashSet::new(),
                    partial_for: HashSet::new(),
                },
            )
        });
        if fail == Some("after") {
            return Err(RelayError::Offline);
        }
        Ok(id)
    }

    async fn read(&self, scope: &str, known: &[String]) -> Result<Listing, RelayError> {
        let listing = self.folder.with_scope(scope, |files| {
            let mut listing = Listing::default();
            for (id, entry) in files.iter() {
                listing.present.push(id.clone());
                if known.contains(id) {
                    continue;
                }
                if entry.hidden_from.contains(&self.device) {
                    listing.pending.push(id.clone());
                } else if entry.partial_for.contains(&self.device) {
                    listing.damaged.push((id.clone(), 0));
                } else {
                    listing.files.push((id.clone(), entry.payload.clone()));
                }
            }
            listing
        });
        if let Some(hook) = self.on_read.lock().unwrap().take() {
            hook();
        }
        Ok(listing)
    }

    async fn remove(&self, scope: &str, ids: &[String]) -> Result<(), RelayError> {
        self.folder.with_scope(scope, |files| {
            for id in ids {
                files.shift_remove(id);
            }
        });
        Ok(())
    }
}

type Store = Arc<Mutex<IndexMap<String, Value>>>;

struct MapAdapter {
    prefix: &'static str,
    store: Store,
    adopt: bool,
}

impl Adapter for MapAdapter {
    fn prefix(&self) -> &str {
        self.prefix
    }

    fn extract(&mut self, _base: &dyn Fn(&str) -> Option<Value>) -> Option<Extraction> {
        Some(Extraction {
            values: self.store.lock().unwrap().clone(),
            ignore: None,
        })
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        _base: &dyn Fn(&str) -> Option<Value>,
    ) -> bool {
        let mut store = self.store.lock().unwrap();
        for key in changed {
            match visible.get(key) {
                Some(value) => {
                    store.insert(key.clone(), value.clone());
                }
                // Settings are adopted, never deleted.
                None if !self.adopt => {
                    store.shift_remove(key);
                }
                None => {}
            }
        }
        true
    }

    fn adopt_remote_on_join(&self) -> bool {
        self.adopt
    }
}

struct Device {
    id: String,
    folder: Arc<Folder>,
    store: Store,
    settings: Store,
    state: ScopeState,
    clock: Clock,
    offset: Arc<AtomicI64>,
    options: ScopeOptions,
    fail_write: Arc<Mutex<Option<&'static str>>>,
    on_read: ReadHook,
    saved: String,
    saved_clock: Option<String>,
    journal: Arc<Mutex<IndexMap<i64, LogFile>>>,
}

fn device_clock(
    id: &str,
    last: Option<&str>,
    folder: &Arc<Folder>,
    offset: &Arc<AtomicI64>,
) -> Clock {
    let (now, offset) = (folder.now.clone(), offset.clone());
    Clock::new(
        id,
        last,
        Box::new(move || now.load(Ordering::SeqCst) + offset.load(Ordering::SeqCst)),
    )
}

impl Device {
    fn new(id: &str, folder: &Arc<Folder>, options: ScopeOptions) -> Self {
        let offset = Arc::new(AtomicI64::new(0));
        let journal: Arc<Mutex<IndexMap<i64, LogFile>>> = Arc::default();
        let persisted = journal.clone();
        let persist: Persist = Arc::new(move |batches| {
            for file in batches {
                persisted.lock().unwrap().insert(file.seq, file.clone());
            }
            Ok(())
        });
        Self {
            id: id.into(),
            clock: device_clock(id, None, folder, &offset),
            folder: folder.clone(),
            store: Store::default(),
            settings: Store::default(),
            state: ScopeState::default(),
            offset,
            options: ScopeOptions {
                prune_grace: 0,
                persist: Some(persist),
                ..options
            },
            fail_write: Arc::default(),
            on_read: Arc::default(),
            saved: serde_json::to_string(&ScopeState::default()).unwrap(),
            saved_clock: None,
            journal,
        }
    }

    fn set(&self, key: &str, value: Value) {
        self.store.lock().unwrap().insert(key.into(), value);
    }

    fn delete(&self, key: &str) {
        self.store.lock().unwrap().shift_remove(key);
    }

    fn get(&self, key: &str) -> Option<Value> {
        self.store.lock().unwrap().get(key).cloned()
    }

    fn snapshot(&self) -> Vec<(String, Value)> {
        let mut entries: Vec<(String, Value)> = self
            .store
            .lock()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        entries
    }

    fn transport(&self) -> FolderTransport {
        FolderTransport {
            folder: self.folder.clone(),
            device: self.id.clone(),
            fail_write: self.fail_write.clone(),
            on_read: self.on_read.clone(),
        }
    }

    fn sync(&mut self) -> Result<CycleResult, ScopeError> {
        let transport = self.transport();
        let mut adapters: Vec<Box<dyn Adapter>> = vec![
            Box::new(MapAdapter {
                prefix: "x:",
                store: self.store.clone(),
                adopt: false,
            }),
            Box::new(MapAdapter {
                prefix: "set:",
                store: self.settings.clone(),
                adopt: true,
            }),
        ];
        pollster::block_on(sync_scope(
            "s",
            &mut self.state,
            &transport,
            &mut adapters,
            &mut self.clock,
            &self.id,
            &self.options,
        ))
    }

    fn relaunch(&mut self) {
        self.state = serde_json::from_str(&serde_json::to_string(&self.state).unwrap()).unwrap();
        self.clock = device_clock(
            &self.id,
            Some(&self.clock.last()),
            &self.folder,
            &self.offset,
        );
    }

    fn save(&mut self) {
        self.saved = serde_json::to_string(&self.state).unwrap();
        self.saved_clock = Some(self.clock.last());
        let seq = self.state.seq;
        self.journal.lock().unwrap().retain(|saved, _| *saved > seq);
    }

    /// Quits without saving: back to what's on disk; the store keeps its edits.
    fn crash(&mut self) {
        self.state = serde_json::from_str(&self.saved).unwrap();
        self.clock = device_clock(
            &self.id,
            self.saved_clock.as_deref(),
            &self.folder,
            &self.offset,
        );
        let batches: Vec<LogFile> = self.journal.lock().unwrap().values().cloned().collect();
        restore_journal(&mut self.state, &batches, &mut self.clock, 0);
    }
}

fn sync_all(devices: &mut [&mut Device], rounds: usize) {
    for _ in 0..rounds {
        for device in devices.iter_mut() {
            device.sync().unwrap();
        }
    }
}

#[test]
fn concurrent_edits_converge_on_the_newest_whatever_order_devices_sync_in() {
    for a_first in [true, false] {
        let folder = Arc::new(Folder::default());
        let mut a = Device::new("devA", &folder, ScopeOptions::default());
        let mut b = Device::new("devB", &folder, ScopeOptions::default());
        a.set("x:k", json!("base"));
        sync_all(&mut [&mut a, &mut b], 2);
        folder.advance(10);
        a.set("x:k", json!("A's edit"));
        folder.advance(10);
        b.set("x:k", json!("B's edit (later)"));
        if a_first {
            sync_all(&mut [&mut a, &mut b], 3);
        } else {
            sync_all(&mut [&mut b, &mut a], 3);
        }
        assert_eq!(a.snapshot(), b.snapshot());
        assert_eq!(a.get("x:k"), Some(json!("B's edit (later)")));
        assert_eq!(a.state.records, b.state.records);
    }
}

#[test]
fn deletes_propagate_and_a_later_add_or_edit_wins() {
    let folder = Arc::new(Folder::default());
    let mut a = Device::new("devA", &folder, ScopeOptions::default());
    let mut b = Device::new("devB", &folder, ScopeOptions::default());
    a.set("x:1", json!("one"));
    a.set("x:2", json!("two"));
    sync_all(&mut [&mut a, &mut b], 2);
    folder.advance(5);
    b.delete("x:1");
    sync_all(&mut [&mut b, &mut a], 2);
    assert_eq!(a.get("x:1"), None);
    folder.advance(5);
    a.set("x:1", json!("one again"));
    sync_all(&mut [&mut a, &mut b], 2);
    assert_eq!(b.get("x:1"), Some(json!("one again")));
    folder.advance(5);
    a.delete("x:2");
    folder.advance(5);
    b.set("x:2", json!("two, edited"));
    sync_all(&mut [&mut a, &mut b], 2);
    a.sync().unwrap();
    a.sync().unwrap();
    assert_eq!(a.get("x:2"), Some(json!("two, edited")));
    assert_eq!(a.snapshot(), b.snapshot());
}

#[test]
fn an_edit_made_after_seeing_anothers_wins_even_with_a_slow_clock() {
    let folder = Arc::new(Folder::default());
    folder.advance(10_000_000);
    let mut a = Device::new("devA", &folder, ScopeOptions::default());
    let mut b = Device::new("devB", &folder, ScopeOptions::default());
    b.offset.store(-3_600_000, Ordering::SeqCst);
    a.set("x:k", json!("A"));
    sync_all(&mut [&mut a, &mut b], 2);
    assert_eq!(b.get("x:k"), Some(json!("A")));
    folder.advance(1000);
    b.set("x:k", json!("B, after seeing A"));
    sync_all(&mut [&mut b, &mut a], 2);
    assert_eq!(a.get("x:k"), Some(json!("B, after seeing A")));
    let mut c = Device::new("devC", &folder, ScopeOptions::default());
    c.offset.store(3 * 86_400_000, Ordering::SeqCst);
    c.set("x:k", json!("C from the future"));
    sync_all(&mut [&mut c, &mut a, &mut b], 2);
    assert_eq!(a.get("x:k"), Some(json!("C from the future")));
    folder.advance(1000);
    a.set("x:k", json!("A, after C"));
    sync_all(&mut [&mut a, &mut b, &mut c], 2);
    for device in [&a, &b, &c] {
        assert_eq!(device.get("x:k"), Some(json!("A, after C")));
    }
}

#[test]
fn files_arriving_late_out_of_order_or_cut_short_are_read_when_whole() {
    let folder = Arc::new(Folder::default());
    let mut a = Device::new("devA", &folder, ScopeOptions::default());
    let mut b = Device::new("devB", &folder, ScopeOptions::default());
    a.set("x:1", json!("v1"));
    a.sync().unwrap();
    a.set("x:1", json!("v2"));
    a.set("x:2", json!("second"));
    a.sync().unwrap();
    let ids: Vec<String> = folder.with_scope("s", |files| files.keys().cloned().collect());
    folder.with_scope("s", |files| {
        files[&ids[0]].hidden_from.insert("devB".into());
        files[&ids[1]].partial_for.insert("devB".into());
    });
    let result = b.sync().unwrap();
    assert_eq!(result.pending, 1);
    assert!(b.snapshot().is_empty());
    assert_eq!(b.state.damaged.len(), 1);
    folder.with_scope("s", |files| files[&ids[1]].partial_for.clear());
    b.sync().unwrap();
    assert_eq!(
        b.snapshot(),
        vec![("x:1".into(), json!("v2")), ("x:2".into(), json!("second"))]
    );
    assert_eq!(b.state.vv.get("devA").copied().unwrap_or(0), 0);
    assert_eq!(b.state.extra.get("devA"), Some(&vec![2]));
    folder.with_scope("s", |files| files[&ids[0]].hidden_from.clear());
    b.sync().unwrap();
    assert_eq!(
        b.snapshot(),
        vec![("x:1".into(), json!("v2")), ("x:2".into(), json!("second"))]
    );
    assert_eq!(b.state.vv.get("devA"), Some(&2));
    assert_eq!(b.state.extra.get("devA"), None);
}

#[test]
fn a_local_edit_made_while_files_are_read_is_not_overwritten() {
    let folder = Arc::new(Folder::default());
    let mut a = Device::new("devA", &folder, ScopeOptions::default());
    let mut b = Device::new("devB", &folder, ScopeOptions::default());
    a.set("x:k", json!("old"));
    sync_all(&mut [&mut a, &mut b], 2);
    folder.advance(10);
    a.set("x:k", json!("A remote"));
    a.sync().unwrap();
    folder.advance(10);
    let store = b.store.clone();
    *b.on_read.lock().unwrap() = Some(Box::new(move || {
        store
            .lock()
            .unwrap()
            .insert("x:k".into(), json!("B, typed during the read"));
    }));
    b.sync().unwrap();
    assert_eq!(b.get("x:k"), Some(json!("B, typed during the read")));
    sync_all(&mut [&mut a, &mut b], 2);
    assert_eq!(a.get("x:k"), Some(json!("B, typed during the read")));
}

#[test]
fn three_devices_with_random_edits_orders_and_crashes_converge() {
    let mut seed = 7.0_f64;
    let mut random = move || {
        seed = (seed * 1_103_515_245.0 + 12345.0) % 2f64.powi(31);
        seed / 2f64.powi(31)
    };
    let mut compactions = 0;
    for run in 0..40 {
        let folder = Arc::new(Folder::default());
        let options = || ScopeOptions {
            compact_after_files: 6,
            compact_interval: 0,
            ..ScopeOptions::default()
        };
        let mut devices: Vec<Device> = ["devA", "devB", "devC"]
            .iter()
            .map(|id| Device::new(id, &folder, options()))
            .collect();
        for step in 0..40 {
            folder.advance((random() * 50.0).floor() as i64);
            let index = (random() * 3.0).floor() as usize;
            let key = format!("x:{}", (random() * 6.0).floor());
            let r = random();
            let device = &mut devices[index];
            if r < 0.5 {
                device.set(&key, json!(format!("{}-{step}", device.id)));
            } else if r < 0.7 {
                device.delete(&key);
            } else if r < 0.75 {
                device.relaunch();
            } else if r < 0.8 {
                device.crash();
            } else {
                let _ = device.sync();
            }
            if random() < 0.4 {
                devices[index].save();
            }
            if random() < 0.3 {
                let other = (random() * 3.0).floor() as usize;
                let _ = devices[other].sync();
            }
            let ids: Vec<String> = folder.with_scope("s", |files| files.keys().cloned().collect());
            for id in ids {
                let (hide, cut) = (random() < 0.15, random() < 0.1);
                let hide_from = (random() * 3.0).floor() as usize;
                let cut_for = (random() * 3.0).floor() as usize;
                let (clear_hidden, clear_partial) = (random() < 0.3, random() < 0.3);
                folder.with_scope("s", |files| {
                    let entry = &mut files[&id];
                    if hide {
                        entry
                            .hidden_from
                            .insert(["devA", "devB", "devC"][hide_from].into());
                    }
                    if cut {
                        entry
                            .partial_for
                            .insert(["devA", "devB", "devC"][cut_for].into());
                    }
                    if clear_hidden {
                        entry.hidden_from.clear();
                    }
                    if clear_partial {
                        entry.partial_for.clear();
                    }
                });
            }
        }
        folder.with_scope("s", |files| {
            for entry in files.values_mut() {
                entry.hidden_from.clear();
                entry.partial_for.clear();
            }
        });
        for _ in 0..3 {
            for device in devices.iter_mut() {
                device.sync().unwrap();
            }
        }
        compactions += folder.with_scope("s", |files| {
            files
                .values()
                .filter(|entry| entry.payload.contains("\"snapshot\""))
                .count()
        });
        assert_eq!(devices[0].snapshot(), devices[1].snapshot(), "run {run}");
        assert_eq!(devices[1].snapshot(), devices[2].snapshot(), "run {run}");
        assert_eq!(
            devices[0].state.records, devices[1].state.records,
            "run {run}"
        );
    }
    assert!(compactions > 0);
}

#[test]
fn an_old_snapshot_put_back_after_its_tombstones_went_does_not_bring_records_back() {
    let folder = Arc::new(Folder::default());
    let day = 86_400_000;
    let options = || ScopeOptions {
        compact_after_files: 1000,
        compact_interval: 0,
        tombstone_ttl: 7 * day,
        ..ScopeOptions::default()
    };
    let mut a = Device::new("devA", &folder, options());
    let mut b = Device::new("devB", &folder, options());
    a.set("x:keep", json!(1));
    a.set("x:secret", json!("hunter2"));
    sync_all(&mut [&mut a, &mut b], 2);
    let force = |device: &mut Device| {
        let transport = device.transport();
        let options = device.options.clone();
        pollster::block_on(compact(
            &mut device.state,
            &transport,
            "s",
            &device.id.clone(),
            device.folder.now(),
            &options,
            true,
        ))
        .unwrap();
    };
    force(&mut a);
    let (old_id, old_payload) = folder.with_scope("s", |files| {
        files
            .iter()
            .find(|(_, entry)| entry.payload.contains("\"snapshot\""))
            .map(|(id, entry)| (id.clone(), entry.payload.clone()))
            .unwrap()
    });
    assert!(old_payload.contains("hunter2"));
    folder.advance(day);
    a.delete("x:secret");
    sync_all(&mut [&mut a, &mut b], 2);
    assert_eq!(b.get("x:secret"), None);
    folder.advance(30 * day);
    a.set("x:later", json!(3));
    sync_all(&mut [&mut a, &mut b], 2);
    force(&mut a);
    force(&mut b);
    for device in [&a, &b] {
        assert!(
            !device.state.records.contains_key("x:secret"),
            "{} collected the tombstone",
            device.id
        );
    }
    assert!(!folder.with_scope("s", |files| files.contains_key(&old_id)));

    let put_back = |folder: &Folder| {
        folder.with_scope("s", |files| {
            files.insert(
                old_id.clone(),
                Entry {
                    payload: old_payload.clone(),
                    hidden_from: HashSet::new(),
                    partial_for: HashSet::new(),
                },
            )
        });
    };
    put_back(&folder);
    sync_all(&mut [&mut a, &mut b], 2);
    assert_eq!(a.get("x:secret"), None, "A");
    assert_eq!(b.get("x:secret"), None, "B");
    // A new device reading the old snapshot after the current ones.
    let mut c = Device::new("devC", &folder, options());
    folder.with_scope("s", |files| {
        let old = files.shift_remove(&old_id).unwrap();
        files.insert(old_id.clone(), old);
    });
    c.sync().unwrap();
    assert_eq!(c.get("x:secret"), None, "C");
    assert_eq!(c.snapshot(), a.snapshot());
}

#[test]
fn a_failed_write_is_retried_as_the_same_batch() {
    let folder = Arc::new(Folder::default());
    let mut a = Device::new("devA", &folder, ScopeOptions::default());
    let mut b = Device::new("devB", &folder, ScopeOptions::default());
    for fail in ["after", "before"] {
        a.set(&format!("x:{fail}"), json!(1));
        *a.fail_write.lock().unwrap() = Some(fail);
        assert!(a.sync().is_err());
        a.set(&format!("x:{fail}-next"), json!(2));
        sync_all(&mut [&mut a, &mut b], 2);
        assert_eq!(b.snapshot(), a.snapshot(), "{fail}");
    }
    assert_eq!(b.get("x:after-next"), Some(json!(2)));
    let payloads: Vec<String> = folder.with_scope("s", |files| {
        files.values().map(|entry| entry.payload.clone()).collect()
    });
    let distinct: HashSet<&String> = payloads.iter().collect();
    assert_eq!(
        payloads.len(),
        distinct.len() + 1,
        "only the batch whose write threw after landing is there twice"
    );
}

#[test]
fn settings_are_adopted_on_join_not_published() {
    let folder = Arc::new(Folder::default());
    let mut a = Device::new("devA", &folder, ScopeOptions::default());
    a.settings
        .lock()
        .unwrap()
        .insert("set:theme".into(), json!("dark"));
    a.sync().unwrap();
    a.sync().unwrap();
    let mut b = Device {
        state: ScopeState::awaiting_remote(),
        ..Device::new("devB", &folder, ScopeOptions::default())
    };
    b.settings
        .lock()
        .unwrap()
        .insert("set:theme".into(), json!("light"));
    b.sync().unwrap();
    assert_eq!(
        b.settings.lock().unwrap().get("set:theme"),
        Some(&json!("dark")),
        "joining adopts the chain's"
    );
}

#[test]
fn a_fresh_device_reads_a_typescript_chain_as_typescript_does() {
    let vector: Value =
        serde_json::from_str(include_str!("../../../../fixtures/scope-chain.json")).unwrap();
    let folder = Arc::new(Folder::default());
    folder
        .now
        .store(vector["now"].as_i64().unwrap(), Ordering::SeqCst);
    for file in vector["files"].as_array().unwrap() {
        let payload = file["payload"].as_str().unwrap();
        // Each file the TypeScript side wrote serializes back byte for byte from the Rust types: the two write one format.
        let parsed: Value = serde_json::from_str(payload).unwrap();
        let rewritten = if parsed["kind"] == "log" {
            serde_json::to_string(&serde_json::from_str::<LogFile>(payload).unwrap()).unwrap()
        } else {
            serde_json::to_string(&serde_json::from_str::<SnapshotFile>(payload).unwrap()).unwrap()
        };
        assert_eq!(rewritten, payload);
        folder.with_scope("s", |files| {
            files.insert(
                file["id"].as_str().unwrap().into(),
                Entry {
                    payload: payload.into(),
                    hidden_from: HashSet::new(),
                    partial_for: HashSet::new(),
                },
            )
        });
    }
    let mut reader = Device::new(
        "devR",
        &folder,
        ScopeOptions {
            compact_after_files: 6,
            compact_interval: 0,
            tombstone_ttl: 50_000,
            ..ScopeOptions::default()
        },
    );
    reader.sync().unwrap();
    assert_eq!(
        serde_json::to_value(&reader.state.records).unwrap(),
        vector["records"]
    );
    let store: serde_json::Map<String, Value> = reader
        .store
        .lock()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    assert_eq!(Value::Object(store), vector["store"]);
}
