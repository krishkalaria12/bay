//! uBO's HTML filtering (`##^selector`): remove matching elements from a response before the renderer parses it.
//!
//! The selector language is CSS plus uBO's procedural operators. Only the operators the lists use are evaluated:
//! `:has-text()`, `:upward()`/`:nth-ancestor()`, `:has()`, `:not()`, `:content()` and `:min-text-length()`. Native
//! `:is()`, `:not()` and `:has()` stay in the CSS selector itself (the `selectors` crate implements them). A rule with
//! an operator we can't evaluate is skipped rather than applied with a different meaning.

use std::collections::{HashMap, HashSet};

use ego_tree::NodeId;
use scraper::{ElementRef, Html, Selector};

use crate::modifiers::{domain_list_matches, entity_stem, Pattern};

/// One `domains##^selector` line. `exception` is `domains#@#^selector`.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlSpec {
    pub domains: Vec<String>,
    pub selector: String,
    pub exception: bool,
}

impl HtmlSpec {
    pub fn parse(line: &str) -> Option<Self> {
        let (exception, domains, selector) =
            if let Some((domains, selector)) = line.split_once("#@#^") {
                (true, domains, selector)
            } else {
                let (domains, selector) = line.split_once("##^")?;
                (false, domains, selector)
            };
        let selector = selector.trim();
        // `responseheader(...)` is a header rule, not a selector, and uBO only allows a block rule on a site.
        if selector.is_empty() || selector.starts_with("responseheader(") {
            return None;
        }
        // A regex in place of a hostname list: its commas aren't separators, nor its case folded.
        let domains: Vec<String> = if host_regex(domains).is_some() {
            vec![domains.to_owned()]
        } else {
            domains
                .split(',')
                .map(|domain| domain.trim().to_ascii_lowercase())
                .filter(|domain| !domain.is_empty())
                .collect()
        };
        if !exception && domains.is_empty() {
            return None;
        }
        Some(Self {
            domains,
            selector: selector.to_owned(),
            exception,
        })
    }
}

/// What a hostname with a wildcard or a path holds: it can't be looked up by label.
const NOT_INDEXABLE: [char; 3] = ['*', '?', '/'];

/// `/regex/` in place of a hostname list.
fn host_regex(domains: &str) -> Option<&str> {
    domains.strip_prefix('/')?.strip_suffix('/')
}

/// The HTML rules, by what they name: every HTML response asks which apply, and there are hundreds.
pub struct HtmlRules {
    rules: Vec<HtmlSpec>,
    hosts: HashMap<String, Vec<usize>>,
    entities: HashMap<String, Vec<usize>>,
    regexes: Vec<(usize, Pattern)>,
    /// Rules without a plain host or entity to index by: wildcards, and exceptions that apply everywhere.
    others: Vec<usize>,
}

impl HtmlRules {
    pub fn new(rules: Vec<HtmlSpec>) -> Self {
        let mut index = Self {
            rules: Vec::new(),
            hosts: HashMap::new(),
            entities: HashMap::new(),
            regexes: Vec::new(),
            others: Vec::new(),
        };
        for (at, rule) in rules.iter().enumerate() {
            let mut indexed = false;
            for domain in rule
                .domains
                .iter()
                .filter(|domain| !domain.starts_with('~'))
            {
                if let Some(pattern) = host_regex(domain) {
                    if let Some(pattern) = Pattern::new(pattern, "") {
                        index.regexes.push((at, pattern));
                    }
                } else if let Some(entity) = domain
                    .strip_suffix(".*")
                    .filter(|entity| !entity.contains(NOT_INDEXABLE))
                {
                    index
                        .entities
                        .entry(entity.to_owned())
                        .or_default()
                        .push(at);
                } else if domain.contains(NOT_INDEXABLE) {
                    index.others.push(at);
                } else {
                    index.hosts.entry(domain.clone()).or_default().push(at);
                }
                indexed = true;
            }
            if !indexed {
                index.others.push(at);
            }
        }
        index.rules = rules;
        index
    }

