//! Reading the file someone chose: a bookmarks page or history file as it is, or an archive (Safari's export, a Google
//! Takeout download) whose bookmark pages and history files are read straight out of it. Passwords, cards and the rest
//! stay in the archive and are only named, so nothing secret is read. The Expo app's native `BayExport` and
//! `src/import/importer.ts`.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use super::{ExportContents, ExportFile, ExportNotes, export_notes, read_export};

/// The largest file Bay reads: a year of Takeout history is a few tens of megabytes.
pub const MAX_FILE_SIZE: u64 = 64 * 1024 * 1024;
const MAX_FILES: usize = 64;
/// How many names of left-out files are kept: enough to tell what an archive held.
const MAX_SKIPPED: usize = 200;

/// A chosen export, read and ready to review.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ChosenExport {
    /// The chosen file's name.
    pub name: String,
    pub contents: ExportContents,
    pub notes: ExportNotes,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum ExportReadError {
    /// Nothing in the file is bookmarks or history, or what was is too large to read: the wrong file, not a failure.
    #[error("{name} doesn't hold bookmarks or history Bay can read.")]
    NothingToImport { name: String, too_large: bool },
    /// The file couldn't be opened or its archive is broken.
    #[error("The file couldn't be read.")]
    Unreadable,
}

/// Whether a file is one Bay reads: a bookmarks page, or a history file by its name.
fn wanted(name: &str) -> bool {
    let lower = name.to_lowercase();
    if lower.ends_with(".html") || lower.ends_with(".htm") {
        return true;
    }
    if !lower.ends_with(".json") {
        return false;
    }
    let squashed: String = lower
        .chars()
        .filter(|c| !matches!(c, ' ' | '_' | '-'))
        .collect();
    squashed.starts_with("history") || squashed.starts_with("browserhistory")
}

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes)
        .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
}

/// The files to read out of the chosen file, with the names of those left out and those too large.
struct Unpacked {
    files: Vec<ExportFile>,
    skipped: Vec<String>,
    too_large: Vec<String>,
}

fn unpack(file: &mut File, name: &str) -> Result<Unpacked, ExportReadError> {
    let mut magic = [0u8; 4];
    let is_zip = file.read_exact(&mut magic).is_ok() && magic == *b"PK\x03\x04";
    file.seek(SeekFrom::Start(0))
        .map_err(|_| ExportReadError::Unreadable)?;

    if !is_zip {
        let size = file
            .metadata()
            .map_err(|_| ExportReadError::Unreadable)?
            .len();
        if size > MAX_FILE_SIZE {
            return Ok(Unpacked {
                files: Vec::new(),
                skipped: Vec::new(),
                too_large: vec![name.to_owned()],
            });
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|_| ExportReadError::Unreadable)?;
        let files = vec![ExportFile {
            name: name.to_owned(),
            text: text(bytes),
        }];
        return Ok(Unpacked {
            files,
            skipped: Vec::new(),
            too_large: Vec::new(),
        });
    }

    let mut archive = zip::ZipArchive::new(file).map_err(|_| ExportReadError::Unreadable)?;
    let (mut files, mut skipped, mut too_large) = (Vec::new(), Vec::new(), Vec::new());
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| ExportReadError::Unreadable)?;
        let path = entry.name().to_owned();
        if entry.is_dir() || path.starts_with("__MACOSX/") {
            continue;
        }
        let entry_name = path.rsplit('/').next().unwrap_or_default().to_owned();
        if entry_name.is_empty() || entry_name.starts_with('.') {
            continue;
        }
        if !wanted(&entry_name) {
            if skipped.len() < MAX_SKIPPED {
                skipped.push(entry_name);
            }
            continue;
        }
        if entry.size() > MAX_FILE_SIZE || files.len() >= MAX_FILES {
            too_large.push(entry_name);
            continue;
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        // The size an entry claims is checked above; a lying one still stops at the limit.
        (&mut entry)
            .take(MAX_FILE_SIZE)
            .read_to_end(&mut bytes)
            .map_err(|_| ExportReadError::Unreadable)?;
        files.push(ExportFile {
            name: entry_name,
            text: text(bytes),
        });
    }
    Ok(Unpacked {
        files,
        skipped,
        too_large,
    })
}

/// Reads the file at `path`, which the person chose as `name`.
#[uniffi::export]
pub fn read_export_file(path: String, name: String) -> Result<ChosenExport, ExportReadError> {
    let mut file = File::open(Path::new(&path)).map_err(|_| ExportReadError::Unreadable)?;
    let unpacked = unpack(&mut file, &name)?;
    let files = unpacked.files;
    let notes = export_notes(&unpacked.skipped, &unpacked.too_large);
    let contents = read_export(&files).map_err(|_| ExportReadError::NothingToImport {
        name: name.clone(),
        too_large: !notes.too_large.is_empty(),
    })?;
    Ok(ChosenExport {
        name,
        contents,
        notes,
    })
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    const BOOKMARKS: &str = "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n<DT><A HREF=\"https://one.example/\">One</A>\n</DL>";

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bay-archive-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn reads_a_bookmarks_page_as_it_is() {
        let path = temp("bookmarks.html");
        std::fs::write(&path, BOOKMARKS).unwrap();
        let chosen =
            read_export_file(path.to_string_lossy().into(), "bookmarks.html".into()).unwrap();
        assert_eq!(super::super::link_count(&chosen.contents.bookmarks), 1);
    }

    #[test]
    fn reads_bookmarks_out_of_an_archive_and_only_names_the_rest() {
        let path = temp("export.zip");
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("Safari Export/Bookmarks.html", options)
            .unwrap();
        zip.write_all(BOOKMARKS.as_bytes()).unwrap();
        zip.start_file("Safari Export/Passwords.csv", options)
            .unwrap();
        zip.write_all(b"url,username,password\n").unwrap();
        zip.finish().unwrap();
        let chosen =
            read_export_file(path.to_string_lossy().into(), "Safari Export.zip".into()).unwrap();
        assert_eq!(super::super::link_count(&chosen.contents.bookmarks), 1);
        assert!(chosen.notes.passwords);
    }

    #[test]
    fn a_file_without_bookmarks_is_nothing_to_import() {
        let path = temp("notes.txt");
        std::fs::write(&path, "hello").unwrap();
        assert_eq!(
            read_export_file(path.to_string_lossy().into(), "notes.txt".into()),
            Err(ExportReadError::NothingToImport {
                name: "notes.txt".into(),
                too_large: false
            })
        );
    }
}
