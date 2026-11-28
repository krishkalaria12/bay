use collections::{HashMap, HashSet};
use core_foundation::{
    array::{CFArray, CFArrayRef},
    base::{CFType, CFTypeRef, TCFType},
    data::{CFData, CFDataRef},
    dictionary::{CFDictionary, CFDictionaryRef},
    number::CFNumber,
    string::{CFString, CFStringRef},
};
use core_graphics::base::CGFloat;
use gpui::{
    Bounds, DevicePixels, Font, FontId, FontMetrics, FontRun, FontStyle, FontWeight, GlyphId, Hsla,
    LineLayout, MissingGlyphSink, Pixels, PlatformTextSystem, RenderGlyphParams, Result,
    SharedString, Size, TextRenderingMode,
};
use parking_lot::RwLock;
use std::{borrow::Cow, ffi::c_void, sync::Arc};

const SYSTEM_UI_FAMILY: &str = ".AppleSystemUIFont";

const FONT_KIT_WEIGHT_MAPPING: [f32; 9] = [-0.7, -0.5, -0.23, 0.0, 0.2, 0.3, 0.4, 0.6, 0.8];

const SEMIBOLD_CSS_WEIGHT: f32 = 600.0;

const CT_FONT_ITALIC_TRAIT: u32 = 1 << 0;

pub(crate) struct MacTextSystem {
    inner: gpui_apple::AppleTextSystem,
    medium_weights: RwLock<HashMap<(SharedString, FontStyle), Option<FontWeight>>>,
    memory_families: RwLock<HashSet<String>>,
}

impl MacTextSystem {
    pub(crate) fn new() -> Self {
        Self {
            inner: gpui_apple::AppleTextSystem::new(),
            medium_weights: RwLock::default(),
            memory_families: RwLock::default(),
        }
    }

    fn medium_weight(&self, font: &Font) -> Option<FontWeight> {
        let key = (font.family.clone(), font.style);
        if let Some(weight) = self.medium_weights.read().get(&key) {
            return *weight;
        }
        let family = gpui::font_name_with_fallbacks(&font.family, SYSTEM_UI_FAMILY);
        let weight = if self.memory_families.read().contains(family) {
            None
        } else {
            medium_request_weight(&system_family_faces(family), font.style)
        };
        self.medium_weights.write().insert(key, weight);
        weight
    }
}

impl PlatformTextSystem for MacTextSystem {
    fn add_fonts(&self, fonts: Vec<Cow<'static, [u8]>>) -> Result<()> {
        let families = fonts
            .iter()
            .flat_map(|bytes| family_names_in_font_data(bytes))
            .collect::<Vec<_>>();
        self.inner.add_fonts(fonts)?;
        self.memory_families.write().extend(families);
        self.medium_weights.write().clear();
        Ok(())
    }

    fn set_missing_glyph_sink(&self, sink: Option<Arc<dyn MissingGlyphSink>>) {
        self.inner.set_missing_glyph_sink(sink)
    }

    fn all_font_names(&self) -> Vec<String> {
        self.inner.all_font_names()
    }

    fn font_id(&self, font: &Font) -> Result<FontId> {
        if font.weight != FontWeight::MEDIUM {
            return self.inner.font_id(font);
        }
        match self.medium_weight(font) {
            Some(weight) => self.inner.font_id(&Font {
                weight,
                ..font.clone()
            }),
            None => self.inner.font_id(font),
        }
    }

    fn prewarm_fonts(&self, font_ids: &[FontId]) {
        self.inner.prewarm_fonts(font_ids)
    }

    fn font_metrics(&self, font_id: FontId) -> FontMetrics {
        self.inner.font_metrics(font_id)
    }

    fn typographic_bounds(&self, font_id: FontId, glyph_id: GlyphId) -> Result<Bounds<f32>> {
        self.inner.typographic_bounds(font_id, glyph_id)
    }

    fn advance(&self, font_id: FontId, glyph_id: GlyphId) -> Result<Size<f32>> {
        self.inner.advance(font_id, glyph_id)
    }

    fn glyph_for_char(&self, font_id: FontId, ch: char) -> Option<GlyphId> {
        self.inner.glyph_for_char(font_id, ch)
    }

    fn glyph_raster_bounds(&self, params: &RenderGlyphParams) -> Result<Bounds<DevicePixels>> {
        self.inner.glyph_raster_bounds(params)
    }

    fn rasterize_glyph(
        &self,
        params: &RenderGlyphParams,
        raster_bounds: Bounds<DevicePixels>,
    ) -> Result<(Size<DevicePixels>, Vec<u8>)> {
        self.inner.rasterize_glyph(params, raster_bounds)
    }

