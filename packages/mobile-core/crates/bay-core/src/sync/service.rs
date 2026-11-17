//! The phone's sync, running: the chain's key in the secure store, the cycle's doc in the app's documents
//! (`sync/state.json`), joining by a code or the recovery phrase, and leaving. The apps call `sync_now` on their own
//! schedule (every half minute while Bay is in front, a few seconds after a change) and show `view`. A port of the
//! Expo app's `src/sync/service.ts` and `state.ts`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use super::bytes::{base32, base64, from_base64};
use super::http::{DEFAULT_RELAY, HttpClient, Relay, RelayError};
use super::keys::{SyncKeys, random_bytes};
use super::pairing::{Poll, Waiting};
use super::phone::adapters::StoreAccess;
use super::phone::engine::{
    CycleDeps, RemoteTabs, SyncDoc, SyncTypes, SyncedDevice, remote_tabs, run_cycle, synced_devices,
};
use super::phrase::{PhraseProblem, phrase_entropy, phrase_words};
use super::scope::ScopeError;
use super::transport::RelayTransport;
use crate::store::handle::BrowserStore;
use crate::store::model::HISTORY_LIMIT;
use crate::store::{Action, BrowserData};

/// The chain's key, base64, in the secure store.
pub const KEY: &str = "bay.sync.key";

/// The cycle's doc, in the app's documents.
const DOC: &str = "sync/state.json";

/// The device's keychain or keystore, where the chain's key lives.
#[uniffi::export(with_foreign)]
pub trait SecretStore: Send + Sync {
    fn read(&self, key: String) -> Option<String>;
    fn write(&self, key: String, value: String);
    fn delete(&self, key: String);
}

/// Hears that what Settings › Sync shows changed.
#[uniffi::export(with_foreign)]
pub trait SyncObserver: Send + Sync {
    fn changed(&self, view: SyncView);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum SyncStatus {
    /// Not syncing: no key on this phone.
    Off,
    Syncing,
    Synced,
    /// Joined, but the computer hasn't listed a profile yet.
    Waiting,
    /// The relay didn't answer; the next cycle tries again.
    Offline,
    Failed,
}

/// A pairing under way: the code this phone shows and the digits to compare, or how it ended.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum Pairing {
    Starting,
    Waiting { code: String, digits: String },
    Expired,
    Failed,
}

/// What Settings › Sync shows.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SyncView {
    pub status: SyncStatus,
    pub last_synced_at: Option<i64>,
    pub devices: Vec<SyncedDevice>,
    pub remote_tabs: Vec<RemoteTabs>,
    pub types: SyncTypes,
    pub pairing: Option<Pairing>,
}

/// What can sync on its own: tabs, bookmarks, history.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum SyncType {
    Tabs,
    Bookmarks,
    History,
}

struct Joined {
    keys: Arc<SyncKeys>,
    doc: SyncDoc,
}

struct Inner {
    joined: Option<Joined>,
    running: bool,
    status: SyncStatus,
    pairing: Option<Pairing>,
}

#[derive(uniffi::Object)]
pub struct PhoneSync {
    store: Arc<BrowserStore>,
    http: Arc<dyn HttpClient>,
    secrets: Arc<dyn SecretStore>,
    doc_file: PathBuf,
    relay_url: String,
    device_name: String,
    bar_title: String,
    inner: Mutex<Inner>,
    waiting: Mutex<Option<Arc<Waiting>>>,
    observers: Mutex<Vec<Arc<dyn SyncObserver>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

fn new_device_id() -> String {
    base32(&random_bytes::<16>())
}

/// Writes the doc aside, then moves it over: a crash mid-write leaves the last whole state.
fn save_doc(file: &Path, doc: &SyncDoc) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let draft = file.with_extension("json.tmp");
    fs::write(
        &draft,
        serde_json::to_vec(doc).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(&draft, file).map_err(|error| error.to_string())
}

/// The browser store as sync reads and changes it.
struct StoreForSync(Arc<BrowserStore>);

impl StoreAccess for StoreForSync {
    fn data(&self) -> BrowserData {
        self.0.snapshot()
    }

    fn ready(&self) -> bool {
        true
    }

    fn dispatch(&self, action: Action) {
        self.0.dispatch(action);
    }
}

/// A store that reads but never changes: leaving takes the phone's records out without touching its browsing.
struct ReadOnly(Arc<BrowserStore>);

impl StoreAccess for ReadOnly {
    fn data(&self) -> BrowserData {
        self.0.snapshot()
    }

