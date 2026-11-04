//! Text handling for `$replace` and HTML filtering. The interceptor sees a response after the network service has
//! removed its `Content-Encoding`, but still in its own charset (Blink decodes that later), so a body is decoded,
//! filtered as text and encoded back. A body that can't make that round trip is left alone.

use encoding_rs::Encoding;

/// Filtering a body means holding it in memory: uBO stops at 10 MiB, and so does the engine.
pub const MAX_BODY: usize = 10 * 1024 * 1024;

/// The response's charset: a byte-order mark, its `Content-Type`, then a `charset` in the first 64 KiB of markup, or
/// UTF-8 (uBO's order, with the mark first as a browser decodes). `None` for a label no decoder knows, and for
/// UTF-16, which a browser reads but no encoder writes: filtering either would only corrupt the text.
pub fn charset(content_type: &str, mime: &str, body: &[u8]) -> Option<&'static Encoding> {
    let encoding = if let Some((encoding, _)) = Encoding::for_bom(body) {
        encoding
    } else if let Some(label) = charset_parameter(content_type) {
        Encoding::for_label(label.as_bytes())?
    } else if matches!(
        mime,
        "text/html" | "application/xhtml+xml" | "text/css" | "application/xml"
    ) {
        charset_from_markup(body)
            .and_then(|label| Encoding::for_label(label.as_bytes()))
            .unwrap_or(encoding_rs::UTF_8)
    } else {
        encoding_rs::UTF_8
    };
    (encoding.output_encoding() == encoding).then_some(encoding)
}

fn charset_parameter(content_type: &str) -> Option<String> {
    let lower = content_type.to_ascii_lowercase();
    let at = lower.find("charset")?;
    let rest = &content_type[at + "charset".len()..];
    let rest = rest.trim_start().strip_prefix('=')?.trim_start();
    let value: String = rest
        .trim_start_matches(['\'', '"'])
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
        .collect();
    (!value.is_empty()).then_some(value)
}

/// uBO's `charsetFromStream`: the first `charset=` declaration in the document head, within 64 KiB.
fn charset_from_markup(body: &[u8]) -> Option<String> {
    let head = &body[..body.len().min(64 * 1024)];
    let needle = b"charset";
    let at = head
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle))?;
    let rest = &head[at + needle.len()..];
    let mut at = 0;
    while at < rest.len() && rest[at].is_ascii_whitespace() {
        at += 1;
    }
    if rest.get(at) != Some(&b'=') {
        return None;
    }
    at += 1;
    while at < rest.len() && (rest[at].is_ascii_whitespace() || matches!(rest[at], b'\'' | b'"')) {
        at += 1;
    }
    let value: Vec<u8> = rest[at..]
        .iter()
        .copied()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b':'))
        .collect();
    (!value.is_empty()).then(|| String::from_utf8_lossy(&value).to_ascii_lowercase())
}

/// Encodes filtered text in the charset it was read in.
pub fn encode(text: &str, encoding: &'static Encoding) -> Vec<u8> {
    encoding.encode(text).0.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_charset_from_the_mark_the_header_then_markup() {
        assert_eq!(
            charset("text/html; charset=windows-1252", "text/html", b""),
            Some(encoding_rs::WINDOWS_1252)
        );
        assert_eq!(
            charset(
                "text/html; charset=windows-1252",
                "text/html",
                b"\xef\xbb\xbf"
            ),
            Some(encoding_rs::UTF_8)
        );
        assert_eq!(
            charset("text/html", "text/html", b"<meta charset='iso-8859-2'>"),
            Some(encoding_rs::ISO_8859_2)
        );
        assert_eq!(
            charset("text/plain", "text/plain", b"charset=iso-8859-2"),
            Some(encoding_rs::UTF_8)
        );
        assert_eq!(
            charset("text/html", "text/html", b""),
            Some(encoding_rs::UTF_8)
        );
    }

    #[test]
    fn leaves_what_it_could_not_write_back() {
        assert_eq!(
            charset("text/html; charset=made-up", "text/html", b""),
            None
        );
        assert_eq!(charset("text/html", "text/html", b"\xff\xfea\0"), None);
        assert_eq!(
            charset("text/html; charset=utf-16le", "text/html", b""),
            None
        );
    }

    #[test]
    fn encodes_back_to_the_same_charset() {
        assert_eq!(encode("caf\u{e9}", encoding_rs::WINDOWS_1252), b"caf\xe9");
    }
}
