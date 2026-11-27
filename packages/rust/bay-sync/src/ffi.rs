//! C ABI (`include/bay_sync.h`), linked into both desktop hosts through `bay-desktop`. Strings returned to the caller
//! are owned by Rust and freed with `bay_sync_string_free`; sealed files with `bay_sync_bytes_free`, and opened
//! payloads, which are secret, with `bay_sync_secret_free`, which wipes them first.

use std::ffi::{CStr, CString, c_char};

use zeroize::Zeroize;

use crate::{
    NONCE, PhraseProblem, SealError, SyncKeys, is_tag, phrase_entropy, phrase_words, random_bytes,
};

pub struct BaySyncKeys(SyncKeys);

/// # Safety
/// `text` must be null or a valid NUL-terminated string.
unsafe fn read(text: *const c_char) -> Option<String> {
    // SAFETY: the caller passes null or a valid string.
    (!text.is_null()).then(|| {
        unsafe { CStr::from_ptr(text) }
            .to_string_lossy()
            .into_owned()
    })
}

fn give(text: String) -> *mut c_char {
    CString::new(text).map_or(std::ptr::null_mut(), CString::into_raw)
}

/// Bytes as `bay_bytes_free` releases them.
///
/// # Safety
/// `length` must be writable.
unsafe fn give_bytes(bytes: Vec<u8>, length: *mut usize) -> *mut u8 {
    let bytes = bytes.into_boxed_slice();
    // SAFETY: the caller passes a writable `length`.
    unsafe { *length = bytes.len() };
    Box::into_raw(bytes).cast()
}

/// # Safety
/// `data` must point to `length` bytes, or be null when `length` is 0.
unsafe fn borrow<'a>(data: *const u8, length: usize) -> &'a [u8] {
    if data.is_null() || length == 0 {
        &[]
    } else {
        // SAFETY: the caller passes `length` readable bytes.
        unsafe { std::slice::from_raw_parts(data, length) }
    }
}

/// # Safety
/// `entropy` must point to 32 bytes.
unsafe fn entropy(entropy: *const u8) -> [u8; 32] {
    // SAFETY: the caller passes 32 readable bytes.
    unsafe { std::slice::from_raw_parts(entropy, 32) }
        .try_into()
        .expect("32 bytes")
}

/// A chain's keys from its 32 random bytes (the recovery phrase's entropy). Null when `entropy` is. Free with
/// `bay_sync_keys_free`.
///
/// # Safety
/// `entropy` must be null or point to 32 bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_sync_keys_new(entropy_bytes: *const u8) -> *mut BaySyncKeys {
    if entropy_bytes.is_null() {
        return std::ptr::null_mut();
    }
    // SAFETY: as the caller's.
    let mut bytes = unsafe { entropy(entropy_bytes) };
    let keys = SyncKeys::new(bytes);
    bytes.zeroize();
    Box::into_raw(Box::new(BaySyncKeys(keys)))
}

/// Wipes and frees the keys.
///
/// # Safety
/// `keys` must be null or come from `bay_sync_keys_new`, and not be used again.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_sync_keys_free(keys: *mut BaySyncKeys) {
    if !keys.is_null() {
        // SAFETY: as the caller's.
        drop(unsafe { Box::from_raw(keys) });
    }
}

/// The chain's folder name.
///
/// # Safety
/// `keys` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_sync_chain_tag(keys: *const BaySyncKeys) -> *mut c_char {
    // SAFETY: as the caller's.
    give(unsafe { &*keys }.0.chain_tag.clone())
}

/// The folder name of `scope` (a profile's or a kind of data's) in the chain.
///
/// # Safety
/// `keys` must be live; `scope` a valid string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_sync_scope_tag(
    keys: *const BaySyncKeys,
    scope: *const c_char,
) -> *mut c_char {
    // SAFETY: as the caller's.
    let scope = unsafe { read(scope) }.unwrap_or_default();
    // SAFETY: as the caller's.
    give(unsafe { &*keys }.0.scope_tag(&scope))
}

/// `payload` sealed as the file `file_id` in the scope tagged `scope_tag`, with a fresh nonce. Free with
/// `bay_sync_bytes_free(file, *length)`.
///
/// # Safety
/// `keys` must be live; `payload` must point to `payload_length` bytes (or be null when it's 0); `scope_tag` and
/// `file_id` valid strings; `length` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_sync_seal(
    keys: *const BaySyncKeys,
    payload: *const u8,
    payload_length: usize,
    scope_tag: *const c_char,
    file_id: *const c_char,
    length: *mut usize,
) -> *mut u8 {
    // SAFETY: as the caller's.
    unsafe {
        bay_sync_seal_with_nonce(
            keys,
            payload,
            payload_length,
            scope_tag,
            file_id,
            std::ptr::null(),
            length,
        )
    }
}

