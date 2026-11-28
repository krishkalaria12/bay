//! The desktop app's state: its model and the documents it saves. No GPUI here: the crate runs in plain `cargo test`,
//! and the UI reads it through its own entities (docs/gpui-desktop-plan.html, Crates).
//!
//! The documents are the React Native app's, read and written in place (decision D6): the same folder, names,
//! versions and fields, and every field this build doesn't model carried through unchanged.

pub mod documents;
pub mod downloads;
mod migrate;
pub mod model;
pub mod number;
pub mod session;
pub mod store;

pub use documents::{DataDir, DocumentError};
pub use downloads::Downloads;
pub use number::JsNumber;
pub use session::Session;
pub use store::Browser;
