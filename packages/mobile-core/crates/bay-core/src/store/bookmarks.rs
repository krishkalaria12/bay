//! Bookmarks: one tree of folders and links per space. Most arrive from another browser's export; a page can also be
//! bookmarked from its menu. A port of the Expo app's `src/store/bookmarks.ts`.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::Value;

use super::types::{BookmarkDrop, BookmarkNode, Bookmarks};
use crate::js;

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

/// Every link under a folder, in the order a walk from it meets them.
pub fn bookmark_links(bookmarks: &Bookmarks, folder_id: &str) -> Vec<(String, String)> {
    let mut links = Vec::new();
    let mut seen = HashSet::new();
    fn walk(
        bookmarks: &Bookmarks,
        id: &str,
        links: &mut Vec<(String, String)>,
        seen: &mut HashSet<String>,
    ) {
        if !seen.insert(id.to_owned()) {
            return;
        }
        for child in folder_children(bookmarks, id).into_iter().flatten() {
            match bookmarks.get(child) {
                Some(BookmarkNode::Url { url, title, .. }) => {
                    links.push((url.clone(), title.clone()))
                }
                Some(BookmarkNode::Folder { .. }) => walk(bookmarks, child, links, seen),
                None => {}
            }
        }
    }
    walk(bookmarks, folder_id, &mut links, &mut seen);
    links
}

/// How many search matches the bookmarks sheet lists.
const SHOWN_MATCHES: usize = 200;

/// A row of the bookmarks sheet: a link, or a folder with how many links it holds, however deep.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BookmarkRow {
    pub node: BookmarkNode,
    pub links: u32,
}

/// What the bookmarks sheet shows: a folder's rows in the order they were saved, or every link that matches a search,
/// whichever folder it's in.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BookmarkListing {
    /// The folder shown: the one asked for, or the top when it's gone (removed while open, or by clearing data).
    pub folder_id: String,
    /// Where the back arrow goes; none at the top.
    pub parent_id: Option<String>,
    pub title: String,
    pub rows: Vec<BookmarkRow>,
    /// Every bookmark and folder in the tree, the root aside.
    pub nodes: u32,
    /// Every link in the tree, however deep.
    pub links: u32,
}

/// Every link node under a folder, in the order a walk from it meets them.
fn link_nodes<'a>(bookmarks: &'a Bookmarks, folder_id: &str) -> Vec<&'a BookmarkNode> {
    fn walk<'a>(
        bookmarks: &'a Bookmarks,
        id: &str,
        links: &mut Vec<&'a BookmarkNode>,
        seen: &mut HashSet<String>,
    ) {
        if !seen.insert(id.to_owned()) {
            return;
        }
        for child in folder_children(bookmarks, id).into_iter().flatten() {
            match bookmarks.get(child) {
                Some(node @ BookmarkNode::Url { .. }) => links.push(node),
                Some(BookmarkNode::Folder { .. }) => walk(bookmarks, child, links, seen),
                None => {}
            }
        }
    }
    let mut links = Vec::new();
    walk(bookmarks, folder_id, &mut links, &mut HashSet::new());
    links
}

