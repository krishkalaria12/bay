//! Bookmarks (store/bookmarks.ts). They're Chrome's (BookmarkModel): this is the app's tree of them, which the engine
//! side keeps alike. A node's id is its Chrome UUID; each engine profile's two permanent folders are its roots.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::{Browser, keep_last};
use crate::number::JsNumber;

const MAX_BOOKMARK_UNDO: usize = 10;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BookmarkNode {
    #[serde(rename_all = "camelCase")]
    Url {
        id: String,
        parent_id: String,
        title: String,
        url: String,
        favicon: Option<String>,
        added_at: JsNumber,
        /// Its sync record's key when that isn't the id: a bookmark synced before Chrome kept them.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sync_key: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Folder {
        id: String,
        parent_id: Option<String>,
        title: String,
        children: Vec<String>,
        added_at: JsNumber,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sync_key: Option<String>,
    },
}

impl BookmarkNode {
    pub fn id(&self) -> &str {
        match self {
            Self::Url { id, .. } | Self::Folder { id, .. } => id,
        }
    }

    pub fn parent_id(&self) -> Option<&str> {
        match self {
            Self::Url { parent_id, .. } => Some(parent_id),
            Self::Folder { parent_id, .. } => parent_id.as_deref(),
        }
    }

    fn set_parent(&mut self, parent: &str) {
        match self {
            Self::Url { parent_id, .. } => *parent_id = parent.to_owned(),
            Self::Folder { parent_id, .. } => *parent_id = Some(parent.to_owned()),
        }
    }

    pub fn children(&self) -> &[String] {
        match self {
            Self::Folder { children, .. } => children,
            Self::Url { .. } => &[],
        }
    }

    pub fn is_folder(&self) -> bool {
        matches!(self, Self::Folder { .. })
    }
}

/// An engine profile's permanent folders.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Roots {
    pub bar: String,
    pub other: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Bookmarks {
    pub nodes: IndexMap<String, BookmarkNode>,
    /// Each space's roots: its engine profile's.
    pub roots: IndexMap<String, Roots>,
}

/// A bookmark or folder to add, with what it holds.
#[derive(Clone, Debug, Default)]
pub struct BookmarkDraft {
    pub title: String,
    pub url: Option<String>,
    pub added_at: Option<f64>,
    pub children: Option<Vec<BookmarkDraft>>,
}

/// Removed bookmarks and where they were, to put back.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RemovedBookmarks {
    pub nodes: Vec<BookmarkNode>,
    /// (id, parent, index)
    pub places: Vec<(String, String, usize)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BookmarkUndo {
    pub id: String,
    pub space_id: String,
    pub removed: RemovedBookmarks,
}

/// An engine profile's permanent folders, as store ids.
pub fn root_ids_for(engine: &str) -> Roots {
    let name = if engine.is_empty() { "default" } else { engine };
    Roots {
        bar: format!("bar@{name}"),
        other: format!("other@{name}"),
    }
}

fn root_folder(id: &str, title: &str) -> BookmarkNode {
    BookmarkNode::Folder {
        id: id.to_owned(),
        parent_id: None,
        title: title.to_owned(),
        children: Vec::new(),
        added_at: JsNumber(0.0),
        sync_key: None,
    }
}

impl Bookmarks {
    /// The space takes the engine profile's roots, made if they aren't there.
    pub fn engine_roots(&mut self, space_id: &str, engine: &str) -> Roots {
        let roots = root_ids_for(engine);
        self.nodes
            .entry(roots.bar.clone())
            .or_insert_with(|| root_folder(&roots.bar, "Bookmarks Bar"));
        self.nodes
            .entry(roots.other.clone())
            .or_insert_with(|| root_folder(&roots.other, "Other Bookmarks"));
        self.roots.insert(space_id.to_owned(), roots.clone());
        roots
    }

    /// The nodes and every node under them, depth first.
    pub fn subtree(&self, ids: &[String]) -> Vec<String> {
        fn walk(b: &Bookmarks, id: &str, out: &mut Vec<String>) {
            let Some(node) = b.nodes.get(id) else {
                return;
            };
            out.push(id.to_owned());
            for child in node.children() {
                walk(b, child, out);
            }
        }
        let mut out = Vec::new();
        for id in ids {
            walk(self, id, &mut out);
        }
        out
    }

