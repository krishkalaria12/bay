//! Sync through Bay's relay: the same files a folder holds, sealed on the device with the chain's keys, kept by the
//! relay under their tags. A port of `packages/sync/src/relay/transport.ts`.

use std::collections::HashSet;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::bytes::from_base64;
use super::http::{Relay, RelayError};
use super::keys::SyncKeys;

/// The protocol this code speaks (apps/sync-relay/README.md).
pub const RELAY_PROTOCOL: u32 = 1;

/// Names asked for in one read.
const READ_BATCH: usize = 200;

/// Names removed in one request.
const REMOVE_BATCH: usize = 500;

/// What a scope holds: the files this device hasn't read yet, and every name there.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Listing {
    pub files: Vec<(String, String)>,
    /// Files a folder hasn't finished downloading (always empty on the relay).
    pub pending: Vec<String>,
    /// Files that didn't open, with how long they've been seen that way.
    pub damaged: Vec<(String, i64)>,
    pub present: Vec<String>,
}

/// Where a scope's files live: the relay on the phone.
#[async_trait::async_trait]
pub trait Transport: Send + Sync {
    /// Writes a file under a new name and returns the name.
    async fn write(&self, scope: &str, payload: &str) -> Result<String, RelayError>;
    /// Reads the files not in `known`.
    async fn read(&self, scope: &str, known: &[String]) -> Result<Listing, RelayError>;
    async fn remove(&self, scope: &str, ids: &[String]) -> Result<(), RelayError>;
}

#[derive(Deserialize)]
struct Ids {
    ids: Vec<String>,
}

#[derive(Serialize)]
struct IdsRef<'a> {
    ids: &'a [String],
}

#[derive(Deserialize)]
struct ReadFile {
    id: String,
    data: String,
}

#[derive(Deserialize)]
struct ReadAnswer {
    files: Vec<ReadFile>,
    missing: Vec<String>,
    later: Vec<String>,
}

/// A chain's version, which changes with every write, and its size.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, uniffi::Record)]
pub struct ChainState {
    pub version: u64,
    pub size: u64,
}

#[derive(Deserialize)]
struct Health {
    ok: bool,
    v: u32,
}

pub struct RelayTransport {
    keys: Arc<SyncKeys>,
    relay: Relay,
    authorization: String,
}

impl RelayTransport {
    pub fn new(keys: Arc<SyncKeys>, relay: Relay) -> Self {
        let authorization = format!("Bearer {}", keys.relay_secret);
        Self {
            keys,
            relay,
            authorization,
        }
    }

    fn chain(&self) -> String {
        format!("/v1/chains/{}", self.keys.chain_tag)
    }

    fn scope_path(&self, scope: &str) -> String {
        format!("{}/scopes/{}", self.chain(), self.keys.scope_tag(scope))
    }

    /// Whether the relay answers and speaks this code's protocol.
    pub async fn answers(&self) -> bool {
        matches!(self.relay.json::<Health>("GET", "/v1/health", &[], None).await, Ok(health) if health.ok && health.v == RELAY_PROTOCOL)
    }

    /// Writes a file under a name it already has.
    pub async fn write_as(&self, scope: &str, id: &str, payload: &str) -> Result<(), RelayError> {
        let body = self
            .keys
            .seal(payload.as_bytes(), &self.keys.scope_tag(scope), id);
        let headers = [
            ("authorization", self.authorization.as_str()),
            ("content-type", "application/octet-stream"),
        ];
        self.relay
            .empty(
                "PUT",
                &format!("{}/files/{id}", self.scope_path(scope)),
                &headers,
                Some(body),
            )
            .await
    }

