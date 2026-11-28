use super::{DrawOrder, PaintNativeView, PaintOperation, PrimitiveKind, Scene};
use crate::{Bounds, ContentMask, Corners, ScaledPixels, point};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use smallvec::SmallVec;

/// The material a [`VisualEffectRegion`] is drawn with, matching AppKit's
/// `NSVisualEffectMaterial`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum VisualEffectMaterial {
    /// The material of a window's titlebar.
    Titlebar,
    /// The material of selected content.
    Selection,
    /// The material of a menu.
    Menu,
    /// The material of a popover.
    Popover,
    /// The material of a sidebar.
    Sidebar,
    /// The material of a table's or list's header.
    HeaderView,
    /// The material of a sheet.
    Sheet,
    /// The material of a window's background.
    #[default]
    WindowBackground,
    /// The material of a heads-up display window.
    HudWindow,
    /// The material of full-screen modal interface.
    FullScreenUi,
    /// The material of a tooltip.
    ToolTip,
    /// The material of opaque content backgrounds.
    ContentBackground,
    /// The material shown beneath a window's background.
    UnderWindowBackground,
    /// The material shown beneath a document's pages.
    UnderPageBackground,
}

impl VisualEffectMaterial {
    /// Every material, in the order AppKit numbers them.
    pub const ALL: [Self; 14] = [
        Self::Titlebar,
        Self::Selection,
        Self::Menu,
        Self::Popover,
        Self::Sidebar,
        Self::HeaderView,
        Self::Sheet,
        Self::WindowBackground,
        Self::HudWindow,
        Self::FullScreenUi,
        Self::ToolTip,
        Self::ContentBackground,
        Self::UnderWindowBackground,
        Self::UnderPageBackground,
    ];
}

/// What a [`VisualEffectRegion`] blurs, matching AppKit's
/// `NSVisualEffectBlendingMode`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum VisualEffectBlending {
    /// Blurs what is behind the window, such as the desktop.
    #[default]
    BehindWindow,
    /// Blurs the window's own views beneath the region.
    WithinWindow,
}

/// Whether a [`VisualEffectRegion`] looks active, matching AppKit's
/// `NSVisualEffectState`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum VisualEffectState {
    /// Looks active while its window is key.
    #[default]
    FollowsWindowActiveState,
    /// Always looks active.
    Active,
    /// Always looks inactive.
    Inactive,
}

/// Where the platform shows a system material, such as an
/// `NSVisualEffectView` on macOS, beneath the window's content.
///
/// Like a native view, the region erases what was painted before it and is
/// covered by what is painted after it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VisualEffectRegion {
    /// Identifies the region from frame to frame, so its platform view is reused.
    pub id: u64,
    /// The region's position among the scene's other primitives.
    pub order: DrawOrder,
    /// Where the region is laid out, before clipping.
    pub bounds: Bounds<ScaledPixels>,
    /// The clip applied to the region.
    pub content_mask: Bounds<ScaledPixels>,
    /// The radius of each corner, clamped to fit the bounds.
    pub corner_radii: Corners<ScaledPixels>,
    /// The material shown.
    pub material: VisualEffectMaterial,
    /// What the material blurs.
    pub blending: VisualEffectBlending,
    /// Whether the material looks active.
    pub state: VisualEffectState,
    /// Whether the material uses its emphasized look.
    pub emphasized: bool,
}

impl VisualEffectRegion {
    /// The part of the region its content mask leaves visible.
    pub fn visible_bounds(&self) -> Bounds<ScaledPixels> {
        self.bounds.intersect(&self.content_mask)
    }

    /// Whether the content mask hides part of the region.
    pub fn is_clipped(&self) -> bool {
        self.visible_bounds() != self.bounds
    }
}

impl Scene {
    /// Adds a region where the platform shows a system material, in paint order.
    pub fn insert_visual_effect(&mut self, region: VisualEffectRegion) {
        if region.visible_bounds().is_empty() {
            return;
        }
        if let Some(&layer) = self.layer_stack.last()
            && let Some(layer) = self.layers.get_mut(layer)
        {
            layer.bounds = layer.bounds.join(&region.visible_bounds());
            layer.has_native_view = true;
            let index = self.paint_operations.len();
            match layer.primitives.last_mut() {
                Some(range) if range.end == index => range.end += 1,
                _ => layer.primitives.push(index..index + 1),
            }
        } else {
            self.place_visual_effect(region);
        }
        self.paint_operations
            .push(PaintOperation::VisualEffect(region));
    }