    /// The nodes and what they hold go; `space_id`'s roots go too when given.
    pub fn remove_tree(&mut self, ids: &[String], space_id: Option<&str>) {
        let gone: HashSet<String> = self.subtree(ids).into_iter().collect();
        self.nodes.retain(|id, _| !gone.contains(id));
        for node in self.nodes.values_mut() {
            if let BookmarkNode::Folder { children, .. } = node {
                children.retain(|c| !gone.contains(c));
            }
        }
        if let Some(space) = space_id {
            self.roots.shift_remove(space);
        }
    }

    /// The space's bookmarks by address.
    pub fn by_url(&self, space_id: &str) -> HashMap<&str, Vec<&str>> {
        let mut index: HashMap<&str, Vec<&str>> = HashMap::new();
        let Some(roots) = self.roots.get(space_id) else {
            return index;
        };
        for id in self.subtree(&[roots.bar.clone(), roots.other.clone()]) {
            if let Some(BookmarkNode::Url { id, url, .. }) = self.nodes.get(&id) {
                index.entry(url.as_str()).or_default().push(id.as_str());
            }
        }
        index
    }

    pub fn is_bookmarked(&self, space_id: &str, url: &str) -> bool {
        !url.is_empty() && self.by_url(space_id).contains_key(url)
    }