    pub fn is_empty(&self) -> bool {
        self.rules.iter().all(|rule| rule.exception)
    }

    /// The rules that apply on `host`, exceptions included.
    pub fn for_host(&self, host: &str) -> Vec<&HtmlSpec> {
        let mut found: Vec<usize> = Vec::new();
        for label in labels(host) {
            found.extend(self.hosts.get(label).into_iter().flatten());
        }
        for label in entity_stem(host).into_iter().flat_map(labels) {
            found.extend(self.entities.get(label).into_iter().flatten());
        }
        found.extend(self.others.iter());
        found.retain(|&at| domain_list_matches(&self.rules[at].domains, host));
        found.extend(
            self.regexes
                .iter()
                .filter(|(_, pattern)| pattern.is_match(host))
                .map(|(at, _)| *at),
        );
        found.sort_unstable();
        found.dedup();
        found.into_iter().map(|at| &self.rules[at]).collect()
    }

    /// Whether a block rule applies on `host`.
    pub fn applies(&self, host: &str) -> bool {
        self.for_host(host).iter().any(|rule| !rule.exception)
    }
}

/// `a.b.c`, `b.c`, `c`.
fn labels(host: &str) -> impl Iterator<Item = &str> {
    std::iter::successors(Some(host), |rest| {
        rest.split_once('.').map(|(_, rest)| rest)
    })
}

/// Applies every block selector an exception doesn't cancel; true when the document changed.
pub fn filter(document: &mut Html, rules: &[&HtmlSpec]) -> bool {
    let exceptions: HashSet<&str> = rules
        .iter()
        .filter(|rule| rule.exception)
        .map(|rule| rule.selector.as_str())
        .collect();
    let mut changed = false;
    for rule in rules {
        if !rule.exception && !exceptions.contains(rule.selector.as_str()) {
            changed |= apply(document, &rule.selector);
        }
    }
    changed
}

/// Applies one selector: removes every node it finds; true when one was removed.
fn apply(document: &mut Html, selector: &str) -> bool {
    let Some(procedure) = Procedure::parse(selector) else {
        return false;
    };
    let nodes = procedure.exec(document, None);
    let mut changed = false;
    for id in nodes {
        if let Some(mut node) = document.tree.get_mut(id) {
            if node.parent().is_some() {
                node.detach();
                changed = true;
            }
        }
    }
    changed
}

struct Procedure {
    base: String,
    steps: Vec<Step>,
}

enum Step {
    /// A CSS selector following an operator (`:upward(1) > script`).
    Select(String),
    HasText(TextMatcher),
    Upward(Upward),
    Has(Box<Procedure>),
    Not(Box<Procedure>),
    Content(String),
    MinTextLength(usize),
}

enum Upward {
    Distance(usize),
    Selector(String),
}

enum TextMatcher {
    Literal(String),
    Regex(Pattern),
}

impl TextMatcher {
    fn parse(argument: &str) -> Option<Self> {
        let argument = unquote(argument.trim());
        if argument.is_empty() {
            // uBO's regexFromString('') is /^/, which matches any text.
            return Some(Self::Literal(String::new()));
        }
        if let Some((pattern, flags)) = regex_literal(&argument) {
            return Some(Self::Regex(Pattern::new(&pattern, &flags)?));
        }
        Some(Self::Literal(
            argument.replace("\\'", "'").replace("\\\"", "\""),
        ))
    }

    fn matches(&self, text: &str) -> bool {
        match self {
            Self::Literal(literal) => text.contains(literal.as_str()),
            Self::Regex(re) => re.is_match(text),
        }
    }
}

