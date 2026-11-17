//! The phone's sync cycle, as the computer runs its own over the same chain: the app's scope first, where every
//! device names itself and the computer lists its profiles, then each linked space's scope (the computer's default
//! profile's holds its open tabs, bookmarks and history). A port of the Expo app's `src/sync/engine.ts`; its doc
//! (`sync/state.json`) reads and writes unchanged.

use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::adapters::{
    BookmarksAdapter, DeviceAdapter, DeviceTabsAdapter, HISTORY_WINDOW_MS, HistoryAdapter,
    PinsAdapter, ProfilesAdapter, RetiredAdapter, StoreAccess, phone_color, read_profile,
    remote_profiles,
};
use crate::store::model::PERSONAL_SPACE_ID;
use crate::store::{Action, BrowserSpace};
use crate::sync::hlc::Clock;
use crate::sync::scope::{
    Adapter, Expired, Persist, ScopeError, ScopeOptions, ScopeState, sync_scope, visible,
};
use crate::sync::transport::Transport;

/// Where every device names itself and the computer lists its profiles.
pub const APP_SCOPE: &str = "app";

/// What the phone syncs; each can be turned off in Settings › Sync.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct SyncTypes {
    pub tabs: bool,
    pub bookmarks: bool,
    pub history: bool,
}

impl Default for SyncTypes {
    fn default() -> Self {
        Self {
            tabs: true,
            bookmarks: true,
            history: true,
        }
    }
}

/// The phone's sync, saved between launches. The chain's key isn't here: it's in the secure store.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDoc {
    pub v: u8,
    pub device_id: String,
    pub clock: Option<String>,
    /// The computer's default profile's sync id, once its record has come: its scope is `p:<profile>`.
    pub profile: Option<String>,
    /// Each of the phone's spaces and the computer's space it is (space id → the profile's sync id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spaces: Option<IndexMap<String, String>>,
    pub scopes: IndexMap<String, ScopeState>,
    pub types: SyncTypes,
    pub last_synced_at: Option<i64>,
}

impl SyncDoc {
    pub fn new(device_id: &str) -> Self {
        Self {
            v: 1,
            device_id: device_id.into(),
            clock: None,
            profile: None,
            spaces: None,
            scopes: IndexMap::new(),
            types: SyncTypes::default(),
            last_synced_at: None,
        }
    }
}

/// The computer's rule: a history record older than the window is gone everywhere, not deleted.
pub fn history_expired(key: &str, value: &Value, now: i64) -> bool {
    if !key.starts_with("h:") {
        return false;
    }
    let Some(times) = value.get("vt").and_then(Value::as_array) else {
        return false;
    };
    let Some(times) = times.iter().map(Value::as_f64).collect::<Option<Vec<_>>>() else {
        return false;
    };
    times.into_iter().fold(0.0, f64::max) < (now - HISTORY_WINDOW_MS) as f64
}

/// Saves the sync doc.
pub type SaveDoc = Arc<dyn Fn(&SyncDoc) -> Result<(), String> + Send + Sync>;

/// What a cycle needs from the app.
pub struct CycleDeps {
    pub transport: Arc<dyn Transport>,
    /// This phone's name, as the computer lists it.
    pub device_name: String,
    pub store: Arc<dyn StoreAccess>,
    /// The computer's bookmarks bar's name on the phone.
    pub bar_title: String,
    pub history_limit: usize,
    /// Saves the doc; it runs before each write, so a crash never reuses a batch's number.
    pub save: SaveDoc,
    /// A new profile's sync id, for a space made on the phone.
    pub new_sync_id: Arc<dyn Fn() -> String + Send + Sync>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

fn app_adapters(doc: &SyncDoc, deps: &CycleDeps, retired: bool) -> Vec<Box<dyn Adapter>> {
    if retired {
        return vec![Box::new(RetiredAdapter {
            prefix: "dev:",
            key: format!("dev:{}", doc.device_id),
        })];
    }
    vec![
        Box::new(DeviceAdapter::new(&doc.device_id, &deps.device_name)),
        Box::new(ProfilesAdapter {
            store: deps.store.clone(),
            links: doc.spaces.clone().unwrap_or_default(),
        }),
    ]
}

/// A space's scope: its open tabs and pins; the default profile's also has the bookmarks and history.
fn space_adapters(
    doc: &SyncDoc,
    deps: &CycleDeps,
    space_id: &str,
    main: bool,
    retired: bool,
) -> Vec<Box<dyn Adapter>> {
    let retired_tabs = || -> Box<dyn Adapter> {
        Box::new(RetiredAdapter {
            prefix: "tabs:",
            key: format!("tabs:{}", doc.device_id),
        })
    };
    if retired {
        return vec![retired_tabs()];
    }
    let mut adapters: Vec<Box<dyn Adapter>> = Vec::new();
    if doc.types.tabs {
        adapters.push(Box::new(DeviceTabsAdapter {
            key: format!("tabs:{}", doc.device_id),
            name: deps.device_name.clone(),
            space_id: space_id.into(),
            store: deps.store.clone(),
        }));
        adapters.push(Box::new(PinsAdapter {
            store: deps.store.clone(),
            space_id: space_id.into(),
        }));
    } else {
        adapters.push(retired_tabs());
    }
    if !main {
        return adapters;
    }
    // The computer's default profile is the phone's personal space: its bookmarks and history are the ones that sync.
    if doc.types.bookmarks {
        adapters.push(Box::new(BookmarksAdapter {
            store: deps.store.clone(),
            space_id: PERSONAL_SPACE_ID.into(),
            bar_title: deps.bar_title.clone(),
        }));
    }
    if doc.types.history {
        adapters.push(Box::new(HistoryAdapter {
            store: deps.store.clone(),
            space_id: PERSONAL_SPACE_ID.into(),
            limit: deps.history_limit,
            now: deps.now.clone(),
        }));
    }
    adapters
}

/// What a cycle found: whether the computer's profile has come, so the phone's tabs, bookmarks and history sync.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CycleResult {
    pub profile: bool,
}

