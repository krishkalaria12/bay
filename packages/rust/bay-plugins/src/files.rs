//! Plugins on disk: one folder each under the host's plugins folder, named by the plugin's id. A plugin comes in as a
//! copy of a folder the person picked, so changing or deleting the original changes nothing; its sandbox reads only
//! from its own folder ([`read`]), and only plain files: no links out of it, nothing hidden.

use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::manifest::{self, Manifest, Refusal, valid_id, valid_path};

/// A plugin's limits: what its folder may hold.
pub const MAX_FILES: usize = 500;
pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 25 * 1024 * 1024;
const MAX_DEPTH: usize = 8;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

/// The runtime every sandbox loads before the plugin's own script.
pub const RUNTIME: &str = include_str!("runtime.js");

/// The sandbox's content security policy: the plugin's own files and nothing else. It reaches the web only through
/// Bay (`bay.fetch`, checked against its manifest's hosts), and runs in a unique origin of its own, so no two plugins
/// share storage or can reach each other's pages.
pub const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; \
                       font-src 'self'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; \
                       base-uri 'none'; form-action 'none'; sandbox allow-scripts";

fn refuse<T>(message: impl Into<String>) -> Result<T, Refusal> {
    Err(Refusal(message.into()))
}

fn read_limited(path: &Path, max: u64) -> Option<Vec<u8>> {
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(max + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= max).then_some(bytes)
}

/// The manifest in `folder`, checked.
pub fn manifest_in(folder: &Path) -> Result<Manifest, Refusal> {
    let path = folder.join("manifest.json");
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() => {}
        _ => return refuse("The folder has no manifest.json"),
    }
    let bytes = read_limited(&path, MAX_MANIFEST_BYTES)
        .map_or_else(|| refuse("manifest.json is too big to read"), Ok)?;
    let text = String::from_utf8(bytes).map_err(|_| Refusal("manifest.json isn't UTF-8".into()))?;
    manifest::check(&text)
}

/// Every plugin in `root`, as JSON: `{"plugins":[manifest…],"problems":[{"folder","error"}]}`.
pub fn list(root: &Path) -> Value {
    let mut plugins = Vec::new();
    let mut problems = Vec::new();
    let mut entries: Vec<_> = fs::read_dir(root)
        .map(|dir| dir.filter_map(Result::ok).collect())
        .unwrap_or_default();
    entries.sort_by_key(fs::DirEntry::file_name);

    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let checked = manifest_in(&entry.path()).and_then(|m| {
            if m.id != name {
                return refuse(format!(
                    "The folder is named \"{name}\", but its plugin's id is \"{}\"",
                    m.id
                ));
            }
            match fs::symlink_metadata(entry.path().join(&m.main)) {
                Ok(meta) if meta.is_file() => Ok(m),
                _ => refuse(format!("The plugin's script {} is missing", m.main)),
            }
        });
        match checked {
            Ok(m) => plugins.push(serde_json::to_value(m).unwrap_or(Value::Null)),
            Err(error) => problems.push(json!({ "folder": name, "error": error.0 })),
        }
    }

    json!({ "plugins": plugins, "problems": problems })
}

/// The files to copy from `source`: relative paths, checked against the limits.
fn files_in(source: &Path) -> Result<Vec<String>, Refusal> {
    let mut out = Vec::new();
    let mut total = 0u64;
    let mut stack = vec![(source.to_path_buf(), String::new(), 0usize)];

    while let Some((dir, prefix, depth)) = stack.pop() {
        let entries =
            fs::read_dir(&dir).map_err(|e| Refusal(format!("Couldn't read the folder: {e}")))?;
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            // Hidden files (.git, .DS_Store) stay behind.
            if name.starts_with('.') {
                continue;
            }
            let relative = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let meta = fs::symlink_metadata(entry.path())
                .map_err(|e| Refusal(format!("Couldn't read {relative}: {e}")))?;

            if meta.file_type().is_symlink() {
                return refuse(format!(
                    "{relative} is a link; a plugin's files must be in its folder"
                ));
            }
            if !valid_path(&relative) {
                return refuse(format!("{relative} has a name a plugin's files can't have"));
            }
            if meta.is_dir() {
                if depth + 1 >= MAX_DEPTH {
                    return refuse("The plugin's folders are nested too deeply");
                }
                stack.push((entry.path(), relative, depth + 1));
            } else if meta.is_file() {
                if meta.len() > MAX_FILE_BYTES {
                    return refuse(format!(
                        "{relative} is bigger than {} MB",
                        MAX_FILE_BYTES / 1024 / 1024
                    ));
                }
                total += meta.len();
                out.push(relative);
                if out.len() > MAX_FILES || total > MAX_TOTAL_BYTES {
                    return refuse(format!(
                        "The plugin has more than {MAX_FILES} files or {} MB",
                        MAX_TOTAL_BYTES / 1024 / 1024
                    ));
                }
            }
        }
    }

    out.sort();
    Ok(out)
}

