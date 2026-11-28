//! Finder files and folders pinned in a space (store/localFiles.ts). Only their metadata is the app's: access grants
//! stay with the native shell.

use indexmap::IndexMap;

use super::Browser;
use super::model::is_incognito_space;
use crate::model::{LocalFilePin, Space};
use crate::number::JsNumber;

/// Pins sync between devices, so a path may be another platform's: /posix, a Windows drive (C:\ or C:/) or a share
/// (\\server\share). Each keeps its own form, its separators tidied; None for anything else.
pub fn local_file_path(path: &str) -> Option<String> {
    if path.contains('\0') {
        return None;
    }
    let posix = path.starts_with('/');
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    let share = path.starts_with("\\\\");
    if !posix && !drive && !share {
        return None;
    }
    // A backslash is an ordinary character in a POSIX name.
    let pieces: Vec<&str> = if posix {
        path.split('/').collect()
    } else {
        path.split(['\\', '/']).collect()
    };
    let parts: Vec<&str> = pieces.into_iter().filter(|p| !p.is_empty()).collect();
    if parts.iter().any(|p| *p == "." || *p == "..") {
        return None;
    }
    Some(if posix {
        format!("/{}", parts.join("/"))
    } else if drive {
        format!("{}\\{}", parts[0], parts[1..].join("\\"))
    } else {
        format!("\\\\{}", parts.join("\\"))
    })
}

fn safe_id(id: &str) -> bool {
    !id.is_empty() && !["__proto__", "constructor", "prototype"].contains(&id)
}

/// The pins that are fine to keep, each only with the fields a pin has: never an input record wholesale.
pub fn normalize_local_files<'a>(
    input: impl IntoIterator<Item = &'a LocalFilePin>,
    spaces: Option<&IndexMap<String, Space>>,
) -> IndexMap<String, LocalFilePin> {
    let mut out = IndexMap::new();
    for pin in input {
        let Some(path) = local_file_path(&pin.path) else {
            continue;
        };
        let space_ok = spaces.is_none_or(|s| s.contains_key(&pin.space_id));
        let name = pin.name.trim();
        if !safe_id(&pin.id)
            || !safe_id(&pin.space_id)
            || is_incognito_space(&pin.space_id)
            || !space_ok
            || name.is_empty()
        {
            continue;
        }
        if pin.kind != "file" && pin.kind != "folder" {
            continue;
        }
        let finite = |n: JsNumber| if n.0.is_finite() { n } else { JsNumber(0.0) };
        out.insert(
            pin.id.clone(),
            LocalFilePin {
                id: pin.id.clone(),
                space_id: pin.space_id.clone(),
                path,
                name: name.to_owned(),
                kind: pin.kind.clone(),
                created_at: finite(pin.created_at),
                order: finite(pin.order),
                expanded: pin.kind == "folder" && pin.expanded,
                extra: Default::default(),
            },
        );
    }
    out
}

/// A file to pin: its path, name and kind ("file" or "folder").
#[derive(Clone, Debug)]
pub struct FileDescriptor {
    pub path: String,
    pub name: String,
    pub kind: String,
}

impl Browser {
    /// A space's pins in order.
    pub fn local_file_pins(&self, space_id: &str) -> Vec<&LocalFilePin> {
        let mut pins: Vec<&LocalFilePin> = self
            .local_files
            .values()
            .filter(|p| p.space_id == space_id)
            .collect();
        pins.sort_by(|a, b| {
            a.order
                .0
                .total_cmp(&b.order.0)
                .then_with(|| a.id.cmp(&b.id))
        });
        pins
    }

    /// Pins the files in the window's space (or `space_id`); their ids, a file already pinned there by its pin's.
    pub fn pin_local_files(
        &mut self,
        window_id: &str,
        files: &[FileDescriptor],
        space_id: Option<&str>,
    ) -> Vec<String> {
        let Some(w) = self.windows.get(window_id) else {
            return Vec::new();
        };
        let space = space_id.map_or_else(|| w.space_id.clone(), str::to_owned);
        if w.incognito || w.is_small() || !self.spaces.contains_key(&space) {
            return Vec::new();
        }
        let mut order = self
            .local_file_pins(&space)
            .iter()
            .map(|p| p.order.0)
            .fold(-1.0, f64::max)
            + 1.0;
        let mut ids = Vec::new();
        for file in files {
            let id = self.new_id("file");
            let candidate = LocalFilePin {
                id: id.clone(),
                space_id: space.clone(),
                path: file.path.clone(),
                name: file.name.clone(),
                kind: file.kind.clone(),
                created_at: JsNumber(self.now()),
                order: JsNumber(order),
                expanded: false,
                extra: Default::default(),
            };
            let Some(pin) =
                normalize_local_files([&candidate], Some(&self.spaces)).shift_remove(&id)
            else {
                continue;
            };
            if let Some(existing) = self
                .local_files
                .values()
                .find(|p| p.space_id == space && p.path == pin.path)
            {
                ids.push(existing.id.clone());
                continue;
            }
            self.local_files.insert(id.clone(), pin);
            order += 1.0;
            ids.push(id);
        }
        ids
    }

    pub fn remove_local_file(&mut self, id: &str) {
        self.local_files.shift_remove(id);
    }

    pub fn rename_local_file(&mut self, id: &str, name: &str) {
        if let Some(pin) = self.local_files.get_mut(id)
            && !name.trim().is_empty()
        {
            pin.name = name.trim().to_owned();
        }
    }

    /// Moves the pin before another of its space's (to the end for None), renumbering their order.
    pub fn move_local_file(&mut self, id: &str, before_id: Option<&str>) {
        let Some(pin) = self.local_files.get(id).cloned() else {
            return;
        };
        if Some(id) == before_id
            || before_id.is_some_and(|b| {
                self.local_files
                    .get(b)
                    .is_none_or(|x| x.space_id != pin.space_id)
            })
        {
            return;
        }
        let mut ids: Vec<String> = self
            .local_file_pins(&pin.space_id)
            .iter()
            .filter(|p| p.id != id)
            .map(|p| p.id.clone())
            .collect();
        let at = before_id
            .and_then(|b| ids.iter().position(|x| x == b))
            .unwrap_or(ids.len());
        ids.insert(at, id.to_owned());
        for (order, pid) in ids.iter().enumerate() {
            if let Some(p) = self.local_files.get_mut(pid) {
                p.order = JsNumber(order as f64);
            }
        }
    }

    pub fn set_local_file_expanded(&mut self, id: &str, expanded: bool) {
        if let Some(pin) = self.local_files.get_mut(id).filter(|p| p.kind == "folder") {
            pin.expanded = expanded;
        }
    }

    /// A space's pins as they were, for undo; access grants are unaffected.
    pub fn restore_local_files(&mut self, space_id: &str, pins: &[LocalFilePin]) {
        if !self.spaces.contains_key(space_id) {
            return;
        }
        self.local_files.retain(|_, p| p.space_id != space_id);
        let restored = normalize_local_files(pins, Some(&self.spaces));
        self.local_files
            .extend(restored.into_iter().filter(|(_, p)| p.space_id == space_id));
    }
}