    fn layout_line(&self, text: &str, font_size: Pixels, runs: &[FontRun]) -> LineLayout {
        self.inner.layout_line(text, font_size, runs)
    }

    fn recommended_rendering_mode(&self, font_id: FontId, font_size: Pixels) -> TextRenderingMode {
        self.inner.recommended_rendering_mode(font_id, font_size)
    }

    fn glyph_dilation_for_color(&self, color: Hsla) -> u8 {
        self.inner.glyph_dilation_for_color(color)
    }
}

#[derive(Clone, Debug, PartialEq)]
struct FaceTraits {
    postscript_name: String,
    style: FontStyle,
    css_weight: f32,
    normal_width: bool,
}

fn medium_request_weight(faces: &[FaceTraits], style: FontStyle) -> Option<FontWeight> {
    let normal_width = faces.iter().filter(|face| face.normal_width);
    let style_preference = match style {
        FontStyle::Italic => [FontStyle::Italic, FontStyle::Oblique, FontStyle::Normal],
        FontStyle::Oblique => [FontStyle::Oblique, FontStyle::Italic, FontStyle::Normal],
        FontStyle::Normal => [FontStyle::Normal, FontStyle::Oblique, FontStyle::Italic],
    };
    let matched_style = style_preference
        .into_iter()
        .find(|preferred| normal_width.clone().any(|face| face.style == *preferred))?;
    let weights = normal_width
        .filter(|face| face.style == matched_style)
        .map(|face| face.css_weight);
    let mut thinnest_medium: Option<f32> = None;
    for weight in weights {
        if weight == FontWeight::MEDIUM.0 {
            return None;
        }
        if weight > FontWeight::MEDIUM.0 && weight < SEMIBOLD_CSS_WEIGHT {
            thinnest_medium = Some(thinnest_medium.map_or(weight, |thinnest| thinnest.min(weight)));
        }
    }
    thinnest_medium.map(|medium| FontWeight((FontWeight::MEDIUM.0 + medium) / 2.0))
}

fn font_kit_css_weight(core_text_weight: f32) -> f32 {
    let mapping = &FONT_KIT_WEIGHT_MAPPING;
    let upper = mapping.partition_point(|value| *value < core_text_weight);
    let index = if upper == 0 || upper >= mapping.len() || mapping[upper] == core_text_weight {
        upper as f32
    } else {
        let (lower_value, upper_value) = (mapping[upper - 1], mapping[upper]);
        (upper - 1) as f32 + (core_text_weight - lower_value) / (upper_value - lower_value)
    };
    index * 100.0 + 100.0
}

type CTFontDescriptorRef = *const c_void;
type CTFontCollectionRef = *const c_void;
type CTFontRef = *const c_void;

#[link(name = "CoreText", kind = "framework")]
unsafe extern "C" {
    static kCTFontFamilyNameAttribute: CFStringRef;
    static kCTFontWeightTrait: CFStringRef;
    static kCTFontWidthTrait: CFStringRef;
    static kCTFontSlantTrait: CFStringRef;

    fn CTFontDescriptorCreateWithAttributes(attributes: CFDictionaryRef) -> CTFontDescriptorRef;
    fn CTFontDescriptorCopyAttribute(
        descriptor: CTFontDescriptorRef,
        attribute: CFStringRef,
    ) -> CFTypeRef;
    fn CTFontCollectionCreateWithFontDescriptors(
        descriptors: CFArrayRef,
        options: CFDictionaryRef,
    ) -> CTFontCollectionRef;
    fn CTFontCollectionCreateMatchingFontDescriptors(collection: CTFontCollectionRef)
    -> CFArrayRef;
    fn CTFontCreateWithFontDescriptor(
        descriptor: CTFontDescriptorRef,
        size: CGFloat,
        matrix: *const c_void,
    ) -> CTFontRef;
    fn CTFontCopyTraits(font: CTFontRef) -> CFDictionaryRef;
    fn CTFontGetSymbolicTraits(font: CTFontRef) -> u32;
    fn CTFontCopyPostScriptName(font: CTFontRef) -> CFStringRef;
    fn CTFontManagerCreateFontDescriptorsFromData(data: CFDataRef) -> CFArrayRef;
}

fn owned_cf(reference: *const c_void) -> Option<CFType> {
    if reference.is_null() {
        None
    } else {
        Some(unsafe { CFType::wrap_under_create_rule(reference) })
    }
}

fn owned_cf_array(reference: CFArrayRef) -> Option<CFArray<CFType>> {
    if reference.is_null() {
        None
    } else {
        Some(unsafe { CFArray::wrap_under_create_rule(reference) })
    }
}