    /// The chain's version and size; none before the chain's first file.
    pub async fn state(&self) -> Result<Option<ChainState>, RelayError> {
        match self
            .relay
            .json(
                "GET",
                &self.chain(),
                &[("authorization", &self.authorization)],
                None,
            )
            .await
        {
            Ok(state) => Ok(Some(state)),
            Err(error) if error.status() == 404 => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Every file of the chain, and its claim.
    pub async fn clear(&self) -> Result<(), RelayError> {
        self.relay
            .empty(
                "DELETE",
                &self.chain(),
                &[("authorization", &self.authorization)],
                None,
            )
            .await
    }
}

#[async_trait::async_trait]
impl Transport for RelayTransport {
    async fn write(&self, scope: &str, payload: &str) -> Result<String, RelayError> {
        let id = SyncKeys::new_file_id();
        self.write_as(scope, &id, payload).await?;
        Ok(id)
    }

    async fn read(&self, scope: &str, known: &[String]) -> Result<Listing, RelayError> {
        let auth = [("authorization", self.authorization.as_str())];
        let json = [
            ("authorization", self.authorization.as_str()),
            ("content-type", "application/json"),
        ];
        let Ids { ids } = self
            .relay
            .json("GET", &self.scope_path(scope), &auth, None)
            .await?;
        let skip: HashSet<&String> = known.iter().collect();
        let scope_tag = self.keys.scope_tag(scope);
        let mut listing = Listing {
            present: ids.clone(),
            ..Listing::default()
        };
        let mut wanted: Vec<String> = ids.into_iter().filter(|id| !skip.contains(id)).collect();
        while !wanted.is_empty() {
            let rest = wanted.split_off(wanted.len().min(READ_BATCH));
            let body = serde_json::to_vec(&IdsRef { ids: &wanted }).expect("ids serialize");
            let answer: ReadAnswer = self
                .relay
                .json(
                    "POST",
                    &format!("{}/read", self.scope_path(scope)),
                    &json,
                    Some(body),
                )
                .await?;
            for file in answer.files {
                let opened = from_base64(&file.data)
                    .and_then(|bytes| self.keys.open(&bytes, &scope_tag, &file.id).ok());
                match opened {
                    Some(plain) => listing
                        .files
                        .push((file.id, String::from_utf8_lossy(&plain).into_owned())),
                    None => listing.damaged.push((file.id, 0)),
                }
            }
            // A file removed since the listing is gone, as one removed from a folder is.
            let gone: HashSet<&String> = answer.missing.iter().collect();
            listing.present.retain(|id| !gone.contains(id));
            wanted = answer.later.into_iter().chain(rest).collect();
        }
        Ok(listing)
    }

    async fn remove(&self, scope: &str, ids: &[String]) -> Result<(), RelayError> {
        let json = [
            ("authorization", self.authorization.as_str()),
            ("content-type", "application/json"),
        ];
        for batch in ids.chunks(REMOVE_BATCH) {
            let body = serde_json::to_vec(&IdsRef { ids: batch }).expect("ids serialize");
            self.relay
                .empty(
                    "POST",
                    &format!("{}/remove", self.scope_path(scope)),
                    &json,
                    Some(body),
                )
                .await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::stand_in::StandInRelay;

    fn transport(relay: &Arc<StandInRelay>, key: u8) -> RelayTransport {
        RelayTransport::new(Arc::new(SyncKeys::new([key; 32])), relay.relay())
    }

    #[test]
    fn files_are_sealed_kept_and_read_back() {
        pollster::block_on(async {
            let relay = Arc::new(StandInRelay::default());
            let phone = transport(&relay, 1);
            assert!(phone.answers().await);
            assert_eq!(phone.state().await.unwrap(), None);
            let first = phone.write("p:default", r#"{"v":1}"#).await.unwrap();
            let second = phone.write("p:default", "two").await.unwrap();
            assert_eq!(
                phone.state().await.unwrap().map(|state| state.version),
                Some(2)
            );

            let listing = phone
                .read("p:default", std::slice::from_ref(&first))
                .await
                .unwrap();
            assert_eq!(listing.files, vec![(second.clone(), "two".to_owned())]);
            assert_eq!(listing.present.len(), 2);
            assert!(listing.damaged.is_empty());

            // Another scope is another folder.
            assert!(phone.read("app", &[]).await.unwrap().present.is_empty());

            phone
                .remove("p:default", std::slice::from_ref(&first))
                .await
                .unwrap();
            assert_eq!(
                phone.read("p:default", &[]).await.unwrap().present,
                vec![second]
            );

            phone.clear().await.unwrap();
            assert_eq!(phone.state().await.unwrap(), None);
        });
    }

    #[test]
    fn another_key_is_refused_and_damage_is_reported() {
        pollster::block_on(async {
            let relay = Arc::new(StandInRelay::default());
            let phone = transport(&relay, 1);
            phone.write("app", "mine").await.unwrap();
            // Same chain tag, different secret: a forged secret is refused.
            let keys = Arc::new(SyncKeys::new([1; 32]));
            let forger = RelayTransport {
                authorization: "Bearer forged".into(),
                ..RelayTransport::new(keys, relay.relay())
            };
            assert_eq!(forger.read("app", &[]).await.unwrap_err().status(), 403);

            // A file sealed under another scope's tag reads as damaged, not as an error.
            let id = SyncKeys::new_file_id();
            let other = SyncKeys::new([1; 32]);
            let wrong = other.seal(b"moved", &other.scope_tag("elsewhere"), &id);
            let headers = [("authorization", phone.authorization.as_str())];
            relay
                .relay()
                .empty(
                    "PUT",
                    &format!("{}/files/{id}", phone.scope_path("app")),
                    &headers,
                    Some(wrong),
                )
                .await
                .unwrap();
            let listing = phone.read("app", &[]).await.unwrap();
            assert_eq!(listing.files.len(), 1);
            assert_eq!(listing.damaged, vec![(id, 0)]);
        });
    }

    #[test]
    fn no_answer_is_offline() {
        let relay = Arc::new(StandInRelay::default());
        *relay.offline.lock().unwrap() = true;
        let phone = transport(&relay, 1);
        assert_eq!(
            pollster::block_on(phone.read("app", &[])).unwrap_err(),
            RelayError::Offline
        );
        assert!(!pollster::block_on(phone.answers()));
    }
}