    pub fn folder_children(&self, folder_id: &str) -> Vec<&BookmarkNode> {
        self.nodes
            .get(folder_id)
            .map(|f| {
                f.children()
                    .iter()
                    .filter_map(|id| self.nodes.get(id))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The folders above the node, nearest first.
    pub fn ancestors(&self, id: &str) -> Vec<&BookmarkNode> {
        let mut out = Vec::new();
        let mut node = self.nodes.get(id);
        for _ in 0..64 {
            let Some(parent) = node
                .and_then(BookmarkNode::parent_id)
                .and_then(|p| self.nodes.get(p))
            else {
                break;
            };
            if !parent.is_folder() {
                break;
            }
            out.push(parent);
            node = Some(parent);
        }
        out
    }

    /// The links in the folder and its folders, in order.
    pub fn folder_links(&self, folder_id: &str) -> Vec<&BookmarkNode> {
        self.folder_children(folder_id)
            .into_iter()
            .flat_map(|n| {
                if n.is_folder() {
                    self.folder_links(n.id())
                } else {
                    vec![n]
                }
            })
            .collect()
    }

    fn insert_child(&mut self, mut node: BookmarkNode, parent_id: &str, index: Option<usize>) {
        let Some(BookmarkNode::Folder { children, .. }) = self.nodes.get_mut(parent_id) else {
            return;
        };
        let id = node.id().to_owned();
        children.retain(|c| *c != id);
        let at = index.unwrap_or(children.len()).min(children.len());
        children.insert(at, id.clone());
        node.set_parent(parent_id);
        self.nodes.insert(id, node);
    }
}

impl Browser {
    /// The space's bookmark roots, made if it has none.
    pub(crate) fn ensure_roots(&mut self, space_id: &str) -> Roots {
        if let Some(roots) = self.bookmarks.roots.get(space_id) {
            return roots.clone();
        }
        let engine = self.engine_profile(space_id);
        self.bookmarks.engine_roots(space_id, &engine)
    }

    /// A UUID as Chrome makes one (version 4).
    pub(crate) fn new_bookmark_id(&self) -> String {
        let words = [
            self.random_u32(),
            self.random_u32(),
            self.random_u32(),
            self.random_u32(),
        ];
        uuid_from(words)
    }

    pub fn add_bookmark(
        &mut self,
        space_id: &str,
        url: &str,
        title: &str,
        favicon: Option<String>,
        parent_id: Option<&str>,
        index: Option<usize>,
    ) -> String {
        let roots = self.ensure_roots(space_id);
        let parent = parent_id.map_or(roots.bar, str::to_owned);
        let node = BookmarkNode::Url {
            id: self.new_bookmark_id(),
            parent_id: parent.clone(),
            title: title.to_owned(),
            url: url.to_owned(),
            favicon,
            added_at: JsNumber(self.now()),
            sync_key: None,
        };
        let id = node.id().to_owned();
        self.bookmarks.insert_child(node, &parent, index);
        id
    }

    pub fn add_bookmark_folder(
        &mut self,
        space_id: &str,
        title: &str,
        parent_id: Option<&str>,
        index: Option<usize>,
    ) -> String {
        let roots = self.ensure_roots(space_id);
        let parent = parent_id.map_or(roots.bar, str::to_owned);
        let node = BookmarkNode::Folder {
            id: self.new_bookmark_id(),
            parent_id: Some(parent.clone()),
            title: title.to_owned(),
            children: Vec::new(),
            added_at: JsNumber(self.now()),
            sync_key: None,
        };
        let id = node.id().to_owned();
        self.bookmarks.insert_child(node, &parent, index);
        id
    }

    /// A link takes every field given; a folder only its title.
    pub fn update_bookmark(
        &mut self,
        id: &str,
        title: Option<String>,
        new_url: Option<String>,
        new_favicon: Option<Option<String>>,
    ) {
        match self.bookmarks.nodes.get_mut(id) {
            Some(BookmarkNode::Url {
                title: t,
                url,
                favicon,
                ..
            }) => {
                if let Some(title) = title {
                    *t = title;
                }
                if let Some(new_url) = new_url {
                    *url = new_url;
                }
                if let Some(new_favicon) = new_favicon {
                    *favicon = new_favicon;
                }
            }
            Some(BookmarkNode::Folder { title: t, .. }) => {
                if let Some(title) = title {
                    *t = title;
                }
            }
            None => {}
        }
    }

    pub fn move_bookmark(&mut self, id: &str, parent_id: &str, index: Option<usize>) {
        let Some(node) = self.bookmarks.nodes.get(id).cloned() else {
            return;
        };
        let Some(old_parent) = node.parent_id().map(str::to_owned) else {
            return;
        };
        if self
            .bookmarks
            .subtree(&[id.to_owned()])
            .iter()
            .any(|n| n == parent_id)
        {
            return;
        }
        if let Some(BookmarkNode::Folder { children, .. }) =
            self.bookmarks.nodes.get_mut(&old_parent)
        {
            children.retain(|c| c != id);
        }
        self.bookmarks.insert_child(node, parent_id, index);
    }

    pub fn remove_bookmark(&mut self, id: &str) {
        if self
            .bookmarks
            .nodes
            .get(id)
            .is_some_and(|n| n.parent_id().is_some())
        {
            self.bookmarks.remove_tree(&[id.to_owned()], None);
        }
    }

    /// Adds the drafts and what they hold under `parent_id` (the bar by default); their ids.
    pub fn add_bookmark_tree(
        &mut self,
        space_id: &str,
        drafts: &[BookmarkDraft],
        parent_id: Option<&str>,
        index: Option<usize>,
    ) -> Vec<String> {
        let roots = self.ensure_roots(space_id);
        let target = parent_id
            .filter(|p| {
                self.bookmarks
                    .nodes
                    .get(*p)
                    .is_some_and(BookmarkNode::is_folder)
            })
            .map_or(roots.bar, str::to_owned);
        let ids: Vec<String> = drafts
            .iter()
            .map(|d| self.build_bookmark(d, &target))
            .collect();
        if let Some(BookmarkNode::Folder { children, .. }) = self.bookmarks.nodes.get_mut(&target) {
            let at = index.unwrap_or(children.len()).min(children.len());
            children.splice(at..at, ids.iter().cloned());
        }
        ids
    }

    fn build_bookmark(&mut self, d: &BookmarkDraft, parent: &str) -> String {
        let id = self.new_bookmark_id();
        let added_at = JsNumber(d.added_at.unwrap_or_else(|| self.now()));
        match (&d.url, &d.children) {
            (Some(url), None) => {
                self.bookmarks.nodes.insert(
                    id.clone(),
                    BookmarkNode::Url {
                        id: id.clone(),
                        parent_id: parent.to_owned(),
                        title: d.title.clone(),
                        url: url.clone(),
                        favicon: None,
                        added_at,
                        sync_key: None,
                    },
                );
            }
            _ => {
                self.bookmarks.nodes.insert(
                    id.clone(),
                    BookmarkNode::Folder {
                        id: id.clone(),
                        parent_id: Some(parent.to_owned()),
                        title: d.title.clone(),
                        children: Vec::new(),
                        added_at,
                        sync_key: None,
                    },
                );
                let children: Vec<String> = d
                    .children
                    .iter()
                    .flatten()
                    .map(|c| self.build_bookmark(c, &id))
                    .collect();
                if let Some(BookmarkNode::Folder { children: kids, .. }) =
                    self.bookmarks.nodes.get_mut(&id)
                {
                    *kids = children;
                }
            }
        }
        id
    }

    /// Removes the bookmarks (not the roots); what went and where, to put back.
    pub fn remove_bookmarks(&mut self, ids: &[String]) -> RemovedBookmarks {
        let b = &self.bookmarks;
        let removable: Vec<&String> = ids
            .iter()
            .filter(|id| b.nodes.get(*id).and_then(BookmarkNode::parent_id).is_some())
            .collect();
        let tops: Vec<String> = removable
            .iter()
            .filter(|id| {
                !b.ancestors(id)
                    .iter()
                    .any(|a| removable.iter().any(|r| *r == a.id()))
            })
            .map(|id| (*id).clone())
            .collect();
        let places = tops
            .iter()
            .map(|id| {
                let parent = b.nodes[id].parent_id().unwrap_or_default().to_owned();
                let index = b
                    .nodes
                    .get(&parent)
                    .and_then(|p| p.children().iter().position(|c| c == id))
                    .unwrap_or(0);
                (id.clone(), parent, index)
            })
            .collect();
        let nodes = b
            .subtree(&tops)
            .iter()
            .map(|id| b.nodes[id].clone())
            .collect();
        if !tops.is_empty() {
            self.bookmarks.remove_tree(&tops, None);
        }
        RemovedBookmarks { nodes, places }
    }

    pub fn restore_bookmarks(&mut self, removed: &RemovedBookmarks) {
        for n in &removed.nodes {
            self.bookmarks.nodes.insert(n.id().to_owned(), n.clone());
        }
        let mut places = removed.places.clone();
        places.sort_by_key(|(_, _, index)| *index);
        for (id, parent, index) in places {
            match self.bookmarks.nodes.get_mut(&parent) {
                Some(BookmarkNode::Folder { children, .. }) => {
                    children.retain(|c| *c != id);
                    let at = index.min(children.len());
                    children.insert(at, id);
                }
                _ => {
                    self.bookmarks.nodes.shift_remove(&id);
                }
            }
        }
    }

    /// Removes the bookmarks and keeps them for Undo; the entry's id, or None when nothing was removed.
    pub fn remove_bookmarks_with_undo(&mut self, space_id: &str, ids: &[String]) -> Option<String> {
        let removed = self.remove_bookmarks(ids);
        if removed.places.is_empty() {
            return None;
        }
        let id = self.new_id("bu");
        self.bookmark_undo.push(BookmarkUndo {
            id: id.clone(),
            space_id: space_id.to_owned(),
            removed,
        });
        keep_last(&mut self.bookmark_undo, MAX_BOOKMARK_UNDO);
        Some(id)
    }

    pub fn restore_removed_bookmarks(&mut self, undo_id: &str) {
        let Some(at) = self.bookmark_undo.iter().position(|u| u.id == undo_id) else {
            return;
        };
        let entry = self.bookmark_undo.remove(at);
        self.restore_bookmarks(&entry.removed);
    }

    /// Bookmarks the page, or removes its bookmarks; whether it's bookmarked now.
    pub fn toggle_bookmark(
        &mut self,
        space_id: &str,
        url: &str,
        title: &str,
        favicon: Option<String>,
    ) -> bool {
        if url.is_empty() {
            return false;
        }
        let existing: Vec<String> = self
            .bookmarks
            .by_url(space_id)
            .get(url)
            .map(|ids| ids.iter().map(|id| (*id).to_owned()).collect())
            .unwrap_or_default();
        if !existing.is_empty() {
            self.bookmarks.remove_tree(&existing, None);
            return false;
        }
        self.add_bookmark(space_id, url, title, favicon, None, None);
        true
    }
}

fn uuid_from(words: [u32; 4]) -> String {
    let hex: String = words.iter().map(|w| format!("{w:08x}")).collect();
    // Version 4, variant 10xx: what Chrome generates.
    let variant = (u8::from_str_radix(&hex[16..17], 16).unwrap_or(0) & 0x3) | 0x8;
    format!(
        "{}-{}-4{}-{variant:x}{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..32]
    )
}
