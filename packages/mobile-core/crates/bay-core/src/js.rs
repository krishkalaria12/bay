//! JavaScript's string, number and URL rules, for ports that must give the same answers as the TypeScript they
//! replace (and that the computer still runs): `slice` counts UTF-16 units, `trim` takes the BOM too, numbers print as
//! `Number#toString` prints them, `encodeURIComponent` escapes what it escapes, and `new URL` follows WHATWG, which the
//! `url` crate implements.

use url::Url;

/// `value.slice(0, units)`: at most `units` UTF-16 code units. A pair split by the cut is left out whole, where
/// JavaScript would keep half of it.
pub fn slice(value: &str, units: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for c in value.chars() {
        used += c.len_utf16();
        if used > units {
            break;
        }
        out.push(c);
    }
    out
}

/// JavaScript's `\s`: Unicode's white space and line ends, and the BOM, but not NEL (U+0085).
pub fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// JavaScript's `\s` as a `regex` class item, to put inside brackets: `[{JS_SPACE}]`, `[^<>{JS_SPACE}]`.
pub const JS_SPACE: &str = r"\x{FEFF}[\s--\x{85}]";

/// `value.trim()`.
pub fn trim(value: &str) -> &str {
    value.trim_matches(is_js_space)
}

/// A page address the store keeps: http or https with a host.
pub fn is_web_address(value: &str) -> bool {
    Url::parse(value).ok().is_some_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some_and(|host| !host.is_empty())
    })
}

/// A `file://` address: what the app's saved icons, snapshots and wallpaper photo are.
pub fn is_file_uri(value: &str) -> bool {
    value.starts_with("file://")
}

/// The key icons and site settings are kept under: a URL's host, lowercased, without a "www", "m" or "mobile" label in
/// front of the site's own name, so a site's mobile pages share its settings. Desktop site moves YouTube between
/// m.youtube.com and youtube.com (and Wikipedia between en.m.wikipedia.org and en.wikipedia.org), and two keys there
/// flipped the setting back on every redirect. Mirrors the store's pattern
/// `^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)` (case-insensitive), so odd addresses key the same way.
#[uniffi::export]
pub fn site_host(url: &str) -> String {
    let host = match_host(url).unwrap_or_default().to_lowercase();
    let labels: Vec<&str> = host.split('.').collect();
    // The site's own name and its suffix are the last two labels; only what comes before them can be dropped.
    let named = labels.len().saturating_sub(2);
    labels
        .iter()
        .enumerate()
        .filter(|(index, label)| *index >= named || !matches!(**label, "www" | "m" | "mobile"))
        .map(|(_, label)| *label)
        .collect::<Vec<_>>()
        .join(".")
}

fn match_host(url: &str) -> Option<&str> {
    let mut chars = url.char_indices();
    let (_, first) = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    let scheme_end = url.find("://")?;
    if !url[..scheme_end]
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    {
        return None;
    }
    let rest = &url[scheme_end + 3..];
    let host_at = |from: &str| -> Option<usize> {
        let end = from.find(['/', '?', '#', ':']).unwrap_or(from.len());
        (end > 0).then_some(end)
    };
    // With the user part first, as the pattern tries; without it when that leaves no host.
    if let Some(at) = rest.find('@')
        && !rest[..at].contains(['/', '?', '#'])
    {
        let after = &rest[at + 1..];
        if let Some(end) = host_at(after) {
            return Some(&after[..end]);
        }
    }
    host_at(rest).map(|end| &rest[..end])
}

/// A host as typed or saved, lowercased and without "www.", when it is one a URL would keep exactly.
pub fn normalize_host(value: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    let lower = value.to_lowercase();
    let host = lower.strip_prefix("www.").unwrap_or(&lower);
    let plain = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    let shaped = if let Some(inner) = host
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
    {
        !inner.is_empty()
            && inner
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase() || c == ':')
    } else {
        let mut chars = host.chars();
        let first = chars.next();
        let last = host.chars().last();
        first.is_some_and(plain)
            && last.is_some_and(plain)
            && host.chars().all(|c| plain(c) || c == '.' || c == '-')
    };
    if !shaped {
        return None;
    }
    let parsed = Url::parse(&format!("https://{host}")).ok()?;
    (parsed.host_str() == Some(host)).then(|| host.to_owned())
}

/// A custom search engine's address: https, a host, and `%s` where the words go.
pub fn is_custom_search_url(value: &str) -> bool {
    if !value.contains("%s") {
        return false;
    }
    Url::parse(&value.replace("%s", "q"))
        .ok()
        .is_some_and(|url| {
            url.scheme() == "https"
                && url.host_str().is_some_and(|host| !host.is_empty())
                && url.username().is_empty()
                && url.password().is_none()
        })
}

/// `Math.round`: halves go up.
pub fn round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `Number(x).toString()`.
pub fn number_string(value: f64) -> String {
    ryu_js::Buffer::new().format(value).to_owned()
}

