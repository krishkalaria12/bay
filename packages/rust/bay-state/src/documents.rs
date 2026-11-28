//! The folder the app keeps its documents in, and reading and writing one, as the React Native app's shell does
//! (packages/desktop/ios/ShellModule.swift: documentURL, write).

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// The data folder of a scratch or test instance; its documents sit directly inside it.
pub const DATA_DIR_ENV: &str = "BAY_DATA_DIR";

#[derive(Debug, thiserror::Error)]
pub enum DocumentError {
    #[error("{name}: {source}")]
    Io {
        name: String,
        #[source]
        source: io::Error,
    },
    #[error("{name} isn't a document this build can read: {source}")]
    Unreadable {
        name: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("{0} is not a plain document name")]
    BadName(String),
}

impl DocumentError {
    pub(crate) fn unreadable(name: &str, source: serde_json::Error) -> Self {
        Self::Unreadable {
            name: name.to_owned(),
            source,
        }
    }
}

/// Where the app's documents are: `$BAY_DATA_DIR`, else `~/Library/Application Support/<bundle id>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataDir {
    root: PathBuf,
}

impl DataDir {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// The folder the running app uses: `BAY_DATA_DIR` when set, else the bundle's folder in Application Support.
    pub fn for_app(bundle_id: &str) -> Option<Self> {
        if let Some(dir) = std::env::var_os(DATA_DIR_ENV).filter(|dir| !dir.is_empty()) {
            return Some(Self::new(dir));
        }
        let home = std::env::var_os("HOME")?;
        Some(Self::new(
            Path::new(&home)
                .join("Library/Application Support")
                .join(bundle_id),
        ))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// A document's path. Only a plain file name is a document (the shell takes the last path component too).
    pub fn path(&self, name: &str) -> Result<PathBuf, DocumentError> {
        let plain =
            !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0']);
        if plain {
            Ok(self.root.join(name))
        } else {
            Err(DocumentError::BadName(name.to_owned()))
        }
    }

    /// The document's text, or `None` when there is none.
    pub fn read(&self, name: &str) -> Result<Option<String>, DocumentError> {
        let path = self.path(name)?;
        match fs::read_to_string(&path) {
            Ok(text) => Ok(Some(text)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(DocumentError::Io {
                name: name.to_owned(),
                source,
            }),
        }
    }

    /// Writes the document whole: into a file beside it, then moved over it, so a reader never sees half of one.
    pub fn write(&self, name: &str, contents: &str) -> Result<(), DocumentError> {
        let path = self.path(name)?;
        let io_error = |source| DocumentError::Io {
            name: name.to_owned(),
            source,
        };
        fs::create_dir_all(&self.root).map_err(io_error)?;
        let staging = self
            .root
            .join(format!(".{name}.{}.tmp", std::process::id()));
        let written = File::create(&staging).and_then(|mut file| {
            file.write_all(contents.as_bytes())?;
            file.sync_all()
        });
        if let Err(source) = written.and_then(|()| fs::rename(&staging, &path)) {
            let _ = fs::remove_file(&staging);
            return Err(io_error(source));
        }
        Ok(())
    }
}
