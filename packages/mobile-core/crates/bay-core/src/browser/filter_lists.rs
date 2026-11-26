//! The filter lists both engines block with, kept fresh on disk: uBlock Origin's default set (as on desktop) plus
//! cookie notices. Each list downloads to a file once a day at most; a server that says the saved copy is current
//! (ETag, else Last-Modified) isn't downloaded from again. The engines read the files themselves, named by a version
//! that changes whenever their text does. The Expo app's `src/privacy/{filterLists,blocker}.ts`.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::sync::http::{HttpClient, HttpRequest};

/// Bumped whenever the engines read the same list text differently, so the rules they cached for a version are
/// rebuilt. 2: a bare hostname line is a hostname rule.
const ENGINE_RULES: u32 = 2;

/// Lists are refreshed once a day.
const REFRESH_AFTER_MS: i64 = 24 * 60 * 60 * 1000;

/// How long a server has to answer the HEAD request that says whether a list changed.
const HEAD_TIMEOUT_MS: u32 = 10_000;

/// Where the lists live, in the app's documents.
const DIRECTORY: &str = "filter-lists";

/// What a site can turn off on its own, for the lists in it; `shared` lists (the unbreak fixes) go with every group.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum FilterGroup {
    Ads,
    Trackers,
    Cookies,
    Shared,
}

impl FilterGroup {
    fn name(self) -> &'static str {
        match self {
            Self::Ads => "ads",
            Self::Trackers => "trackers",
            Self::Cookies => "cookies",
            Self::Shared => "shared",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FilterList {
    pub id: String,
    pub title: String,
    pub group: FilterGroup,
    pub url: String,
}

const LISTS: [(&str, &str, FilterGroup, &str); 8] = [
    (
        "ublock-filters",
        "uBlock filters",
        FilterGroup::Ads,
        "https://ublockorigin.github.io/uAssets/filters/filters.min.txt",
    ),
    (
        "ublock-privacy",
        "uBlock filters – Privacy",
        FilterGroup::Trackers,
        "https://ublockorigin.github.io/uAssets/filters/privacy.min.txt",
    ),
    (
        "ublock-unbreak",
        "uBlock filters – Unbreak",
        FilterGroup::Shared,
        "https://ublockorigin.github.io/uAssets/filters/unbreak.min.txt",
    ),
    (
        "ublock-badware",
        "uBlock filters – Badware risks",
        FilterGroup::Ads,
        "https://ublockorigin.github.io/uAssets/filters/badware.min.txt",
    ),
    (
        "easylist",
        "EasyList",
        FilterGroup::Ads,
        "https://easylist.to/easylist/easylist.txt",
    ),
    (
        "easyprivacy",
        "EasyPrivacy",
        FilterGroup::Trackers,
        "https://easylist.to/easylist/easyprivacy.txt",
    ),
    (
        "plowe",
        "Peter Lowe's list",
        FilterGroup::Ads,
        "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblock&showintro=0&mimetype=plaintext",
    ),
    (
        "cookies",
        "EasyList Cookie",
        FilterGroup::Cookies,
        "https://secure.fanboy.co.nz/fanboy-cookiemonster.txt",
    ),
];

/// The filter lists, in the order the engines get them.
#[uniffi::export]
pub fn filter_lists() -> Vec<FilterList> {
    LISTS
        .iter()
        .map(|(id, title, group, url)| FilterList {
            id: (*id).into(),
            title: (*title).into(),
            group: *group,
            url: (*url).into(),
        })
        .collect()
}

/// The lists on disk, as the engines take them: `file://` addresses, each list's group, and the version that names
/// their text. Empty while none has downloaded yet.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ListsOnDisk {
    pub uris: Vec<String>,
    pub groups: Vec<String>,
    pub version: String,
}

/// When a list was fetched and what its server said about it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListMeta {
    fetched_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_modified: Option<String>,
}

/// A download is plausible filter text, not an error page: judged from its first bytes and its size.
fn looks_like_filter_list(body: &[u8]) -> bool {
    let start = String::from_utf8_lossy(&body[..body.len().min(512)])
        .trim_start()
        .chars()
        .take(200)
        .collect::<String>()
        .to_lowercase();
    body.len() > 1000 && !start.starts_with("<!doctype") && !start.starts_with("<html")
}

/// The server's list matches the saved copy: same ETag, or with no ETag on either side, the same Last-Modified.
fn unchanged(saved: &ListMeta, etag: Option<&String>, last_modified: Option<&String>) -> bool {
    match (&saved.etag, etag) {
        (Some(saved), Some(current)) => saved == current,
        _ => saved.last_modified.is_some() && saved.last_modified.as_ref() == last_modified,
    }
}

/// The filter lists in the app's documents, and the refresh that keeps them current.
#[derive(uniffi::Object)]
pub struct FilterListStore {
    directory: PathBuf,
}

impl FilterListStore {
    fn list_path(&self, id: &str) -> PathBuf {
        self.directory.join(format!("{id}.txt"))
    }

    fn meta_path(&self) -> PathBuf {
        self.directory.join("lists.json")
    }

