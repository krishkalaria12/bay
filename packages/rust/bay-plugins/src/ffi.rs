//! C ABI (`include/bay_plugins.h`), linked into both desktop hosts through `bay-desktop`. Strings and files returned
//! to the caller are owned by Rust; release them with `bay_plugins_string_free` and `bay_plugins_file_free`.

use std::ffi::{CStr, CString, c_char};
use std::path::PathBuf;

use serde_json::json;

use crate::files;

/// # Safety
/// `text` must be null or a valid NUL-terminated string.
unsafe fn read<'a>(text: *const c_char) -> Option<&'a str> {
    // SAFETY: the caller passes null or a valid string, which outlives this call.
    (!text.is_null())
        .then(|| unsafe { CStr::from_ptr(text) }.to_str().ok())
        .flatten()
}

fn owned(text: String) -> *mut c_char {
    CString::new(text).map_or(std::ptr::null_mut(), CString::into_raw)
}

/// Every plugin in the plugins folder `root`, as JSON: `{"plugins":[manifest…],"problems":[{"folder","error"}]}`.
///
/// # Safety
/// `root` must be null or a valid NUL-terminated UTF-8 string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_plugins_list(root: *const c_char) -> *mut c_char {
    // SAFETY: as the caller's.
    let root = unsafe { read(root) }.unwrap_or_default();
    owned(
        if root.is_empty() {
            json!({ "plugins": [], "problems": [] })
        } else {
            files::list(&PathBuf::from(root))
        }
        .to_string(),
    )
}

/// Copies the plugin folder `source` into `root`: `{"ok":true,"manifest":{…}}` or `{"ok":false,"error":"…"}`.
///
/// # Safety
/// Each string must be null or a valid NUL-terminated UTF-8 string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_plugins_install(
    root: *const c_char,
    source: *const c_char,
) -> *mut c_char {
    // SAFETY: as the caller's.
    let (root, source) = unsafe { (read(root), read(source)) };
    let result = match (root, source) {
        (Some(root), Some(source)) if !root.is_empty() && !source.is_empty() => {
            match files::install(&PathBuf::from(root), &PathBuf::from(source)) {
                Ok(manifest) => json!({ "ok": true, "manifest": manifest }),
                Err(refusal) => json!({ "ok": false, "error": refusal.0 }),
            }
        }
        _ => json!({ "ok": false, "error": "No folder" }),
    };
    owned(result.to_string())
}

/// Deletes plugin `id` from `root`; true once it's gone.
///
/// # Safety
/// Each string must be null or a valid NUL-terminated UTF-8 string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_plugins_remove(root: *const c_char, id: *const c_char) -> bool {
    // SAFETY: as the caller's.
    match unsafe { (read(root), read(id)) } {
        (Some(root), Some(id)) if !root.is_empty() => files::remove(&PathBuf::from(root), id),
        _ => false,
    }
}

/// A file a sandbox asked for.
#[repr(C)]
pub struct BayPluginFile {
    pub data: *mut u8,
    pub len: usize,
    /// Static: never freed.
    pub mime: *const c_char,
}

/// The file at `path` for plugin `id`'s sandbox (see `files::read`), or null.
///
/// # Safety
/// Each string must be null or a valid NUL-terminated UTF-8 string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_plugins_file(
    root: *const c_char,
    id: *const c_char,
    path: *const c_char,
) -> *mut BayPluginFile {
    // SAFETY: as the caller's.
    let (Some(root), Some(id), Some(path)) = (unsafe { (read(root), read(id), read(path)) }) else {
        return std::ptr::null_mut();
    };
    let Some((bytes, mime)) = files::read(&PathBuf::from(root), id, path.trim_start_matches('/'))
    else {
        return std::ptr::null_mut();
    };
    let mime = match mime {
        "text/javascript" => c"text/javascript",
        "text/html" => c"text/html",
        "text/css" => c"text/css",
        "application/json" => c"application/json",
        "image/png" => c"image/png",
        "image/jpeg" => c"image/jpeg",
        "image/gif" => c"image/gif",
        "image/webp" => c"image/webp",
        "image/svg+xml" => c"image/svg+xml",
        "image/x-icon" => c"image/x-icon",
        "font/woff2" => c"font/woff2",
        "font/woff" => c"font/woff",
        "font/ttf" => c"font/ttf",
        "text/plain" => c"text/plain",
        _ => c"application/octet-stream",
    };
    let data = Box::into_raw(bytes.into_boxed_slice());
    Box::into_raw(Box::new(BayPluginFile {
        len: data.len(),
        data: data.cast(),
        mime: mime.as_ptr(),
    }))
}