    pub(super) fn place_visual_effect(&mut self, mut region: VisualEffectRegion) {
        region.order = self.primitive_bounds.insert(
            region.visible_bounds(),
            PrimitiveKind::NativeView,
            PrimitiveKind::Surface,
        );
        let content_mask = ContentMask {
            bounds: region.content_mask,
        };
        for bounds in rounded_cutouts(region.bounds, region.corner_radii) {
            if bounds.intersects(&region.content_mask) {
                self.native_views
                    .push(PaintNativeView::cutout(region.order, bounds, content_mask));
            }
        }
        self.visual_effect_regions.push(region);
    }
}

/// Rectangles that together cover a rounded rectangle from inside, so that
/// erasing them leaves what was painted beyond its corners.
fn rounded_cutouts(
    bounds: Bounds<ScaledPixels>,
    corner_radii: Corners<ScaledPixels>,
) -> SmallVec<[Bounds<ScaledPixels>; 32]> {
    let mut cutouts = SmallVec::new();
    if bounds.is_empty() {
        return cutouts;
    }
    let (left, top) = (bounds.left().0, bounds.top().0);
    let (right, bottom) = (bounds.right().0, bounds.bottom().0);
    let limit = (right - left).min(bottom - top) / 2.;
    let radius = |corner: ScaledPixels| {
        if corner.0.is_nan() || corner.0 < 1. {
            0.
        } else {
            corner.0.min(limit)
        }
    };
    let [top_left, top_right, bottom_right, bottom_left] = [
        radius(corner_radii.top_left),
        radius(corner_radii.top_right),
        radius(corner_radii.bottom_right),
        radius(corner_radii.bottom_left),
    ];
    let inset = |radius: f32, row: f32| {
        if row >= radius {
            0.
        } else {
            let distance = radius - row;
            (radius - (radius * radius - distance * distance).max(0.).sqrt()).ceil()
        }
    };
    let bands = |first: f32, second: f32| {
        let depth = first.max(second);
        let mut bands: SmallVec<[(f32, f32, f32, f32); 16]> = SmallVec::new();
        for row in 0..depth.ceil() as u32 {
            let start = row as f32;
            let end = (start + 1.).min(depth);
            let insets = (inset(first, start), inset(second, start));
            match bands.last_mut() {
                Some(band) if (band.2, band.3) == insets => band.1 = end,
                _ => bands.push((start, end, insets.0, insets.1)),
            }
        }
        (depth, bands)
    };
    let mut push = |top: f32, bottom: f32, left_inset: f32, right_inset: f32| {
        if bottom > top && right - right_inset > left + left_inset {
            cutouts.push(Bounds::from_corners(
                point(ScaledPixels(left + left_inset), ScaledPixels(top)),
                point(ScaledPixels(right - right_inset), ScaledPixels(bottom)),
            ));
        }
    };
    let (top_depth, top_bands) = bands(top_left, top_right);
    let (bottom_depth, bottom_bands) = bands(bottom_left, bottom_right);
    for &(start, end, left_inset, right_inset) in &top_bands {
        push(top + start, top + end, left_inset, right_inset);
    }
    push(top + top_depth, bottom - bottom_depth, 0., 0.);
    for &(start, end, left_inset, right_inset) in bottom_bands.iter().rev() {
        push(bottom - end, bottom - start, left_inset, right_inset);
    }
    cutouts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::size;

    fn bounds(x: f32, y: f32, width: f32, height: f32) -> Bounds<ScaledPixels> {
        Bounds {
            origin: point(ScaledPixels(x), ScaledPixels(y)),
            size: size(ScaledPixels(width), ScaledPixels(height)),
        }
    }

    fn region(id: u64, x: f32) -> VisualEffectRegion {
        VisualEffectRegion {
            id,
            order: 0,
            bounds: bounds(x, 0., 10., 10.),
            content_mask: bounds(-100., -100., 400., 400.),
            corner_radii: Corners::default(),
            material: VisualEffectMaterial::Sidebar,
            blending: VisualEffectBlending::BehindWindow,
            state: VisualEffectState::FollowsWindowActiveState,
            emphasized: false,
        }
    }

    fn corners(
        top_left: f32,
        top_right: f32,
        bottom_right: f32,
        bottom_left: f32,
    ) -> Corners<ScaledPixels> {
        Corners {
            top_left: ScaledPixels(top_left),
            top_right: ScaledPixels(top_right),
            bottom_right: ScaledPixels(bottom_right),
            bottom_left: ScaledPixels(bottom_left),
        }
    }

    #[test]
    fn visual_effects_are_clipped_dropped_when_unseen_and_replayed() {
        let mut scene = Scene::default();
        let mut hidden = region(1, 0.);
        hidden.content_mask = bounds(50., 50., 10., 10.);
        scene.insert_visual_effect(hidden);
        let mut clipped = region(2, 0.);
        clipped.content_mask = bounds(4., 0., 100., 100.);
        scene.insert_visual_effect(clipped);
        scene.finish();
        assert_eq!(scene.visual_effect_regions.len(), 1);
        let shown = scene.visual_effect_regions[0];
        assert_eq!(shown.id, 2);
        assert!(shown.is_clipped());
        assert_eq!(shown.visible_bounds(), bounds(4., 0., 6., 10.));
        assert_eq!(scene.attached_native_views().count(), 0);
        assert!(!scene.native_views.is_empty());

        let mut replayed = Scene::default();
        replayed.replay(0..scene.len(), &scene);
        replayed.finish();
        assert_eq!(replayed.visual_effect_regions, scene.visual_effect_regions);
        assert_eq!(replayed.native_views.len(), scene.native_views.len());
    }

    #[test]
    fn visual_effects_stack_with_glass_and_native_views_in_paint_order() {
        let mut scene = Scene::default();
        scene.insert_visual_effect(region(1, 0.));
        scene.insert_liquid_glass(crate::LiquidGlassRegion {
            id: 2,
            order: 0,
            bounds: bounds(0., 0., 10., 10.),
            content_mask: bounds(-100., -100., 400., 400.),
            corner_radius: ScaledPixels(0.),
            tint: None,
            style: crate::LiquidGlassStyle::Regular,
            group_id: None,
            alpha: 1.,
        });
        scene.push_layer();
        scene.insert_visual_effect(region(3, 0.));
        scene.pop_layer();
        scene.finish();
        let effects = &scene.visual_effect_regions;
        let glass = scene.liquid_glass_regions[0];
        assert_eq!(effects.len(), 2);
        assert!(effects[0].order < glass.order);
        assert!(effects[1].order > glass.order);
        assert_eq!(effects[1].id, 3);
    }

    #[test]
    fn rounded_cutouts_cover_each_corner_from_inside() {
        let frame = bounds(10., 20., 120., 80.);
        let radii = corners(24., 0., 8., 40.);
        let cutouts = rounded_cutouts(frame, radii);
        let inside = |x: f32, y: f32| {
            let (left, top, right, bottom) = (10., 20., 130., 100.);
            let corner = |radius: f32, cx: f32, cy: f32, in_x: bool, in_y: bool| {
                !(in_x && in_y) || (x - cx).powi(2) + (y - cy).powi(2) <= radius * radius + 1e-3
            };
            corner(24., left + 24., top + 24., x < left + 24., y < top + 24.)
                && corner(8., right - 8., bottom - 8., x > right - 8., y > bottom - 8.)
                && corner(
                    40.,
                    left + 40.,
                    bottom - 40.,
                    x < left + 40.,
                    y > bottom - 40.,
                )
        };
        let mut area = 0.;
        for cutout in &cutouts {
            for (x, y) in [
                (cutout.left().0, cutout.top().0),
                (cutout.right().0, cutout.top().0),
                (cutout.left().0, cutout.bottom().0),
                (cutout.right().0, cutout.bottom().0),
            ] {
                assert!(inside(x, y), "{cutout:?} leaves the rounded shape");
            }
            area += cutout.size.width.0 * cutout.size.height.0;
        }
        for (index, cutout) in cutouts.iter().enumerate() {
            for other in &cutouts[index + 1..] {
                assert!(cutout.intersect(other).is_empty());
            }
        }
        let corner_area = |radius: f32| (1. - std::f32::consts::PI / 4.) * radius * radius;
        let shape = 120. * 80. - corner_area(24.) - corner_area(8.) - corner_area(40.);
        assert!(area > shape * 0.97, "{area} of {shape}");
        assert!(area <= shape + 1e-3);

        assert_eq!(
            rounded_cutouts(frame, Corners::default()).as_slice(),
            [frame]
        );
        assert_eq!(
            rounded_cutouts(frame, corners(f32::NAN, 0.5, 0., 0.)).as_slice(),
            [frame]
        );
        assert!(rounded_cutouts(bounds(0., 0., 0., 10.), radii).is_empty());
    }
}
