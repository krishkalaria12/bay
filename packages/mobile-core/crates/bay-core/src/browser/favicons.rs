//! Site icons, fetched from the site itself (no third-party icon service learns what you browse): the icon the open
//! page names, or for a site Bay already shows that has none yet, its apple-touch-icon or /favicon.ico. Each is checked
//! to be an image of an icon's size, kept in the app's documents (the system may empty a cache) and drawn from that
//! copy, so showing it makes no request. An icon too small to stay sharp on a large tile (a 16 px favicon.ico) is kept
//! only until the site gives a wider one. One fetch per site runs at a time. Icons are best effort: a failure is
//! dropped, and the next visit or launch tries again. The Expo app's `src/browser/favicons.ts`.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use super::icons::{KNOWN_LIMIT, SHARP_WIDTH, icon_width, is_image};
use crate::js::site_host;
use crate::store::handle::BrowserStore;
use crate::store::model::Action;
use crate::sync::http::{HttpClient, HttpRequest};

const FOLDER: &str = "favicons";

/// Where a site usually keeps its 180 px icon for home screens.
const TOUCH_ICON: &str = "/apple-touch-icon.png";

/// Where a site's own icon usually sits, best first, for a site with no page open.
const KNOWN_ICON_PATHS: [&str; 2] = [TOUCH_ICON, "/favicon.ico"];

/// Sent until a page has told Bay the engine's own user agent; some sites refuse requests from unknown clients.
const FALLBACK_USER_AGENT: &str = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";

/// Smaller than this isn't an image; larger isn't an icon (a 180 px touch icon with a photo in it can pass 64 KB).
const MIN_BYTES: usize = 16;
const MAX_BYTES: usize = 256 * 1024;

/// The bytes read to learn an icon's width: an ICO's header and sixteen of its pictures.
const HEAD_BYTES: usize = 6 + 16 * 16;

const TIMEOUT_MS: u32 = 15_000;

#[derive(Default)]
struct Fetching {
    /// Saved icons' widths, read from their files when first needed.
    widths: HashMap<String, u32>,
    /// Known sites asked this launch, so one with no icon at either path isn't asked again until the next.
    asked: HashSet<String>,
    /// Sites whose small icon an open page was asked to replace this launch.
    page_asked: HashSet<String>,
    /// Sites with a fetch running.
    running: HashSet<String>,
    /// The engine's user agent, from the last page that named its icon.
    user_agent: Option<String>,
}

/// Fetches and keeps site icons, recording each in the store's favicons by host.
#[derive(uniffi::Object)]
pub struct Favicons {
    store: Arc<BrowserStore>,
    http: Arc<dyn HttpClient>,
    folder: PathBuf,
    fetching: Mutex<Fetching>,
}

/// Holds a site's one running fetch until it ends.
struct Running<'a> {
    favicons: &'a Favicons,
    host: String,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.favicons.lock().running.remove(&self.host);
    }
}

impl Favicons {
    fn lock(&self) -> MutexGuard<'_, Fetching> {
        self.fetching
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn file(&self, host: &str) -> PathBuf {
        let name: String = url::form_urlencoded::byte_serialize(host.as_bytes()).collect();
        self.folder.join(name)
    }