    fn ready(&self) -> bool {
        false
    }

    fn dispatch(&self, _action: Action) {}
}

#[uniffi::export]
impl PhoneSync {
    /// Loads the chain's key and the cycle's doc. `relay_url` is the default relay's unless given.
    #[uniffi::constructor]
    pub fn new(
        store: Arc<BrowserStore>,
        http: Arc<dyn HttpClient>,
        secrets: Arc<dyn SecretStore>,
        documents_dir: String,
        device_name: String,
        bar_title: String,
        relay_url: Option<String>,
    ) -> Arc<Self> {
        let doc_file = Path::new(&documents_dir).join(DOC);
        let joined = secrets
            .read(KEY.into())
            .and_then(|stored| from_base64(&stored))
            .and_then(|entropy| <[u8; 32]>::try_from(entropy).ok())
            .map(|entropy| {
                let doc = fs::read_to_string(&doc_file)
                    .ok()
                    .and_then(|text| serde_json::from_str::<SyncDoc>(&text).ok())
                    .unwrap_or_else(|| SyncDoc::new(&new_device_id()));
                Joined {
                    keys: Arc::new(SyncKeys::new(entropy)),
                    doc,
                }
            });
        let status = if joined.is_some() {
            SyncStatus::Waiting
        } else {
            SyncStatus::Off
        };
        Arc::new(Self {
            store,
            http,
            secrets,
            doc_file,
            relay_url: relay_url.unwrap_or_else(|| DEFAULT_RELAY.into()),
            device_name,
            bar_title,
            inner: Mutex::new(Inner {
                joined,
                running: false,
                status,
                pairing: None,
            }),
            waiting: Mutex::new(None),
            observers: Mutex::new(Vec::new()),
        })
    }

    pub fn observe(&self, observer: Arc<dyn SyncObserver>) {
        lock(&self.observers).push(observer);
    }

    /// What Settings › Sync shows now.
    pub fn view(&self) -> SyncView {
        let inner = lock(&self.inner);
        match &inner.joined {
            Some(joined) => SyncView {
                status: inner.status,
                last_synced_at: joined.doc.last_synced_at,
                devices: synced_devices(&joined.doc),
                remote_tabs: remote_tabs(&joined.doc),
                types: joined.doc.types,
                pairing: inner.pairing.clone(),
            },
            None => SyncView {
                status: SyncStatus::Off,
                last_synced_at: None,
                devices: Vec::new(),
                remote_tabs: Vec::new(),
                types: SyncTypes::default(),
                pairing: inner.pairing.clone(),
            },
        }
    }

    pub fn is_joined(&self) -> bool {
        lock(&self.inner).joined.is_some()
    }

    /// The chain's recovery phrase, to join another device by it.
    pub fn recovery_phrase(&self) -> Option<Vec<String>> {
        lock(&self.inner)
            .joined
            .as_ref()
            .map(|joined| phrase_words(joined.keys.entropy()))
    }

    /// One cycle, if the phone syncs; a cycle under way already is enough.
    pub async fn sync_now(&self) {
        self.cycle().await;
    }

    /// Shows a code and waits under it for a computer to let this phone in; `poll_pairing` asks whether it has.
    pub async fn start_pairing(&self) -> Pairing {
        self.set_pairing(Some(Pairing::Starting));
        let pairing = match Waiting::start(self.relay()).await {
            Ok(waiting) => {
                let pairing = Pairing::Waiting {
                    code: waiting.code.clone(),
                    digits: waiting.digits.clone(),
                };
                *lock(&self.waiting) = Some(Arc::new(waiting));
                pairing
            }
            Err(_) => Pairing::Failed,
        };
        self.set_pairing(Some(pairing.clone()));
        pairing
    }

