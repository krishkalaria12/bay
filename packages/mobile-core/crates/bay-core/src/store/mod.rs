//! The browser store: the browsing state, every change to it, and reading it back from disk.

pub mod bookmarks;
pub mod handle;
pub mod model;
pub mod parse;
pub mod types;

pub use model::{Action, reduce};
pub use types::*;
