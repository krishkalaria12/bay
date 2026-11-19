//! What an import adds to the store: pasted links as tabs or archived tabs, and an export's bookmarks, favorites and
//! history in the space showing. The Expo app's `importTabs` and `importExport` (`src/store/browser.ts`).

use std::collections::HashSet;

use super::bookmarks::{
    BOOKMARKS_ROOT, bookmark_links, bookmark_room, draft_nodes, empty_bookmarks, folder_children,
};
use super::handle::BrowserStore;
use super::model::{Action, HISTORY_LIMIT, PinDraft, create_tab};
use super::types::{BookmarkNode, Bookmarks, BrowserData, HistoryEntry};
use crate::imports::{ExportContents, ImportedTab, bookmark_drafts, draft_link_count};

/// Which parts of an export to add.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct ImportChoice {
    pub bookmarks: bool,
    pub favorites: bool,
    pub history: bool,
}

/// How many of each an import added; what Bay had already isn't counted again.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, uniffi::Record)]
pub struct ImportCounts {
    pub bookmarks: u32,
    pub favorites: u32,
    pub history: u32,
}

/// A random id in the shape of a UUID, as the apps' own are.
fn new_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the system has randomness");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn space_bookmarks(data: &BrowserData, space_id: &str) -> Bookmarks {
    data.bookmarks
        .get(space_id)
        .cloned()
        .unwrap_or_else(empty_bookmarks)
}

#[uniffi::export]
impl BrowserStore {
    /// Opens pasted links as background tabs in the space showing, or files them in its archive. Returns how many
    /// were added: a link already open (or archived) isn't added again.
    pub fn import_tabs(&self, tabs: Vec<ImportedTab>, archive: bool, now: i64) -> u32 {
        let before = self.snapshot();
        let count = |data: &BrowserData| {
            if archive {
                data.archive.len()
            } else {
                data.tabs.len()
            }
        };
        let created = tabs
            .iter()
            .map(|entry| {
                let mut tab =
                    create_tab(&new_id(), now, &entry.url, false, &before.active_space_id);
                tab.title = entry.title.clone();
                tab
            })
            .collect();
        self.dispatch(if archive {
            Action::ImportArchive { tabs: created, now }
        } else {
            Action::ImportTabs { tabs: created }
        });
        count(&self.snapshot()).saturating_sub(count(&before)) as u32
    }