/// `bay_sync_seal` with the given 12-byte nonce, for cross-platform test vectors only; null `nonce` draws one.
///
/// # Safety
/// As `bay_sync_seal`; `nonce` null or pointing to 12 bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_sync_seal_with_nonce(
    keys: *const BaySyncKeys,
    payload: *const u8,
    payload_length: usize,
    scope_tag: *const c_char,
    file_id: *const c_char,
    nonce: *const u8,
    length: *mut usize,
) -> *mut u8 {
    // SAFETY: as the caller's.
    let (keys, payload) = unsafe { (&(*keys).0, borrow(payload, payload_length)) };
    // SAFETY: as the caller's.
    let (scope_tag, file_id) = unsafe {
        (
            read(scope_tag).unwrap_or_default(),
            read(file_id).unwrap_or_default(),
        )
    };
    let nonce: [u8; NONCE] = if nonce.is_null() {
        random_bytes::<NONCE>()
    } else {
        // SAFETY: the caller passes 12 readable bytes.
        unsafe { std::slice::from_raw_parts(nonce, NONCE) }
            .try_into()
            .expect("12 bytes")
    };
    let sealed = keys.seal_with_nonce(payload, &scope_tag, &file_id, &nonce);
    // SAFETY: as the caller's.
    unsafe { give_bytes(sealed, length) }
}

/// Opens the file `file_id` of the scope tagged `scope_tag`: 0 with `*payload` set (free it with
/// `bay_sync_secret_free(*payload, *payload_length)`), 1 when it isn't a sync file, 2 when it doesn't open with these
/// keys (changed, moved, or another chain's).
///
/// # Safety
/// `keys` must be live; `file` must point to `length` bytes (or be null when it's 0); `scope_tag` and `file_id` valid
/// strings; `payload` and `payload_length` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_sync_open(
    keys: *const BaySyncKeys,
    file: *const u8,
    length: usize,
    scope_tag: *const c_char,
    file_id: *const c_char,
    payload: *mut *mut u8,
    payload_length: *mut usize,
) -> i32 {
    // SAFETY: as the caller's.
    let (keys, file) = unsafe { (&(*keys).0, borrow(file, length)) };
    // SAFETY: as the caller's.
    let (scope_tag, file_id) = unsafe {
        (
            read(scope_tag).unwrap_or_default(),
            read(file_id).unwrap_or_default(),
        )
    };
    // SAFETY: the caller passes writable pointers.
    unsafe {
        *payload = std::ptr::null_mut();
        *payload_length = 0;
    }
    match keys.open(file, &scope_tag, &file_id) {
        Ok(opened) => {
            // SAFETY: as above.
            unsafe { *payload = give_bytes(opened, payload_length) };
            0
        }
        Err(SealError::Format) => 1,
        Err(SealError::Authentication) => 2,
    }
}

/// Frees a string this library returned.
///
/// # Safety
/// `text` must be null or come from this library, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_sync_string_free(text: *mut c_char) {
    if !text.is_null() {
        // SAFETY: as the caller's.
        drop(unsafe { CString::from_raw(text) });
    }
}

/// Frees bytes this library returned (a sealed file).
///
/// # Safety
/// `data` and `length` must come from one call of this library, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_sync_bytes_free(data: *mut u8, length: usize) {
    if !data.is_null() {
        // SAFETY: as the caller's: a boxed slice this library gave out.
        drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(data, length)) });
    }
}

/// Wipes and frees secret bytes this library returned (an opened payload).
///
/// # Safety
/// `data` and `length` must come from one call of this library, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_sync_secret_free(data: *mut u8, length: usize) {
    if !data.is_null() {
        // SAFETY: as the caller's: a boxed slice this library gave out.
        let mut bytes = unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(data, length)) };
        bytes.zeroize();
    }
}

/// A new file's name: 16 random bytes in base32.
#[unsafe(no_mangle)]
pub extern "C" fn bay_sync_new_file_id() -> *mut c_char {
    give(SyncKeys::new_file_id())
}

/// A new chain's 32 random bytes, from the operating system.
///
/// # Safety
/// `out` must point to 32 writable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_sync_random_entropy(out: *mut u8) {
    let mut bytes = random_bytes::<32>();
    // SAFETY: the caller passes 32 writable bytes.
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, 32) };
    bytes.zeroize();
}

/// Whether `name` is a tag: 16 bytes in base32, as every chain, scope and file name is.
///
/// # Safety
/// `name` must be null or a valid string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_sync_is_tag(name: *const c_char) -> bool {
    // SAFETY: as the caller's.
    unsafe { read(name) }.is_some_and(|name| is_tag(&name))
}