    /// The fetch for a site, unless one is running.
    fn start(&self, host: &str) -> Option<Running<'_>> {
        self.lock()
            .running
            .insert(host.to_owned())
            .then(|| Running {
                favicons: self,
                host: host.to_owned(),
            })
    }

    /// The width of the icon a site has now: 0 for none; a JPEG's or WebP's counts as sharp.
    fn width_of(&self, host: &str) -> u32 {
        if let Some(width) = self.lock().widths.get(host) {
            return *width;
        }
        if !self.store.favicons().contains_key(host) {
            return 0;
        }
        let width = fs::read(self.file(host)).ok().map_or(0, |bytes| {
            icon_width(&bytes[..bytes.len().min(HEAD_BYTES)]).unwrap_or(SHARP_WIDTH)
        });
        self.lock().widths.insert(host.to_owned(), width);
        width
    }

    fn sharp(&self, host: &str) -> bool {
        self.width_of(host) >= SHARP_WIDTH
    }

    /// Downloads an icon and keeps it if it is an image of an icon's size, wider than the one the site has. Whether it
    /// was kept.
    async fn save(&self, host: &str, href: &str, user_agent: &str) -> bool {
        let had = self.width_of(host);
        let mut request = HttpRequest::new("GET", href);
        request
            .headers
            .insert("User-Agent".into(), user_agent.into());
        request.headers.insert("Accept".into(), "image/*".into());
        request.timeout_ms = Some(TIMEOUT_MS);
        let Ok(response) = self.http.send(request).await else {
            return false;
        };
        let body = response.body;
        if !(200..300).contains(&response.status) || !(MIN_BYTES..=MAX_BYTES).contains(&body.len())
        {
            return false;
        }
        let head = &body[..body.len().min(HEAD_BYTES)];
        let width = if is_image(head) {
            icon_width(head).unwrap_or(SHARP_WIDTH)
        } else {
            0
        };
        if width <= had {
            return false;
        }
        let file = self.file(host);
        if write(&file, &body).is_err() {
            return false;
        }
        self.lock().widths.insert(host.to_owned(), width);
        // A wider icon takes the narrower one's file, so its address changes too: an image already drawn is cached by it.
        let uri = url::Url::from_file_path(&file)
            .map_or_else(|()| file.to_string_lossy().into_owned(), String::from);
        let uri = if had > 0 {
            format!("{uri}#{width}")
        } else {
            uri
        };
        self.store.dispatch(Action::Favicon {
            host: host.to_owned(),
            uri: Some(uri),
        });
        true
    }

    fn user_agent(&self) -> String {
        self.lock()
            .user_agent
            .clone()
            .unwrap_or_else(|| FALLBACK_USER_AGENT.into())
    }

    /// A known site's icon, from where sites usually keep it; the next path while none is sharp.
    async fn fetch_known(&self, host: &str) {
        let Some(_running) = self.start(host) else {
            return;
        };
        let agent = self.user_agent();
        for path in KNOWN_ICON_PATHS {
            if self.sharp(host) {
                return;
            }
            self.save(host, &format!("https://{host}{path}"), &agent)
                .await;
        }
    }
}

fn write(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(folder) = file.parent() {
        fs::create_dir_all(folder)?;
    }
    // Written beside it first, so a reader never sees half an icon.
    let part = file.with_extension("part");
    fs::write(&part, bytes)?;
    fs::rename(&part, file)
}