    /// Asks the relay whether the computer has let this phone in, and joins when it has. The apps call it every two
    /// seconds while the code shows.
    pub async fn poll_pairing(&self) -> Option<Pairing> {
        let Some(waiting) = lock(&self.waiting).clone() else {
            return lock(&self.inner).pairing.clone();
        };
        match waiting.poll().await {
            Ok(Poll::Joined(entropy)) => {
                *lock(&self.waiting) = None;
                self.set_pairing(None);
                if self.join(*entropy).is_err() {
                    self.set_pairing(Some(Pairing::Failed));
                } else {
                    self.cycle().await;
                }
            }
            Ok(Poll::Expired) => {
                *lock(&self.waiting) = None;
                self.set_pairing(Some(Pairing::Expired));
            }
            // Still waiting, or no answer this time: ask again.
            Ok(Poll::Waiting) | Err(_) => {}
        }
        lock(&self.inner).pairing.clone()
    }

    pub fn cancel_pairing(&self) {
        *lock(&self.waiting) = None;
        self.set_pairing(None);
    }

    /// Joins with the recovery phrase, or says why the phrase doesn't read.
    pub async fn join_with_phrase(&self, text: String) -> Result<(), PhraseProblem> {
        let entropy = phrase_entropy(&text)?;
        if self.join(entropy).is_ok() {
            self.cycle().await;
        }
        Ok(())
    }

    pub fn set_type(&self, kind: SyncType, on: bool) {
        {
            let mut inner = lock(&self.inner);
            let Some(joined) = inner.joined.as_mut() else {
                return;
            };
            match kind {
                SyncType::Tabs => joined.doc.types.tabs = on,
                SyncType::Bookmarks => joined.doc.types.bookmarks = on,
                SyncType::History => joined.doc.types.history = on,
            }
            let _ = save_doc(&self.doc_file, &joined.doc);
        }
        self.notify();
    }

    /// Takes this phone out of the chain and forgets the key; what it synced stays.
    pub async fn leave(&self) {
        let joined = lock(&self.inner).joined.take();
        // The phone's name and tabs leave the chain first, if the relay answers; the key goes either way.
        if let Some(mut joined) = joined {
            let deps = self.deps(&joined.keys, Arc::new(ReadOnly(self.store.clone())), false);
            let _ = run_cycle(&mut joined.doc, &deps, true).await;
        }
        self.secrets.delete(KEY.into());
        let _ = fs::remove_file(&self.doc_file);
        lock(&self.inner).status = SyncStatus::Off;
        self.notify();
    }
}

impl PhoneSync {
    fn relay(&self) -> Relay {
        Relay::new(self.relay_url.clone(), self.http.clone())
    }

    fn notify(&self) {
        let view = self.view();
        let observers = lock(&self.observers).clone();
        for observer in observers {
            observer.changed(view.clone());
        }
    }

    fn set_pairing(&self, pairing: Option<Pairing>) {
        lock(&self.inner).pairing = pairing;
        self.notify();
    }

    /// Starts syncing with a chain's key.
    fn join(&self, entropy: [u8; 32]) -> Result<(), String> {
        self.secrets.write(KEY.into(), base64(&entropy));
        let doc = SyncDoc::new(&new_device_id());
        save_doc(&self.doc_file, &doc)?;
        let mut inner = lock(&self.inner);
        inner.joined = Some(Joined {
            keys: Arc::new(SyncKeys::new(entropy)),
            doc,
        });
        inner.status = SyncStatus::Waiting;
        drop(inner);
        self.notify();
        Ok(())
    }

    fn deps(&self, keys: &Arc<SyncKeys>, store: Arc<dyn StoreAccess>, save: bool) -> CycleDeps {
        let file = self.doc_file.clone();
        CycleDeps {
            transport: Arc::new(RelayTransport::new(keys.clone(), self.relay())),
            device_name: self.device_name.clone(),
            store,
            bar_title: self.bar_title.clone(),
            history_limit: HISTORY_LIMIT,
            save: Arc::new(move |doc: &SyncDoc| if save { save_doc(&file, doc) } else { Ok(()) }),
            new_sync_id: Arc::new(new_device_id),
            now: Arc::new(now),
        }
    }