impl Procedure {
    fn parse(selector: &str) -> Option<Self> {
        let selector = selector.trim();
        if selector.is_empty() {
            return None;
        }
        let mut base = String::new();
        let mut steps = Vec::new();
        let mut segment_start = 0;
        let mut at = 0;
        let bytes = selector.as_bytes();
        while at < bytes.len() {
            match bytes[at] {
                b'\\' => at = (at + 2).min(bytes.len()),
                b'\'' | b'"' => at = skip_quoted(selector, at),
                b'[' => at = skip_bracketed(selector, at),
                b':' => {
                    let name_start = at + 1;
                    let mut end = name_start;
                    while end < bytes.len()
                        && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'-')
                    {
                        end += 1;
                    }
                    let name = &selector[name_start..end];
                    if bytes.get(end) != Some(&b'(') {
                        at = end;
                        continue;
                    }
                    let (argument, after) = balanced_argument(selector, end)?;
                    let procedural = match name {
                        "has" | "not" => contains_procedural(argument),
                        name => is_procedural(name),
                    };
                    if !procedural {
                        at = after;
                        continue;
                    }
                    let segment = selector[segment_start..at].trim();
                    if steps.is_empty() {
                        base = segment.to_owned();
                    } else if !segment.is_empty() {
                        steps.push(Step::Select(segment.to_owned()));
                    }
                    let argument = argument.trim();
                    let step = match name {
                        "has-text" => Step::HasText(TextMatcher::parse(argument)?),
                        "upward" | "nth-ancestor" => Step::Upward(
                            argument
                                .parse::<usize>()
                                .ok()
                                .filter(|distance| *distance > 0 && *distance < 256)
                                .map_or_else(
                                    || {
                                        // A plain CSS selector, which `closest()` climbs to.
                                        Selector::parse(argument)
                                            .ok()
                                            .map(|_| Upward::Selector(argument.to_owned()))
                                    },
                                    |distance| Some(Upward::Distance(distance)),
                                )?,
                        ),
                        "has" | "if" => Step::Has(Box::new(Self::parse(argument)?)),
                        "not" | "if-not" => Step::Not(Box::new(Self::parse(argument)?)),
                        "content" => Step::Content(argument.to_owned()),
                        "min-text-length" => Step::MinTextLength(argument.parse().ok()?),
                        _ => return None,
                    };
                    steps.push(step);
                    at = after;
                    segment_start = after;
                }
                _ => at += 1,
            }
        }
        let tail = selector[segment_start..].trim();
        if steps.is_empty() {
            base = tail.to_owned();
        } else if !tail.is_empty() {
            steps.push(Step::Select(tail.to_owned()));
        }
        if base.is_empty() && steps.is_empty() {
            return None;
        }
        Some(Self { base, steps })
    }

    /// The nodes this procedure selects, starting from `input` (the document when none).
    fn exec(&self, document: &Html, input: Option<NodeId>) -> Vec<NodeId> {
        let mut nodes = self.prime(document, input);
        for step in &self.steps {
            if nodes.is_empty() {
                break;
            }
            let mut next = Vec::new();
            for id in nodes {
                step.apply(document, id, &mut next);
            }
            nodes = next;
        }
        nodes
    }

    fn prime(&self, document: &Html, input: Option<NodeId>) -> Vec<NodeId> {
        match input {
            None if self.base.is_empty() => vec![document.tree.root().id()],
            None => select(document, None, &self.base),
            Some(id) if self.base.is_empty() => vec![id],
            Some(id) => select(document, Some(id), &self.base),
        }
    }

    /// uBO's `PSelector.test()`: whether the procedure selects anything from `node`.
    fn test(&self, document: &Html, node: NodeId) -> bool {
        !self.exec(document, Some(node)).is_empty()
    }
}