fn stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos())
}

/// Copies the plugin in `source` into `root`, replacing an older copy of it; its manifest once it's in place.
pub fn install(root: &Path, source: &Path) -> Result<Manifest, Refusal> {
    let manifest = manifest_in(source)?;
    let files = files_in(source)?;
    if !files.contains(&manifest.main) {
        return refuse(format!("The plugin's script {} is missing", manifest.main));
    }

    fs::create_dir_all(root)
        .map_err(|e| Refusal(format!("Couldn't make the plugins folder: {e}")))?;
    let target = root.join(&manifest.id);
    // A plugin added from its own place in the plugins folder is already there.
    if let (Ok(a), Ok(b)) = (source.canonicalize(), target.canonicalize())
        && a == b
    {
        return Ok(manifest);
    }

    let staging = root.join(format!(".adding-{}-{}", manifest.id, stamp()));
    let copied = (|| -> std::io::Result<()> {
        fs::create_dir(&staging)?;
        for file in &files {
            let to = staging.join(file);
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(source.join(file), to)?;
        }
        Ok(())
    })();
    if let Err(error) = copied {
        let _ = fs::remove_dir_all(&staging);
        return refuse(format!("Couldn't copy the plugin: {error}"));
    }

    // The old copy steps aside first, so a failed move leaves it as it was.
    let old = root.join(format!(".removing-{}-{}", manifest.id, stamp()));
    let had_old = target.exists();
    if had_old && let Err(error) = fs::rename(&target, &old) {
        let _ = fs::remove_dir_all(&staging);
        return refuse(format!("Couldn't replace the plugin: {error}"));
    }
    if let Err(error) = fs::rename(&staging, &target) {
        if had_old {
            let _ = fs::rename(&old, &target);
        }
        let _ = fs::remove_dir_all(&staging);
        return refuse(format!("Couldn't add the plugin: {error}"));
    }
    if had_old {
        let _ = fs::remove_dir_all(&old);
    }
    Ok(manifest)
}

/// Deletes the plugin `id` from `root`; true once it's gone.
pub fn remove(root: &Path, id: &str) -> bool {
    if !valid_id(id) {
        return false;
    }
    let target = root.join(id);
    if !target.exists() {
        return true;
    }
    let gone = root.join(format!(".removing-{id}-{}", stamp()));
    fs::rename(&target, &gone).is_ok() && {
        let _ = fs::remove_dir_all(&gone);
        true
    }
}

/// A file's type, by its extension.
pub fn mime_type(path: &str) -> &'static str {
    let ext = path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "js" | "mjs" => "text/javascript",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "txt" | "md" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// `path` with every byte outside a URL path's plain characters escaped.
