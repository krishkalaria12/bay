//! Arc's Peek (store/peeks.ts): a link from a pinned tab or a favourite opens over that tab's page, in a card,
//! instead of as a tab of its own. The peek's page is a tab no list holds, marked `peek_of` its opener. Closing it
//! throws it away; keeping it lists it after its opener; splitting it pairs it with its opener. One per window.

use super::model::{TabList, pinned_first};
use super::{
    Browser, CreateWindow, LinkDestination, OpenPane, SplitSide, TabLive, matching_link_rule,
    normalize_external_link_rules,
};

/// A window's peek: its page's tab and the tab it peeks from, and where its link was clicked (for the card to open
/// out of).
#[derive(Clone, Debug, PartialEq)]
pub struct Peek {
    pub tab_id: String,
    pub from_id: String,
    pub at: Option<(f64, f64)>,
}

/// The last peek a window closed, for Reopen Closed Tab; `after_tab` the window's last closed tab then.
#[derive(Clone, Debug, PartialEq)]
pub struct ClosedPeek {
    pub url: String,
    pub from_id: String,
    pub after_tab: Option<String>,
}

const SECOND_LEVEL: [&str; 21] = [
    "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp",
    "or.jp", "co.in", "com.br", "com.mx", "com.ar", "com.tr", "com.cn", "com.hk", "com.sg",
    "co.za", "co.kr",
];

/// A host's site: its last two labels, or three under a common second-level suffix.
pub fn peek_site_of(host: &str) -> String {
    let host = host.to_lowercase();
    let labels: Vec<&str> = host.strip_suffix('.').unwrap_or(&host).split('.').collect();
    let two = labels[labels.len().saturating_sub(2)..].join(".");
    if labels.len() > 2 && SECOND_LEVEL.contains(&two.as_str()) {
        labels[labels.len() - 3..].join(".")
    } else {
        two
    }
}

fn web_host(url: &str) -> &str {
    let lower = url
        .get(..8)
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let rest = if lower.starts_with("https://") {
        &url[8..]
    } else if lower.starts_with("http://") {
        &url[7..]
    } else {
        return "";
    };
    &rest[..rest.find(['/', '?', '#', ':']).unwrap_or(rest.len())]
}

impl Browser {
    /// Whether the tab peeks its links: a pinned page in a main window, with the setting on.
    pub fn peeks_links(&self, from_id: &str) -> bool {
        let Some(from) = self.tabs.get(from_id) else {
            return false;
        };
        self.settings.flag("peekLinksFromPinnedTabs") == Some(true)
            && from.peek_of.is_none()
            && from.pinned_page()
            && self
                .windows
                .get(&from.window_id)
                .is_some_and(|w| !w.incognito && !w.is_small())
    }

    /// Whether a link the tab opens goes to a peek: one to another site, from a tab that peeks its links.
    pub fn opens_in_peek(&self, from_id: &str, url: &str) -> bool {
        let host = web_host(url);
        !host.is_empty()
            && self.peeks_links(from_id)
            && peek_site_of(host) != peek_site_of(web_host(&self.tabs[from_id].url))
    }

    /// The window's peek while it's on screen: its opener is the shown tab, or a pane of the shown split.
    pub fn shown_peek(&self, window_id: &str) -> Option<&Peek> {
        let peek = self
            .peeks
            .get(window_id)
            .filter(|p| self.tabs.contains_key(&p.tab_id))?;
        let shown = self.active_tab_id(window_id, None)?;
        let in_split = self
            .split_of(&shown)
            .is_some_and(|v| v.tab_ids.contains(&peek.from_id));
        (shown == peek.from_id || in_split).then_some(peek)
    }

    fn last_closed_tab(&self, window_id: &str) -> Option<String> {
        self.closed_tabs
            .iter()
            .rev()
            .find(|c| c.window_id == window_id)
            .map(|c| c.id.clone())
    }

    /// Opens `url` in a peek over the tab's page (`adopt_id`: the page the engine already made for the link); its
    /// tab. Another link replaces the window's peek.
    pub fn open_peek(
        &mut self,
        from_id: &str,
        url: &str,
        adopt_id: Option<&str>,
        at: Option<(f64, f64)>,
    ) -> Option<String> {
        let from = self.tabs.get(from_id)?.clone();
        if !self.windows.contains_key(&from.window_id) {
            return None;
        }
        let window_id = from.window_id.clone();
        if let Some(replaced) = self.peeks.remove(&window_id) {
            self.remove_tabs(&[replaced.tab_id], false);
        }
        let mut tab = self.make_tab(&window_id, &from.space_id, url, None, false);
        tab.opener_id = Some(from_id.to_owned());
        tab.peek_of = Some(from_id.to_owned());
        if let Some(adopt) = adopt_id {
            // The engine's page for the link is already loading it; loading again would drop its POST body.
            tab.adopt_id = Some(adopt.to_owned());
            tab.navigation = None;
        }
        let id = tab.id.clone();
        self.tabs.insert(id.clone(), tab);
        self.live.insert(id.clone(), TabLive::default());
        self.peeks.insert(
            window_id,
            Peek {
                tab_id: id.clone(),
                from_id: from_id.to_owned(),
                at,
            },
        );
        Some(id)
    }