impl Step {
    fn apply(&self, document: &Html, node: NodeId, out: &mut Vec<NodeId>) {
        match self {
            Self::Select(selector) => {
                let selector = selector.trim_start();
                if let Some(rest) = selector.strip_prefix('>') {
                    select_children(document, node, rest.trim(), out);
                } else if let Some(rest) = selector.strip_prefix('+') {
                    if let Some(sibling) = next_sibling(document, node) {
                        if matches(document, sibling, rest.trim()) {
                            out.push(sibling);
                        }
                    }
                } else if let Some(rest) = selector.strip_prefix('~') {
                    let mut current = next_sibling(document, node);
                    while let Some(sibling) = current {
                        if matches(document, sibling, rest.trim()) {
                            out.push(sibling);
                        }
                        current = next_sibling(document, sibling);
                    }
                } else if !selector.is_empty() {
                    out.extend(select(document, Some(node), selector));
                }
            }
            Self::HasText(matcher) => {
                if matcher.matches(&text_content(document, node)) {
                    out.push(node);
                }
            }
            Self::Upward(distance) => match distance {
                Upward::Distance(distance) => {
                    let mut current = node;
                    for _ in 0..*distance {
                        let Some(parent) = parent_element(document, current) else {
                            return;
                        };
                        current = parent;
                    }
                    out.push(current);
                }
                Upward::Selector(selector) => {
                    let mut current = parent_element(document, node);
                    while let Some(candidate) = current {
                        if matches(document, candidate, selector) {
                            out.push(candidate);
                            return;
                        }
                        current = parent_element(document, candidate);
                    }
                }
            },
            Self::Has(procedure) => {
                if procedure.test(document, node) {
                    out.push(node);
                }
            }
            Self::Not(procedure) => {
                if !procedure.test(document, node) {
                    out.push(node);
                }
            }
            Self::Content(selector) => {
                if let Some(element) = element(document, node) {
                    if element.value().name.local.to_string() == "template" {
                        let Ok(selector) = Selector::parse(selector) else {
                            return;
                        };
                        out.extend(element.select(&selector).map(|found| found.id()));
                    }
                }
            }
            Self::MinTextLength(minimum) => {
                if text_content(document, node).chars().count() >= *minimum {
                    out.push(node);
                }
            }
        }
    }
}

fn element<'a>(document: &'a Html, id: NodeId) -> Option<ElementRef<'a>> {
    ElementRef::wrap(document.tree.get(id)?)
}

fn select(document: &Html, input: Option<NodeId>, selector: &str) -> Vec<NodeId> {
    let Ok(selector) = Selector::parse(selector) else {
        return Vec::new();
    };
    match input {
        None => document.select(&selector).map(|found| found.id()).collect(),
        Some(id) => match element(document, id) {
            Some(element) => element.select(&selector).map(|found| found.id()).collect(),
            None => Vec::new(),
        },
    }
}

fn select_children(document: &Html, node: NodeId, selector: &str, out: &mut Vec<NodeId>) {
    let Ok(selector) = Selector::parse(selector) else {
        return;
    };
    if let Some(element) = element(document, node) {
        out.extend(
            element
                .children()
                .filter_map(ElementRef::wrap)
                .filter(|child| selector.matches(child))
                .map(|child| child.id()),
        );
        return;
    }
    if node == document.tree.root().id() {
        out.extend(
            document
                .tree
                .root()
                .children()
                .filter_map(ElementRef::wrap)
                .filter(|child| selector.matches(child))
                .map(|child| child.id()),
        );
    }
}

fn matches(document: &Html, id: NodeId, selector: &str) -> bool {
    let Ok(selector) = Selector::parse(selector) else {
        return false;
    };
    element(document, id).is_some_and(|element| selector.matches(&element))
}

fn parent_element(document: &Html, id: NodeId) -> Option<NodeId> {
    let mut parent = document.tree.get(id)?.parent();
    while let Some(node) = parent {
        if node.value().is_element() {
            return Some(node.id());
        }
        parent = node.parent();
    }
    None
}

fn next_sibling(document: &Html, id: NodeId) -> Option<NodeId> {
    document
        .tree
        .get(id)?
        .next_siblings()
        .find(|node| node.value().is_element())
        .map(|node| node.id())
}

