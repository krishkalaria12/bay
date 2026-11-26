//! Favicon checks: whether a file is an image the apps can draw, how wide an icon is, and which known sites still have
//! none.

use indexmap::IndexSet;

use crate::js::site_host;
use crate::store::BrowserData;
use crate::store::bookmarks::{BOOKMARKS_ROOT, bookmark_links};

/// An icon at least this wide is sharp enough to keep.
pub const SHARP_WIDTH: u32 = 96;

/// How many sites one pass looks up icons for.
pub const KNOWN_LIMIT: usize = 200;

const PNG: &[u8] = b"\x89PNG";
const ICO: &[u8] = b"\0\0\x01\0";

/// Whether a file's first bytes are an image the apps can draw: PNG, ICO, JPEG, GIF, WebP or BMP.
#[uniffi::export]
pub fn is_image(head: &[u8]) -> bool {
    head.starts_with(PNG)
        || head.starts_with(ICO)
        || head.starts_with(b"\xFF\xD8")
        || head.starts_with(b"GIF8")
        || (head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WEBP"))
        || head.starts_with(b"BM")
}

/// An icon's width in pixels from its first bytes: a PNG's, a GIF's, or an ICO's widest picture. None for a format
/// whose width sits further in (JPEG, WebP), which are photos large enough to be sharp.
#[uniffi::export]
pub fn icon_width(head: &[u8]) -> Option<u32> {
    let byte = |at: usize| u32::from(head.get(at).copied().unwrap_or(0));
    if head.starts_with(PNG) {
        return Some(byte(16) << 24 | byte(17) << 16 | byte(18) << 8 | byte(19));
    }
    if head.starts_with(b"GIF8") {
        return Some(byte(6) | byte(7) << 8);
    }
    if !head.starts_with(ICO) {
        return None;
    }
    let count = (byte(4) | byte(5) << 8) as usize;
    // Each picture's entry is 16 bytes after the 6-byte header; a width of 0 means 256.
    let widest = (0..count)
        .take_while(|index| 6 + index * 16 < head.len())
        .map(|index| match byte(6 + index * 16) {
            0 => 256,
            width => width,
        })
        .max()
        .unwrap_or(0);
    Some(widest)
}

/// The sites Bay already shows, without an icon yet: tabs and pins first, then bookmarks, then history by last visit.
/// Private tabs never ask: a site's icon would say what was opened privately.
pub fn known_sites_without_icons(data: &BrowserData, limit: usize) -> Vec<String> {
    let mut history: Vec<_> = data.history.iter().collect();
    history.sort_by_key(|entry| std::cmp::Reverse(entry.last_visit));

    // Each space's bookmarks in the spaces' order, as the document lists them.
    let mut trees: Vec<&String> = data
        .spaces
        .iter()
        .map(|space| &space.id)
        .filter(|id| data.bookmarks.contains_key(*id))
        .collect();
    let rest: Vec<&String> = data
        .bookmarks
        .keys()
        .filter(|id| !trees.contains(id))
        .collect();
    trees.extend(rest);

    let urls = data
        .tabs
        .iter()
        .filter(|tab| !tab.private)
        .map(|tab| tab.url.clone())
        .chain(data.pinned_sites.iter().map(|pin| pin.url.clone()))
        .chain(data.archive.iter().map(|item| item.tab.url.clone()))
        .chain(trees.into_iter().flat_map(|id| {
            bookmark_links(&data.bookmarks[id], BOOKMARKS_ROOT)
                .into_iter()
                .map(|(url, _)| url)
        }))
        .chain(history.iter().map(|entry| entry.url.clone()));

    let mut hosts = IndexSet::new();
    for url in urls {
        let web = url
            .get(..5)
            .is_some_and(|start| start.eq_ignore_ascii_case("http:"))
            || url
                .get(..6)
                .is_some_and(|start| start.eq_ignore_ascii_case("https:"));
        let host = if web { site_host(&url) } else { String::new() };
        if !host.is_empty() && data.favicons.get(&host).is_none_or(String::is_empty) {
            hosts.insert(host);
        }
        if hosts.len() >= limit {
            break;
        }
    }
    hosts.into_iter().collect()
}
