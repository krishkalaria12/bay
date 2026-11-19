//! The fonts Bay can show pages in, and the files each app bundles for them (packages/mobile-core/design/fonts, cut
//! down by `scripts/subset-fonts.sh`). A page gets the chosen font's files from the app, read into the page script
//! that adds them with the FontFace API, so a site's font-src policy can't block them.

use crate::store::SiteFont;

/// The fonts in the order the pickers list them, each with its name's string key.
pub const SITE_FONTS: [(SiteFont, &str); 7] = [
    (SiteFont::Original, "font.original"),
    (SiteFont::System, "font.system"),
    (SiteFont::Literata, "font.literata"),
    (SiteFont::Inter, "font.inter"),
    (SiteFont::Nunito, "font.nunito"),
    (SiteFont::Charis, "font.charis"),
    (SiteFont::Lora, "font.lora"),
];

/// One bundled file of a font: its name in the fonts folder, and the styles and weights it covers as CSS says them.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SiteFontFile {
    pub file: String,
    pub italic: bool,
    /// A weight ("400") or a variable font's range ("200 900").
    pub weight: String,
}

/// How a page shows in a font: the CSS family to set and the files that family needs. The family is empty for the
/// site's own fonts, and there are no files for System, which each phone has already.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SiteFontFace {
    pub family: String,
    pub files: Vec<SiteFontFile>,
}

fn file(file: &str, italic: bool, weight: &str) -> SiteFontFile {
    SiteFontFile {
        file: file.to_owned(),
        italic,
        weight: weight.to_owned(),
    }
}

/// The family and files a page needs to show in `font`. The family names the phone's font after the bundled one, so a
/// script the bundled files leave out (Hindi, Japanese) still shows in the phone's font.
#[uniffi::export]
pub fn site_font_face(font: SiteFont) -> SiteFontFace {
    const SYSTEM: &str = "system-ui, -apple-system, Roboto, sans-serif";
    let (name, files) = match font {
        SiteFont::Original => {
            return SiteFontFace {
                family: String::new(),
                files: Vec::new(),
            };
        }
        SiteFont::System => {
            return SiteFontFace {
                family: SYSTEM.to_owned(),
                files: Vec::new(),
            };
        }
        SiteFont::Literata => (
            "Literata",
            vec![
                file("literata.woff2", false, "200 900"),
                file("literata-italic.woff2", true, "200 900"),
            ],
        ),
        SiteFont::Inter => (
            "Inter",
            vec![
                file("inter.woff2", false, "100 900"),
                file("inter-italic.woff2", true, "100 900"),
            ],
        ),
        SiteFont::Nunito => (
            "Nunito",
            vec![
                file("nunito.woff2", false, "200 1000"),
                file("nunito-italic.woff2", true, "200 1000"),
            ],
        ),
        SiteFont::Charis => (
            "Charis",
            vec![
                file("charis.woff2", false, "400"),
                file("charis-bold.woff2", false, "700"),
                file("charis-italic.woff2", true, "400"),
                file("charis-bold-italic.woff2", true, "700"),
            ],
        ),
        SiteFont::Lora => (
            "Lora",
            vec![
                file("lora.woff2", false, "400 700"),
                file("lora-italic.woff2", true, "400 700"),
            ],
        ),
    };
    let serif = matches!(font, SiteFont::Literata | SiteFont::Charis | SiteFont::Lora);
    SiteFontFace {
        family: format!(
            "\"Bay {name}\", {}",
            if serif { "Georgia, serif" } else { SYSTEM }
        ),
        files,
    }
}

/// The string key of a font's name.
#[uniffi::export]
pub fn site_font_label(font: SiteFont) -> String {
    SITE_FONTS
        .iter()
        .find(|(each, _)| *each == font)
        .map_or("font.original", |(_, label)| label)
        .to_owned()
}

/// Every font the pickers list, in order.
#[uniffi::export]
pub fn site_fonts() -> Vec<SiteFont> {
    SITE_FONTS.iter().map(|(font, _)| *font).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_bundled_file_is_in_the_fonts_folder() {
        let folder = concat!(env!("CARGO_MANIFEST_DIR"), "/../../design/fonts");
        for font in site_fonts() {
            for each in site_font_face(font).files {
                assert!(
                    std::path::Path::new(folder).join(&each.file).is_file(),
                    "{} is missing",
                    each.file
                );
            }
        }
    }

    #[test]
    fn the_family_falls_back_to_the_phone_font() {
        assert_eq!(site_font_face(SiteFont::Original).family, "");
        assert!(site_font_face(SiteFont::System).files.is_empty());
        let literata = site_font_face(SiteFont::Literata);
        assert!(literata.family.starts_with("\"Bay Literata\", "));
        assert!(literata.family.ends_with("serif"));
        assert_eq!(site_font_label(SiteFont::Charis), "font.charis");
    }
}