    /// Adds what an export held to the space showing: its bookmarks in a folder named for the browser (a second import
    /// from it joins that folder), its favorites to the space's pins, its newest history to the space's.
    pub fn import_export(
        &self,
        contents: ExportContents,
        choice: ImportChoice,
        folder_name: String,
        now: i64,
    ) -> ImportCounts {
        let before = self.snapshot();
        let space_id = before.active_space_id.clone();
        let tree = space_bookmarks(&before, &space_id);
        let mut counts = ImportCounts::default();

        if choice.bookmarks {
            let drafts = bookmark_drafts(&contents.bookmarks, &tree);
            if !drafts.is_empty() {
                let folder = folder_children(&tree, BOOKMARKS_ROOT)
                    .into_iter()
                    .flatten()
                    .find(|id| matches!(tree.get(id.as_str()), Some(BookmarkNode::Folder { title, .. }) if *title == folder_name))
                    .cloned();
                let mut id = new_id;
                let nodes = match folder {
                    Some(folder) => {
                        draft_nodes(&drafts, &folder, &mut id, now, bookmark_room(&tree))
                    }
                    None => {
                        let wrapper = super::bookmarks::BookmarkDraft {
                            title: folder_name,
                            url: None,
                            added_at: Some(now),
                            children: drafts.clone(),
                        };
                        draft_nodes(
                            &[wrapper],
                            BOOKMARKS_ROOT,
                            &mut id,
                            now,
                            bookmark_room(&tree),
                        )
                    }
                };
                self.dispatch(Action::AddBookmarks {
                    space_id: space_id.clone(),
                    nodes,
                });
                let added = bookmark_links(
                    &space_bookmarks(&self.snapshot(), &space_id),
                    BOOKMARKS_ROOT,
                )
                .len()
                .saturating_sub(bookmark_links(&tree, BOOKMARKS_ROOT).len());
                counts.bookmarks = (draft_link_count(&drafts) as usize).min(added) as u32;
            }
        }

        if choice.favorites && !contents.favorites.is_empty() {
            let pinned = |data: &BrowserData| data.pinned_sites.len();
            let start = pinned(&self.snapshot());
            let sites = contents
                .favorites
                .iter()
                .filter_map(|favorite| {
                    let url = favorite.url.clone().filter(|url| !url.is_empty())?;
                    Some(PinDraft {
                        id: new_id(),
                        url,
                        title: favorite.title.clone(),
                        favicon: None,
                    })
                })
                .collect();
            self.dispatch(Action::ImportPins { sites });
            counts.favorites = pinned(&self.snapshot()).saturating_sub(start) as u32;
        }

        if choice.history && !contents.history.is_empty() {
            // Only the newest pages can stay: Bay keeps so many.
            let entries: Vec<HistoryEntry> = contents
                .history
                .iter()
                .take(HISTORY_LIMIT)
                .map(|visit| HistoryEntry {
                    space_id: space_id.clone(),
                    url: visit.url.clone(),
                    title: visit.title.clone(),
                    favicon: None,
                    visits: visit.visits,
                    last_visit: visit.last_visit,
                })
                .collect();
            let urls: HashSet<&str> = entries.iter().map(|entry| entry.url.as_str()).collect();
            self.dispatch(Action::ImportHistory {
                entries: entries.clone(),
            });
            counts.history = self
                .snapshot()
                .history
                .iter()
                .filter(|entry| entry.space_id == space_id && urls.contains(entry.url.as_str()))
                .count() as u32;
        }

        counts
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imports::{ImportedBookmark, ImportedVisit};
    use crate::store::model::PERSONAL_SPACE_ID;

    fn store(name: &str) -> std::sync::Arc<BrowserStore> {
        let dir = std::env::temp_dir().join(format!("bay-importing-{name}-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        BrowserStore::open(dir.to_string_lossy().into(), "first".into(), 5)
    }

    fn tab(url: &str) -> ImportedTab {
        ImportedTab {
            url: url.into(),
            title: String::new(),
        }
    }

    #[test]
    fn pasted_links_archive_once() {
        let store = store("tabs");
        let links = vec![
            tab("https://bay.example/one"),
            tab("https://bay.example/two"),
        ];
        assert_eq!(store.import_tabs(links.clone(), true, 10), 2);
        assert_eq!(store.import_tabs(links, true, 11), 0);
        assert_eq!(
            store.import_tabs(vec![tab("https://bay.example/three")], false, 12),
            1
        );
    }

    #[test]
    fn an_export_adds_bookmarks_in_a_folder_pins_and_history() {
        let store = store("export");
        let link = |title: &str, url: &str| ImportedBookmark {
            title: title.into(),
            url: Some(url.into()),
            children: None,
            added_at: None,
            role: None,
        };
        let contents = ExportContents {
            bookmarks: ImportedBookmark {
                title: String::new(),
                url: None,
                children: Some(vec![
                    link("One", "https://one.example/"),
                    link("Two", "https://two.example/"),
                ]),
                added_at: None,
                role: None,
            },
            favorites: vec![link("Fav", "https://fav.example/")],
            history: vec![ImportedVisit {
                url: "https://seen.example/".into(),
                title: "Seen".into(),
                visits: 3,
                last_visit: 9,
            }],
        };
        let all = ImportChoice {
            bookmarks: true,
            favorites: true,
            history: true,
        };
        let counts = store.import_export(contents.clone(), all, "Chrome".into(), 20);
        assert_eq!(
            counts,
            ImportCounts {
                bookmarks: 2,
                favorites: 1,
                history: 1
            }
        );
        let listing = store.bookmark_listing(
            PERSONAL_SPACE_ID.into(),
            BOOKMARKS_ROOT.into(),
            String::new(),
        );
        assert_eq!(listing.rows.len(), 1);
        // The same export again adds nothing new, into the same folder.
        let again = store.import_export(contents, all, "Chrome".into(), 21);
        assert_eq!((again.bookmarks, again.favorites), (0, 0));
        let listing = store.bookmark_listing(
            PERSONAL_SPACE_ID.into(),
            BOOKMARKS_ROOT.into(),
            String::new(),
        );
        assert_eq!(listing.rows.len(), 1);
    }

    #[test]
    fn a_bookmark_saved_before_its_title_takes_the_page_title() {
        let store = store("titles");
        let url = "https://en.wikipedia.org/wiki/Bay";
        let save = |id: &str, title: &str, url: &str| {
            store.dispatch(Action::ToggleBookmark {
                space_id: PERSONAL_SPACE_ID.into(),
                bookmark: BookmarkNode::Url {
                    id: id.into(),
                    parent_id: BOOKMARKS_ROOT.into(),
                    title: title.into(),
                    url: url.into(),
                    added_at: 1,
                },
            })
        };
        assert!(save("bare", "en.wikipedia.org/wiki/Bay", url));
        assert!(save("named", "My bay", "https://bay.example/"));
        store.dispatch(Action::PageTitle {
            url: url.into(),
            title: "Bay - Wikipedia".into(),
        });
        store.dispatch(Action::PageTitle {
            url: "https://bay.example/".into(),
            title: "Bay Example".into(),
        });
        let titles: std::collections::HashMap<String, String> = store
            .bookmarks(PERSONAL_SPACE_ID.into())
            .into_values()
            .filter_map(|node| match node {
                BookmarkNode::Url { id, title, .. } => Some((id, title)),
                _ => None,
            })
            .collect();
        assert_eq!(titles["bare"], "Bay - Wikipedia");
        assert_eq!(titles["named"], "My bay");
    }
}
