//! Which engine a tab's page runs in, Chromium or WebKit (store/engines.ts, lib/siteDomain.ts). Chromium is Bay's
//! engine; it has no Widevine, so streaming sites open in WebKit, whose FairPlay plays them. The person can change
//! that: a mode for the whole browser, a default engine, rules for single sites and a pick on any tab. A page's links
//! stay on its engine; a typed address leaves for its own site's engine. A build without WebKit, or one where Bay
//! switched it off, keeps every page in Chromium (`Browser::set_webkit_on`).

use serde_json::Value;

use super::{Browser, Settings};
use crate::model::Tab;

pub const CHROMIUM: &str = "chromium";
pub const WEBKIT: &str = "webkit";

/// Sites whose video is DRM-protected, subdomains included.
pub const PROTECTED_VIDEO_SITES: [&str; 14] = [
    "netflix.com",
    "disneyplus.com",
    "max.com",
    "hbomax.com",
    "primevideo.com",
    "hulu.com",
    "tv.apple.com",
    "music.apple.com",
    "open.spotify.com",
    "peacocktv.com",
    "paramountplus.com",
    "crunchyroll.com",
    "hotstar.com",
    "jiohotstar.com",
];

const COUNTRY_SECOND_LEVELS: [&str; 19] = [
    "ac", "co", "com", "edu", "go", "gob", "gov", "gv", "ltd", "me", "mil", "ne", "net", "nic",
    "nom", "or", "org", "plc", "sch",
];

/// Hosting suffixes where each customer's subdomain is its own site.
const SHARED_HOSTS: [&str; 17] = [
    "github.io",
    "gitlab.io",
    "vercel.app",
    "netlify.app",
    "pages.dev",
    "workers.dev",
    "herokuapp.com",
    "appspot.com",
    "web.app",
    "firebaseapp.com",
    "blogspot.com",
    "cloudfront.net",
    "azurewebsites.net",
    "fly.dev",
    "onrender.com",
    "glitch.me",
    "myshopify.com",
];

fn is_ipv4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
}

/// A host's registrable domain ("eTLD+1"): "accounts.example.co.uk" → "example.co.uk". IPs and one-label hosts are
/// their own site. Without the Public Suffix List: country codes' common second levels and common hosting suffixes.
pub fn registrable_domain(hostname: &str) -> String {
    let host = hostname.to_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host);
    if !host.contains('.') || is_ipv4(host) || host.contains(':') {
        return host.to_owned();
    }
    let labels: Vec<&str> = host.split('.').collect();
    let keep = if let Some(shared) = SHARED_HOSTS
        .iter()
        .find(|s| host == **s || host.ends_with(&format!(".{s}")))
    {
        shared.split('.').count() + 1
    } else {
        let tld = labels[labels.len() - 1];
        let second = labels[labels.len() - 2];
        if labels.len() >= 3 && tld.len() == 2 && COUNTRY_SECOND_LEVELS.contains(&second) {
            3
        } else {
            2
        }
    };
    labels[labels.len().saturating_sub(keep)..].join(".")
}

/// A web page's site: its scheme and host:port key, its host, and its registrable domain.
struct Site {
    key: String,
    host: String,
    domain: String,
}

fn site(url: &str) -> Option<Site> {
    let u = url::Url::parse(url).ok()?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return None;
    }
    let host = u.host_str()?.to_lowercase();
    let authority = match u.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.clone(),
    };
    Some(Site {
        key: format!("{}://{authority}", u.scheme()),
        domain: registrable_domain(&host),
        host,
    })
}

/// A site's key: scheme, host and port, for web pages only.
pub fn site_of(url: &str) -> Option<String> {
    site(url).map(|s| s.key)
}

/// A web page's registrable domain, which site rules key by.
pub fn site_domain_of(url: &str) -> Option<String> {
    site(url).map(|s| s.domain)
}

pub fn protected_video_site(url: &str) -> bool {
    let Some(site) = site(url).filter(|s| s.key.starts_with("https://")) else {
        return false;
    };
    PROTECTED_VIDEO_SITES
        .iter()
        .any(|d| site.host == *d || site.host.ends_with(&format!(".{d}")))
}

/// Bay's and Chrome's own pages, extensions and DevTools exist only in Chromium.
fn chromium_only(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    [
        "bay:",
        "chrome:",
        "chrome-extension:",
        "chrome-untrusted:",
        "devtools:",
        "view-source:",
    ]
    .iter()
    .any(|p| lower.starts_with(p))
}

fn web_or_file(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http:") || lower.starts_with("https:") || lower.starts_with("file:")
}

impl Settings {
    /// "automatic", "chromium" or "webkit".
    pub fn engine_mode(&self) -> &str {
        self.str("engineMode").unwrap_or("automatic")
    }

    pub fn default_engine(&self) -> &str {
        self.str("defaultEngine").unwrap_or(CHROMIUM)
    }

    pub fn streaming_in_webkit(&self) -> bool {
        self.flag("streamingInWebKit").unwrap_or(true)
    }

    /// The person's rule for a site's registrable domain.
    pub fn site_engine(&self, domain: &str) -> Option<&str> {
        self.0
            .get("siteEngines")
            .and_then(|m| m.get(domain))
            .and_then(Value::as_str)
    }

    /// The one engine every page opens in, in Chromium or WebKit mode.
    fn single_engine(&self) -> Option<&str> {
        match self.engine_mode() {
            "automatic" => None,
            mode => Some(mode),
        }
    }
}

impl Browser {
    /// WebKit is there to open pages in: the build has it, and Bay hasn't switched it off.
    pub fn webkit_on(&self) -> bool {
        self.webkit_on
    }

