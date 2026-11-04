//! uBO network rules adblock-rust's parser rejects outright, a whole rule for one option it doesn't know, rewritten to
//! ones it takes. This runs after the `!#if` preprocessor and before the engines are built:
//!
//! - `$popup` rules go to a separate list ([`Adapted::popups`]) as `$document` rules, for the engine asked about pages
//!   a page opens. Any other types the rule has stay in the main list (`$doc,popup` is both).
//! - `$denyallow=a|b` becomes the rule without it, plus an exception for each host. An exception also lifts other
//!   rules for those hosts in the same context, a little more than uBO does.
//! - `$reason=` only words uBO's block page, so it goes. `$strict3p` becomes `$3p`, which covers fewer requests.
//! - `$csp` rejects a type option, and a `$csp` rule only applies to documents, so `$doc` goes.
//! - `$popunder` appears only on exceptions, and popunders aren't blocked: those rules go.
//!
//! [`block_documents_of_hostname_rules`] is uBO's strict blocking, for an engine that asks about pages being visited.

use crate::removeparam::is_type_option;

#[derive(Default)]
pub struct Adapted {
    /// The list for the main engine.
    pub main: String,
    /// `$popup` rules as `$document` rules, for the popup engine.
    pub popups: String,
}

pub fn adapt(list: &str) -> Adapted {
    let mut adapted = Adapted {
        main: String::with_capacity(list.len()),
        popups: String::new(),
    };
    for line in list.lines() {
        if matches!(adapt_line(line.trim_end(), &mut adapted), Line::Unchanged) {
            adapted.main.push_str(line);
            adapted.main.push('\n');
        }
    }
    adapted
}

/// A rule that's only a hostname (`||host^`) also stops a visit to the host, as in uBO. adblock-rust otherwise applies it
/// to everything a page requests, but not to the page itself. `$all` covers both.
pub fn block_documents_of_hostname_rules(list: &str) -> String {
    let mut rules = String::with_capacity(list.len());
    for line in list.lines() {
        rules.push_str(line);
        if is_hostname_rule(line.trim_end()) {
            rules.push_str("$all");
        }
        rules.push('\n');
    }
    rules
}

fn is_hostname_rule(line: &str) -> bool {
    line.strip_prefix("||")
        .and_then(|rule| rule.strip_suffix('^'))
        .is_some_and(|host| {
            host.contains('.')
                && host
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
        })
}

enum Line {
    Rewritten,
    Unchanged,
}

fn adapt_line(line: &str, adapted: &mut Adapted) -> Line {
    const WORTH_PARSING: &[&str] = &[
        "popup",
        "popunder",
        "denyallow=",
        "reason=",
        "strict3p",
        "csp=",
    ];
    if !WORTH_PARSING.iter().any(|word| line.contains(word)) || is_not_network_rule(line) {
        return Line::Unchanged;
    }
    let Some((pattern, options)) = split_rule(line) else {
        return Line::Unchanged;
    };
    let mut kept: Vec<&str> = Vec::with_capacity(options.len());
    let (mut popup, mut popunder, mut changed) = (false, false, false);
    let mut denyallow = None;
    let has_csp = options.iter().any(|option| option.starts_with("csp="));
    for &option in &options {
        match option {
            "popup" => popup = true,
            "~popup" => {}
            "popunder" | "~popunder" => popunder = true,
            "strict3p" => {
                if !options.contains(&"3p") && !options.contains(&"third-party") {
                    kept.push("3p");
                }
            }
            "doc" | "document" if has_csp => {}
            _ if option.starts_with("reason=") => {}
            _ if option.starts_with("denyallow=") => {
                denyallow = Some(&option["denyallow=".len()..])
            }
            _ => {
                kept.push(option);
                continue;
            }
        }
        changed = true;
    }
    if !changed {
        return Line::Unchanged;
    }
    if popunder {
        return Line::Rewritten;
    }
    if popup {
        let context: Vec<&str> = kept
            .iter()
            .copied()
            .filter(|option| !is_type_option(option))
            .collect();
        push_rule(&mut adapted.popups, pattern, &["document"], &context);
        // Popups only: nothing for the main engine.
        if !kept.iter().any(|option| is_type_option(option)) {
            return Line::Rewritten;
        }
    }
    if let Some(hosts) = denyallow {
        // A host pattern this can't turn into an exception: the rule stays as it was, which the parser rejects.
        if hosts.contains(['*', '~', '/']) {
            return Line::Unchanged;
        }
        let context: Vec<&str> = kept
            .iter()
            .copied()
            .filter(|option| *option != "important")
            .collect();
        for host in hosts.split('|').filter(|host| !host.is_empty()) {
            let exception = format!("@@||{host}^");
            push_rule(&mut adapted.main, &exception, &[], &context);
        }
    }
    push_rule(&mut adapted.main, pattern, &[], &kept);
    Line::Rewritten
}

