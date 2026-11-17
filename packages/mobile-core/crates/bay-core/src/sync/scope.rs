//! One scope of a sync chain, as every device of it merges: records stamped with hybrid logical clocks, written as
//! log files of operations and folded now and then into snapshots, read back by every device and merged newest-wins.
//! Adapters turn the app's own state into records and records back into it. A port of `packages/sync/src/scope.ts`,
//! whose saved state (`ScopeState`) and files this reads and writes unchanged, so the phone and the computer read one
//! chain.

use std::collections::HashSet;
use std::sync::Arc;

use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::canon::canonical;
use super::hlc::{Clock, Hlc, hlc_wall};
use super::http::RelayError;
use super::transport::Transport;

/// The device and batch a record was written in.
pub type Origin = (String, i64);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncRecord {
    pub h: Hlc,
    pub v: Option<Value>,
    pub o: Origin,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Op {
    pub k: String,
    pub h: Hlc,
    pub v: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogFile {
    pub v: u8,
    pub kind: LogKind,
    pub device: String,
    pub seq: i64,
    pub at: i64,
    pub ops: Vec<Op>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogKind {
    Log,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotKind {
    Snapshot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotFile {
    pub v: u8,
    pub kind: SnapshotKind,
    pub device: String,
    pub at: i64,
    pub vv: IndexMap<String, i64>,
    pub seen: IndexMap<String, i64>,
    pub records: IndexMap<String, SyncRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
enum SyncFile {
    Snapshot(SnapshotFile),
    Log(LogFile),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Log,
    Snapshot,
    Bad,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileMeta {
    pub d: String,
    pub k: FileKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vv: Option<IndexMap<String, i64>>,
    pub at: i64,
}

/// A scope as this device has merged it, saved between cycles.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeState {
    pub records: IndexMap<String, SyncRecord>,
    /// Each published key's value as canonical JSON, as this device last published or applied it.
    pub base: IndexMap<String, String>,
    pub unapplied: Vec<String>,
    pub vv: IndexMap<String, i64>,
    pub extra: IndexMap<String, Vec<i64>>,
    pub files: IndexMap<String, FileMeta>,
    pub damaged: IndexMap<String, i64>,
    /// The last seq given to a batch. Batches in `journal` have their seq but may not be written yet.
    pub seq: i64,
    pub outbox: Vec<Op>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub journal: Option<Vec<LogFile>>,
    pub seen: IndexMap<String, i64>,
    pub joined: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub await_remote: Option<bool>,
    pub snapshot_at: i64,
    pub pending: i64,
}

impl ScopeState {
    /// A scope this device hasn't read yet: it waits for what's there before it publishes, so joining merges.
    pub fn awaiting_remote() -> Self {
        Self {
            await_remote: Some(true),
            ..Self::default()
        }
    }
}

/// Keys an adapter doesn't own though they share its prefix: asked with each key's last published value.
pub type Ignore = Box<dyn Fn(&str, Option<&Value>) -> bool + Send>;

/// What an adapter publishes: its keys' values, and the keys it doesn't own though they share its prefix.
pub struct Extraction {
    pub values: IndexMap<String, Value>,
    pub ignore: Option<Ignore>,
}

/// Turns part of the app's state into records with a key prefix, and records back into it.
pub trait Adapter: Send {
    fn prefix(&self) -> &str;
    /// The values to publish, or none while the app's state isn't ready.
    fn extract(&mut self, base: &dyn Fn(&str) -> Option<Value>) -> Option<Extraction>;
    /// Applies the visible records under the prefix; `false` keeps the changed keys for the next cycle.
    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        base: &dyn Fn(&str) -> Option<Value>,
    ) -> bool;
    /// When a value was made, for a record published for the first time.
    fn edited_at(&self, _value: &Value) -> Option<i64> {
        None
    }
    /// Publishes nothing until the scope has joined, so a new device takes the chain's values.
    fn adopt_remote_on_join(&self) -> bool {
        false
    }
}

/// Saves the scope, with the batches about to be written in its journal, so they survive a crash; they're written only
/// once it returns.
pub type Persist = Arc<dyn Fn(&ScopeState) -> Result<(), String> + Send + Sync>;

/// Whether a record has expired and is dropped at the next snapshot.
pub type Expired = Arc<dyn Fn(&str, &Value, i64) -> bool + Send + Sync>;

#[derive(Clone)]
pub struct ScopeOptions {
    pub expired: Option<Expired>,
    pub tombstone_ttl: i64,
    pub compact_after_files: usize,
    pub compact_interval: i64,
    pub prune_grace: i64,
    pub damaged_give_up: i64,
    pub persist: Option<Persist>,
}

impl Default for ScopeOptions {
    fn default() -> Self {
        Self {
            expired: None,
            tombstone_ttl: 45 * 86_400_000,
            compact_after_files: 40,
            compact_interval: 10 * 60_000,
            prune_grace: 60 * 60_000,
            damaged_give_up: 86_400_000,
            persist: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ScopeError {
    #[error(transparent)]
    Relay(#[from] RelayError),
    #[error("Couldn't save sync's progress: {0}")]
    Persist(String),
}

pub fn covered(vv: &IndexMap<String, i64>, (device, seq): (&str, i64)) -> bool {
    vv.get(device).copied().unwrap_or(0) >= seq
}

fn mark_applied(state: &mut ScopeState, device: &str, seq: i64) {
    if covered(&state.vv, (device, seq)) {
        return;
    }
    let mut extra: std::collections::BTreeSet<i64> = state
        .extra
        .get(device)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect();
    extra.insert(seq);
    let mut top = state.vv.get(device).copied().unwrap_or(0);
    while extra.remove(&(top + 1)) {
        top += 1;
    }
    state.vv.insert(device.into(), top);
    if extra.is_empty() {
        state.extra.shift_remove(device);
    } else {
        state
            .extra
            .insert(device.into(), extra.into_iter().collect());
    }
}

fn is_applied(state: &ScopeState, (device, seq): (&str, i64)) -> bool {
    covered(&state.vv, (device, seq))
        || state
            .extra
            .get(device)
            .is_some_and(|extra| extra.contains(&seq))
}

fn see(state: &mut ScopeState, device: &str, at: i64) {
    if state.seen.get(device).is_none_or(|seen| at > *seen) {
        state.seen.insert(device.into(), at);
    }
}

fn merge_record(state: &mut ScopeState, key: &str, record: SyncRecord, clock: &mut Clock) -> bool {
    clock.observe(&record.h);
    if state
        .records
        .get(key)
        .is_some_and(|current| current.h >= record.h)
    {
        return false;
    }
    state.records.insert(key.into(), record);
    true
}

pub fn ingest_log(
    state: &mut ScopeState,
    file: &LogFile,
    clock: &mut Clock,
    changed: &mut IndexSet<String>,
) {
    see(state, &file.device, file.at);
    if is_applied(state, (&file.device, file.seq)) {
        return;
    }
    for op in &file.ops {
        if merge_record(
            state,
            &op.k,
            SyncRecord {
                h: op.h.clone(),
                v: op.v.clone(),
                o: (file.device.clone(), file.seq),
            },
            clock,
        ) {
            changed.insert(op.k.clone());
        }
    }
    mark_applied(state, &file.device, file.seq);
}

pub fn ingest_snapshot(
    state: &mut ScopeState,
    file: &SnapshotFile,
    clock: &mut Clock,
    changed: &mut IndexSet<String>,
) {
    for (device, at) in &file.seen {
        see(state, device, *at);
    }
    see(state, &file.device, file.at);
    for (key, record) in &file.records {
        // This replica already applied the change that wrote this record and no longer has the key: it was deleted
        // and the tombstone collected (or it expired). An older snapshot mustn't bring it back.
        if !state.records.contains_key(key) && is_applied(state, (&record.o.0, record.o.1)) {
            continue;
        }
        if merge_record(state, key, record.clone(), clock) {
            changed.insert(key.clone());
        }
    }
    let gone: Vec<String> = state
        .records
        .iter()
        .filter(|(key, record)| {
            !file.records.contains_key(*key) && covered(&file.vv, (&record.o.0, record.o.1))
        })
        .map(|(key, _)| key.clone())
        .collect();
    for key in gone {
        state.records.shift_remove(&key);
        changed.insert(key);
    }
    for (device, seq) in &file.vv {
        if *seq > state.vv.get(device).copied().unwrap_or(0) {
            state.vv.insert(device.clone(), *seq);
            let mut extra: Vec<i64> = state
                .extra
                .get(device)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|s| s > seq)
                .collect();
            let mut top = *seq;
            while extra.first() == Some(&(top + 1)) {
                top = extra.remove(0);
                state.vv.insert(device.clone(), top);
            }
            if extra.is_empty() {
                state.extra.shift_remove(device);
            } else {
                state.extra.insert(device.clone(), extra);
            }
        }
    }
}

/// The live records under a prefix, in the order they were first written here.
pub fn visible(state: &ScopeState, prefix: &str) -> IndexMap<String, Value> {
    state
        .records
        .iter()
        .filter_map(|(key, record)| {
            record
                .v
                .as_ref()
                .filter(|_| key.starts_with(prefix))
                .map(|value| (key.clone(), value.clone()))
        })
        .collect()
}

fn parse_base(json: Option<&String>) -> Option<Value> {
    json.and_then(|json| serde_json::from_str(json).ok())
}

pub fn publish_adapter(
    state: &mut ScopeState,
    adapter: &mut dyn Adapter,
    clock: &mut Clock,
    device: &str,
) -> IndexSet<String> {
    let mut published = IndexSet::new();
    if adapter.adopt_remote_on_join() && !state.joined {
        return published;
    }
    let base = state.base.clone();
    let Some(extraction) = adapter.extract(&|key| parse_base(base.get(key))) else {
        return published;
    };

    let mut put =
        |state: &mut ScopeState, key: &str, value: Option<Value>, adapter: &dyn Adapter| {
            let known = state.records.get(key);
            let edited_at = if known.is_none() {
                value.as_ref().and_then(|value| adapter.edited_at(value))
            } else {
                None
            };
            let h = match edited_at {
                Some(at) => clock.at(at),
                None => clock.tick(),
            };
            if known.is_some_and(|known| known.h >= h) {
                return;
            }
            state.records.insert(
                key.into(),
                SyncRecord {
                    h: h.clone(),
                    v: value.clone(),
                    o: (device.into(), state.seq + 1),
                },
            );
            state.outbox.push(Op {
                k: key.into(),
                h,
                v: value,
            });
            published.insert(key.to_owned());
        };

    for (key, value) in &extraction.values {
        let json = canonical(value);
        if state.base.get(key) == Some(&json) {
            continue;
        }
        state.base.insert(key.clone(), json);
        put(state, key, Some(value.clone()), &*adapter);
    }
    let prefix = adapter.prefix().to_owned();
    let stale: Vec<String> = state
        .base
        .keys()
        .filter(|key| {
            key.starts_with(&prefix)
                && !extraction.values.contains_key(*key)
                && !extraction
                    .ignore
                    .as_ref()
                    .is_some_and(|ignore| ignore(key, parse_base(state.base.get(*key)).as_ref()))
        })
        .cloned()
        .collect();
    for key in stale {
        state.base.shift_remove(&key);
        put(state, &key, None, &*adapter);
    }
    published
}

pub fn publish(
    state: &mut ScopeState,
    adapters: &mut [Box<dyn Adapter>],
    clock: &mut Clock,
    device: &str,
) -> IndexSet<String> {
    let mut published = IndexSet::new();
    for adapter in adapters.iter_mut() {
        published.extend(publish_adapter(state, adapter.as_mut(), clock, device));
    }
    published
}

pub async fn flush(
    state: &mut ScopeState,
    transport: &dyn Transport,
    scope: &str,
    device: &str,
    now: i64,
    options: &ScopeOptions,
) -> Result<(), ScopeError> {
    if !state.outbox.is_empty() {
        state.seq += 1;
        let file = LogFile {
            v: 1,
            kind: LogKind::Log,
            device: device.into(),
            seq: state.seq,
            at: now,
            ops: std::mem::take(&mut state.outbox),
        };
        state.journal.get_or_insert_with(Vec::new).push(file);
    }
    if state.journal.as_ref().is_none_or(Vec::is_empty) {
        return Ok(());
    }
    if let Some(persist) = &options.persist {
        persist(state).map_err(ScopeError::Persist)?;
    }
    while let Some(file) = state
        .journal
        .as_ref()
        .and_then(|journal| journal.first())
        .cloned()
    {
        let payload = serde_json::to_string(&file).expect("a log file serializes");
        let id = transport.write(scope, &payload).await?;
        state.files.insert(
            id,
            FileMeta {
                d: file.device.clone(),
                k: FileKind::Log,
                s: Some(file.seq),
                vv: None,
                at: file.at,
            },
        );
        if let Some(journal) = state.journal.as_mut() {
            journal.remove(0);
        }
        mark_applied(state, &file.device, file.seq);
        see(state, &file.device, now);
    }
    state.journal = None;
    Ok(())
}

/// After a restart, puts back the batches `persist` saved that `state` (as last saved) doesn't have yet. Batches
/// above `written` may not have been written and are sent again by the next flush.
pub fn restore_journal(
    state: &mut ScopeState,
    batches: &[LogFile],
    clock: &mut Clock,
    written: i64,
) {
    let saved = state.seq;
    let mut batches = batches.to_vec();
    batches.sort_by_key(|file| file.seq);
    for file in batches {
        if file.seq <= state.seq {
            continue;
        }
        // The saved outbox went out in the batch after the saved seq.
        if file.seq == saved + 1 {
            state.outbox.clear();
        }
        for op in &file.ops {
            merge_record(
                state,
                &op.k,
                SyncRecord {
                    h: op.h.clone(),
                    v: op.v.clone(),
                    o: (file.device.clone(), file.seq),
                },
                clock,
            );
            match &op.v {
                None => {
                    state.base.shift_remove(&op.k);
                }
                Some(value) => {
                    state.base.insert(op.k.clone(), canonical(value));
                }
            }
        }
        state.seq = file.seq;
        if file.seq <= written {
            mark_applied(state, &file.device, file.seq);
        } else {
            state.journal.get_or_insert_with(Vec::new).push(file);
        }
    }
    state.seq = state.seq.max(written);
}

/// The last seq known to be written.
pub fn written_seq(state: &ScopeState) -> i64 {
    state.seq
        - state
            .journal
            .as_ref()
            .map_or(0, |journal| journal.len() as i64)
}

pub async fn pull(
    state: &mut ScopeState,
    transport: &dyn Transport,
    scope: &str,
    clock: &mut Clock,
    now: i64,
    options: &ScopeOptions,
) -> Result<IndexSet<String>, ScopeError> {
    let known: Vec<String> = state.files.keys().cloned().collect();
    let listing = transport.read(scope, &known).await?;
    let mut changed = IndexSet::new();
    let mut parsed: Vec<(String, SyncFile)> = Vec::new();

    let bad = |state: &mut ScopeState, id: &str| {
        let since = *state.damaged.entry(id.into()).or_insert(now);
        if now - since > options.damaged_give_up {
            state.files.insert(
                id.into(),
                FileMeta {
                    d: String::new(),
                    k: FileKind::Bad,
                    s: None,
                    vv: None,
                    at: now,
                },
            );
            state.damaged.shift_remove(id);
        }
    };

    for (id, payload) in &listing.files {
        match serde_json::from_str::<SyncFile>(payload) {
            Ok(file)
                if matches!(&file, SyncFile::Log(log) if log.v == 1)
                    || matches!(&file, SyncFile::Snapshot(snapshot) if snapshot.v == 1) =>
            {
                parsed.push((id.clone(), file));
            }
            _ => bad(state, id),
        }
    }
    for (id, _) in &listing.damaged {
        bad(state, id);
    }
    // Snapshots first: a stable sort, as JavaScript's.
    parsed.sort_by_key(|(_, file)| !matches!(file, SyncFile::Snapshot(_)));

    for (id, file) in &parsed {
        match file {
            SyncFile::Snapshot(snapshot) => {
                ingest_snapshot(state, snapshot, clock, &mut changed);
                state.files.insert(
                    id.clone(),
                    FileMeta {
                        d: snapshot.device.clone(),
                        k: FileKind::Snapshot,
                        s: None,
                        vv: Some(snapshot.vv.clone()),
                        at: snapshot.at,
                    },
                );
            }
            SyncFile::Log(log) => {
                ingest_log(state, log, clock, &mut changed);
                state.files.insert(
                    id.clone(),
                    FileMeta {
                        d: log.device.clone(),
                        k: FileKind::Log,
                        s: Some(log.seq),
                        vv: None,
                        at: log.at,
                    },
                );
            }
        }
        state.damaged.shift_remove(id);
    }

    let present: HashSet<&String> = listing.present.iter().collect();
    state.files.retain(|id, _| present.contains(id));
    state.damaged.retain(|id, _| present.contains(id));
    state.pending = listing.pending.len() as i64;
    Ok(changed)
}

pub fn apply_adapter(
    state: &mut ScopeState,
    adapter: &mut dyn Adapter,
    keys: &IndexSet<String>,
) -> bool {
    let mine: IndexSet<String> = keys
        .iter()
        .filter(|key| key.starts_with(adapter.prefix()))
        .cloned()
        .collect();
    if mine.is_empty() {
        return true;
    }
    let view = visible(state, adapter.prefix());
    let base = state.base.clone();
    if !adapter.apply(&view, &mine, &|key| parse_base(base.get(key))) {
        return false;
    }
    for key in mine {
        match view.get(&key) {
            Some(value) => {
                state.base.insert(key, canonical(value));
            }
            None => {
                state.base.shift_remove(&key);
            }
        }
    }
    true
}

pub async fn compact(
    state: &mut ScopeState,
    transport: &dyn Transport,
    scope: &str,
    device: &str,
    now: i64,
    options: &ScopeOptions,
    force: bool,
) -> Result<bool, ScopeError> {
    let count = state.files.len();
    let newest_snapshot = state
        .files
        .values()
        .filter(|file| file.k == FileKind::Snapshot)
        .map(|file| file.at)
        .fold(state.snapshot_at, i64::max);
    if !force
        && (count <= options.compact_after_files
            || now - newest_snapshot < options.compact_interval)
    {
        return Ok(false);
    }
    flush(state, transport, scope, device, now, options).await?;
    let mut records = IndexMap::new();
    let mut dropped = Vec::new();
    for (key, record) in &state.records {
        let drop = match &record.v {
            None => now - hlc_wall(&record.h) > options.tombstone_ttl,
            Some(value) => options
                .expired
                .as_ref()
                .is_some_and(|expired| expired(key, value, now)),
        };
        if drop {
            dropped.push(key.clone());
        } else {
            records.insert(key.clone(), record.clone());
        }
    }
    for key in dropped {
        state.records.shift_remove(&key);
    }
    let vv = state.vv.clone();
    let file = SnapshotFile {
        v: 1,
        kind: SnapshotKind::Snapshot,
        device: device.into(),
        at: now,
        vv: vv.clone(),
        seen: state.seen.clone(),
        records,
    };
    let id = transport
        .write(
            scope,
            &serde_json::to_string(&file).expect("a snapshot serializes"),
        )
        .await?;
    state.files.insert(
        id.clone(),
        FileMeta {
            d: device.into(),
            k: FileKind::Snapshot,
            s: None,
            vv: Some(vv.clone()),
            at: now,
        },
    );
    state.snapshot_at = now;
    let dominated = |other: &IndexMap<String, i64>| {
        other
            .iter()
            .all(|(device, seq)| vv.get(device).copied().unwrap_or(0) >= *seq)
    };
    let prune: Vec<String> = state
        .files
        .iter()
        .filter(|(file_id, file)| {
            if **file_id == id || now - file.at < options.prune_grace {
                return false;
            }
            match file.k {
                FileKind::Log => covered(&vv, (&file.d, file.s.unwrap_or(i64::MAX))),
                FileKind::Snapshot => dominated(file.vv.as_ref().unwrap_or(&IndexMap::new())),
                FileKind::Bad => false,
            }
        })
        .map(|(file_id, _)| file_id.clone())
        .collect();
    if !prune.is_empty() {
        transport.remove(scope, &prune).await?;
        for file_id in &prune {
            state.files.shift_remove(file_id);
        }
    }
    Ok(true)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CycleResult {
    pub published: usize,
    pub changed: usize,
    pub pending: i64,
    pub compacted: bool,
}

/// One cycle of a scope: publish, write, read, apply, write what applying changed, and compact now and then.
pub async fn sync_scope(
    scope: &str,
    state: &mut ScopeState,
    transport: &dyn Transport,
    adapters: &mut [Box<dyn Adapter>],
    clock: &mut Clock,
    device: &str,
    options: &ScopeOptions,
) -> Result<CycleResult, ScopeError> {
    let mut published = publish(state, adapters, clock, device).len();
    flush(state, transport, scope, device, clock.now(), options).await?;
    let changed = pull(state, transport, scope, clock, clock.now(), options).await?;
    let changed_count = changed.len();
    let mut keys: IndexSet<String> = state.unapplied.iter().cloned().chain(changed).collect();
    let mut unapplied = Vec::new();
    for adapter in adapters.iter_mut() {
        let late = publish_adapter(state, adapter.as_mut(), clock, device);
        published += late.len();
        for key in &late {
            keys.shift_remove(key);
        }
        if !apply_adapter(state, adapter.as_mut(), &keys) {
            unapplied.extend(
                keys.iter()
                    .filter(|key| key.starts_with(adapter.prefix()))
                    .cloned(),
            );
        }
    }
    unapplied.extend(
        keys.iter()
            .filter(|key| {
                !adapters
                    .iter()
                    .any(|adapter| key.starts_with(adapter.prefix()))
            })
            .cloned(),
    );
    state.unapplied = unapplied;
    if state.await_remote != Some(true) || state.seen.keys().any(|seen| seen != device) {
        state.joined = true;
        state.await_remote = None;
    }
    flush(state, transport, scope, device, clock.now(), options).await?;
    let compacted = compact(state, transport, scope, device, clock.now(), options, false).await?;
    Ok(CycleResult {
        published,
        changed: changed_count,
        pending: state.pending,
        compacted,
    })
}