fn text_content(document: &Html, id: NodeId) -> String {
    document
        .tree
        .get(id)
        .map(|node| {
            node.descendants()
                .filter_map(|descendant| descendant.value().as_text())
                .map(|text| text.text.as_ref())
                .collect()
        })
        .unwrap_or_default()
}

/// uBO's operators that are procedural wherever they appear. `:has()` and `:not()` are only when their argument is.
fn is_procedural(name: &str) -> bool {
    matches!(
        name,
        "has-text" | "upward" | "nth-ancestor" | "content" | "min-text-length" | "if" | "if-not"
    )
}

/// Whether an operator appears anywhere in a `:has()`/`:not()` argument; native CSS may stay native.
fn contains_procedural(selector: &str) -> bool {
    let bytes = selector.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'\\' => at = (at + 2).min(bytes.len()),
            b'\'' | b'"' => at = skip_quoted(selector, at),
            b'[' => at = skip_bracketed(selector, at),
            b':' => {
                let start = at + 1;
                let mut end = start;
                while end < bytes.len()
                    && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'-')
                {
                    end += 1;
                }
                let name = &selector[start..end];
                if bytes.get(end) != Some(&b'(') {
                    at = end;
                    continue;
                }
                let Some((argument, after)) = balanced_argument(selector, end) else {
                    return true;
                };
                match name {
                    "has" | "not" if contains_procedural(argument) => return true,
                    name if is_procedural(name) => return true,
                    _ => {}
                }
                at = after;
            }
            _ => at += 1,
        }
    }
    false
}

/// The text between an opening `(` and its matching `)`, and the index after it.
fn balanced_argument(text: &str, open: usize) -> Option<(&str, usize)> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut brackets = 0usize;
    let mut at = open;
    while at < bytes.len() {
        match bytes[at] {
            b'\\' => {
                at += 2;
                continue;
            }
            b'\'' | b'"' => {
                at = skip_quoted(text, at);
                continue;
            }
            b'[' => {
                brackets += 1;
                at += 1;
                continue;
            }
            b']' => {
                brackets = brackets.saturating_sub(1);
                at += 1;
                continue;
            }
            b'(' if brackets == 0 => depth += 1,
            b')' if brackets == 0 => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some((&text[open + 1..at], at + 1));
                }
            }
            _ => {}
        }
        at += 1;
    }
    None
}

fn skip_quoted(text: &str, open: usize) -> usize {
    let bytes = text.as_bytes();
    let quote = bytes[open];
    let mut at = open + 1;
    while at < bytes.len() {
        match bytes[at] {
            b'\\' => at += 2,
            byte if byte == quote => return at + 1,
            _ => at += 1,
        }
    }
    bytes.len()
}

fn skip_bracketed(text: &str, open: usize) -> usize {
    let bytes = text.as_bytes();
    let mut at = open + 1;
    while at < bytes.len() {
        match bytes[at] {
            b'\\' => at += 2,
            b'\'' | b'"' => at = skip_quoted(text, at),
            b']' => return at + 1,
            _ => at += 1,
        }
    }
    bytes.len()
}

/// `/pattern/flags` at the start of a `:has-text()` argument, as uBO's `regexFromString`.
fn regex_literal(argument: &str) -> Option<(String, String)> {
    let rest = argument.strip_prefix('/')?;
    let mut escaped = false;
    for (at, c) in rest.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' => escaped = true,
            '/' => {
                let flags = &rest[at + 1..];
                if flags.chars().all(|c| c.is_ascii_alphabetic()) {
                    return Some((rest[..at].to_owned(), flags.to_owned()));
                }
                return None;
            }
            _ => {}
        }
    }
    None
}

