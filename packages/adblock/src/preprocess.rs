//! uBlock Origin's list preprocessor (`!#if`, `!#else`, `!#endif`), which adblock-rust reads as comments and so keeps
//! every branch: lists then apply rules meant for Firefox, Safari or another blocker. This keeps what uBO keeps on
//! each of Bay's engines (see [`Platform`]); none of them has HTML filtering.

use std::borrow::Cow;

/// The engine a list is prepared for. Each has its own true tokens; any other (`env_firefox`, `adguard`,
/// `cap_html_filtering`…) is false.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    /// Desktop Bay: Chromium with a user stylesheet.
    DesktopChromium,
    /// Android: the system WebView (Chromium), with injected cosmetic CSS.
    AndroidWebView,
    /// iOS: WebKit content-blocking rules, as uBO resolves lists for Safari.
    IosWebKit,
}

impl Platform {
    fn true_tokens(self) -> &'static [&'static str] {
        match self {
            Self::DesktopChromium => &["env_chromium", "ext_ublock", "cap_user_stylesheet"],
            Self::AndroidWebView => &[
                "env_chromium",
                "env_mobile",
                "ext_ublock",
                "cap_user_stylesheet",
            ],
            Self::IosWebKit => &["env_safari", "env_mobile"],
        }
    }
}

/// The list without the lines its `!#if` conditions leave out on desktop (unchanged when it has none).
pub fn preprocess(list: &str) -> Cow<'_, str> {
    preprocess_for(list, Platform::DesktopChromium)
}

/// The list without the lines its `!#if` conditions leave out on `platform` (unchanged when it has none).
pub fn preprocess_for(list: &str, platform: Platform) -> Cow<'_, str> {
    let true_tokens = platform.true_tokens();
    if !list.contains("!#if") {
        return Cow::Borrowed(list);
    }
    let mut kept = String::with_capacity(list.len());
    // Per open `!#if`: whether its enclosing block is in force, and whether its own condition held.
    let mut blocks: Vec<(bool, bool)> = Vec::new();
    let active =
        |blocks: &[(bool, bool)]| blocks.last().is_none_or(|&(outer, holds)| outer && holds);
    for line in list.lines() {
        let directive = line.trim_end();
        if let Some(condition) = directive.strip_prefix("!#if ") {
            let outer = active(&blocks);
            blocks.push((outer, evaluate(condition, true_tokens)));
        } else if directive == "!#else" {
            if let Some(block) = blocks.last_mut() {
                block.1 = !block.1;
            }
        } else if directive == "!#endif" {
            blocks.pop();
        } else if active(&blocks) {
            kept.push_str(line);
            kept.push('\n');
        }
    }
    Cow::Owned(kept)
}

fn evaluate(condition: &str, true_tokens: &[&str]) -> bool {
    let tokens = tokenize(condition);
    let mut parser = Parser {
        tokens: &tokens,
        true_tokens,
        at: 0,
    };
    let value = parser.or();
    // Malformed (an unbalanced parenthesis, a stray operator): uBO drops the block.
    value && parser.at == tokens.len()
}

fn tokenize(condition: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut rest = condition.trim();
    while !rest.is_empty() {
        let token_len = if rest.starts_with("&&") || rest.starts_with("||") {
            2
        } else if rest.starts_with(['!', '(', ')']) {
            1
        } else {
            rest.find(|c: char| c.is_whitespace() || "!()&|".contains(c))
                .unwrap_or(rest.len())
                .max(1)
        };
        tokens.push(&rest[..token_len]);
        rest = rest[token_len..].trim_start();
    }
    tokens
}

struct Parser<'a> {
    tokens: &'a [&'a str],
    true_tokens: &'a [&'a str],
    at: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<&'a str> {
        self.tokens.get(self.at).copied()
    }

    fn or(&mut self) -> bool {
        let mut value = self.and();
        while self.peek() == Some("||") {
            self.at += 1;
            value |= self.and();
        }
        value
    }

    fn and(&mut self) -> bool {
        let mut value = self.not();
        while self.peek() == Some("&&") {
            self.at += 1;
            value &= self.not();
        }
        value
    }

    fn not(&mut self) -> bool {
        match self.peek() {
            Some("!") => {
                self.at += 1;
                !self.not()
            }
            Some("(") => {
                self.at += 1;
                let value = self.or();
                if self.peek() == Some(")") {
                    self.at += 1;
                    value
                } else {
                    self.at = self.tokens.len() + 1;
                    false
                }
            }
            Some(token) if !matches!(token, ")" | "&&" | "||") => {
                self.at += 1;
                self.true_tokens.contains(&token)
            }
            _ => {
                self.at = self.tokens.len() + 1;
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_what_ubo_keeps_on_chromium() {
        let list = "a\n!#if env_firefox\nfirefox\n!#else\nnot-firefox\n!#endif\n!#if !cap_html_filtering\nno-html\n!#endif\n\
                    !#if env_chromium && (ext_ublock || adguard)\nboth\n!#if env_safari\nnested-safari\n!#endif\n!#endif\nz\n";
        assert_eq!(preprocess(list), "a\nnot-firefox\nno-html\nboth\nz\n");
    }

    #[test]
    fn leaves_lists_without_directives_alone() {
        assert!(matches!(preprocess("a\n! comment\nb"), Cow::Borrowed(_)));
    }

    #[test]
    fn drops_malformed_conditions() {
        assert_eq!(preprocess("!#if (env_chromium\nx\n!#endif\ny\n"), "y\n");
        assert_eq!(preprocess("!#if env_chromium &&\nx\n!#endif\n"), "");
    }

    #[test]
    fn keeps_each_platforms_branch() {
        let list = "!#if env_mobile\nmobile\n!#endif\n!#if env_safari\nsafari\n!#else\nnot-safari\n!#endif\n";
        assert_eq!(preprocess(list), "not-safari\n");
        assert_eq!(
            preprocess_for(list, Platform::AndroidWebView),
            "mobile\nnot-safari\n"
        );
        assert_eq!(
            preprocess_for(list, Platform::IosWebKit),
            "mobile\nsafari\n"
        );
    }
}