/// Saves the doc with a scope's newest state, as `persist` does before a batch is written.
fn persist_for(doc: &SyncDoc, scope: &str, deps: &CycleDeps) -> Persist {
    let template = Arc::new(Mutex::new(doc.clone()));
    let (scope, save) = (scope.to_owned(), deps.save.clone());
    Arc::new(move |state: &ScopeState| {
        let mut doc = template
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        doc.scopes.insert(scope.clone(), state.clone());
        save(&doc)
    })
}

/// One cycle: the app's scope, then each linked space's. `retired` takes this phone out of the chain's records.
pub async fn run_cycle(
    doc: &mut SyncDoc,
    deps: &CycleDeps,
    retired: bool,
) -> Result<CycleResult, ScopeError> {
    let now = deps.now.clone();
    let mut clock = Clock::new(
        &doc.device_id,
        doc.clock.as_deref(),
        Box::new(move || now()),
    );
    let device = doc.device_id.clone();

    // A scope the phone hasn't read yet waits for what's there before it publishes, so joining merges into the chain.
    let mut app = doc
        .scopes
        .get(APP_SCOPE)
        .cloned()
        .unwrap_or_else(ScopeState::awaiting_remote);
    let options = ScopeOptions {
        persist: Some(persist_for(doc, APP_SCOPE, deps)),
        ..ScopeOptions::default()
    };
    let mut adapters = app_adapters(doc, deps, retired);
    let result = sync_scope(
        APP_SCOPE,
        &mut app,
        deps.transport.as_ref(),
        &mut adapters,
        &mut clock,
        &device,
        &options,
    )
    .await;
    doc.scopes.insert(APP_SCOPE.into(), app);
    doc.clock = Some(clock.last());
    result?;

    if doc.profile.is_none() {
        doc.profile = default_profile(&doc.scopes[APP_SCOPE]);
    }
    if doc.profile.is_some() && !retired {
        link_spaces(doc, deps);
    }

    let expired: Expired = Arc::new(history_expired);
    for (space_id, sync_id) in space_scopes(doc, deps) {
        let scope = format!("p:{sync_id}");
        let mut state = doc
            .scopes
            .get(&scope)
            .cloned()
            .unwrap_or_else(ScopeState::awaiting_remote);
        let options = ScopeOptions {
            expired: Some(expired.clone()),
            persist: Some(persist_for(doc, &scope, deps)),
            ..ScopeOptions::default()
        };
        let mut adapters = space_adapters(
            doc,
            deps,
            &space_id,
            doc.profile.as_deref() == Some(sync_id.as_str()),
            retired,
        );
        let result = sync_scope(
            &scope,
            &mut state,
            deps.transport.as_ref(),
            &mut adapters,
            &mut clock,
            &device,
            &options,
        )
        .await;
        doc.scopes.insert(scope, state);
        doc.clock = Some(clock.last());
        result?;
    }

    doc.clock = Some(clock.last());
    doc.last_synced_at = Some((deps.now)());
    (deps.save)(doc).map_err(ScopeError::Persist)?;
    Ok(CycleResult {
        profile: doc.profile.is_some(),
    })
}