/// The 24 words of the recovery phrase for a chain's 32 bytes, separated by single spaces.
///
/// # Safety
/// `entropy` must point to 32 bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_sync_phrase_words(entropy_bytes: *const u8) -> *mut c_char {
    // SAFETY: as the caller's.
    let mut bytes = unsafe { entropy(entropy_bytes) };
    let words = phrase_words(&bytes).join(" ");
    bytes.zeroize();
    give(words)
}

/// The recovery phrase's QR code for a chain's 32 bytes: `*side` modules a row, `side * side` bytes, 1 for dark. Free
/// with `bay_sync_secret_free(modules, side * side)` (the phrase is in it).
///
/// # Safety
/// `entropy` must point to 32 bytes and `side` be writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_sync_phrase_qr(entropy_bytes: *const u8, side: *mut usize) -> *mut u8 {
    // SAFETY: as the caller's.
    let mut bytes = unsafe { entropy(entropy_bytes) };
    let (size, modules) = crate::phrase_qr(&bytes);
    bytes.zeroize();
    // SAFETY: as the caller's.
    unsafe { *side = size };
    let mut length = 0;
    // SAFETY: `length` is ours; the copy goes to the caller, the original is wiped as it drops.
    unsafe { give_bytes(modules.to_vec(), &mut length) }
}

