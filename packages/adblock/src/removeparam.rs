//! uBO's `$removeparam` exceptions (`@@||web.archive.org/*/http$removeparam`, `@@…$xhr,removeparam=s_cid`), which
//! adblock-rust's parser drops ("removeparam with exception"), so its rewrites would ignore them. Each becomes a plain
//! rule (the same pattern and options, without `removeparam`) for a second engine: a request one matches keeps all its
//! parameters. That keeps more than uBO when an exception names one parameter, never less.
//!
//! A plain rule without a type option matches every type but `document`, where `$removeparam` mostly applies: such an
//! exception is also added with `document`.

/// adblock-rust's request type options (and uBO's aliases), negated or not.
const TYPES: &[&str] = &[
    "document",
    "doc",
    "subdocument",
    "frame",
    "script",
    "image",
    "stylesheet",
    "css",
    "object",
    "xmlhttprequest",
    "xhr",
    "ping",
    "beacon",
    "websocket",
    "media",
    "font",
    "other",
    "popup",
    "object-subrequest",
    "webrtc",
];

/// The list's `$removeparam` exceptions as plain rules, one per line.
pub fn exceptions(list: &str) -> String {
    let mut rules = String::new();
    for line in list.lines() {
        let Some(rule) = line.trim().strip_prefix("@@") else {
            continue;
        };
        let Some(at) = rule.rfind('$') else {
            continue;
        };
        let (pattern, options) = (&rule[..at], &rule[at + 1..]);
        let mut found = false;
        let mut kept = Vec::new();
        for option in options.split(',').map(str::trim) {
            if option == "removeparam" || option.starts_with("removeparam=") {
                found = true;
            } else if !option.is_empty() {
                kept.push(option);
            }
        }
        // Without a pattern or an option left, the rule would match every request.
        if !found || (pattern.is_empty() && kept.is_empty()) {
            continue;
        }
        let typed = kept
            .iter()
            .any(|option| TYPES.contains(&option.trim_start_matches('~')));
        let mut push = |options: &[&str]| {
            rules.push_str(pattern);
            if !options.is_empty() {
                rules.push('$');
                rules.push_str(&options.join(","));
            }
            rules.push('\n');
        };
        push(&kept);
        if !typed {
            kept.push("document");
            push(&kept);
        }
    }
    rules
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_each_exception_without_its_removeparam_option() {
        let list = "! comment\n@@||web.archive.org/*/http$removeparam\n\
                    @@||che168.com^$xhr,removeparam=s_cid\n||ads.example^\n$removeparam=fbclid\n\
                    @@$removeparam\n@@||other.example^$script\n";
        assert_eq!(
            exceptions(list),
            "||web.archive.org/*/http\n||web.archive.org/*/http$document\n||che168.com^$xhr\n"
        );
    }
}
