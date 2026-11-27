//! Reader's look: its themes, fonts and text sizes, and the CSS variables its open and update page scripts take. The
//! Expo app's `src/pagescripts/reader.ts` (`READER_THEMES`, `READER_FONTS`, `READER_SIZES`, `readerVariables`).

use std::collections::HashMap;

use crate::store::{ReaderFont, ReaderSettings, ReaderTheme};

/// The smallest and largest body text Reader sets, in CSS pixels.
pub const READER_SIZE_MIN: i64 = 14;
pub const READER_SIZE_MAX: i64 = 28;

/// A Reader theme's colours, as `#RRGGBB`: the page, its text, quieter text and links.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ReaderThemeColors {
    pub id: ReaderTheme,
    pub background: String,
    pub text: String,
    pub muted: String,
    pub link: String,
}

const THEMES: [(ReaderTheme, &str, &str, &str, &str); 7] = [
    (
        ReaderTheme::Light,
        "#FFFFFF",
        "#1C1C1E",
        "#6B6B70",
        "#0A66C2",
    ),
    (
        ReaderTheme::Paper,
        "#F7F4EC",
        "#26231E",
        "#7A7466",
        "#8A4B12",
    ),
    (
        ReaderTheme::Sepia,
        "#F1E3C6",
        "#3B2F20",
        "#7D6A4E",
        "#8C4A16",
    ),
    (
        ReaderTheme::Mint,
        "#E7F2EA",
        "#1E2B23",
        "#5E7366",
        "#1D6B4A",
    ),
    (
        ReaderTheme::Gray,
        "#4A4C50",
        "#F1F1F2",
        "#C2C3C6",
        "#9CC8FF",
    ),
    (
        ReaderTheme::Dark,
        "#1C1C1E",
        "#E8E8EA",
        "#9A9AA0",
        "#7FB7FF",
    ),
    (
        ReaderTheme::Black,
        "#000000",
        "#D9D9DB",
        "#8E8E93",
        "#7FB7FF",
    ),
];

/// Reader's themes, in the order its settings show them.
#[uniffi::export]
pub fn reader_themes() -> Vec<ReaderThemeColors> {
    THEMES
        .iter()
        .map(|(id, background, text, muted, link)| ReaderThemeColors {
            id: *id,
            background: (*background).into(),
            text: (*text).into(),
            muted: (*muted).into(),
            link: (*link).into(),
        })
        .collect()
}

fn font_family(font: ReaderFont) -> &'static str {
    match font {
        ReaderFont::Serif => r#""New York", ui-serif, Georgia, "Noto Serif", serif"#,
        ReaderFont::Sans => {
            r#"ui-sans-serif, -apple-system, system-ui, Roboto, "Helvetica Neue", sans-serif"#
        }
        ReaderFont::Mono => r#"ui-monospace, "SF Mono", Menlo, "Roboto Mono", monospace"#,
    }
}

/// Reader's CSS variables for these settings: the `variables` argument of its open and update scripts.
#[uniffi::export]
pub fn reader_variables(settings: ReaderSettings) -> HashMap<String, String> {
    let (_, background, text, muted, link) = THEMES
        .iter()
        .find(|(id, ..)| *id == settings.theme)
        .unwrap_or(&THEMES[0]);
    let size = settings.size.clamp(READER_SIZE_MIN, READER_SIZE_MAX);
    HashMap::from([
        ("--bay-bg".to_owned(), (*background).to_owned()),
        ("--bay-text".to_owned(), (*text).to_owned()),
        ("--bay-muted".to_owned(), (*muted).to_owned()),
        ("--bay-link".to_owned(), (*link).to_owned()),
        (
            "--bay-font".to_owned(),
            font_family(settings.font).to_owned(),
        ),
        ("--bay-size".to_owned(), format!("{size}px")),
    ])
}

/// Whether Reader's text can step down, and up, from this size.
#[uniffi::export]
pub fn reader_size_steps(size: i64) -> ReaderSizeSteps {
    ReaderSizeSteps {
        smaller: size > READER_SIZE_MIN,
        larger: size < READER_SIZE_MAX,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct ReaderSizeSteps {
    pub smaller: bool,
    pub larger: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reader_variables_follow_the_settings_and_keep_the_size_in_range() {
        let settings = ReaderSettings {
            theme: ReaderTheme::Sepia,
            font: ReaderFont::Mono,
            size: 40,
        };
        let variables = reader_variables(settings);
        assert_eq!(variables["--bay-bg"], "#F1E3C6");
        assert_eq!(variables["--bay-size"], "28px");
        assert!(variables["--bay-font"].starts_with("ui-monospace"));
        assert_eq!(reader_themes().len(), 7);
        assert_eq!(
            reader_size_steps(READER_SIZE_MIN),
            ReaderSizeSteps {
                smaller: false,
                larger: true
            }
        );
    }
}