/// Links the phone's spaces to the computer's: the first to its default space, its others by name or as new spaces
/// here, and each space made here to a profile of its own, which the computer then offers to add.
fn link_spaces(doc: &mut SyncDoc, deps: &CycleDeps) {
    if !deps.store.ready() {
        return;
    }
    let spaces = deps.store.data().spaces;
    let profile = doc.profile.clone();
    let links = doc.spaces.get_or_insert_with(IndexMap::new);
    links.retain(|id, _| spaces.iter().any(|space| &space.id == id));
    let mut linked: std::collections::HashSet<String> = links.values().cloned().collect();
    if let (Some(profile), Some(first)) = (&profile, spaces.first())
        && !linked.contains(profile)
        && !links.contains_key(&first.id)
    {
        links.insert(first.id.clone(), profile.clone());
        linked.insert(profile.clone());
    }
    let mut added: Vec<BrowserSpace> = Vec::new();
    for (sync_id, record) in remote_profiles(&visible(&doc.scopes[APP_SCOPE], "prof:")) {
        if linked.contains(&sync_id) {
            continue;
        }
        let named = spaces
            .iter()
            .find(|space| !links.contains_key(&space.id) && space.name == record.n);
        let id = named.map_or_else(|| format!("sync-{sync_id}"), |space| space.id.clone());
        if named.is_none() {
            added.push(BrowserSpace {
                id: id.clone(),
                name: record.n.clone(),
                color: phone_color(&record.c),
                icon: record.i.clone(),
            });
        }
        links.insert(id, sync_id.clone());
        linked.insert(sync_id);
    }
    if !added.is_empty() {
        deps.store.dispatch(Action::SyncSpaces {
            added,
            changed: Vec::new(),
        });
    }
    for space in deps.store.data().spaces {
        if !links.contains_key(&space.id) {
            links.insert(space.id, (deps.new_sync_id)());
        }
    }
}

/// The scopes a cycle syncs: each linked space's, and the default profile's before any space is linked to it.
fn space_scopes(doc: &SyncDoc, deps: &CycleDeps) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> =
        doc.spaces.clone().unwrap_or_default().into_iter().collect();
    if let Some(profile) = &doc.profile
        && !pairs.iter().any(|(_, sync_id)| sync_id == profile)
    {
        let first = deps
            .store
            .data()
            .spaces
            .first()
            .map(|space| space.id.clone())
            .unwrap_or_default();
        pairs.insert(0, (first, profile.clone()));
    }
    pairs
}

/// The computer's default profile's sync id, from its record in the app's scope.
fn default_profile(app: &ScopeState) -> Option<String> {
    visible(app, "prof:").iter().find_map(|(key, value)| {
        read_profile(Some(value))
            .filter(|record| record.d)
            .map(|_| key[5..].to_owned())
    })
}

/// A device of the chain, as Settings › Sync lists it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SyncedDevice {
    pub id: String,
    pub name: String,
    /// When it last wrote to the chain, as this phone has seen.
    pub last_seen: Option<i64>,
    pub current: bool,
}

pub fn synced_devices(doc: &SyncDoc) -> Vec<SyncedDevice> {
    let Some(app) = doc.scopes.get(APP_SCOPE) else {
        return Vec::new();
    };
    let mut seen = app.seen.clone();
    if let Some(profile) = doc
        .profile
        .as_ref()
        .and_then(|profile| doc.scopes.get(&format!("p:{profile}")))
    {
        seen.extend(profile.seen.clone());
    }
    let mut devices: Vec<SyncedDevice> = visible(app, "dev:")
        .iter()
        .filter_map(|(key, value)| {
            let id = key[4..].to_owned();
            let name = value.get("n")?.as_str()?.to_owned();
            Some(SyncedDevice {
                last_seen: seen.get(&id).copied(),
                current: id == doc.device_id,
                id,
                name,
            })
        })
        .collect();
    devices.sort_by(|a, b| {
        b.current
            .cmp(&a.current)
            .then_with(|| b.last_seen.unwrap_or(0).cmp(&a.last_seen.unwrap_or(0)))
    });
    devices
}

/// A page another device has open.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RemoteTab {
    pub url: String,
    pub title: String,
}

/// Another device's open tabs, to open here.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RemoteTabs {
    pub device_id: String,
    pub name: String,
    pub tabs: Vec<RemoteTab>,
}

pub fn remote_tabs(doc: &SyncDoc) -> Vec<RemoteTabs> {
    let Some(profile) = doc
        .profile
        .as_ref()
        .and_then(|profile| doc.scopes.get(&format!("p:{profile}")))
    else {
        return Vec::new();
    };
    visible(profile, "tabs:")
        .iter()
        .filter_map(|(key, value)| {
            let device_id = key[5..].to_owned();
            let tabs = value
                .get("tabs")?
                .as_array()?
                .iter()
                .map(|tab| {
                    Some(RemoteTab {
                        url: tab.get("u")?.as_str()?.into(),
                        title: tab.get("t")?.as_str()?.into(),
                    })
                })
                .collect::<Option<Vec<_>>>()?;
            let name = value.get("n")?.as_str()?.to_owned();
            (device_id != doc.device_id && !tabs.is_empty()).then_some(RemoteTabs {
                device_id,
                name,
                tabs,
            })
        })
        .collect()
}