#[uniffi::export]
impl Favicons {
    #[uniffi::constructor]
    pub fn new(
        store: Arc<BrowserStore>,
        http: Arc<dyn HttpClient>,
        documents_dir: String,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            http,
            folder: Path::new(&documents_dir).join(FOLDER),
            fetching: Mutex::new(Fetching::default()),
        })
    }

    /// After a page (never a private one) finishes loading: saves the icon it names (`href`, from the favicon page
    /// script, with the engine's `user_agent`) if its site has none yet, and its site's touch icon too while the one it
    /// has is too small to stay sharp. A site with an icon is asked again only while that is too small, once a launch.
    pub async fn page_loaded(
        &self,
        page_url: String,
        href: Option<String>,
        user_agent: Option<String>,
    ) {
        let host = site_host(&page_url);
        let Some(href) =
            href.filter(|href| href.starts_with("http://") || href.starts_with("https://"))
        else {
            return;
        };
        if host.is_empty() {
            return;
        }
        if self.store.favicons().contains_key(&host)
            && (self.sharp(&host) || !self.lock().page_asked.insert(host.clone()))
        {
            return;
        }
        let Some(_running) = self.start(&host) else {
            return;
        };
        let agent = user_agent.unwrap_or_else(|| self.user_agent());
        self.lock().user_agent = Some(agent.clone());
        self.save(&host, &href, &agent).await;
        let touch = url::Url::parse(&page_url)
            .and_then(|page| page.join(TOUCH_ICON))
            .map(String::from);
        if let Ok(touch) = touch
            && !self.sharp(&host)
            && touch != href
        {
            self.save(&host, &touch, &agent).await;
        }
    }

    /// Asks, once a launch, for the icons of the sites Bay shows without one, and wider ones for icons too small to
    /// stay sharp, one site at a time. Files of icons the store no longer has are deleted first.
    pub async fn fill_known(&self) {
        self.forget_dropped();
        let saved: Vec<String> = self.store.favicons().into_keys().collect();
        let mut hosts = self.store.sites_without_icons();
        hosts.extend(
            saved
                .into_iter()
                .rev()
                .take(KNOWN_LIMIT)
                .filter(|host| !self.sharp(host)),
        );
        for host in hosts {
            if !self.lock().asked.insert(host.clone()) {
                continue;
            }
            self.fetch_known(&host).await;
        }
    }

    /// Deletes the files of sites whose icons the store dropped (clearing history or browsing data drops them).
    pub fn forget_dropped(&self) {
        let kept: HashSet<PathBuf> = self
            .store
            .favicons()
            .keys()
            .map(|host| self.file(host))
            .collect();
        let Ok(entries) = fs::read_dir(&self.folder) else {
            return;
        };
        let mut dropped = false;
        for path in entries.flatten().map(|entry| entry.path()) {
            if !kept.contains(&path) {
                dropped |= fs::remove_file(&path).is_ok();
            }
        }
        // A dropped icon may be asked for again.
        if dropped {
            let mut fetching = self.lock();
            fetching.widths.clear();
            fetching.asked.clear();
            fetching.page_asked.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::http::{HttpError, HttpResponse};

    /// A PNG header `width` pixels wide, padded past the smallest image.
    fn png(width: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        bytes.extend(width.to_be_bytes());
        bytes.extend(width.to_be_bytes());
        bytes.resize(64, 0);
        bytes
    }

    /// Answers each address with the icon set for it, else 404; remembers what was asked.
    struct Site {
        icons: HashMap<String, Vec<u8>>,
        asked: Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl HttpClient for Site {
        async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
            self.asked.lock().unwrap().push(request.url.clone());
            Ok(match self.icons.get(&request.url) {
                Some(body) => HttpResponse::new(200, body.clone()),
                None => HttpResponse::new(404, Vec::new()),
            })
        }
    }

    fn setup(
        name: &str,
        icons: &[(&str, Vec<u8>)],
    ) -> (Arc<Favicons>, Arc<BrowserStore>, Arc<Site>) {
        let dir = std::env::temp_dir().join(format!("bay-favicons-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let store = BrowserStore::open(dir.to_string_lossy().into(), "first".into(), 5);
        let site = Arc::new(Site {
            icons: icons
                .iter()
                .map(|(url, body)| ((*url).to_owned(), body.clone()))
                .collect(),
            asked: Mutex::new(Vec::new()),
        });
        let favicons = Favicons::new(store.clone(), site.clone(), dir.to_string_lossy().into());
        (favicons, store, site)
    }

    #[test]
    fn a_page_icon_is_kept_and_a_small_one_gives_way_to_the_touch_icon() {
        let (favicons, store, _) = setup(
            "page",
            &[
                ("https://bay.example/favicon.ico", png(16)),
                ("https://www.bay.example/apple-touch-icon.png", png(180)),
            ],
        );
        pollster::block_on(favicons.page_loaded(
            "https://www.bay.example/page".into(),
            Some("https://bay.example/favicon.ico".into()),
            Some("agent".into()),
        ));
        let uri = store.favicons().remove("bay.example").expect("an icon");
        // The 16 px icon came first and the 180 px touch icon replaced it, at a new address.
        assert!(uri.starts_with("file://") && uri.ends_with("#180"), "{uri}");
        let path = url::Url::parse(&uri).unwrap().to_file_path().unwrap();
        assert_eq!(fs::read(path).unwrap(), png(180));
    }

    #[test]
    fn known_sites_try_the_usual_paths_and_dropped_icons_lose_their_files() {
        let (favicons, store, site) =
            setup("known", &[("https://known.example/favicon.ico", png(32))]);
        store.dispatch(Action::Visit {
            space_id: crate::store::model::PERSONAL_SPACE_ID.into(),
            url: "https://known.example/a".into(),
            title: "A".into(),
            favicon: None,
            now: 1,
        });
        pollster::block_on(favicons.fill_known());
        assert!(store.favicons().contains_key("known.example"));
        assert_eq!(
            *site.asked.lock().unwrap(),
            [
                "https://known.example/apple-touch-icon.png",
                "https://known.example/favicon.ico"
            ]
        );
        // Asked once a launch: a second pass asks nothing.
        pollster::block_on(favicons.fill_known());
        assert_eq!(site.asked.lock().unwrap().len(), 2);

        let file = favicons.file("known.example");
        assert!(file.exists());
        store.dispatch(Action::Favicon {
            host: "known.example".into(),
            uri: None,
        });
        favicons.forget_dropped();
        assert!(!file.exists());
    }
}
