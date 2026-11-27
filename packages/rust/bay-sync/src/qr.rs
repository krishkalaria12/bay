//! The recovery kit's QR code: the phrase, at medium error correction. Rust gives the modules; each host draws them
//! (Core Graphics on macOS, its own PNG and PDF writer on Windows and Linux).

use qrcodegen::{QrCode, QrCodeEcc};
use zeroize::Zeroizing;

use crate::phrase::phrase_words;

/// The QR code of a chain's recovery phrase: its side in modules and each module, row by row, 1 for dark. The phrase
/// is in it, so the modules are wiped when they go.
pub fn phrase_qr(entropy: &[u8; 32]) -> (usize, Zeroizing<Vec<u8>>) {
    let words = Zeroizing::new(phrase_words(entropy).join(" "));
    let code = QrCode::encode_text(&words, QrCodeEcc::Medium).expect("24 words fit in a QR code");
    let side = code.size() as usize;
    let mut modules = Zeroizing::new(Vec::with_capacity(side * side));
    for y in 0..code.size() {
        for x in 0..code.size() {
            modules.push(u8::from(code.get_module(x, y)));
        }
    }
    (side, modules)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_phrase_fits_a_version_6_code() {
        let (side, modules) = phrase_qr(&[7; 32]);
        // 24 words of up to 8 letters, at medium correction.
        assert!((37..=53).contains(&side), "{side}");
        assert_eq!(modules.len(), side * side);
        // The finder pattern's corner.
        assert_eq!(&modules[..7], &[1; 7]);
        assert_ne!(phrase_qr(&[8; 32]).1, modules);
    }
}