/// The bookmarks sheet's rows for a folder, or for a search across the whole tree.
pub fn bookmark_listing(bookmarks: &Bookmarks, folder_id: &str, query: &str) -> BookmarkListing {
    let folder_id = match bookmarks.get(folder_id) {
        Some(BookmarkNode::Folder { .. }) => folder_id,
        _ => BOOKMARKS_ROOT,
    };
    let (parent_id, title) = match bookmarks.get(folder_id) {
        Some(BookmarkNode::Folder {
            parent_id, title, ..
        }) if folder_id != BOOKMARKS_ROOT => (
            Some(parent_id.clone().unwrap_or_else(|| BOOKMARKS_ROOT.into())),
            title.clone(),
        ),
        _ => (None, String::new()),
    };
    let row = |node: &BookmarkNode| BookmarkRow {
        links: match node {
            BookmarkNode::Folder { id, .. } => link_nodes(bookmarks, id).len() as u32,
            BookmarkNode::Url { .. } => 0,
        },
        node: node.clone(),
    };
    let needle = query.trim().to_lowercase();
    let rows = if needle.is_empty() {
        folder_children(bookmarks, folder_id)
            .into_iter()
            .flatten()
            .filter_map(|id| bookmarks.get(id))
            .map(row)
            .collect()
    } else {
        link_nodes(bookmarks, BOOKMARKS_ROOT)
            .into_iter()
            .filter(|node| match node {
                BookmarkNode::Url { title, url, .. } => {
                    title.to_lowercase().contains(&needle) || url.to_lowercase().contains(&needle)
                }
                BookmarkNode::Folder { .. } => false,
            })
            .take(SHOWN_MATCHES)
            .map(row)
            .collect()
    };
    BookmarkListing {
        folder_id: folder_id.to_owned(),
        parent_id,
        title,
        rows,
        nodes: bookmarks.len().saturating_sub(1) as u32,
        links: link_nodes(bookmarks, BOOKMARKS_ROOT).len() as u32,
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

/// A folder to choose when saving a bookmark: its id, its title ("" for the top of the tree), and how deep it sits.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BookmarkFolderChoice {
    pub id: String,
    pub title: String,
    pub depth: u32,
}

/// Every folder of a tree, the top first, then each folder before the folders inside it, in their order.
pub fn bookmark_folders(bookmarks: &Bookmarks) -> Vec<BookmarkFolderChoice> {
    fn walk(
        bookmarks: &Bookmarks,
        id: &str,
        depth: u32,
        out: &mut Vec<BookmarkFolderChoice>,
        seen: &mut HashSet<String>,
    ) {
        if !seen.insert(id.to_owned()) {
            return;
        }
        let Some(BookmarkNode::Folder {
            title, children, ..
        }) = bookmarks.get(id)
        else {
            return;
        };
        out.push(BookmarkFolderChoice {
            id: id.to_owned(),
            title: if id == BOOKMARKS_ROOT {
                String::new()
            } else {
                title.clone()
            },
            depth,
        });
        for child in children {
            walk(bookmarks, child, depth + 1, out, seen);
        }
    }
    let mut out = Vec::new();
    walk(bookmarks, BOOKMARKS_ROOT, 0, &mut out, &mut HashSet::new());
    out
}

/// The first bookmark of a page in a tree, in the order a walk from the top meets it.
pub fn bookmark_of<'a>(bookmarks: &'a Bookmarks, url: &str) -> Option<&'a BookmarkNode> {
    link_nodes(bookmarks, BOOKMARKS_ROOT)
        .into_iter()
        .find(|node| matches!(node, BookmarkNode::Url { url: saved, .. } if saved == url))
}

/// Whether `id` is `ancestor` or sits somewhere inside it.
fn is_inside(bookmarks: &Bookmarks, id: &str, ancestor: &str) -> bool {
    let mut at = Some(id.to_owned());
    let mut steps = 0;
    while let Some(current) = at {
        if current == ancestor {
            return true;
        }
        steps += 1;
        if steps > bookmarks.len() {
            return false;
        }
        at = bookmarks
            .get(&current)
            .and_then(|node| node.parent_id())
            .map(str::to_owned);
    }
    false
}

/// Moves a bookmark or a folder into `parent_id`, at `index` among its children (at the end without one). A folder
/// can't go into itself or one of its own folders. Returns `None` when nothing changes.
pub fn move_bookmark(
    bookmarks: &Bookmarks,
    id: &str,
    parent_id: &str,
    index: Option<usize>,
) -> Option<Bookmarks> {
    let node = bookmarks.get(id)?;
    if id == BOOKMARKS_ROOT
        || folder_children(bookmarks, parent_id).is_none()
        || is_inside(bookmarks, parent_id, id)
    {
        return None;
    }
    let mut next = bookmarks.clone();
    if let Some(old) = node.parent_id()
        && let Some(children) = children_mut(&mut next, old)
    {
        children.retain(|child| child != id);
    }
    let children = children_mut(&mut next, parent_id)?;
    let at = index.unwrap_or(children.len()).min(children.len());
    children.insert(at, id.to_owned());
    match next.get_mut(id)? {
        BookmarkNode::Url {
            parent_id: parent, ..
        } => *parent = parent_id.to_owned(),
        BookmarkNode::Folder {
            parent_id: parent, ..
        } => *parent = Some(parent_id.to_owned()),
    }
    (next != *bookmarks).then_some(next)
}

