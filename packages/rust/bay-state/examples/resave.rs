//! Reads a data folder's session and downloads through this crate and writes them to another folder, to check that
//! the React Native app reads what this crate writes:
//!
//!   cargo run -p bay-state --example resave -- <from data dir> <to data dir>

use bay_state::{DataDir, Downloads, Session};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let (Some(from), Some(to)) = (args.next(), args.next()) else {
        return Err("usage: resave <from data dir> <to data dir>".into());
    };
    let (from, to) = (DataDir::new(from), DataDir::new(to));
    if let Some(session) = Session::load(&from)? {
        session.save(&to)?;
    }
    if let Some(downloads) = Downloads::load(&from)? {
        downloads.save(&to)?;
    }
    Ok(())
}
