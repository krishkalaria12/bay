//! session.json: spaces, windows, tabs and what was closed, as the React Native app writes it (apps/browser/src/lib/
//! persist.ts, sessionJson) and reads it back (loadSession). Version 2.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::documents::{DataDir, DocumentError};
use crate::model::{
    BrowserWindow, ClosedGroup, ClosedTab, ClosedWindow, Extra, LocalFilePin, PinnedFolder, Space,
    SplitView, Tab, TabGroup,
};

pub const SESSION: &str = "session.json";
pub const SESSION_VERSION: u32 = 2;

/// The saved session. Fields are in the order the app writes them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub version: u32,
    #[serde(default)]
    pub spaces: IndexMap<String, Space>,
    #[serde(default)]
    pub space_order: Vec<String>,
    /// Native profile folders no space owns any more, kept until their data is deleted.
    #[serde(default)]
    pub orphaned_profile_data: Vec<String>,
    /// The app's settings, kept as written until each has a typed home here.
    #[serde(default)]
    pub settings: Map<String, Value>,
    #[serde(default)]
    pub windows: Vec<BrowserWindow>,
    #[serde(default)]
    pub window_order: Vec<String>,
    #[serde(default)]
    pub focused_window_id: Option<String>,
    #[serde(default)]
    pub tabs: Vec<Tab>,
    /// Each list's tab ids, in order ("space:<id>" and the like).
    #[serde(default)]
    pub tab_lists: IndexMap<String, Vec<String>>,
    #[serde(default)]
    pub groups: Vec<TabGroup>,
    #[serde(default)]
    pub pinned_folders: Vec<PinnedFolder>,
    #[serde(default)]
    pub local_files: Vec<LocalFilePin>,
    #[serde(default)]
    pub splits: Vec<SplitView>,
    #[serde(default)]
    pub closed_tabs: Vec<ClosedTab>,
    #[serde(default)]
    pub closed_windows: Vec<ClosedWindow>,
    #[serde(default)]
    pub closed_groups: Vec<ClosedGroup>,
    #[serde(default)]
    pub deleted_groups: Vec<ClosedGroup>,
    #[serde(default)]
    pub cleaned_tabs: Vec<ClosedTab>,
    #[serde(flatten)]
    pub extra: Extra,
}

impl Session {
    /// The saved session, or `None` when there is none or it is another version (the app then starts afresh, as the
    /// React Native app does). A session from before spaces had that name (`profiles`) is left to that app, which
    /// migrates it: this build refuses it rather than lose its spaces.
    pub fn load(dir: &DataDir) -> Result<Option<Self>, DocumentError> {
        let Some(text) = dir.read(SESSION)? else {
            return Ok(None);
        };
        let unreadable = |source| DocumentError::unreadable(SESSION, source);
        let value: Value = serde_json::from_str(&text).map_err(unreadable)?;
        if value.get("version").and_then(Value::as_u64) != Some(u64::from(SESSION_VERSION)) {
            return Ok(None);
        }
        if value.get("spaces").is_none() && value.get("profiles").is_some() {
            return Err(unreadable(serde::de::Error::custom(
                "a session from before spaces (profiles): open it in the React Native app once to migrate it",
            )));
        }
        serde_json::from_value(value).map(Some).map_err(unreadable)
    }

    pub fn to_json(&self) -> Result<String, DocumentError> {
        serde_json::to_string(self).map_err(|source| DocumentError::unreadable(SESSION, source))
    }

    pub fn save(&self, dir: &DataDir) -> Result<(), DocumentError> {
        dir.write(SESSION, &self.to_json()?)
    }
}
