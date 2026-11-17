//! Bookmarks: one tree of folders and links per space. Most arrive from another browser's export; a page can also be
//! bookmarked from its menu. A port of the Expo app's `src/store/bookmarks.ts`.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::Value;

use super::js;
use super::types::{BookmarkNode, Bookmarks};

/// The folder every bookmark hangs off. It has no title of its own and is never removed.
pub const BOOKMARKS_ROOT: &str = "bookmarks";

/// How many bookmarks and folders a tree keeps.
pub const BOOKMARK_LIMIT: usize = 5000;

const TITLE_LIMIT: usize = 300;

/// A bookmark or folder that doesn't have an id yet: what an import builds.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BookmarkDraft {
    pub title: String,
    /// Absent on a folder.
    pub url: Option<String>,
    pub added_at: Option<i64>,
    pub children: Vec<BookmarkDraft>,
}

pub fn empty_bookmarks() -> Bookmarks {
    HashMap::from([(
        BOOKMARKS_ROOT.to_owned(),
        BookmarkNode::Folder {
            id: BOOKMARKS_ROOT.into(),
            parent_id: None,
            title: String::new(),
            children: Vec::new(),
            added_at: 0,
        },
    )])
}

/// A folder's children, by id, when `id` is a folder.
pub fn folder_children<'a>(bookmarks: &'a Bookmarks, id: &str) -> Option<&'a Vec<String>> {
    match bookmarks.get(id) {
        Some(BookmarkNode::Folder { children, .. }) => Some(children),
        _ => None,
    }
}

fn children_mut<'a>(bookmarks: &'a mut Bookmarks, id: &str) -> Option<&'a mut Vec<String>> {
    match bookmarks.get_mut(id) {
        Some(BookmarkNode::Folder { children, .. }) => Some(children),
        _ => None,
    }
}

/// Whether a page is bookmarked anywhere in the tree.
pub fn is_bookmarked(bookmarks: &Bookmarks, url: &str) -> bool {
    bookmarks
        .values()
        .any(|node| matches!(node, BookmarkNode::Url { url: saved, .. } if saved == url))
}

/// How many more nodes the tree has room for.
pub fn bookmark_room(bookmarks: &Bookmarks) -> usize {
    BOOKMARK_LIMIT.saturating_sub(bookmarks.len())
}

/// Gives drafts ids under a folder, as nodes `add_bookmarks` adds whole. Takes at most `room` nodes, in order: a
/// folder that doesn't fit leaves out its children too.
pub fn draft_nodes(
    drafts: &[BookmarkDraft],
    parent_id: &str,
    new_id: &mut dyn FnMut() -> String,
    now: i64,
    room: usize,
) -> Vec<BookmarkNode> {
    fn add(
        draft: &BookmarkDraft,
        parent: &str,
        nodes: &mut Vec<BookmarkNode>,
        new_id: &mut dyn FnMut() -> String,
        now: i64,
        room: usize,
    ) -> Option<String> {
        if nodes.len() >= room {
            return None;
        }
        let id = new_id();
        let title = js::slice(&draft.title, TITLE_LIMIT);
        let added_at = draft.added_at.unwrap_or(now);
        if let Some(url) = &draft.url {
            nodes.push(BookmarkNode::Url {
                id: id.clone(),
                parent_id: parent.into(),
                title,
                url: url.clone(),
                added_at,
            });
            return Some(id);
        }
        let index = nodes.len();
        nodes.push(BookmarkNode::Folder {
            id: id.clone(),
            parent_id: Some(parent.into()),
            title,
            children: Vec::new(),
            added_at,
        });
        for child in &draft.children {
            if let Some(child_id) = add(child, &id, nodes, new_id, now, room)
                && let BookmarkNode::Folder { children, .. } = &mut nodes[index]
            {
                children.push(child_id);
            }
        }
        Some(id)
    }

    let mut nodes = Vec::new();
    for draft in drafts {
        add(draft, parent_id, &mut nodes, new_id, now, room);
    }
    nodes
}

/// Adds nodes made by `draft_nodes`. Each node whose parent is already in the tree joins the end of that folder; the
/// rest are already listed by their new parents. Nothing is added past the limit, and an id already taken is skipped.
/// Returns `None` when nothing changes.
pub fn add_bookmarks(bookmarks: &Bookmarks, nodes: &[BookmarkNode]) -> Option<Bookmarks> {
    let fresh: Vec<&BookmarkNode> = nodes
        .iter()
        .filter(|node| !bookmarks.contains_key(node.id()))
        .take(bookmark_room(bookmarks))
        .collect();
    if fresh.is_empty() {
        return None;
    }
    let mut next = bookmarks.clone();
    let batch: HashSet<&str> = fresh.iter().map(|node| node.id()).collect();
    for node in fresh {
        let parent_in_batch = node
            .parent_id()
            .is_some_and(|parent| batch.contains(parent));
        let parent = node
            .parent_id()
            .filter(|_| !parent_in_batch)
            .filter(|parent| folder_children(&next, parent).is_some());
        // A node whose parent is neither in the tree nor in the batch would hang off nothing.
        if parent.is_none() && !parent_in_batch {
            continue;
        }
        let stored = match node {
            BookmarkNode::Folder {
                id,
                parent_id,
                title,
                children,
                added_at,
            } => BookmarkNode::Folder {
                id: id.clone(),
                parent_id: parent_id.clone(),
                title: title.clone(),
                children: children
                    .iter()
                    .filter(|child| batch.contains(child.as_str()))
                    .cloned()
                    .collect(),
                added_at: *added_at,
            },
            url => url.clone(),
        };
        next.insert(node.id().to_owned(), stored);
        if let Some(parent) = parent
            && let Some(children) = children_mut(&mut next, parent)
        {
            children.push(node.id().to_owned());
        }
    }
    Some(next)
}

