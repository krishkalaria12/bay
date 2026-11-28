//! downloads.json: the Downloads list, as the React Native app writes it (apps/browser/src/lib/persist.ts, DOCS).
//! Version 2. Each download is kept as written until the downloads have a typed home here.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::documents::{DataDir, DocumentError};
use crate::model::Extra;

pub const DOWNLOADS: &str = "downloads.json";
pub const DOWNLOADS_VERSION: u32 = 2;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Downloads {
    pub version: u32,
    #[serde(default)]
    pub downloads: Vec<Map<String, Value>>,
    #[serde(flatten)]
    pub extra: Extra,
}

impl Downloads {
    /// The saved downloads, or `None` when there are none or they are another version.
    pub fn load(dir: &DataDir) -> Result<Option<Self>, DocumentError> {
        let Some(text) = dir.read(DOWNLOADS)? else {
            return Ok(None);
        };
        let downloads: Self = serde_json::from_str(&text)
            .map_err(|source| DocumentError::unreadable(DOWNLOADS, source))?;
        Ok((downloads.version == DOWNLOADS_VERSION).then_some(downloads))
    }

    pub fn save(&self, dir: &DataDir) -> Result<(), DocumentError> {
        let json = serde_json::to_string(self)
            .map_err(|source| DocumentError::unreadable(DOWNLOADS, source))?;
        dir.write(DOWNLOADS, &json)
    }
}