/// Removes one layer of quotes, as uBO's `compileText()` does.
fn unquote(text: &str) -> String {
    let bytes = text.as_bytes();
    if bytes.len() < 2 || !matches!(bytes[0], b'\'' | b'"') || bytes[bytes.len() - 1] != bytes[0] {
        return text.to_owned();
    }
    let inner = &text[1..text.len() - 1];
    if !inner.contains('\\') {
        return inner.to_owned();
    }
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(escaped) = chars.next() {
                out.push(escaped);
                continue;
            }
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remove(html: &str, selector: &str) -> String {
        let mut document = Html::parse_document(html);
        assert!(apply(&mut document, selector), "{selector}");
        document.html()
    }

    #[test]
    fn removes_a_script_by_text() {
        let html =
            "<html><head><script>var admc = 1;</script><script>keep()</script></head></html>";
        let out = remove(html, "script:has-text(admc)");
        assert!(!out.contains("var admc"));
        assert!(out.contains("keep()"));
    }

    #[test]
    fn matches_text_quotes_and_regexes() {
        assert!(TextMatcher::parse("'shift'")
            .unwrap()
            .matches("window['shift']"));
        assert!(TextMatcher::parse("\\'shift\\'")
            .unwrap()
            .matches("window['shift']"));
        assert!(TextMatcher::parse("/AdBlock/i").unwrap().matches("adblock"));
        assert!(TextMatcher::parse("(window);")
            .unwrap()
            .matches("(window);"));
    }

    #[test]
    fn climbs_to_an_ancestor_then_selects() {
        let html = "<html><head><meta name='template' content='x'><script src='https://ads/x.js'></script></head></html>";
        let out = remove(
            html,
            "html > head > meta[name=\"template\"]:upward(1) > script[src*=\"ads\"]",
        );
        assert!(!out.contains("ads/x.js"));
    }

    #[test]
    fn applies_a_selector_to_template_content() {
        let html = "<html><body><template><script src='page-kit.io/x.js'></script></template></body></html>";
        let out = remove(html, "template:content(script[src*=\"page-kit.io\"])");
        assert!(!out.contains("page-kit.io"));
    }

    #[test]
    fn keeps_nodes_a_not_selector_rejects() {
        let html = "<html><head><script src='pwt.js'></script></head></html>";
        let mut document = Html::parse_document(html);
        assert!(!apply(
            &mut document,
            "link[rel=\"canonical\"]:not([href^=\"https://x/\"]) ~ script"
        ));
    }

    #[test]
    fn exceptions_cancel_the_same_selector() {
        let rules = HtmlRules::new(vec![
            HtmlSpec::parse("example.com##^script:has-text(ad)").unwrap(),
            HtmlSpec::parse("example.com#@#^script:has-text(ad)").unwrap(),
        ]);
        let mut document = Html::parse_document("<script>ad</script>");
        assert!(!filter(&mut document, &rules.for_host("example.com")));
    }

    #[test]
    fn finds_rules_by_host_entity_regex_and_negation() {
        let rules = HtmlRules::new(vec![
            HtmlSpec::parse("example.com,~skip.example.com##^a").unwrap(),
            HtmlSpec::parse("entity.*##^b").unwrap(),
            HtmlSpec::parse(r"/(\d{0,1})?print(\d{1,2})?\.[a-z]{3,7}/##^c").unwrap(),
            HtmlSpec::parse("#@#^d").unwrap(),
        ]);
        assert!(rules.applies("www.example.com"));
        assert!(!rules.applies("skip.example.com"));
        assert!(rules.applies("www.entity.co.uk"));
        assert!(rules.applies("7print12.com"));
        assert!(!rules.applies("elsewhere.org"));
        assert_eq!(rules.for_host("elsewhere.org").len(), 1);
    }

    #[test]
    fn text_literals_are_case_sensitive_as_in_ubo() {
        assert!(TextMatcher::parse("AdBlock").unwrap().matches("AdBlock"));
        assert!(!TextMatcher::parse("AdBlock").unwrap().matches("adblock"));
    }
}