    fn read_meta(&self) -> HashMap<String, ListMeta> {
        fs::read_to_string(self.meta_path())
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn write_meta(&self, meta: &HashMap<String, ListMeta>) {
        if let Ok(text) = serde_json::to_string(meta) {
            let _ = fs::write(self.meta_path(), text);
        }
    }

    /// Refreshes one list when it is stale; whether its file changed.
    async fn refresh_list(
        &self,
        http: &dyn HttpClient,
        list: &FilterList,
        meta: &mut HashMap<String, ListMeta>,
        now: i64,
    ) -> bool {
        let path = self.list_path(&list.id);
        let cached = path.exists();
        let saved = meta.get(&list.id).cloned();
        let fresh = saved.as_ref().is_some_and(|saved| {
            now - saved.fetched_at < REFRESH_AFTER_MS && saved.fetched_at <= now
        });
        // A missing file is stale whatever the metadata says.
        if cached && fresh {
            return false;
        }
        let head = http
            .send(HttpRequest {
                timeout_ms: Some(HEAD_TIMEOUT_MS),
                ..HttpRequest::new("HEAD", list.url.clone())
            })
            .await
            .ok()
            .filter(|response| (200..300).contains(&response.status));
        let etag = head
            .as_ref()
            .and_then(|response| response.headers.get("etag").cloned());
        let last_modified = head
            .as_ref()
            .and_then(|response| response.headers.get("last-modified").cloned());
        if let Some(saved) = saved.as_ref()
            && cached
            && head.is_some()
            && unchanged(saved, etag.as_ref(), last_modified.as_ref())
        {
            meta.insert(
                list.id.clone(),
                ListMeta {
                    fetched_at: now,
                    ..saved.clone()
                },
            );
            return false;
        }
        let Ok(response) = http.send(HttpRequest::new("GET", list.url.clone())).await else {
            return false;
        };
        if !(200..300).contains(&response.status) || !looks_like_filter_list(&response.body) {
            return false;
        }
        let same = fs::read(&path).is_ok_and(|current| current == response.body);
        if !same {
            let temporary = self.directory.join(format!("{}.download", list.id));
            if fs::write(&temporary, &response.body)
                .and_then(|()| fs::rename(&temporary, &path))
                .is_err()
            {
                let _ = fs::remove_file(&temporary);
                return false;
            }
        }
        meta.insert(
            list.id.clone(),
            ListMeta {
                fetched_at: now,
                etag,
                last_modified,
            },
        );
        !same
    }
}

#[uniffi::export]
impl FilterListStore {
    #[uniffi::constructor]
    pub fn new(documents_dir: String) -> Arc<Self> {
        Arc::new(Self {
            directory: PathBuf::from(documents_dir).join(DIRECTORY),
        })
    }

    /// The lists already downloaded, ready for the engines.
    pub fn on_disk(&self) -> ListsOnDisk {
        let mut uris = Vec::new();
        let mut groups = Vec::new();
        let mut hasher = Sha256::new();
        hasher.update(ENGINE_RULES.to_string());
        for list in filter_lists() {
            let path = self.list_path(&list.id);
            let Ok(text) = fs::read(&path) else { continue };
            hasher.update(Sha256::digest(&text));
            uris.push(
                url::Url::from_file_path(&path)
                    .map(String::from)
                    .unwrap_or_default(),
            );
            groups.push(list.group.name().to_owned());
        }
        let version = if uris.is_empty() {
            String::new()
        } else {
            hex::encode(&hasher.finalize()[..8])
        };
        ListsOnDisk {
            uris,
            groups,
            version,
        }
    }

    /// Refreshes the stale lists, each on its own: one that fails keeps its saved copy and is tried on the next
    /// refresh. Whether any list's file changed (so the engines need the lists again).
    pub async fn refresh(&self, http: Arc<dyn HttpClient>, now: i64) -> bool {
        if fs::create_dir_all(&self.directory).is_err() {
            return false;
        }
        let mut meta = self.read_meta();
        let mut changed = false;
        for list in filter_lists() {
            changed |= self
                .refresh_list(http.as_ref(), &list, &mut meta, now)
                .await;
        }
        self.write_meta(&meta);
        changed
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::sync::http::{HttpError, HttpResponse};

    struct Lists {
        requests: Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl HttpClient for Lists {
        async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
            self.requests
                .lock()
                .unwrap()
                .push(format!("{} {}", request.method, request.url));
            Ok(HttpResponse {
                headers: HashMap::from([("etag".to_owned(), "\"v1\"".to_owned())]),
                ..HttpResponse::new(
                    200,
                    if request.method == "GET" {
                        format!("! list\n{}", "||ads.example^\n".repeat(100)).into_bytes()
                    } else {
                        Vec::new()
                    },
                )
            })
        }
    }

    #[test]
    fn lists_download_once_a_day_and_name_their_text() {
        let dir = std::env::temp_dir().join(format!("bay-lists-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = FilterListStore::new(dir.to_string_lossy().into());
        assert_eq!(store.on_disk().uris.len(), 0);
        let http = Arc::new(Lists {
            requests: Mutex::new(Vec::new()),
        });

        assert!(pollster::block_on(store.refresh(http.clone(), 1_000)));
        let lists = store.on_disk();
        assert_eq!((lists.uris.len(), lists.groups[2].as_str()), (8, "shared"));
        assert!(lists.uris[0].starts_with("file://"));
        assert_eq!(lists.version.len(), 16);

        // Fresh lists aren't asked for again; a day on, the server's same ETag keeps the saved copies.
        let asked = http.requests.lock().unwrap().len();
        assert!(!pollster::block_on(store.refresh(http.clone(), 2_000)));
        assert_eq!(http.requests.lock().unwrap().len(), asked);
        assert!(!pollster::block_on(
            store.refresh(http.clone(), 1_000 + REFRESH_AFTER_MS)
        ));
        assert!(
            http.requests.lock().unwrap()[asked..]
                .iter()
                .all(|request| request.starts_with("HEAD"))
        );
        assert_eq!(store.on_disk().version, lists.version);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_error_page_is_not_a_list() {
        assert!(!looks_like_filter_list(
            format!("<!DOCTYPE html>{}", "x".repeat(2000)).as_bytes()
        ));
        assert!(!looks_like_filter_list(b"! too short"));
    }
}
