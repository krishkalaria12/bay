//! Hosts, as the blocker compares them.

/// The lowercased host of a URL, an origin or a bare host; empty when it has none. Credentials and the port are
/// dropped; an IPv6 literal keeps its brackets.
pub fn host_of(url: &str) -> String {
    let start = url.find("://").map_or(0, |at| at + 3);
    let rest = &url[start..];
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let mut authority = &rest[..end];
    if let Some(at) = authority.rfind('@') {
        authority = &authority[at + 1..];
    }
    let host = if authority.starts_with('[') {
        authority
            .find(']')
            .map_or(authority, |close| &authority[..=close])
    } else {
        authority.split(':').next().unwrap_or_default()
    };
    host.to_ascii_lowercase()
}

/// Whether an entry for `allowed` applies to `host`: the same host, or a subdomain of it.
pub fn covers(allowed: &str, host: &str) -> bool {
    if allowed.is_empty() || host.is_empty() {
        return false;
    }
    host == allowed
        || (host.len() > allowed.len()
            && host.ends_with(allowed)
            && host.as_bytes()[host.len() - allowed.len() - 1] == b'.')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_come_from_urls_origins_and_bare_names() {
        assert_eq!(
            host_of("https://WWW.Example.com/path?q#f"),
            "www.example.com"
        );
        assert_eq!(host_of("https://user:pw@example.com:8443/"), "example.com");
        assert_eq!(host_of("http://[::1]:8080/x"), "[::1]");
        assert_eq!(host_of("example.com"), "example.com");
        assert_eq!(host_of("example.com:80"), "example.com");
        assert_eq!(host_of("about:blank"), "about");
        assert_eq!(host_of(""), "");
    }

    #[test]
    fn an_entry_covers_its_host_and_subdomains_only() {
        assert!(covers("example.com", "example.com"));
        assert!(covers("example.com", "www.example.com"));
        assert!(!covers("example.com", "badexample.com"));
        assert!(!covers("www.example.com", "example.com"));
        assert!(!covers("", "example.com"));
        assert!(!covers("example.com", ""));
    }
}