/// Where `id` goes when it's dropped beside `target` (just before it, or just after with `after`): `target`'s folder, at
/// its place there once `id` has left. None when either isn't in the tree, or `id` would go inside itself.
pub fn bookmark_drop(
    bookmarks: &Bookmarks,
    id: &str,
    target: &str,
    after: bool,
) -> Option<BookmarkDrop> {
    bookmarks.get(id)?;
    let parent_id = bookmarks.get(target)?.parent_id()?.to_owned();
    if id == target || parent_id == id || is_inside(bookmarks, &parent_id, id) {
        return None;
    }
    let siblings: Vec<&String> = folder_children(bookmarks, &parent_id)?
        .iter()
        .filter(|child| *child != id)
        .collect();
    let at = siblings.iter().position(|child| *child == target)? + usize::from(after);
    Some(BookmarkDrop {
        parent_id,
        index: (at < siblings.len()).then_some(at as i64),
    })
}

/// A bookmark's new title (and address, for a link), or a folder's new name. An empty title keeps the old one.
pub fn rename_bookmark(
    bookmarks: &Bookmarks,
    id: &str,
    title: &str,
    url: Option<&str>,
) -> Option<Bookmarks> {
    let mut next = bookmarks.clone();
    let title = crate::js::trim(title);
    match next.get_mut(id)? {
        BookmarkNode::Url {
            title: old,
            url: address,
            ..
        } => {
            if !title.is_empty() {
                *old = title.to_owned();
            }
            if let Some(url) = url.filter(|url| crate::js::is_web_address(url)) {
                *address = url.to_owned();
            }
        }
        BookmarkNode::Folder { title: old, .. } => {
            if !title.is_empty() {
                *old = title.to_owned();
            }
        }
    }
    (next != *bookmarks).then_some(next)
}

/// Saves a page into a folder: a page already saved in the tree moves there and takes the new title, so it's never
/// saved twice; otherwise it's added at the folder's end. A folder that's gone means the top.
pub fn save_bookmark(bookmarks: &Bookmarks, bookmark: &BookmarkNode) -> Option<Bookmarks> {
    let BookmarkNode::Url {
        url,
        title,
        parent_id,
        ..
    } = bookmark
    else {
        return None;
    };
    let parent = if folder_children(bookmarks, parent_id).is_some() {
        parent_id.as_str()
    } else {
        BOOKMARKS_ROOT
    };
    if let Some(saved) = bookmark_of(bookmarks, url) {
        let id = saved.id().to_owned();
        let moved = if saved.parent_id() == Some(parent) {
            None
        } else {
            move_bookmark(bookmarks, &id, parent, None)
        };
        let tree = moved.unwrap_or_else(|| bookmarks.clone());
        let renamed = rename_bookmark(&tree, &id, title, None).unwrap_or(tree);
        return (renamed != *bookmarks).then_some(renamed);
    }
    let mut node = bookmark.clone();
    if let BookmarkNode::Url { parent_id, .. } = &mut node {
        *parent_id = parent.to_owned();
    }
    add_bookmarks(bookmarks, std::slice::from_ref(&node))
}

#[cfg(test)]
mod save_tests {
    use super::*;

    fn link(id: &str, parent: &str, url: &str) -> BookmarkNode {
        BookmarkNode::Url {
            id: id.into(),
            parent_id: parent.into(),
            title: id.into(),
            url: url.into(),
            added_at: 1,
        }
    }

    fn folder(id: &str, parent: &str, title: &str) -> BookmarkNode {
        BookmarkNode::Folder {
            id: id.into(),
            parent_id: Some(parent.into()),
            title: title.into(),
            children: Vec::new(),
            added_at: 1,
        }
    }

    fn tree() -> Bookmarks {
        let tree = add_bookmarks(
            &empty_bookmarks(),
            &[folder("watch", BOOKMARKS_ROOT, "Watchlist")],
        )
        .unwrap();
        let tree = add_bookmarks(&tree, &[folder("old", "watch", "Old")]).unwrap();
        add_bookmarks(&tree, &[link("a", BOOKMARKS_ROOT, "https://a.example/")]).unwrap()
    }

