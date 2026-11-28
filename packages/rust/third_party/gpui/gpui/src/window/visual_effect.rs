use crate::{
    Bounds, Corners, Pixels, VisualEffectBlending, VisualEffectMaterial, VisualEffectRegion,
    VisualEffectState, Window,
};

const IMPLICIT_ID: u64 = 1 << 63;

/// A request to show a system material beneath the window's content, made
/// while painting.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PaintVisualEffect {
    /// A stable identifier for the region, or `None` to derive one from the
    /// element painting it.
    pub id: Option<u64>,
    /// Where the material is shown.
    pub bounds: Bounds<Pixels>,
    /// The radius of each corner.
    pub corner_radii: Corners<Pixels>,
    /// The material shown.
    pub material: VisualEffectMaterial,
    /// What the material blurs.
    pub blending: VisualEffectBlending,
    /// Whether the material looks active.
    pub state: VisualEffectState,
    /// Whether the material uses its emphasized look.
    pub emphasized: bool,
}

impl Window {
    /// Whether the platform shows the system materials painted with
    /// [`Self::paint_visual_effect`].
    pub fn composites_visual_effects(&self) -> bool {
        self.platform_window.composites_visual_effects()
    }

    /// Shows a system material beneath the window's content within the given
    /// bounds, clipped to the current content mask. What is painted before it
    /// there is hidden and what is painted after it is drawn on top.
    ///
    /// Nothing is shown while the element is translucent or where the platform
    /// has no system materials.
    pub fn paint_visual_effect(&mut self, effect: PaintVisualEffect) {
        self.invalidator.debug_assert_paint();
        let opacity = self.element_opacity();
        if opacity.is_nan() || opacity < 1. || effect.bounds.is_empty() {
            return;
        }
        if !self.composites_visual_effects() {
            return;
        }
        let id = match effect.id {
            Some(id) => id & !IMPLICIT_ID,
            None => {
                let index = self.next_frame.scene.visual_effect_regions.len() as u64 + 1;
                let scope = self.element_id_stack.hash().as_u64();
                IMPLICIT_ID | (scope ^ index.wrapping_mul(0x9e37_79b9_7f4a_7c15))
            }
        };
        let corner_radii = Corners {
            top_left: effect.corner_radii.top_left.max(Pixels::ZERO),
            top_right: effect.corner_radii.top_right.max(Pixels::ZERO),
            bottom_right: effect.corner_radii.bottom_right.max(Pixels::ZERO),
            bottom_left: effect.corner_radii.bottom_left.max(Pixels::ZERO),
        }
        .clamp_radii_for_quad_size(effect.bounds.size)
        .scale(self.scale_factor());
        self.next_frame
            .scene
            .insert_visual_effect(VisualEffectRegion {
                id,
                order: 0,
                bounds: self.snap_bounds(effect.bounds),
                content_mask: self.snapped_content_mask().bounds,
                corner_radii,
                material: effect.material,
                blending: effect.blending,
                state: effect.state,
                emphasized: effect.emphasized,
            });
    }
}
