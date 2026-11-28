use crate::{
    BorderStyle, Bounds, BoxShadow, Corners, Edges, Hsla, LiquidGlassRegion, LiquidGlassStyle,
    Path, PathBuilder, Pixels, Rgba, Window, WindowAppearance, WindowBackgroundAppearance, fill,
    hsla, linear_color_stop, linear_gradient, point, px, quad, transparent_black,
};

const IMPLICIT_ID: u64 = 1 << 63;

#[allow(missing_docs)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PaintLiquidGlass {
    pub id: Option<u64>,
    pub bounds: Bounds<Pixels>,
    pub corner_radius: Pixels,
    pub tint: Option<Rgba>,
    pub style: LiquidGlassStyle,
    pub group_id: Option<u64>,
    /// The native glass view's alpha, from 0 to 1. Non-finite values mean 1.
    pub alpha: f32,
}

#[allow(missing_docs)]
impl Window {
    pub fn liquid_glass_available(&self) -> bool {
        self.platform_window.liquid_glass_available()
    }

    pub fn composites_liquid_glass(&self) -> bool {
        self.platform_window.composites_liquid_glass()
            && self.platform_window.background_appearance() != WindowBackgroundAppearance::Opaque
    }

    pub fn paint_liquid_glass(&mut self, glass: PaintLiquidGlass) {
        self.invalidator.debug_assert_paint();
        let opacity = self.element_opacity();
        let alpha = native_glass_alpha(glass.alpha);
        if opacity.is_nan() || opacity <= 0. || alpha <= 0. || glass.bounds.is_empty() {
            return;
        }
        let corner_radius = glass
            .corner_radius
            .max(Pixels::ZERO)
            .min(glass.bounds.size.width.min(glass.bounds.size.height) / 2.);
        if opacity < 1. || !self.composites_liquid_glass() {
            self.with_element_opacity(Some(alpha), |window| {
                window.paint_frosted_glass(&glass, corner_radius)
            });
            return;
        }
        let id = match glass.id {
            Some(id) => id & !IMPLICIT_ID,
            None => {
                let index = self.next_frame.scene.liquid_glass_regions.len() as u64 + 1;
                let scope = self.element_id_stack.hash().as_u64();
                IMPLICIT_ID | (scope ^ index.wrapping_mul(0x9e37_79b9_7f4a_7c15))
            }
        };
        let region = LiquidGlassRegion {
            id,
            order: 0,
            bounds: self.snap_bounds(glass.bounds),
            content_mask: self.snapped_content_mask().bounds,
            corner_radius: corner_radius.scale(self.scale_factor()),
            tint: glass.tint,
            style: glass.style,
            group_id: glass.group_id,
            alpha,
        };
        self.next_frame.scene.insert_liquid_glass(region);
    }

    fn paint_frosted_glass(&mut self, glass: &PaintLiquidGlass, corner_radius: Pixels) {
        let dark = matches!(
            self.appearance(),
            WindowAppearance::Dark | WindowAppearance::VibrantDark
        );
        let look = FrostedLook::new(dark, glass.style);
        let bounds = glass.bounds;
        let corners = Corners::all(corner_radius);
        self.paint_quad(quad(
            bounds,
            corners,
            linear_gradient(
                180.,
                linear_color_stop(look.top, 0.),
                linear_color_stop(look.bottom, 1.),
            ),
            Edges::default(),
            transparent_black(),
            BorderStyle::Solid,
        ));
        if let Some(tint) = glass.tint {
            self.paint_quad(fill(bounds, Hsla::from(tint)).corner_radii(corners));
        }
        self.paint_inset_shadows(
            bounds,
            corners,
            &[BoxShadow {
                color: look.glow,
                offset: point(px(0.), px(1.)),
                blur_radius: px(1.),
                spread_radius: px(0.),
                inset: true,
            }],
        );
        if let Ok(rim) = rim_path(bounds, corner_radius) {
            self.paint_path(
                rim,
                linear_gradient(
                    135.,
                    linear_color_stop(look.rim_start, 0.),
                    linear_color_stop(look.rim_end, 1.),
                ),
            );
        }
    }
}

fn native_glass_alpha(alpha: f32) -> f32 {
    if alpha.is_finite() {
        alpha.clamp(0., 1.)
    } else {
        1.
    }
}

struct FrostedLook {
    top: Hsla,
    bottom: Hsla,
    rim_start: Hsla,
    rim_end: Hsla,
    glow: Hsla,
}

impl FrostedLook {
    fn new(dark: bool, style: LiquidGlassStyle) -> Self {
        let white = |alpha| hsla(0., 0., 1., alpha);
        let frost = match style {
            LiquidGlassStyle::Regular => 1.,
            LiquidGlassStyle::Clear => 0.5,
        };
        if dark {
            Self {
                top: white(0.16 * frost),
                bottom: white(0.07 * frost),
                rim_start: white(0.46),
                rim_end: white(0.06),
                glow: white(0.14 * frost),
            }
        } else {
            Self {
                top: white(0.68 * frost),
                bottom: white(0.46 * frost),
                rim_start: white(0.95),
                rim_end: hsla(0., 0., 0., 0.1),
                glow: white(0.6 * frost),
            }
        }
    }
}

fn rim_path(bounds: Bounds<Pixels>, corner_radius: Pixels) -> anyhow::Result<Path> {
    let inset = px(0.5);
    let (left, top) = (bounds.left() + inset, bounds.top() + inset);
    let (right, bottom) = (bounds.right() - inset, bounds.bottom() - inset);
    let radius = (corner_radius - inset).max(Pixels::ZERO);
    let radii = point(radius, radius);
    let mut builder = PathBuilder::stroke(px(1.));
    builder.move_to(point(left + radius, top));
    builder.line_to(point(right - radius, top));
    builder.arc_to(radii, px(0.), false, true, point(right, top + radius));
    builder.line_to(point(right, bottom - radius));
    builder.arc_to(radii, px(0.), false, true, point(right - radius, bottom));
    builder.line_to(point(left + radius, bottom));
    builder.arc_to(radii, px(0.), false, true, point(left, bottom - radius));
    builder.line_to(point(left, top + radius));
    builder.arc_to(radii, px(0.), false, true, point(left + radius, top));
    builder.close();
    builder.build()
}
