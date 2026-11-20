//! What an import adds, decided before anything is written: the bookmark drafts that aren't in Bay yet, and what the
//! export held that Bay leaves where it is.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use super::{ExportNotes, ImportedBookmark};
use crate::store::Bookmarks;
use crate::store::bookmarks::{BOOKMARKS_ROOT, BookmarkDraft, bookmark_links};

static PASSWORDS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u:password|\.csv$)").unwrap());
static CARDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i-u:card|payment)").unwrap());

/// What the native side left in the archive, read for what it means to the user.
pub fn export_notes(skipped: &[String], too_large: &[String]) -> ExportNotes {
    ExportNotes {
        passwords: skipped.iter().any(|name| PASSWORDS.is_match(name)),
        cards: skipped.iter().any(|name| CARDS.is_match(name)),
        too_large: too_large.to_vec(),
    }
}

/// The imported tree as drafts, without the pages Bay has bookmarked already (anywhere) or that the export names
/// twice. A folder left empty by that is left out too.
pub fn bookmark_drafts(root: &ImportedBookmark, existing: &Bookmarks) -> Vec<BookmarkDraft> {
    let mut seen: HashSet<String> = bookmark_links(existing, BOOKMARKS_ROOT)
        .into_iter()
        .map(|(url, _)| url)
        .collect();

    fn draft(node: &ImportedBookmark, seen: &mut HashSet<String>) -> Option<BookmarkDraft> {
        let added_at = node.added_at.filter(|at| *at != 0);
        if let Some(url) = node.url.as_deref().filter(|url| !url.is_empty()) {
            if !seen.insert(url.to_owned()) {
                return None;
            }
            return Some(BookmarkDraft {
                title: node.title.clone(),
                url: Some(url.to_owned()),
                added_at,
                children: Vec::new(),
            });
        }
        let children: Vec<BookmarkDraft> = node
            .children()
            .iter()
            .filter_map(|child| draft(child, seen))
            .collect();
        (!children.is_empty()).then(|| BookmarkDraft {
            title: node.title.clone(),
            url: None,
            added_at,
            children,
        })
    }

    root.children()
        .iter()
        .filter_map(|child| draft(child, &mut seen))
        .collect()
}

/// How many links drafts hold.
#[uniffi::export]
pub fn draft_link_count(drafts: &[BookmarkDraft]) -> u32 {
    drafts
        .iter()
        .map(|draft| {
            if draft.url.is_some() {
                1
            } else {
                draft_link_count(&draft.children)
            }
        })
        .sum()
}
