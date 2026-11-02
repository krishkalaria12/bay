//! uBlock Origin's list preprocessor (`!#if`, `!#else`, `!#endif`), which adblock-rust reads as comments and so keeps
//! every branch: lists then apply rules meant for Firefox, Safari or another blocker. This keeps what uBO keeps on
//! Chromium, where Bay's blocker has a user stylesheet but no HTML filtering.

use std::borrow::Cow;

/// The tokens that are true for Bay; any other (`env_firefox`, `adguard`, `cap_html_filtering`…) is false.
const TRUE_TOKENS: &[&str] = &["env_chromium", "ext_ublock", "cap_user_stylesheet"];

/// The list without the lines its `!#if` conditions leave out (unchanged when it has none).
pub fn preprocess(list: &str) -> Cow<'_, str> {
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
            blocks.push((outer, evaluate(condition)));
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

fn evaluate(condition: &str) -> bool {
    let tokens = tokenize(condition);
    let mut parser = Parser {
        tokens: &tokens,
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
                TRUE_TOKENS.contains(&token)
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
}