    #[test]
    fn folders_are_listed_top_first_and_nested_in_order() {
        let folders = bookmark_folders(&tree());
        let shape: Vec<(&str, u32)> = folders.iter().map(|f| (f.id.as_str(), f.depth)).collect();
        assert_eq!(shape, [(BOOKMARKS_ROOT, 0), ("watch", 1), ("old", 2)]);
        assert_eq!(folders[0].title, "");
        assert_eq!(folders[1].title, "Watchlist");
    }

    #[test]
    fn saving_a_saved_page_moves_it_instead_of_saving_it_twice() {
        let moved = save_bookmark(
            &tree(),
            &BookmarkNode::Url {
                id: "new".into(),
                parent_id: "watch".into(),
                title: "A, renamed".into(),
                url: "https://a.example/".into(),
                added_at: 2,
            },
        )
        .unwrap();
        assert!(!moved.contains_key("new"));
        assert!(
            matches!(moved.get("a"), Some(BookmarkNode::Url { parent_id, title, .. }) if parent_id == "watch" && title == "A, renamed")
        );
        assert_eq!(
            folder_children(&moved, "watch").unwrap(),
            &vec!["old".to_owned(), "a".to_owned()]
        );
        assert!(
            !folder_children(&moved, BOOKMARKS_ROOT)
                .unwrap()
                .contains(&"a".to_owned())
        );

        let added = save_bookmark(&tree(), &link("b", "gone", "https://b.example/")).unwrap();
        assert!(
            matches!(added.get("b"), Some(BookmarkNode::Url { parent_id, .. }) if parent_id == BOOKMARKS_ROOT)
        );
        assert_eq!(
            save_bookmark(
                &tree(),
                &BookmarkNode::Url {
                    id: "x".into(),
                    parent_id: BOOKMARKS_ROOT.into(),
                    title: "a".into(),
                    url: "https://a.example/".into(),
                    added_at: 3,
                }
            ),
            None
        );
    }

    #[test]
    fn a_folder_never_moves_into_itself_and_renames_keep_a_title() {
        assert_eq!(move_bookmark(&tree(), "watch", "old", None), None);
        assert_eq!(move_bookmark(&tree(), "watch", "watch", None), None);
        let moved = move_bookmark(&tree(), "a", "watch", Some(0)).unwrap();
        assert_eq!(folder_children(&moved, "watch").unwrap()[0], "a");
        assert_eq!(rename_bookmark(&tree(), "watch", "  ", None), None);
        let renamed = rename_bookmark(&tree(), "a", "Ay", Some("not an address")).unwrap();
        assert!(
            matches!(renamed.get("a"), Some(BookmarkNode::Url { title, url, .. }) if title == "Ay" && url == "https://a.example/")
        );
    }
}

/// One row of the bookmarks drawer: a folder (open or closed, with how many links it holds) or a link, and how deep.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BookmarkTreeRow {
    pub id: String,
    pub folder: bool,
    pub title: String,
    /// A link's address; empty for a folder.
    pub url: String,
    pub depth: u32,
    /// A folder's links, however deep.
    pub links: u32,
    pub open: bool,
}

/// A tree as the drawer lists it: the top's folders and links in their order, and inside each folder in `open` its
/// own, one step deeper. Folders come before links at each level, as the reference lists them.
pub fn bookmark_tree_rows(bookmarks: &Bookmarks, open: &[String]) -> Vec<BookmarkTreeRow> {
    fn walk(
        bookmarks: &Bookmarks,
        id: &str,
        depth: u32,
        open: &[String],
        out: &mut Vec<BookmarkTreeRow>,
        seen: &mut HashSet<String>,
    ) {
        if !seen.insert(id.to_owned()) {
            return;
        }
        let Some(children) = folder_children(bookmarks, id) else {
            return;
        };
        let nodes: Vec<&BookmarkNode> = children
            .iter()
            .filter_map(|child| bookmarks.get(child))
            .collect();
        let (folders, links): (Vec<&BookmarkNode>, Vec<&BookmarkNode>) = nodes
            .into_iter()
            .partition(|node| matches!(node, BookmarkNode::Folder { .. }));
        for node in folders.into_iter().chain(links) {
            match node {
                BookmarkNode::Folder { id, title, .. } => {
                    let is_open = open.iter().any(|open| open == id);
                    out.push(BookmarkTreeRow {
                        id: id.clone(),
                        folder: true,
                        title: title.clone(),
                        url: String::new(),
                        depth,
                        links: bookmark_links(bookmarks, id).len() as u32,
                        open: is_open,
                    });
                    if is_open {
                        walk(bookmarks, id, depth + 1, open, out, seen);
                    }
                }
                BookmarkNode::Url { id, title, url, .. } => out.push(BookmarkTreeRow {
                    id: id.clone(),
                    folder: false,
                    title: title.clone(),
                    url: url.clone(),
                    depth,
                    links: 0,
                    open: false,
                }),
            }
        }
    }
    let mut out = Vec::new();
    walk(
        bookmarks,
        BOOKMARKS_ROOT,
        0,
        open,
        &mut out,
        &mut HashSet::new(),
    );
    out
}