    pub fn close_peek(&mut self, window_id: &str) {
        let Some(peek) = self.peeks.get(window_id).cloned() else {
            return;
        };
        if let Some(url) = self
            .tabs
            .get(&peek.tab_id)
            .map(|t| t.url.clone())
            .filter(|u| !u.is_empty())
        {
            let after_tab = self.last_closed_tab(window_id);
            self.closed_peeks.insert(
                window_id.to_owned(),
                ClosedPeek {
                    url,
                    from_id: peek.from_id.clone(),
                    after_tab,
                },
            );
        }
        self.remove_tabs(&[peek.tab_id], false);
        self.peeks.remove(window_id);
    }

    /// Reopen Closed Tab: the window's last closed peek, when no tab closed there since.
    pub fn reopen_peek(&mut self, window_id: &str) -> bool {
        let Some(closed) = self.closed_peeks.get(window_id).cloned() else {
            return false;
        };
        if self.last_closed_tab(window_id) != closed.after_tab
            || self
                .tabs
                .get(&closed.from_id)
                .is_none_or(|t| t.window_id != window_id)
        {
            return false;
        }
        self.closed_peeks.remove(window_id);
        self.activate(&closed.from_id, Some(window_id));
        self.open_peek(&closed.from_id, &closed.url, None, None)
            .is_some()
    }

    /// Puts the window's peek in its opener's list, as a link opened from it would be, and forgets the peek.
    fn list_peek(&mut self, window_id: &str, background: bool) -> Option<Peek> {
        let peek = self
            .peeks
            .get(window_id)
            .filter(|p| self.tabs.contains_key(&p.tab_id))
            .cloned()?;
        let mut tab = self.tabs[&peek.tab_id].clone();
        tab.peek_of = None;
        let key = self.space_list_key(&tab.space_id);
        let mut list = TabList {
            key: key.clone(),
            tab_ids: self.list_ids(&key).to_vec(),
        };
        self.tabs.insert(tab.id.clone(), tab.clone());
        let at = self.insertion_index(&list, &tab, background);
        list.tab_ids
            .insert(at.min(list.tab_ids.len()), tab.id.clone());
        self.peeks.remove(window_id);
        list.tab_ids = pinned_first(&list.tab_ids, &self.tabs);
        self.set_list(list);
        if let Some(opener) = &tab.opener_id {
            self.group_with_opener(&tab.id, opener, background);
        }
        Some(peek)
    }

    /// The space most recently shown in a main window, else the default one.
    pub fn most_recent_space(&self) -> String {
        self.main_window_for(None).map_or_else(
            || self.settings.default_space_id().to_owned(),
            |w| self.windows[&w].space_id.clone(),
        )
    }

    /// Open as Tab: the peek becomes a tab after its opener, shown, where the link rules send its page. The window it's in.
    pub fn keep_peek(&mut self, window_id: &str) -> Option<String> {
        let tab = self
            .peeks
            .get(window_id)
            .and_then(|p| self.tabs.get(&p.tab_id))
            .cloned();
        let private = self.windows.get(window_id).is_some_and(|w| w.incognito);
        let rules = normalize_external_link_rules(self.settings.value("externalLinkRules"));
        let route = tab
            .as_ref()
            .filter(|_| !private)
            .and_then(|t| matching_link_rule(&rules, &t.url, None))
            .map(|r| r.destination.clone());
        let most_recent = self.most_recent_space();
        let peek = self.list_peek(window_id, false)?;
        self.activate_in(&peek.tab_id, Some(window_id));
        let space_id = match route {
            Some(LinkDestination::LittleBay) => {
                return Some(self.create_window(CreateWindow {
                    small: true,
                    tab_ids: vec![peek.tab_id.clone()],
                    space_id: tab.map(|t| t.space_id),
                    ..Default::default()
                }));
            }
            Some(LinkDestination::NewWindow) => {
                return self.move_tabs_to_window(std::slice::from_ref(&peek.tab_id), None);
            }
            Some(LinkDestination::MostRecentSpace) => Some(most_recent),
            Some(LinkDestination::Space { space_id, .. }) => Some(space_id),
            None => None,
        };
        let Some(space_id) = space_id.filter(|s| {
            self.spaces.contains_key(s) && Some(s) != tab.as_ref().map(|t| &t.space_id)
        }) else {
            return Some(window_id.to_owned());
        };
        let target = self
            .main_window_for(Some(&space_id))
            .unwrap_or_else(|| window_id.to_owned());
        // The page goes to its window before the space changes, so the opener's window stays on its space.
        if target != window_id {
            self.move_tabs_to_window(std::slice::from_ref(&peek.tab_id), Some(&target));
        }
        self.move_tab_to_space(&peek.tab_id, &space_id, None);
        Some(target)
    }

    /// Open in Split View: the peek becomes a tab beside its opener, in one split (a tab of its own if the split is full).
    pub fn split_peek(&mut self, window_id: &str) {
        let Some(peek) = self.list_peek(window_id, true) else {
            return;
        };
        let pane = OpenPane {
            tab_id: Some(peek.tab_id.clone()),
            anchor_tab_id: Some(peek.from_id.clone()),
            side: SplitSide::Right,
            background: true,
            ..Default::default()
        };
        if self.open_split_pane(window_id, pane).is_err() {
            self.activate(&peek.tab_id, Some(window_id));
        }
    }
}