    async fn cycle(&self) {
        let (keys, mut doc) = {
            let mut inner = lock(&self.inner);
            let Some(joined) = inner.joined.as_ref().filter(|_| !inner.running) else {
                return;
            };
            let taken = (joined.keys.clone(), joined.doc.clone());
            inner.running = true;
            inner.status = SyncStatus::Syncing;
            taken
        };
        self.notify();
        let deps = self.deps(&keys, Arc::new(StoreForSync(self.store.clone())), true);
        let result = run_cycle(&mut doc, &deps, false).await;
        {
            let mut inner = lock(&self.inner);
            inner.running = false;
            // Left while the cycle ran: what it learned goes with the key.
            if let Some(joined) = inner
                .joined
                .as_mut()
                .filter(|joined| Arc::ptr_eq(&joined.keys, &keys))
            {
                joined.doc = doc;
                inner.status = match result {
                    Ok(outcome) if outcome.profile => SyncStatus::Synced,
                    Ok(_) => SyncStatus::Waiting,
                    Err(ScopeError::Relay(RelayError::Offline)) => SyncStatus::Offline,
                    Err(_) => SyncStatus::Failed,
                };
            }
        }
        self.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::stand_in::StandInRelay;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Secrets(Mutex<HashMap<String, String>>);

    impl SecretStore for Secrets {
        fn read(&self, key: String) -> Option<String> {
            lock(&self.0).get(&key).cloned()
        }

        fn write(&self, key: String, value: String) {
            lock(&self.0).insert(key, value);
        }

        fn delete(&self, key: String) {
            lock(&self.0).remove(&key);
        }
    }

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bay-sync-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn phone(name: &str, relay: &Arc<StandInRelay>, secrets: &Arc<Secrets>) -> Arc<PhoneSync> {
        let dir = dir(name);
        let store = BrowserStore::open(dir.to_string_lossy().into(), "tab".into(), 1);
        PhoneSync::new(
            store,
            relay.clone(),
            secrets.clone(),
            dir.to_string_lossy().into(),
            "Test phone".into(),
            "Bar".into(),
            Some("https://relay.test".into()),
        )
    }

    #[test]
    fn a_phone_joins_by_phrase_syncs_and_leaves() {
        pollster::block_on(async {
            let relay = Arc::new(StandInRelay::default());
            let secrets = Arc::new(Secrets::default());
            let sync = phone("phrase", &relay, &secrets);
            assert_eq!(sync.view().status, SyncStatus::Off);
            assert_eq!(
                sync.join_with_phrase("too short".into()).await,
                Err(PhraseProblem::WordCount { count: 2 })
            );

            let words = phrase_words(&[5; 32]).join(" ");
            sync.join_with_phrase(words.clone()).await.unwrap();
            assert!(sync.is_joined());
            assert_eq!(sync.recovery_phrase().unwrap().join(" "), words);
            // No computer has listed a profile yet: the phone waits, having named itself.
            assert_eq!(sync.view().status, SyncStatus::Waiting);
            assert_eq!(
                sync.view()
                    .devices
                    .iter()
                    .map(|device| device.name.as_str())
                    .collect::<Vec<_>>(),
                ["Test phone"]
            );
            assert!(secrets.read(KEY.into()).is_some());

            // A relaunch reads the key and the doc back.
            let again = phone("phrase-again", &relay, &secrets);
            assert!(again.is_joined());

            sync.leave().await;
            assert!(!sync.is_joined());
            assert_eq!(secrets.read(KEY.into()), None);
        });
    }

    #[test]
    fn a_phone_pairs_by_code_with_a_device_already_syncing() {
        pollster::block_on(async {
            let relay = Arc::new(StandInRelay::default());
            let sync = phone("code", &relay, &Arc::new(Secrets::default()));
            let Pairing::Waiting { code, digits } = sync.start_pairing().await else {
                panic!("no code")
            };
            assert_eq!(
                sync.poll_pairing().await,
                Some(Pairing::Waiting {
                    code: code.clone(),
                    digits: digits.clone()
                })
            );
            let computer = crate::sync::pairing::Joining::find(&code, relay.relay())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(computer.digits, digits);
            computer.let_in(&[7; 32]).await.unwrap();
            assert_eq!(sync.poll_pairing().await, None);
            assert!(sync.is_joined());
            assert_eq!(sync.recovery_phrase(), Some(phrase_words(&[7; 32])));
        });
    }

    #[test]
    fn no_answer_reads_as_offline() {
        pollster::block_on(async {
            let relay = Arc::new(StandInRelay::default());
            let sync = phone("offline", &relay, &Arc::new(Secrets::default()));
            sync.join_with_phrase(phrase_words(&[3; 32]).join(" "))
                .await
                .unwrap();
            *relay.offline.lock().unwrap() = true;
            sync.sync_now().await;
            assert_eq!(sync.view().status, SyncStatus::Offline);
        });
    }
}