/// `Number(value.toPrecision(digits))`: the value rounded to `digits` significant digits.
pub fn to_precision(value: f64, digits: usize) -> f64 {
    if !value.is_finite() || value == 0.0 {
        return value;
    }
    format!("{:.*e}", digits.saturating_sub(1), value)
        .parse()
        .unwrap_or(value)
}

/// `value.toExponential()`: the fewest digits that read back as the value, as `d.ddde±x`.
pub fn to_exponential(value: f64) -> String {
    let shortest = format!("{value:e}");
    match shortest.split_once('e') {
        Some((mantissa, exponent)) => {
            let sign = if exponent.starts_with('-') { "-" } else { "+" };
            format!("{mantissa}e{sign}{}", exponent.trim_start_matches('-'))
        }
        None => shortest,
    }
}

/// `Math.round`: halves go up (toward +∞), as `round` does.
pub fn math_round(value: f64) -> f64 {
    round(value)
}

/// `encodeURIComponent`: everything but letters, digits and `-_.!~*'()` as UTF-8 percent escapes.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `decodeURIComponent`, or `None` where it throws: a `%` without two hex digits, or bytes that aren't UTF-8.
pub fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The text's length in UTF-16 units, as JavaScript's `length`.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// JavaScript's string order: by UTF-16 code units.
pub fn js_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `Number(text)`: JavaScript's reading of a string as a number. Spaces around it are dropped, an empty string is 0,
/// `0x`/`0o`/`0b` prefixes and `Infinity` are read, and anything else that isn't a decimal literal is NaN.
pub fn string_to_number(text: &str) -> f64 {
    let text = trim(text);
    if text.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        let Some(digits) = text
            .get(..2)
            .filter(|start| start.eq_ignore_ascii_case(prefix))
            .map(|_| &text[2..])
        else {
            continue;
        };
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
            return f64::NAN;
        }
        return digits.chars().fold(0.0, |value, c| {
            value * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
        });
    }
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned == "Infinity" {
        return if text.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    static DECIMAL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$").unwrap()
    });
    if !DECIMAL.is_match(text) {
        return f64::NAN;
    }
    text.parse().unwrap_or(f64::NAN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_as_javascript_prints_them() {
        assert_eq!(number_string(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(number_string(1e21), "1e+21");
        assert_eq!(number_string(100.0), "100");
        assert_eq!(number_string(1.5e-7), "1.5e-7");
        assert_eq!(to_exponential(1.5e21), "1.5e+21");
        assert_eq!(to_exponential(1e-10), "1e-10");
        assert_eq!(to_precision(1.0 / 3.0, 12), 0.333333333333);
    }

    #[test]
    fn uri_components_encode_and_decode_as_javascript_does() {
        assert_eq!(encode_uri_component("a b&c/é!"), "a%20b%26c%2F%C3%A9!");
        assert_eq!(decode_uri_component("a%20b%C3%A9").as_deref(), Some("a bé"));
        assert_eq!(decode_uri_component("%E0%A4%A"), None);
        assert_eq!(decode_uri_component("%C3"), None);
    }

    #[test]
    fn slice_counts_utf16_units() {
        assert_eq!(slice("abcdef", 3), "abc");
        assert_eq!(slice("🏠🏠", 2), "🏠");
        assert_eq!(slice("🏠🏠", 3), "🏠");
    }

    #[test]
    fn site_host_follows_the_pattern() {
        assert_eq!(site_host("https://www.Example.com/a"), "example.com");
        assert_eq!(
            site_host("https://user:pw@news.ycombinator.com:443/x"),
            "news.ycombinator.com"
        );
        assert_eq!(site_host("https://m.youtube.com/shorts"), "youtube.com");
        assert_eq!(site_host("https://mobile.twitter.com"), "twitter.com");
        assert_eq!(site_host("https://m.com"), "m.com");
        assert_eq!(
            site_host("https://en.m.wikipedia.org/wiki/Cat"),
            "en.wikipedia.org"
        );
        assert_eq!(site_host("https://www.m.example.co"), "example.co");
        assert_eq!(site_host("about:blank"), "");
        assert_eq!(site_host("1http://x"), "");
    }

    #[test]
    fn normalize_host_keeps_only_exact_hosts() {
        assert_eq!(
            normalize_host("WWW.Example.com").as_deref(),
            Some("example.com")
        );
        assert_eq!(normalize_host("[::1]").as_deref(), Some("[::1]"));
        assert_eq!(normalize_host("1.2.3"), None);
        assert_eq!(normalize_host("bad_host"), None);
        assert_eq!(normalize_host("-a.com"), None);
    }

    #[test]
    fn custom_search_urls_need_https_and_the_slot() {
        assert!(is_custom_search_url("https://example.com/?q=%s"));
        assert!(!is_custom_search_url("http://example.com/?q=%s"));
        assert!(!is_custom_search_url("https://u:p@example.com/?q=%s"));
        assert!(!is_custom_search_url("https://example.com/"));
    }
}