fn url_path(path: &str) -> String {
    path.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The page a sandbox opens: the runtime, then the plugin's script.
pub fn host_page(manifest: &Manifest) -> String {
    format!(
        "<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>{}</title>\n<script src=\"runtime.js\"></script>\n<script src=\"../{}\"></script>\n</head><body></body></html>\n",
        manifest.id,
        url_path(&manifest.main)
    )
}

fn plugin_folder(root: &Path, id: &str) -> Option<PathBuf> {
    valid_id(id).then(|| root.join(id))
}

/// A file of plugin `id` for its sandbox, and its type: `__bay/host.html` and `__bay/runtime.js` are Bay's, anything
/// else a plain file in the plugin's own folder. None for anything else.
pub fn read(root: &Path, id: &str, path: &str) -> Option<(Vec<u8>, &'static str)> {
    let folder = plugin_folder(root, id)?;
    let path = path.split(['?', '#']).next().unwrap_or_default();

    match path {
        "__bay/host.html" => {
            return Some((
                host_page(&manifest_in(&folder).ok()?).into_bytes(),
                "text/html",
            ));
        }
        "__bay/runtime.js" => return Some((RUNTIME.as_bytes().to_vec(), "text/javascript")),
        _ => {}
    }
    if !valid_path(path) {
        return None;
    }

    // Each step a real folder or file, never a link, and the whole path still inside the plugin's folder.
    let mut at = folder.clone();
    for part in path.split('/') {
        at.push(part);
        if fs::symlink_metadata(&at).ok()?.file_type().is_symlink() {
            return None;
        }
    }
    let real_folder = folder.canonicalize().ok()?;
    let real = at.canonicalize().ok()?;
    if !real.starts_with(&real_folder) || !fs::metadata(&real).ok()?.is_file() {
        return None;
    }
    Some((read_limited(&real, MAX_FILE_BYTES)?, mime_type(path)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, path: &str, text: &str) {
        let file = dir.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, text).unwrap();
    }

    fn plugin(dir: &Path, id: &str) {
        write(
            dir,
            "manifest.json",
            &format!(r#"{{"manifestVersion":1,"id":"{id}","name":"Hi","version":"1"}}"#),
        );
        write(dir, "main.js", "bay.commands.on('hi', () => {});");
        write(dir, "lib/util.js", "export {};");
        write(dir, ".git/config", "secret");
    }

    #[test]
    fn a_plugin_is_copied_listed_and_removed() {
        let source = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        plugin(source.path(), "hello");

        let m = install(root.path(), source.path()).unwrap();
        assert_eq!(m.id, "hello");
        assert!(root.path().join("hello/lib/util.js").is_file());
        assert!(
            !root.path().join("hello/.git").exists(),
            "hidden files stay behind"
        );

        let listed = list(root.path());
        assert_eq!(listed["plugins"][0]["id"], "hello");
        assert_eq!(listed["problems"].as_array().unwrap().len(), 0);

        // A second install replaces the first.
        write(source.path(), "main.js", "// new");
        install(root.path(), source.path()).unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("hello/main.js")).unwrap(),
            "// new"
        );
        assert_eq!(
            fs::read_dir(root.path()).unwrap().count(),
            1,
            "no staging folders left"
        );

        assert!(remove(root.path(), "hello"));
        assert!(!root.path().join("hello").exists());
        assert!(!remove(root.path(), "../etc"));
    }

    #[test]
    fn a_folder_that_isnt_its_plugin_is_a_problem() {
        let root = tempfile::tempdir().unwrap();
        plugin(&root.path().join("other"), "hello");
        fs::create_dir_all(root.path().join("empty")).unwrap();

        let listed = list(root.path());
        assert_eq!(listed["plugins"].as_array().unwrap().len(), 0);
        let problems: Vec<_> = listed["problems"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["folder"].as_str().unwrap())
            .collect();
        assert_eq!(problems, vec!["empty", "other"]);
    }

    #[test]
    fn install_refuses_a_missing_script_and_links() {
        let source = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        write(
            source.path(),
            "manifest.json",
            r#"{"manifestVersion":1,"id":"hello","name":"Hi","version":"1"}"#,
        );
        assert!(
            install(root.path(), source.path())
                .unwrap_err()
                .0
                .contains("main.js is missing")
        );

        write(source.path(), "main.js", "");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/hosts", source.path().join("hosts")).unwrap();
            assert!(
                install(root.path(), source.path())
                    .unwrap_err()
                    .0
                    .contains("is a link")
            );
        }
    }

    #[test]
    fn the_sandbox_reads_only_its_own_plain_files() {
        let source = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        plugin(source.path(), "hello");
        install(root.path(), source.path()).unwrap();
        write(root.path(), "secret.txt", "nope");

        let (page, mime) = read(root.path(), "hello", "__bay/host.html").unwrap();
        assert_eq!(mime, "text/html");
        assert!(
            String::from_utf8(page)
                .unwrap()
                .contains(r#"<script src="../main.js"></script>"#)
        );
        assert!(read(root.path(), "hello", "__bay/runtime.js").is_some());

        let (script, mime) = read(root.path(), "hello", "lib/util.js?v=2").unwrap();
        assert_eq!(
            (script.as_slice(), mime),
            (b"export {};".as_slice(), "text/javascript")
        );

        for bad in [
            "../secret.txt",
            "lib/../../secret.txt",
            "manifest.json/..",
            ".git/config",
            "",
            "lib",
        ] {
            assert!(read(root.path(), "hello", bad).is_none(), "{bad}");
        }
        assert!(read(root.path(), "../hello", "main.js").is_none());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                root.path().join("secret.txt"),
                root.path().join("hello/out.txt"),
            )
            .unwrap();
            assert!(read(root.path(), "hello", "out.txt").is_none());
        }
    }

    #[test]
    fn the_host_page_escapes_the_script_path() {
        let m = manifest::check(r#"{"manifestVersion":1,"id":"hello","name":"Hi","version":"1","main":"src/my main.js"}"#).unwrap();
        assert!(host_page(&m).contains(r#"src="../src/my%20main.js""#));
    }
}