    pub fn set_webkit_on(&mut self, on: bool) {
        self.webkit_on = on;
    }

    /// A page WebKit can show: a web page or a file, while WebKit is on.
    pub fn can_use_webkit(&self, url: &str) -> bool {
        self.webkit_on && !url.is_empty() && web_or_file(url)
    }

    /// The engine pages open in when nothing else decides: the mode's, else the default engine.
    pub fn default_engine(&self) -> String {
        if !self.webkit_on {
            return CHROMIUM.to_owned();
        }
        self.settings
            .single_engine()
            .unwrap_or(self.settings.default_engine())
            .to_owned()
    }

    /// The person's rule for a page's site.
    pub fn site_rule(&self, url: &str) -> Option<String> {
        site_domain_of(url).and_then(|d| self.settings.site_engine(&d).map(str::to_owned))
    }

    /// The engine a page's site asks for, if anything does: the mode's single engine, the site's rule, then WebKit
    /// for a streaming site.
    pub fn chosen_engine(&self, url: &str) -> Option<String> {
        if !self.can_use_webkit(url) {
            return None;
        }
        self.settings
            .single_engine()
            .map(str::to_owned)
            .or_else(|| self.site_rule(url))
            .or_else(|| {
                (self.settings.streaming_in_webkit() && protected_video_site(url))
                    .then(|| WEBKIT.to_owned())
            })
    }

    /// A fresh page's engine at an address: Chromium for Bay's own pages, else its site's choice, else the default.
    pub fn engine_for_url(&self, url: &str) -> String {
        if !self.can_use_webkit(url) {
            return CHROMIUM.to_owned();
        }
        self.chosen_engine(url)
            .unwrap_or_else(|| self.default_engine())
    }

    fn engine_of(&self, t: &Tab, depth: u8) -> String {
        let address = page_address(t);
        if !self.webkit_on || chromium_only(address) {
            return CHROMIUM.to_owned();
        }
        if let Some(engine) = &t.engine {
            return engine.clone();
        }
        if let Some(id) = &t.adopt_id {
            if id.starts_with("webkit:") {
                return WEBKIT.to_owned();
            }
            if id.starts_with("nncore:") || id.starts_with("tab:") {
                return CHROMIUM.to_owned();
            }
            if let Some(source) = id
                .strip_prefix("clone:")
                .and_then(|s| self.tabs.get(s))
                .filter(|_| depth < 8)
            {
                return self.engine_of(source, depth + 1);
            }
        }
        if let Some(single) = self.settings.single_engine() {
            return single.to_owned();
        }
        let opener = t.opener_id.as_ref().and_then(|o| self.tabs.get(o));
        if let Some(engine) = opener
            .filter(|o| !o.url.is_empty() || o.navigation.is_some())
            .and_then(|o| o.engine.clone())
        {
            return engine;
        }
        self.engine_for_url(address)
    }

    /// The tab's engine now: its page's, else its adopted page's, the mode's, its opener's, then its address's.
    pub fn tab_engine(&self, tab_id: &str) -> String {
        self.tabs
            .get(tab_id)
            .map_or_else(|| CHROMIUM.to_owned(), |t| self.engine_of(t, 0))
    }

    /// The engine the settings want the tab in: Chromium-only pages, the single-engine mode, the tab's own pick, the
    /// site's rule, streaming sites, the default engine.
    pub fn wanted_engine(&self, tab_id: &str) -> String {
        let Some(t) = self.tabs.get(tab_id) else {
            return CHROMIUM.to_owned();
        };
        let url = page_address(t);
        if !self.can_use_webkit(url) {
            return CHROMIUM.to_owned();
        }
        if let Some(single) = self.settings.single_engine() {
            // A page Chromium made for the tab (an extension's, a pop-up) keeps Chromium: extensions exist only there.
            let chromium_driven = t
                .adopt_id
                .as_ref()
                .is_some_and(|a| a.starts_with("nncore:") || a.starts_with("tab:"));
            return if single == WEBKIT && chromium_driven {
                CHROMIUM
            } else {
                single
            }
            .to_owned();
        }
        tab_pick(t, url).unwrap_or_else(|| self.engine_for_url(url))
    }

    /// An address the person typed: its site's choice (the tab's pick while it stays on the site), else the default.
    pub fn typed_navigation_engine(&self, tab: &Tab, url: &str) -> String {
        if !self.can_use_webkit(url) {
            return CHROMIUM.to_owned();
        }
        let pick = if self.settings.single_engine().is_none() {
            tab_pick(tab, url)
        } else {
            None
        };
        pick.unwrap_or_else(|| self.engine_for_url(url))
    }

    /// The engine a tab's icon is marked with: a web page in the engine other pages don't open in.
    pub fn engine_mark(&self, tab_id: &str) -> Option<String> {
        let t = self.tabs.get(tab_id)?;
        let url = if t.url.is_empty() {
            t.navigation.as_ref().map_or("", |n| n.url.as_str())
        } else {
            &t.url
        };
        if !self.can_use_webkit(url) {
            return None;
        }
        let engine = self.tab_engine(tab_id);
        (engine != self.default_engine()).then_some(engine)
    }
}

fn page_address(t: &Tab) -> &str {
    t.navigation.as_ref().map_or(&t.url, |n| &n.url)
}

/// The engine the person picked for the tab with Reopen in…, while the tab stays on that site.
pub fn tab_pick(t: &Tab, url: &str) -> Option<String> {
    let pick = t.engine_pick.as_ref()?;
    (Some(&pick.site) == site_domain_of(url).as_ref()).then(|| pick.engine.clone())
}