/// The chain's 32 bytes a typed recovery phrase holds (any case and separators; a word by its first four letters or
/// more): 0 with `out` filled; 1 for the wrong number of words (`*detail` the count); 2 for a word that isn't one
/// (`*detail` the word); 3 when the checksum fails. `*detail` is null or freed with `bay_sync_string_free`.
///
/// # Safety
/// `text` must be a valid string; `out` must point to 32 writable bytes; `detail` writable or null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bay_sync_phrase_entropy(
    text: *const c_char,
    out: *mut u8,
    detail: *mut *mut c_char,
) -> i32 {
    let set_detail = |text: Option<String>| {
        if !detail.is_null() {
            // SAFETY: the caller passes a writable `detail`.
            unsafe { *detail = text.map_or(std::ptr::null_mut(), give) };
        }
    };
    // SAFETY: as the caller's.
    let text = unsafe { read(text) }.unwrap_or_default();
    match phrase_entropy(&text) {
        Ok(mut entropy) => {
            // SAFETY: the caller passes 32 writable bytes.
            unsafe { std::ptr::copy_nonoverlapping(entropy.as_ptr(), out, 32) };
            entropy.zeroize();
            set_detail(None);
            0
        }
        Err(PhraseProblem::WordCount { count }) => {
            set_detail(Some(count.to_string()));
            1
        }
        Err(PhraseProblem::UnknownWord { word }) => {
            set_detail(Some(word));
            2
        }
        Err(PhraseProblem::Checksum) => {
            set_detail(None);
            3
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    use super::{bay_sync_bytes_free as bay_bytes_free, bay_sync_string_free as bay_string_free};

    fn golden() -> Value {
        serde_json::from_str(include_str!("../../../sync/fixtures/golden.json")).unwrap()
    }

    fn take(raw: *mut c_char) -> String {
        assert!(!raw.is_null());
        // SAFETY: a string this library returned, freed once.
        let text = unsafe { CStr::from_ptr(raw) }
            .to_string_lossy()
            .into_owned();
        // SAFETY: as above.
        unsafe { bay_string_free(raw) };
        text
    }

    #[test]
    fn a_host_seals_and_opens_the_golden_file_through_the_c_functions() {
        let golden = golden();
        let entropy = hex::decode(golden["entropy"].as_str().unwrap()).unwrap();
        let nonce = hex::decode(golden["nonce"].as_str().unwrap()).unwrap();
        let payload = golden["payload"].as_str().unwrap().as_bytes();
        let scope = CString::new(golden["scope"].as_str().unwrap()).unwrap();
        let file_id = CString::new(golden["fileId"].as_str().unwrap()).unwrap();
        // SAFETY: every pointer is a live buffer or CString this test owns.
        unsafe {
            let keys = bay_sync_keys_new(entropy.as_ptr());
            assert_eq!(
                take(bay_sync_chain_tag(keys)),
                golden["chainTag"].as_str().unwrap()
            );
            let scope_tag = take(bay_sync_scope_tag(keys, scope.as_ptr()));
            assert_eq!(scope_tag, golden["scopeTag"].as_str().unwrap());
            let scope_tag = CString::new(scope_tag).unwrap();

            let mut length = 0;
            let sealed = bay_sync_seal_with_nonce(
                keys,
                payload.as_ptr(),
                payload.len(),
                scope_tag.as_ptr(),
                file_id.as_ptr(),
                nonce.as_ptr(),
                &mut length,
            );
            assert_eq!(
                std::slice::from_raw_parts(sealed, length),
                hex::decode(golden["sealed"].as_str().unwrap()).unwrap()
            );

            let (mut opened, mut opened_length) = (std::ptr::null_mut(), 0);
            let status = bay_sync_open(
                keys,
                sealed,
                length,
                scope_tag.as_ptr(),
                file_id.as_ptr(),
                &mut opened,
                &mut opened_length,
            );
            assert_eq!(status, 0);
            assert_eq!(std::slice::from_raw_parts(opened, opened_length), payload);
            bay_sync_secret_free(opened, opened_length);

            let other = CString::new("zzzzzzzzzzzzzzzzzzzzzzzzzz").unwrap();
            let status = bay_sync_open(
                keys,
                sealed,
                length,
                scope_tag.as_ptr(),
                other.as_ptr(),
                &mut opened,
                &mut opened_length,
            );
            assert_eq!((status, opened.is_null()), (2, true));
            assert_eq!(
                bay_sync_open(
                    keys,
                    b"NNS0".as_ptr(),
                    4,
                    scope_tag.as_ptr(),
                    file_id.as_ptr(),
                    &mut opened,
                    &mut opened_length
                ),
                1
            );
            bay_bytes_free(sealed, length);

            let mut length = 0;
            let fresh = bay_sync_seal(
                keys,
                b"hi".as_ptr(),
                2,
                scope_tag.as_ptr(),
                file_id.as_ptr(),
                &mut length,
            );
            assert_eq!(length, 4 + 12 + 1024 + 16);
            bay_bytes_free(fresh, length);
            bay_sync_keys_free(keys);
        }
    }

    #[test]
    fn a_host_reads_and_writes_recovery_phrases_through_the_c_functions() {
        let entropy = hex::decode(golden()["entropy"].as_str().unwrap()).unwrap();
        // SAFETY: every pointer is a live buffer or CString this test owns.
        unsafe {
            let words = take(bay_sync_phrase_words(entropy.as_ptr()));
            assert_eq!(words.split(' ').count(), 24);
            let mut out = [0u8; 32];
            let mut detail = std::ptr::null_mut();
            let typed = CString::new(words.to_uppercase().replace(' ', ",  ")).unwrap();
            assert_eq!(
                bay_sync_phrase_entropy(typed.as_ptr(), out.as_mut_ptr(), &mut detail),
                0
            );
            assert_eq!((out.to_vec(), detail.is_null()), (entropy.clone(), true));

            let short =
                CString::new(words.split(' ').skip(1).collect::<Vec<_>>().join(" ")).unwrap();
            assert_eq!(
                bay_sync_phrase_entropy(short.as_ptr(), out.as_mut_ptr(), &mut detail),
                1
            );
            assert_eq!(take(detail), "23");
            let mut unknown: Vec<&str> = words.split(' ').take(23).collect();
            unknown.push("zzzz");
            let unknown = CString::new(unknown.join(" ")).unwrap();
            assert_eq!(
                bay_sync_phrase_entropy(unknown.as_ptr(), out.as_mut_ptr(), &mut detail),
                2
            );
            assert_eq!(take(detail), "zzzz");

            let id = take(bay_sync_new_file_id());
            assert!(bay_sync_is_tag(CString::new(id).unwrap().as_ptr()));
            assert!(!bay_sync_is_tag(
                CString::new("not-a-tag").unwrap().as_ptr()
            ));
            let (mut a, mut b) = ([0u8; 32], [0u8; 32]);
            bay_sync_random_entropy(a.as_mut_ptr());
            bay_sync_random_entropy(b.as_mut_ptr());
            assert_ne!(a, b);
        }
    }

    /// The `bay_sync_*` functions declared or defined in `text`: names followed by `(` on lines that aren't comments,
    /// after `prefix` when one is given.
    fn functions(text: &str, prefix: &str) -> std::collections::BTreeSet<String> {
        let mut names = std::collections::BTreeSet::new();
        for line in text
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
        {
            let Some(at) = line.find(&format!("{prefix}bay_sync_")) else {
                continue;
            };
            let rest = &line[at + prefix.len()..];
            let name: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if rest[name.len()..].starts_with('(') {
                names.insert(name);
            }
        }
        names
    }

    /// Every C function here is declared in the header the hosts include, and the header declares nothing else.
    #[test]
    fn the_header_declares_exactly_these_functions() {
        let defined = functions(include_str!("ffi.rs"), "extern \"C\" fn ");
        let declared = functions(include_str!("../include/bay_sync.h"), "");
        assert_eq!(defined.len(), 16);
        assert_eq!(declared, defined);
    }
}