fn system_family_faces(family: &str) -> Vec<FaceTraits> {
    let attributes = CFDictionary::from_CFType_pairs(&[(
        CFString::new("NSFontFamilyAttribute"),
        CFString::new(family).as_CFType(),
    )]);
    let Some(query) =
        owned_cf(unsafe { CTFontDescriptorCreateWithAttributes(attributes.as_concrete_TypeRef()) })
    else {
        return Vec::new();
    };
    let queries = CFArray::from_CFTypes(&[query]);
    let Some(collection) = owned_cf(unsafe {
        CTFontCollectionCreateWithFontDescriptors(queries.as_concrete_TypeRef(), std::ptr::null())
    }) else {
        return Vec::new();
    };
    let Some(descriptors) = owned_cf_array(unsafe {
        CTFontCollectionCreateMatchingFontDescriptors(collection.as_CFTypeRef())
    }) else {
        return Vec::new();
    };
    descriptors
        .iter()
        .filter_map(|descriptor| face_traits(descriptor.as_CFTypeRef()))
        .collect()
}

fn face_traits(descriptor: CTFontDescriptorRef) -> Option<FaceTraits> {
    let font =
        owned_cf(unsafe { CTFontCreateWithFontDescriptor(descriptor, 16.0, std::ptr::null()) })?;
    let font_ref = font.as_CFTypeRef();
    let traits = unsafe { CTFontCopyTraits(font_ref) };
    if traits.is_null() {
        return None;
    }
    let traits = unsafe { CFDictionary::<CFString, CFType>::wrap_under_create_rule(traits) };
    let number_trait = |key: CFStringRef| {
        traits
            .find(unsafe { CFString::wrap_under_get_rule(key) })
            .and_then(|value| value.downcast::<CFNumber>())
            .and_then(|number| number.to_f64())
    };
    let weight = number_trait(unsafe { kCTFontWeightTrait })?;
    let width = number_trait(unsafe { kCTFontWidthTrait })?;
    let slant = number_trait(unsafe { kCTFontSlantTrait })?;
    let postscript_name = unsafe { CTFontCopyPostScriptName(font_ref) };
    if postscript_name.is_null() {
        return None;
    }
    let postscript_name = unsafe { CFString::wrap_under_create_rule(postscript_name) }.to_string();
    let style = if unsafe { CTFontGetSymbolicTraits(font_ref) } & CT_FONT_ITALIC_TRAIT != 0 {
        FontStyle::Italic
    } else if slant > 0.0 {
        FontStyle::Oblique
    } else {
        FontStyle::Normal
    };
    Some(FaceTraits {
        postscript_name,
        style,
        css_weight: font_kit_css_weight(weight as f32),
        normal_width: width == 0.0,
    })
}