/// Releases a file this library returned.
///
/// # Safety
/// `file` must be null or a file from `bay_plugins_file`, not yet released.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_plugins_file_free(file: *mut BayPluginFile) {
    if file.is_null() {
        return;
    }
    // SAFETY: both came from Box::into_raw in bay_plugins_file.
    unsafe {
        let file = Box::from_raw(file);
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            file.data, file.len,
        )));
    }
}

/// The sandbox's content security policy. Static: never freed.
#[unsafe(no_mangle)]
pub extern "C" fn bay_plugins_csp() -> *const c_char {
    static CSP: std::sync::OnceLock<CString> = std::sync::OnceLock::new();
    CSP.get_or_init(|| CString::new(files::CSP).unwrap_or_default())
        .as_ptr()
}

/// Releases a string this library returned.
///
/// # Safety
/// `text` must be null or a string from this library, not yet released.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_plugins_string_free(text: *mut c_char) {
    if !text.is_null() {
        // SAFETY: it came from CString::into_raw above.
        drop(unsafe { CString::from_raw(text) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(result: *mut c_char) -> String {
        // SAFETY: a string from this library, released once.
        let out = unsafe { CStr::from_ptr(result) }
            .to_str()
            .unwrap()
            .to_owned();
        unsafe { bay_plugins_string_free(result) };
        out
    }

    #[test]
    fn install_list_read_and_remove_over_the_c_abi() {
        let source = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            source.path().join("manifest.json"),
            r#"{"manifestVersion":1,"id":"hello","name":"Hi","version":"1"}"#,
        )
        .unwrap();
        std::fs::write(source.path().join("main.js"), "1;").unwrap();
        let c = |p: &std::path::Path| CString::new(p.to_str().unwrap()).unwrap();
        let (root_c, source_c) = (c(root.path()), c(source.path()));

        // SAFETY: valid strings; results are released.
        let installed = text(unsafe { bay_plugins_install(root_c.as_ptr(), source_c.as_ptr()) });
        assert!(
            installed.starts_with(r#"{"manifest":{"#) && installed.ends_with(r#""ok":true}"#),
            "{installed}"
        );
        let listed = text(unsafe { bay_plugins_list(root_c.as_ptr()) });
        assert!(listed.contains(r#""id":"hello""#));

        let id = CString::new("hello").unwrap();
        let path = CString::new("/main.js").unwrap();
        // SAFETY: valid strings; the file is released below.
        let file = unsafe { bay_plugins_file(root_c.as_ptr(), id.as_ptr(), path.as_ptr()) };
        assert!(!file.is_null());
        // SAFETY: a file from the call above.
        unsafe {
            assert_eq!(std::slice::from_raw_parts((*file).data, (*file).len), b"1;");
            assert_eq!(
                CStr::from_ptr((*file).mime).to_str().unwrap(),
                "text/javascript"
            );
            bay_plugins_file_free(file);
        }

        // SAFETY: valid strings.
        assert!(unsafe { bay_plugins_remove(root_c.as_ptr(), id.as_ptr()) });
        // SAFETY: a static string.
        assert!(
            unsafe { CStr::from_ptr(bay_plugins_csp()) }
                .to_str()
                .unwrap()
                .contains("connect-src 'none'")
        );
    }

    #[test]
    fn the_header_declares_these_functions() {
        let header = include_str!("../include/bay_plugins.h");

        for name in [
            "bay_plugins_list(",
            "bay_plugins_install(",
            "bay_plugins_remove(",
            "bay_plugins_file(",
            "bay_plugins_file_free(",
            "bay_plugins_csp(",
            "bay_plugins_string_free(",
        ] {
            assert!(
                header.contains(name),
                "{name} is missing from bay_plugins.h"
            );
        }
    }
}
