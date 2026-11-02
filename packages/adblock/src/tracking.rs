use std::collections::HashSet;

use serde::Deserialize;

/// Tracking parameters to strip from navigations. The table comes from `@bay/core` (`TRACKING_PARAMS`), so desktop
/// and both mobile engines strip the same parameters; [`TrackingParams::clean`] mirrors its `cleanUrl`.
#[derive(Debug, Default, Deserialize)]
pub struct TrackingParams {
    global: HashSet<String>,
    prefixes: Vec<String>,
    sites: Vec<SiteParams>,
}

#[derive(Debug, Deserialize)]
struct SiteParams {
    hosts: Vec<String>,
    params: Vec<String>,
    #[serde(default)]
    prefixes: Vec<String>,
}

impl TrackingParams {
    pub fn from_json(json: &str) -> Option<Self> {
        serde_json::from_str(json).ok()
    }

    /// The URL without tracking parameters, or `None` when nothing was removed.
    pub fn clean(&self, url: &str) -> Option<String> {
        let query_start = url
            .find(['?', '#'])
            .filter(|&index| url[index..].starts_with('?'))?;
        let hostname = web_hostname(url)?;
        let (base, rest) = url.split_at(query_start);
        let (query, hash) = rest
            .find('#')
            .map_or((rest, ""), |index| rest.split_at(index));
        let pairs: Vec<&str> = query[1..].split('&').collect();
        let kept: Vec<&str> = pairs
            .iter()
            .copied()
            .filter(|pair| {
                !pair.is_empty()
                    && !self.is_tracking(
                        &decode_name(pair.split('=').next().unwrap_or("")),
                        &hostname,
                    )
            })
            .collect();
        if kept.len() == pairs.len() {
            return None;
        }
        let query = if kept.is_empty() {
            String::new()
        } else {
            format!("?{}", kept.join("&"))
        };
        Some(format!("{base}{query}{hash}"))
    }

    fn is_tracking(&self, name: &str, hostname: &str) -> bool {
        if self.global.contains(name)
            || self
                .prefixes
                .iter()
                .any(|prefix| name.starts_with(prefix.as_str()))
        {
            return true;
        }
        let host = hostname.strip_prefix("www.").unwrap_or(hostname);
        self.sites
            .iter()
            .filter(|site| {
                site.hosts
                    .iter()
                    .any(|h| host == h || host.ends_with(&format!(".{h}")))
            })
            .any(|site| {
                site.params.iter().any(|p| p == name)
                    || site.prefixes.iter().any(|p| name.starts_with(p.as_str()))
            })
    }
}

/// The lowercase hostname of an HTTP(S) URL.
fn web_hostname(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?;
    let host = if host.starts_with('[') {
        host.split(']').next().map(|h| format!("{h}]"))?
    } else {
        host.split(':').next()?.to_owned()
    };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// `decodeURIComponent` of a parameter name, with `+` as a space, lowercased; the raw name if it isn't valid.
fn decode_name(raw: &str) -> String {
    let bytes = raw.replace('+', " ").into_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes
                .get(index + 1..index + 3)
                .and_then(|h| std::str::from_utf8(h).ok())
                .and_then(|h| u8::from_str_radix(h, 16).ok());
            match hex {
                Some(byte) => {
                    decoded.push(byte);
                    index += 3;
                    continue;
                }
                None => return raw.to_lowercase(),
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).map_or_else(|_| raw.to_lowercase(), |name| name.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> TrackingParams {
        TrackingParams::from_json(
            r#"{"global":["gclid","fbclid"],"prefixes":["utm_"],"sites":[{"hosts":["youtube.com"],"params":["si"]}]}"#,
        )
        .unwrap()
    }

    #[test]
    fn strips_global_prefixed_and_site_parameters() {
        let p = params();
        assert_eq!(
            p.clean("https://a.com/x?utm_source=n&id=4&gclid=9#top")
                .as_deref(),
            Some("https://a.com/x?id=4#top")
        );
        assert_eq!(
            p.clean("https://www.youtube.com/watch?v=1&si=abc")
                .as_deref(),
            Some("https://www.youtube.com/watch?v=1")
        );
        assert_eq!(
            p.clean("https://a.com/?fbclid=1").as_deref(),
            Some("https://a.com/")
        );
        assert_eq!(
            p.clean("https://a.com/?UTM%5FSOURCE=1&q=2").as_deref(),
            Some("https://a.com/?q=2")
        );
    }

    #[test]
    fn leaves_clean_and_non_web_urls_alone() {
        let p = params();
        assert_eq!(p.clean("https://a.com/x?id=4"), None);
        assert_eq!(p.clean("https://a.com/#utm_source=1"), None);
        assert_eq!(p.clean("https://other.com/?si=1"), None);
        assert_eq!(p.clean("mailto:a@b.c?utm_source=1"), None);
    }
}
