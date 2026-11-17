//! A relay in memory that answers as `apps/sync-relay` does, for the sync tests: chains with their claims and files,
//! and the pairing boxes.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::bytes::base64;
use super::http::{HttpClient, HttpError, HttpRequest, HttpResponse, Relay};

#[derive(Default)]
struct Chain {
    secret: String,
    files: BTreeMap<String, Vec<u8>>,
    version: u64,
}

#[derive(Default)]
pub struct StandInRelay {
    chains: Mutex<HashMap<String, Chain>>,
    pub boxes: Mutex<HashMap<String, (String, Option<String>)>>,
    pub offline: Mutex<bool>,
}

fn reply(status: u16, body: Option<Value>) -> Result<HttpResponse, HttpError> {
    Ok(HttpResponse {
        status,
        body: body
            .map(|body| body.to_string().into_bytes())
            .unwrap_or_default(),
    })
}

impl StandInRelay {
    pub fn relay(self: &Arc<Self>) -> Relay {
        Relay::new("https://relay.test", self.clone())
    }
}

#[async_trait::async_trait]
impl HttpClient for StandInRelay {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        if *self.offline.lock().unwrap() {
            return Err(HttpError::Offline {
                reason: "test".into(),
            });
        }
        let path = request
            .url
            .strip_prefix("https://relay.test")
            .unwrap_or(&request.url)
            .to_owned();
        let body: Value = request
            .body
            .as_deref()
            .and_then(|body| serde_json::from_slice(body).ok())
            .unwrap_or(Value::Null);
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        let method = request.method.as_str();
        match parts.as_slice() {
            ["v1", "health"] => reply(200, Some(json!({ "ok": true, "v": 1 }))),
            ["v1", "pair"] if method == "POST" => {
                let mut boxes = self.boxes.lock().unwrap();
                let name = body["box"].as_str().unwrap_or_default().to_owned();
                if boxes.contains_key(&name) {
                    return reply(409, Some(json!({ "error": "taken" })));
                }
                boxes.insert(
                    name,
                    (body["pub"].as_str().unwrap_or_default().to_owned(), None),
                );
                reply(204, None)
            }
            ["v1", "pair", name] => {
                let mut boxes = self.boxes.lock().unwrap();
                let Some(entry) = boxes.get_mut(*name) else {
                    return reply(404, Some(json!({ "error": "not-found" })));
                };
                if method == "PUT" {
                    if entry.1.is_some() {
                        return reply(409, Some(json!({ "error": "taken" })));
                    }
                    entry.1 = body["envelope"].as_str().map(str::to_owned);
                    return reply(204, None);
                }
                match &entry.1 {
                    Some(envelope) => {
                        reply(200, Some(json!({ "pub": entry.0, "envelope": envelope })))
                    }
                    None => reply(200, Some(json!({ "pub": entry.0 }))),
                }
            }
            ["v1", "chains", chain_tag, rest @ ..] => {
                let secret = request
                    .headers
                    .get("authorization")
                    .cloned()
                    .unwrap_or_default();
                let mut chains = self.chains.lock().unwrap();
                if chains
                    .get(*chain_tag)
                    .is_some_and(|chain| chain.secret != secret)
                {
                    return reply(403, Some(json!({ "error": "auth" })));
                }
                match rest {
                    [] if method == "DELETE" => {
                        chains.remove(*chain_tag);
                        reply(204, None)
                    }
                    [] => match chains.get(*chain_tag) {
                        Some(chain) => reply(
                            200,
                            Some(
                                json!({ "version": chain.version, "size": chain.files.values().map(Vec::len).sum::<usize>() }),
                            ),
                        ),
                        None => reply(404, Some(json!({ "error": "none" }))),
                    },
                    ["scopes", scope] => {
                        let ids: Vec<String> = chains
                            .get(*chain_tag)
                            .map(|chain| {
                                chain
                                    .files
                                    .keys()
                                    .filter_map(|key| {
                                        key.strip_prefix(&format!("{scope}/")).map(str::to_owned)
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        let version = chains.get(*chain_tag).map_or(0, |chain| chain.version);
                        reply(200, Some(json!({ "ids": ids, "version": version })))
                    }
                    ["scopes", scope, "files", id] => {
                        let chain =
                            chains
                                .entry((*chain_tag).to_owned())
                                .or_insert_with(|| Chain {
                                    secret,
                                    ..Chain::default()
                                });
                        let key = format!("{scope}/{id}");
                        // A name already there keeps its first file.
                        if let std::collections::btree_map::Entry::Vacant(slot) =
                            chain.files.entry(key)
                        {
                            slot.insert(request.body.unwrap_or_default());
                            chain.version += 1;
                        }
                        reply(204, None)
                    }
                    ["scopes", scope, "read"] => {
                        let chain = chains.get(*chain_tag);
                        let ids: Vec<String> =
                            serde_json::from_value(body["ids"].clone()).unwrap_or_default();
                        let file = |id: &String| {
                            chain.and_then(|chain| chain.files.get(&format!("{scope}/{id}")))
                        };
                        let files: Vec<Value> = ids
                            .iter()
                            .filter_map(|id| {
                                file(id).map(|data| json!({ "id": id, "data": base64(data) }))
                            })
                            .collect();
                        let missing: Vec<&String> =
                            ids.iter().filter(|id| file(id).is_none()).collect();
                        reply(
                            200,
                            Some(json!({ "files": files, "missing": missing, "later": [] })),
                        )
                    }
                    ["scopes", scope, "remove"] => {
                        let ids: Vec<String> =
                            serde_json::from_value(body["ids"].clone()).unwrap_or_default();
                        if let Some(chain) = chains.get_mut(*chain_tag) {
                            for id in ids {
                                chain.files.remove(&format!("{scope}/{id}"));
                            }
                            chain.version += 1;
                        }
                        reply(204, None)
                    }
                    _ => reply(404, Some(json!({ "error": "route" }))),
                }
            }
            _ => reply(404, Some(json!({ "error": "route" }))),
        }
    }
}