#[cfg(test)]
mod tree_rows_tests {
    use super::*;

    #[test]
    fn a_dragged_bookmark_lands_beside_its_target() {
        let link = |id: &str, parent: &str| BookmarkNode::Url {
            id: id.into(),
            parent_id: parent.into(),
            title: id.into(),
            url: format!("https://{id}.example/"),
            added_at: 1,
        };
        let tree = add_bookmarks(
            &empty_bookmarks(),
            &[
                link("a", BOOKMARKS_ROOT),
                link("b", BOOKMARKS_ROOT),
                link("c", BOOKMARKS_ROOT),
                BookmarkNode::Folder {
                    id: "f".into(),
                    parent_id: Some(BOOKMARKS_ROOT.into()),
                    title: "f".into(),
                    children: vec!["d".into()],
                    added_at: 1,
                },
                link("d", "f"),
            ],
        )
        .unwrap();
        let drop = |id: &str, target: &str, after: bool| bookmark_drop(&tree, id, target, after);
        let at = |index: Option<i64>, parent: &str| {
            Some(BookmarkDrop {
                parent_id: parent.into(),
                index,
            })
        };
        // "c" before "a": first; "a" after "c": at the end.
        assert_eq!(drop("c", "a", false), at(Some(0), BOOKMARKS_ROOT));
        assert_eq!(drop("a", "f", true), at(None, BOOKMARKS_ROOT));
        // Into another folder, beside its link.
        assert_eq!(drop("a", "d", false), at(Some(0), "f"));
        // A folder can't go inside itself.
        assert_eq!(drop("f", "d", false), None);
        let moved = move_bookmark(&tree, "c", BOOKMARKS_ROOT, Some(0)).unwrap();
        assert_eq!(
            folder_children(&moved, BOOKMARKS_ROOT).unwrap()[..3],
            ["c", "a", "b"]
        );
    }

    #[test]
    fn the_drawer_lists_folders_first_and_opens_only_the_open_ones() {
        let folder = |id: &str, parent: &str, children: &[&str]| BookmarkNode::Folder {
            id: id.into(),
            parent_id: Some(parent.into()),
            title: id.into(),
            children: children.iter().map(|c| (*c).to_owned()).collect(),
            added_at: 1,
        };
        let link = |id: &str, parent: &str| BookmarkNode::Url {
            id: id.into(),
            parent_id: parent.into(),
            title: id.into(),
            url: format!("https://{id}.example/"),
            added_at: 1,
        };
        let tree = add_bookmarks(
            &empty_bookmarks(),
            &[
                link("top", BOOKMARKS_ROOT),
                folder("watch", BOOKMARKS_ROOT, &["a", "b"]),
                link("a", "watch"),
                link("b", "watch"),
                folder("trips", BOOKMARKS_ROOT, &[]),
            ],
        )
        .unwrap();
        let shut: Vec<(String, u32, u32)> = bookmark_tree_rows(&tree, &[])
            .into_iter()
            .map(|r| (r.id, r.depth, r.links))
            .collect();
        assert_eq!(
            shut,
            [
                ("watch".into(), 0, 2),
                ("trips".into(), 0, 0),
                ("top".into(), 0, 0)
            ]
        );
        let open: Vec<(String, u32)> = bookmark_tree_rows(&tree, &["watch".into()])
            .into_iter()
            .map(|r| (r.id, r.depth))
            .collect();
        assert_eq!(
            open,
            [
                ("watch".into(), 0),
                ("a".into(), 1),
                ("b".into(), 1),
                ("trips".into(), 0),
                ("top".into(), 0)
            ]
        );
    }
}