/// Removes a bookmark, or a folder with everything in it. The root stays. Returns `None` when nothing changes.
pub fn remove_bookmark(bookmarks: &Bookmarks, id: &str) -> Option<Bookmarks> {
    let node = bookmarks.get(id)?;
    if id == BOOKMARKS_ROOT {
        return None;
    }
    let mut next = bookmarks.clone();
    let mut stack = vec![id.to_owned()];
    while let Some(target) = stack.pop() {
        if let Some(BookmarkNode::Folder { children, .. }) = next.remove(&target) {
            stack.extend(children);
        }
    }
    if let Some(parent) = node.parent_id()
        && let Some(children) = children_mut(&mut next, parent)
    {
        children.retain(|child| child != id);
    }
    Some(next)
}

/// Removes every bookmark of a page.
pub fn remove_bookmarks_of(bookmarks: &Bookmarks, url: &str) -> Bookmarks {
    let ids: Vec<String> = bookmarks
        .values()
        .filter(|node| matches!(node, BookmarkNode::Url { url: saved, .. } if saved == url))
        .map(|node| node.id().to_owned())
        .collect();
    ids.iter().fold(bookmarks.clone(), |tree, id| {
        remove_bookmark(&tree, id).unwrap_or(tree)
    })
}

fn timestamp(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite() && *number >= 0.0)
        .map(|number| number as i64)
}

enum Saved<'a> {
    Url {
        title: &'a str,
        url: &'a str,
        added_at: i64,
    },
    Folder {
        title: &'a str,
        children: Vec<&'a str>,
        added_at: i64,
    },
}

fn saved_node<'a>(key: Option<&str>, value: &'a Value) -> Option<Saved<'a>> {
    let node = value.as_object()?;
    let id = node.get("id")?.as_str()?;
    if key.is_some_and(|key| key != id) {
        return None;
    }
    let title = node.get("title")?.as_str()?;
    let added_at = timestamp(node.get("addedAt"))?;
    match node.get("kind")?.as_str()? {
        "url" => {
            let url = node
                .get("url")?
                .as_str()
                .filter(|url| js::is_web_address(url))?;
            Some(Saved::Url {
                title,
                url,
                added_at,
            })
        }
        "folder" => {
            let children = node
                .get("children")?
                .as_array()?
                .iter()
                .map(Value::as_str)
                .collect::<Option<Vec<_>>>()?;
            Some(Saved::Folder {
                title,
                children,
                added_at,
            })
        }
        _ => None,
    }
}

/// Reads a saved tree, repairing it: only what a walk from the root reaches is kept (each node once, under the folder
/// that lists it first), up to the limit. A document saved before bookmarks existed has none.
pub fn parse_bookmarks(value: Option<&Value>) -> Bookmarks {
    let mut bookmarks = empty_bookmarks();
    let Some(saved) = value.and_then(Value::as_object) else {
        return bookmarks;
    };
    let mut queue: VecDeque<(String, String)> = match saved
        .get(BOOKMARKS_ROOT)
        .and_then(|root| saved_node(None, root))
    {
        Some(Saved::Folder { children, .. }) => children
            .into_iter()
            .map(|id| (id.to_owned(), BOOKMARKS_ROOT.to_owned()))
            .collect(),
        _ => VecDeque::new(),
    };
    let mut count = 1;
    // Breadth first, so a cut at the limit keeps the top of every folder rather than the depths of the first.
    while let Some((id, parent_id)) = queue.pop_front() {
        if count >= BOOKMARK_LIMIT {
            break;
        }
        let Some(node) = saved
            .get(&id)
            .and_then(|value| saved_node(Some(&id), value))
        else {
            continue;
        };
        if bookmarks.contains_key(&id) || folder_children(&bookmarks, &parent_id).is_none() {
            continue;
        }
        count += 1;
        if let Some(children) = children_mut(&mut bookmarks, &parent_id) {
            children.push(id.clone());
        }
        match node {
            Saved::Url {
                title,
                url,
                added_at,
            } => {
                let node = BookmarkNode::Url {
                    id: id.clone(),
                    parent_id,
                    title: js::slice(title, TITLE_LIMIT),
                    url: url.into(),
                    added_at,
                };
                bookmarks.insert(id, node);
            }
            Saved::Folder {
                title,
                children,
                added_at,
            } => {
                queue.extend(
                    children
                        .into_iter()
                        .map(|child| (child.to_owned(), id.clone())),
                );
                let node = BookmarkNode::Folder {
                    id: id.clone(),
                    parent_id: Some(parent_id),
                    title: js::slice(title, TITLE_LIMIT),
                    children: Vec::new(),
                    added_at,
                };
                bookmarks.insert(id, node);
            }
        }
    }
    bookmarks
}