fn family_names_in_font_data(bytes: &[u8]) -> Vec<String> {
    let data = CFData::from_buffer(bytes);
    let Some(descriptors) = owned_cf_array(unsafe {
        CTFontManagerCreateFontDescriptorsFromData(data.as_concrete_TypeRef())
    }) else {
        return Vec::new();
    };
    descriptors
        .iter()
        .filter_map(|descriptor| {
            owned_cf(unsafe {
                CTFontDescriptorCopyAttribute(descriptor.as_CFTypeRef(), kCTFontFamilyNameAttribute)
            })?
            .downcast_into::<CFString>()
            .map(|name| name.to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{FontFeatures, px};

    const ALL_WEIGHTS: [FontWeight; 9] = [
        FontWeight::THIN,
        FontWeight::EXTRA_LIGHT,
        FontWeight::LIGHT,
        FontWeight::NORMAL,
        FontWeight::MEDIUM,
        FontWeight::SEMIBOLD,
        FontWeight::BOLD,
        FontWeight::EXTRA_BOLD,
        FontWeight::BLACK,
    ];

    fn font(family: &str, weight: FontWeight) -> Font {
        Font {
            family: SharedString::from(family.to_string()),
            features: FontFeatures::default(),
            fallbacks: None,
            weight,
            style: FontStyle::Normal,
        }
    }

    fn github_width(text_system: &dyn PlatformTextSystem, font: &Font) -> f32 {
        let font_id = text_system.font_id(font).expect("font resolves");
        let text = "github.com";
        let layout = text_system.layout_line(
            text,
            px(13.0),
            &[FontRun {
                len: text.len(),
                font_id,
            }],
        );
        layout.width.into()
    }

    fn face_for_width(faces: &[FaceTraits], family: &str, width: f32) -> String {
        let probe = gpui_apple::AppleTextSystem::new();
        faces
            .iter()
            .filter(|face| face.style == FontStyle::Normal && face.normal_width)
            .map(|face| {
                let exact = font(family, FontWeight(face.css_weight));
                (face, (github_width(&probe, &exact) - width).abs())
            })
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(face, _)| format!("{} ({:.0})", face.postscript_name, face.css_weight))
            .unwrap_or_default()
    }

    fn widths(text_system: &dyn PlatformTextSystem, family: &str) -> Vec<f32> {
        ALL_WEIGHTS
            .iter()
            .map(|weight| github_width(text_system, &font(family, *weight)))
            .collect()
    }

    fn assert_only_medium_changes(family: &str, expect_medium_face: bool) {
        let before = widths(&gpui_apple::AppleTextSystem::new(), family);
        let after = widths(&MacTextSystem::new(), family);
        let faces = system_family_faces(gpui::font_name_with_fallbacks(family, SYSTEM_UI_FAMILY));
        for (index, weight) in ALL_WEIGHTS.iter().enumerate() {
            eprintln!(
                "{family} {:>3}: before {:.2} {} | after {:.2} {}",
                weight.0,
                before[index],
                face_for_width(&faces, family, before[index]),
                after[index],
                face_for_width(&faces, family, after[index]),
            );
        }
        for (index, weight) in ALL_WEIGHTS.iter().enumerate() {
            if *weight == FontWeight::MEDIUM {
                continue;
            }
            assert_eq!(
                before[index], after[index],
                "{family} weight {} changed",
                weight.0
            );
        }
        let medium = ALL_WEIGHTS
            .iter()
            .position(|weight| *weight == FontWeight::MEDIUM)
            .unwrap();
        if expect_medium_face {
            assert!(
                after[medium] > before[medium],
                "{family} 500 still renders {:.2}, the width of the face before",
                after[medium]
            );
            assert!(after[medium] < after[medium + 1]);
        } else {
            assert_eq!(before[medium], after[medium], "{family} 500 changed");
        }
    }

    fn family_installed(family: &str) -> bool {
        !system_family_faces(family).is_empty()
    }

    #[test]
    fn system_ui_medium_selects_the_medium_face() {
        let text_system = MacTextSystem::new();
        let regular = github_width(&text_system, &font(".SystemUIFont", FontWeight::NORMAL));
        let medium = github_width(&text_system, &font(".SystemUIFont", FontWeight::MEDIUM));
        assert!(
            (regular - 68.06).abs() < 0.05 && (medium - 70.03).abs() < 0.05,
            "regular {regular:.2}, medium {medium:.2}"
        );
    }

    #[test]
    fn only_medium_changes_for_the_system_ui_font() {
        assert_only_medium_changes(".SystemUIFont", true);
    }

    #[test]
    fn only_medium_changes_for_helvetica_neue() {
        assert_only_medium_changes("Helvetica Neue", true);
    }

    #[test]
    fn only_medium_changes_for_sf_pro_when_installed() {
        if family_installed("SF Pro") {
            assert_only_medium_changes("SF Pro", true);
        }
    }

    #[test]
    fn families_without_a_medium_face_are_unchanged() {
        for family in ["Helvetica", "Menlo", "Georgia"] {
            assert_only_medium_changes(family, false);
        }
    }

    #[test]
    fn font_kit_weights_match_the_core_text_table() {
        assert_eq!(font_kit_css_weight(0.0), 400.0);
        assert_eq!(font_kit_css_weight(0.3), 600.0);
        assert!((font_kit_css_weight(0.23) - 530.0).abs() < 0.01);
        assert_eq!(font_kit_css_weight(-1.0), 100.0);
        assert_eq!(font_kit_css_weight(1.0), 1000.0);
    }

    #[test]
    fn medium_request_weight_follows_css_fallback() {
        let face = |weight: f32, style: FontStyle| FaceTraits {
            postscript_name: String::new(),
            style,
            css_weight: weight,
            normal_width: true,
        };
        let with_medium = [
            face(400.0, FontStyle::Normal),
            face(530.0, FontStyle::Normal),
            face(600.0, FontStyle::Normal),
        ];
        assert_eq!(
            medium_request_weight(&with_medium, FontStyle::Normal),
            Some(FontWeight(515.0))
        );
        let exact = [
            face(400.0, FontStyle::Normal),
            face(500.0, FontStyle::Normal),
        ];
        assert_eq!(medium_request_weight(&exact, FontStyle::Normal), None);
        let no_medium = [
            face(400.0, FontStyle::Normal),
            face(700.0, FontStyle::Normal),
        ];
        assert_eq!(medium_request_weight(&no_medium, FontStyle::Normal), None);
        let italic_medium_only = [
            face(400.0, FontStyle::Normal),
            face(400.0, FontStyle::Italic),
            face(530.0, FontStyle::Italic),
        ];
        assert_eq!(
            medium_request_weight(&italic_medium_only, FontStyle::Normal),
            None
        );
        assert_eq!(
            medium_request_weight(&italic_medium_only, FontStyle::Italic),
            Some(FontWeight(515.0))
        );
    }
}
