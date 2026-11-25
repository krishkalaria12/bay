//! A database another browser may have open, read without touching it: the file and its WAL or journal are copied
//! before SQLite opens anything (even a read-only connection may create `-shm` beside the original), the copy is
//! checked against the original, and the copy is backed up into memory and deleted.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use rusqlite::backup::Backup;
use rusqlite::{Connection, OpenFlags};

use crate::failure::{Failure, Result};

pub struct Snapshot {
    db: Connection,
}

/// A file's modification time and size, or `None` when it's missing.
fn stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.modified().ok()?, metadata.len()))
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// A new private folder in the temporary directory, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self> {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes)
            .map_err(|_| Failure::new("unreadable", "Could not create database snapshot"))?;
        let name: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = std::env::temp_dir().join(format!("bay-import-{name}"));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder
            .create(&path)
            .map_err(|_| Failure::new("unreadable", "Could not create database snapshot"))?;
        Ok(Self(path))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const SIDECARS: [&str; 2] = ["-wal", "-journal"];

/// Copies `from` into `to` in one step, retrying a busy or locked source up to 40 times, 25 ms apart.
fn back_up(from: &Connection, to: &mut Connection) -> bool {
    use rusqlite::backup::StepResult;
    let Ok(backup) = Backup::new(from, to) else {
        return false;
    };
    for _ in 0..40 {
        match backup.step(-1) {
            Ok(StepResult::Done) => return true,
            Ok(StepResult::Busy | StepResult::Locked) => {
                std::thread::sleep(Duration::from_millis(25))
            }
            _ => return false,
        }
    }
    false
}

/// Copies `path` and its sidecars to `copy`; whether nothing changed meanwhile.
fn copy_stable(path: &Path, copy: &Path) -> Result<bool> {
    let before =
        stamp(path).ok_or_else(|| Failure::new("notFound", "Source database is unavailable"))?;
    let sidecars: Vec<_> = SIDECARS
        .iter()
        .map(|suffix| stamp(&with_suffix(path, suffix)))
        .collect();
    let copied = (|| -> std::io::Result<()> {
        std::fs::copy(path, copy)?;
        // Owner read and write only, whatever the original allowed.
        #[cfg(unix)]
        std::fs::set_permissions(copy, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
        #[cfg(not(unix))]
        {
            let mut permissions = std::fs::metadata(copy)?.permissions();
            #[allow(
                clippy::permissions_set_readonly_false,
                reason = "Windows has no world-writable bit"
            )]
            permissions.set_readonly(false);
            std::fs::set_permissions(copy, permissions)?;
        }
        for (suffix, sidecar) in SIDECARS.iter().zip(&sidecars) {
            let destination = with_suffix(copy, suffix);
            let _ = std::fs::remove_file(&destination);
            if sidecar.is_some() {
                std::fs::copy(with_suffix(path, suffix), &destination)?;
            }
        }
        Ok(())
    })();
    if copied.is_err() {
        return Ok(false);
    }
    Ok(stamp(path) == Some(before)
        && SIDECARS
            .iter()
            .zip(&sidecars)
            .all(|(suffix, sidecar)| stamp(&with_suffix(path, suffix)) == *sidecar))
}

impl Snapshot {
    pub fn open(path: &Path) -> Result<Self> {
        let scratch = Scratch::new()?;
        let copy = scratch.0.join("snapshot.sqlite");
        let mut stable = false;
        for _ in 0..3 {
            if copy_stable(path, &copy)? {
                stable = true;
                break;
            }
        }
        if !stable {
            return Err(Failure::new(
                "unreadable",
                "The source database changed while copying. Close the browser and try again",
            ));
        }
        let source = Connection::open_with_flags(
            &copy,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| Failure::new("unreadable", "Close the source browser and try again"))?;
        let mut db = Connection::open_in_memory()
            .map_err(|_| Failure::new("unreadable", "Could not create database snapshot"))?;
        if !back_up(&source, &mut db) {
            return Err(Failure::new(
                "unreadable",
                "The source database is busy. Close the browser and try again",
            ));
        }
        drop(source);
        Ok(Self { db })
    }

    /// Runs `sql`, giving each row to `row` until it returns `Ok(false)`.
    pub fn query(
        &self,
        sql: &str,
        mut row: impl FnMut(&rusqlite::Row<'_>) -> Result<bool>,
    ) -> Result<()> {
        let mut statement = self
            .db
            .prepare(sql)
            .map_err(|_| Failure::new("unreadable", "Source database has an unsupported layout"))?;
        let mut rows = statement
            .query([])
            .map_err(|_| Failure::new("unreadable", "Could not read the source database"))?;
        loop {
            match rows.next() {
                Ok(Some(current)) => {
                    if !row(current)? {
                        return Ok(());
                    }
                }
                Ok(None) => return Ok(()),
                Err(_) => {
                    return Err(Failure::new(
                        "unreadable",
                        "Could not read the source database",
                    ));
                }
            }
        }
    }

    /// Whether the database has a table named `name`.
    pub fn table(&self, name: &str) -> Result<bool> {
        let mut found = false;
        self.query("SELECT name FROM sqlite_master WHERE type='table'", |row| {
            found = row.get::<_, String>(0).is_ok_and(|table| table == name);
            Ok(!found)
        })?;
        Ok(found)
    }

    /// The snapshot written to a new database file at `path` (NSS needs key4.db on disk).
    pub fn write_to(&self, path: &Path) -> Result<()> {
        let mut destination = Connection::open(path)
            .map_err(|_| Failure::new("unreadable", "Could not copy the Firefox key database"))?;
        if back_up(&self.db, &mut destination) {
            Ok(())
        } else {
            Err(Failure::new(
                "unreadable",
                "Could not copy the Firefox key database",
            ))
        }
    }
}

/// A text column as the C++ readers read it: empty when null.
pub fn text(row: &rusqlite::Row<'_>, column: usize) -> String {
    match row.get_ref(column) {
        Ok(rusqlite::types::ValueRef::Text(bytes)) | Ok(rusqlite::types::ValueRef::Blob(bytes)) => {
            String::from_utf8_lossy(bytes).into_owned()
        }
        Ok(rusqlite::types::ValueRef::Integer(value)) => value.to_string(),
        Ok(rusqlite::types::ValueRef::Real(value)) => value.to_string(),
        _ => String::new(),
    }
}

/// An integer column, 0 when null or not a number.
pub fn integer(row: &rusqlite::Row<'_>, column: usize) -> i64 {
    match row.get_ref(column) {
        Ok(rusqlite::types::ValueRef::Integer(value)) => value,
        Ok(rusqlite::types::ValueRef::Real(value)) => value as i64,
        Ok(rusqlite::types::ValueRef::Text(bytes)) => String::from_utf8_lossy(bytes)
            .trim()
            .parse::<i64>()
            .unwrap_or(0),
        _ => 0,
    }
}

pub fn is_null(row: &rusqlite::Row<'_>, column: usize) -> bool {
    matches!(
        row.get_ref(column),
        Ok(rusqlite::types::ValueRef::Null) | Err(_)
    )
}