fn push_rule(list: &mut String, pattern: &str, first: &[&str], options: &[&str]) {
    list.push_str(pattern);
    let mut separator = '$';
    for option in first.iter().chain(options) {
        list.push(separator);
        list.push_str(option);
        separator = ',';
    }
    list.push('\n');
}

pub(crate) fn is_not_network_rule(line: &str) -> bool {
    line.starts_with('!')
        || line.starts_with('[')
        || ["##", "#@#", "#?#", "#$#", "#%#"]
            .iter()
            .any(|marker| line.contains(marker))
}

/// The pattern and options of a network rule: at the last `$` whose rest reads as options, since a `$` can also be
/// inside a pattern's regular expression or an option's value. Commas inside a `/regex/` value don't split.
pub(crate) fn split_rule(line: &str) -> Option<(&str, Vec<&str>)> {
    let mut end = line.len();
    while let Some(at) = line[..end].rfind('$') {
        let options = split_options(&line[at + 1..]);
        if options.iter().all(|option| reads_as_option(option)) {
            return Some((&line[..at], options));
        }
        end = at;
    }
    None
}

fn split_options(text: &str) -> Vec<&str> {
    let (mut options, mut start, mut in_regex) = (Vec::new(), 0, false);
    let bytes = text.as_bytes();
    for (at, &byte) in bytes.iter().enumerate() {
        match byte {
            b'/' if in_regex || (at > 0 && bytes[at - 1] == b'=') => {
                // A regex ends at a `/` before a comma or the end.
                if !in_regex || bytes.get(at + 1).is_none_or(|next| *next == b',') {
                    in_regex = !in_regex;
                }
            }
            b',' if !in_regex => {
                options.push(text[start..at].trim());
                start = at + 1;
            }
            _ => {}
        }
    }
    options.push(text[start..].trim());
    options
}

fn reads_as_option(option: &str) -> bool {
    let name = option
        .split('=')
        .next()
        .unwrap_or("")
        .trim_start_matches('~');
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn main(line: &str) -> String {
        adapt(line).main
    }

    #[test]
    fn leaves_other_rules_alone() {
        let list = "! a comment with popup\n||ads.example^$script\nexample.com##.popup\nexample.com##+js(reason=)\n/a$b/\n";
        let adapted = adapt(list);
        assert_eq!(adapted.main, list);
        assert!(adapted.popups.is_empty());
    }

    #[test]
    fn moves_popup_rules_to_their_own_list() {
        let adapted = adapt("||ad.example^$popup\n/apop/*$doc,popup\n@@||ok.example^$popup,domain=a.example\n||b.example^$popup,3p\n");
        assert_eq!(
            adapted.popups,
            "||ad.example^$document\n/apop/*$document\n@@||ok.example^$document,domain=a.example\n||b.example^$document,3p\n"
        );
        assert_eq!(adapted.main, "/apop/*$doc\n");
    }

    #[test]
    fn turns_denyallow_into_exceptions() {
        assert_eq!(
            main("*$script,3p,denyallow=a.example|b.example,domain=site.example\n"),
            "@@||a.example^$script,3p,domain=site.example\n@@||b.example^$script,3p,domain=site.example\n\
             *$script,3p,domain=site.example\n"
        );
    }

    #[test]
    fn drops_what_the_parser_would_reject_the_rule_for() {
        assert_eq!(
            main("||bad.example^$doc,reason=malicious\n"),
            "||bad.example^$doc\n"
        );
        assert_eq!(main("/a/$script,3p,strict3p\n"), "/a/$script,3p\n");
        assert_eq!(main("/a/$script,strict3p\n"), "/a/$script,3p\n");
        assert_eq!(
            main("||gg.example/r/$doc,csp=script-src 'none'\n"),
            "||gg.example/r/$csp=script-src 'none'\n"
        );
        assert_eq!(main("@@||a.example^$popunder,domain=b.example\n"), "");
    }

    #[test]
    fn hostname_rules_also_block_documents() {
        assert_eq!(
            block_documents_of_hostname_rules(
                "||ads.example^\n||ads.example/path^\n||ads.example^$script\n@@||ok.example^\n||tld^\n##.ad\n"
            ),
            "||ads.example^$all\n||ads.example/path^\n||ads.example^$script\n@@||ok.example^\n||tld^\n##.ad\n"
        );
    }

    #[test]
    fn finds_options_past_a_dollar_in_a_regex() {
        let (pattern, options) =
            split_rule("/^https:.*$/$script,reason=a,domain=b.example").unwrap();
        assert_eq!(pattern, "/^https:.*$/");
        assert_eq!(options, ["script", "reason=a", "domain=b.example"]);
        assert!(split_rule("/^https:.*$/").is_none());
        assert_eq!(
            split_options("removeparam=/a,b/,doc"),
            ["removeparam=/a,b/", "doc"]
        );
    }
}
