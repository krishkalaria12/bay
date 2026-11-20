//! The element picker's reports: what a tap on the page picked (for Hide elements and Inspect), and what the
//! inspector read about it. Both come from the page, so each is checked before anything acts on it. The Expo app's
//! `useReadingTools` (picked messages) and `panels/InspectPanel.tsx` (the rendered font's kind).

use serde::Deserialize;
use serde_json::Value;

use crate::js::slice;

/// A selector longer than this is turned down: no real rule needs it.
const SELECTOR_LIMIT: usize = 4096;

/// An element the picker selected, as `start-picker` reports it (`{ type: "picked", … }`).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PickedElement {
    pub selector: String,
    /// What it is, in words: its kind and its text (Link “Pricing”).
    pub label: String,
    /// Its tag, as <a>.
    pub tag: String,
    pub width: i64,
    pub height: i64,
}

fn whole(value: Option<&Value>) -> i64 {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .map(|number| number.round() as i64)
        .unwrap_or(0)
}

/// Reads a page message as the picker's selection; None for anything else.
#[uniffi::export]
pub fn parse_picked_message(message: &str) -> Option<PickedElement> {
    let value: Value = serde_json::from_str(message).ok()?;
    let object = value.as_object()?;
    if object.get("type")?.as_str()? != "picked" {
        return None;
    }
    let selector = object.get("selector")?.as_str()?;
    if selector.len() >= SELECTOR_LIMIT {
        return None;
    }
    Some(PickedElement {
        selector: selector.to_owned(),
        label: slice(object.get("label")?.as_str()?, 200),
        tag: object
            .get("tag")
            .and_then(Value::as_str)
            .map(|tag| slice(tag, 40))
            .unwrap_or_default(),
        width: whole(object.get("width")),
        height: whole(object.get("height")),
    })
}

/// One CSS rule that matches the inspected element: its selector, its style sheet, and its declarations.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, uniffi::Record)]
pub struct InspectedRule {
    pub selector: String,
    pub source: String,
    pub decls: Vec<CssDeclaration>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, uniffi::Record)]
#[serde(from = "(String, String)")]
pub struct CssDeclaration {
    pub property: String,
    pub value: String,
}

impl From<(String, String)> for CssDeclaration {
    fn from((property, value): (String, String)) -> Self {
        Self { property, value }
    }
}

/// The font that draws the element's text.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct InspectedFont {
    /// The font-family stack as written.
    pub stack: Vec<String>,
    /// The family that draws the text: a web font, an installed font, or the generic fallback.
    pub rendered: String,
    pub web: bool,
    /// Where the web font is loaded from, when the page's style sheets say.
    pub source: Option<String>,
    pub size: String,
    pub weight: String,
    pub style: String,
    pub line_height: String,
    pub letter_spacing: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, uniffi::Record)]
pub struct ColorSwatches {
    pub color: String,
    pub background: String,
}

/// What the inspector read about the picked element.
#[derive(Debug, Clone, PartialEq, Deserialize, uniffi::Record)]
pub struct InspectedElement {
    pub name: String,
    pub selector: String,
    pub width: f64,
    pub height: f64,
    pub color: String,
    pub background: String,
    /// The two colours above in sRGB for the app to draw: pages can write any CSS colour, such as oklch().
    pub swatches: ColorSwatches,
    pub rules: Vec<InspectedRule>,
    pub font: InspectedFont,
    /// The element's text, shortened; "" when it has none.
    pub text: String,
    /// Everything above as Markdown for a coding agent.
    pub agent: String,
}

/// Reads the `inspect` script's result; None when nothing is picked or the result isn't one.
#[uniffi::export]
pub fn parse_inspected_element(json: &str) -> Option<InspectedElement> {
    serde_json::from_str(json).ok()
}

/// Where the rendered font comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum FontKind {
    Web,
    /// The system's default, from a generic family.
    System,
    Installed,
}

/// The rendered font's kind, and the family asked for first when the page's first choice isn't what draws.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FontOrigin {
    pub kind: FontKind,
    pub missing: Option<String>,
}

const GENERIC_FAMILIES: [&str; 15] = [
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "ui-rounded",
    "math",
    "emoji",
    "fangsong",
    "-apple-system",
    "blinkmacsystemfont",
];

#[uniffi::export]
pub fn font_origin(font: InspectedFont) -> FontOrigin {
    let kind = if font.web {
        FontKind::Web
    } else if GENERIC_FAMILIES.contains(&font.rendered.to_lowercase().as_str()) {
        FontKind::System
    } else {
        FontKind::Installed
    };
    FontOrigin {
        kind,
        missing: font
            .stack
            .first()
            .filter(|first| **first != font.rendered)
            .cloned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_pickers_selection_and_turns_down_the_rest() {
        let picked = parse_picked_message(
            r#"{"type":"picked","selector":"main > a","label":"Link “Pricing”","tag":"<a>","width":120.6,"height":"x"}"#,
        )
        .unwrap();
        assert_eq!(
            (picked.selector.as_str(), picked.width, picked.height),
            ("main > a", 121, 0)
        );
        let long = format!(
            r#"{{"type":"picked","selector":"{}","label":""}}"#,
            "a".repeat(5000)
        );
        assert_eq!(parse_picked_message(&long), None);
        assert_eq!(parse_picked_message(r#"{"type":"media"}"#), None);
    }

    #[test]
    fn reads_an_inspected_element_and_its_fonts_origin() {
        let element = parse_inspected_element(
            r##"{"name":"h1.title","selector":"h1","width":300,"height":40,"x":0,"y":0,"color":"rgb(0, 0, 0)",
            "background":"transparent","swatches":{"color":"#000000","background":"#ffffff"},
            "rules":[{"selector":"h1","source":"site.css","decls":[["color","black"]]}],
            "font":{"stack":["Inter","sans-serif"],"rendered":"sans-serif","web":false,"source":null,"size":"32px",
            "weight":"700","style":"normal","lineHeight":"40px","letterSpacing":"normal","color":"#000"},
            "text":"Hello","agent":"# h1"}"##,
        )
        .unwrap();
        assert_eq!(element.rules[0].decls[0].property, "color");
        assert_eq!(
            font_origin(element.font),
            FontOrigin {
                kind: FontKind::System,
                missing: Some("Inter".into())
            }
        );
        assert_eq!(parse_inspected_element("null"), None);
    }
}
