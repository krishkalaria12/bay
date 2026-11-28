use super::{
    liquid_glass::{Pool, PoolOps, new_layer, set_layer_color, transparent_class},
    native_views::set_rounded_path,
};
use gpui::{
    DrawOrder, ScaledPixels, VisualEffectBlending, VisualEffectMaterial, VisualEffectRegion,
    VisualEffectState,
};
use objc2::{
    class, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool},
};
use objc2_app_kit::{
    NSColor, NSView, NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState,
    NSVisualEffectView, NSWindowOrderingMode,
};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use std::sync::OnceLock;

fn effect_class() -> &'static AnyClass {
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    CLASS.get_or_init(|| transparent_class(c"GPUIVisualEffectView", class!(NSVisualEffectView)))
}

pub(super) fn ns_material(material: VisualEffectMaterial) -> NSVisualEffectMaterial {
    match material {
        VisualEffectMaterial::Titlebar => NSVisualEffectMaterial::Titlebar,
        VisualEffectMaterial::Selection => NSVisualEffectMaterial::Selection,
        VisualEffectMaterial::Menu => NSVisualEffectMaterial::Menu,
        VisualEffectMaterial::Popover => NSVisualEffectMaterial::Popover,
        VisualEffectMaterial::Sidebar => NSVisualEffectMaterial::Sidebar,
        VisualEffectMaterial::HeaderView => NSVisualEffectMaterial::HeaderView,
        VisualEffectMaterial::Sheet => NSVisualEffectMaterial::Sheet,
        VisualEffectMaterial::WindowBackground => NSVisualEffectMaterial::WindowBackground,
        VisualEffectMaterial::HudWindow => NSVisualEffectMaterial::HUDWindow,
        VisualEffectMaterial::FullScreenUi => NSVisualEffectMaterial::FullScreenUI,
        VisualEffectMaterial::ToolTip => NSVisualEffectMaterial::ToolTip,
        VisualEffectMaterial::ContentBackground => NSVisualEffectMaterial::ContentBackground,
        VisualEffectMaterial::UnderWindowBackground => {
            NSVisualEffectMaterial::UnderWindowBackground
        }
        VisualEffectMaterial::UnderPageBackground => NSVisualEffectMaterial::UnderPageBackground,
    }
}

pub(super) fn ns_blending(blending: VisualEffectBlending) -> NSVisualEffectBlendingMode {
    match blending {
        VisualEffectBlending::BehindWindow => NSVisualEffectBlendingMode::BehindWindow,
        VisualEffectBlending::WithinWindow => NSVisualEffectBlendingMode::WithinWindow,
    }
}

pub(super) fn ns_state(state: VisualEffectState) -> NSVisualEffectState {
    match state {
        VisualEffectState::FollowsWindowActiveState => {
            NSVisualEffectState::FollowsWindowActiveState
        }
        VisualEffectState::Active => NSVisualEffectState::Active,
        VisualEffectState::Inactive => NSVisualEffectState::Inactive,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum EffectMask {
    Square,
    Rounded {
        radius: f64,
        corners: usize,
    },
    Shaped {
        clip: [f64; 4],
        size: [f64; 2],
        radii: [f64; 4],
    },
}

impl EffectMask {
    pub(super) fn new(size: [f64; 2], clip: Option<[f64; 4]>, radii: [f64; 4]) -> Self {
        let [width, height] = size;
        let limit = (width.min(height) / 2.).max(0.);
        let radii = radii.map(|radius| {
            if radius.is_finite() {
                radius.clamp(0., limit)
            } else {
                0.
            }
        });
        let radius = radii.into_iter().fold(0., f64::max);
        let uniform = radii
            .iter()
            .all(|corner| *corner == 0. || *corner == radius);
        match clip {
            None if radius == 0. => Self::Square,
            None if uniform => Self::Rounded {
                radius,
                corners: radii
                    .into_iter()
                    .zip([4, 8, 2, 1])
                    .filter(|(corner, _)| *corner > 0.)
                    .fold(0, |corners, (_, corner)| corners | corner),
            },
            clip => Self::Shaped {
                clip: clip.unwrap_or([0., 0., width, height]),
                size,
                radii,
            },
        }
    }

    fn apply(self, view: &NSView) {
        let layer: Option<Retained<AnyObject>> = unsafe { msg_send![view, layer] };
        let Some(layer) = layer else {
            return;
        };
        let continuous = NSString::from_str("continuous");
        unsafe {
            let (radius, corners, mask) = match self {
                Self::Square => (0., 15, None),
                Self::Rounded { radius, corners } => (radius, corners, None),
                Self::Shaped { clip, size, radii } => {
                    let mask = new_layer();
                    let _: () = msg_send![&*mask, setFrame: rect(clip)];
                    let _: () = msg_send![&*mask, setMasksToBounds: Bool::YES];
                    if radii.iter().all(|radius| *radius == 0.) {
                        set_layer_color(&mask, Some(&NSColor::blackColor()));
                    } else {
                        let shape: Retained<AnyObject> = msg_send![class!(CAShapeLayer), layer];
                        let [width, height] = size;
                        let _: () = msg_send![
                            &*shape,
                            setFrame: rect([-clip[0], -clip[1], width, height])
                        ];
                        set_rounded_path(&shape, [0., 0., width, height], radii);
                        let _: () = msg_send![&*mask, addSublayer: &*shape];
                    }
                    (0., 15, Some(mask))
                }
            };
            let _: () = msg_send![&*layer, setCornerRadius: radius];
            let _: () = msg_send![&*layer, setCornerCurve: &*continuous];
            let _: () = msg_send![&*layer, setMaskedCorners: corners];
            let _: () = msg_send![&*layer, setMasksToBounds: Bool::new(radius > 0.)];
            let _: () = msg_send![&*layer, setMask: mask.as_deref()];
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct EffectPlacement {
    pub(super) frame: [f64; 4],
    pub(super) mask: EffectMask,
    pub(super) material: VisualEffectMaterial,
    pub(super) blending: VisualEffectBlending,
    pub(super) state: VisualEffectState,
    pub(super) emphasized: bool,
}

impl EffectPlacement {
    pub(super) fn new(
        region: &VisualEffectRegion,
        scale_factor: f64,
        gpui_frame: [f64; 4],
    ) -> Option<Self> {
        let points = |value: ScaledPixels| f64::from(value) / scale_factor;
        let [gpui_x, gpui_y, _, gpui_height] = gpui_frame;
        let bounds = region.bounds;
        let (x, top) = (points(bounds.origin.x), points(bounds.origin.y));
        let (width, height) = (points(bounds.size.width), points(bounds.size.height));
        let frame = [
            gpui_x + x,
            gpui_y + gpui_height - top - height,
            width,
            height,
        ];
        if !frame.iter().all(|value| value.is_finite()) {
            return None;
        }
        let clip = region.is_clipped().then(|| {
            let visible = region.visible_bounds();
            let visible_height = points(visible.size.height);
            [
                points(visible.origin.x) - x,
                top + height - points(visible.origin.y) - visible_height,
                points(visible.size.width),
                visible_height,
            ]
        });
        let radii = region.corner_radii;
        let radii = [
            radii.top_left,
            radii.top_right,
            radii.bottom_right,
            radii.bottom_left,
        ]
        .map(points);
        Some(Self {
            frame,
            mask: EffectMask::new([width, height], clip, radii),
            material: region.material,
            blending: region.blending,
            state: region.state,
            emphasized: region.emphasized,
        })
    }
}

#[derive(Default, Debug, PartialEq)]
pub(super) struct EffectLayout {
    regions: Vec<(u64, DrawOrder, EffectPlacement)>,
}

impl EffectLayout {
    pub(super) fn new(
        regions: &[VisualEffectRegion],
        scale_factor: f64,
        gpui_frame: [f64; 4],
    ) -> Self {
        Self {
            regions: regions
                .iter()
                .filter_map(|region| {
                    let placement = EffectPlacement::new(region, scale_factor, gpui_frame)?;
                    Some((region.id, region.order, placement))
                })
                .collect(),
        }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.regions.is_empty()
    }
}

#[derive(Default)]
pub(super) struct EffectHost {
    views: Pool<Retained<NSView>, u64, EffectPlacement>,
}

impl EffectHost {
    pub(super) fn sync(
        &mut self,
        layout: &EffectLayout,
        host: &NSView,
        gpui_view: &NSView,
    ) -> Vec<(DrawOrder, Retained<NSView>)> {
        let wanted = layout
            .regions
            .iter()
            .map(|(id, _, placement)| (*id, *placement))
            .collect::<Vec<_>>();
        let views = self.views.sync(&wanted, &mut EffectOps { host, gpui_view });
        layout
            .regions
            .iter()
            .zip(views)
            .map(|((_, order, _), view)| (*order, view))
            .collect()
    }

    pub(super) fn is_idle(&self) -> bool {
        self.views.is_idle()
    }

    pub(super) fn owned_views(&self) -> impl Iterator<Item = &Retained<NSView>> {
        self.views.views()
    }

    pub(super) fn remove(self) {
        for view in self.owned_views() {
            view.removeFromSuperview();
        }
    }
}

struct EffectOps<'a> {
    host: &'a NSView,
    gpui_view: &'a NSView,
}

impl PoolOps<Retained<NSView>, EffectPlacement> for EffectOps<'_> {
    fn create(&mut self) -> Retained<NSView> {
        let frame = NSRect::new(NSPoint::new(0., 0.), NSSize::new(0., 0.));
        let view: Retained<NSView> =
            unsafe { msg_send![msg_send![effect_class(), alloc], initWithFrame: frame] };
        view.setWantsLayer(true);
        view.setHidden(true);
        view
    }

    fn apply(
        &mut self,
        view: &Retained<NSView>,
        placement: &EffectPlacement,
        previous: Option<&EffectPlacement>,
    ) {
        if unsafe { view.superview() }.is_none() {
            self.host.addSubview_positioned_relativeTo(
                view,
                NSWindowOrderingMode::Below,
                Some(self.gpui_view),
            );
        }
        if previous.is_none_or(|previous| previous.frame != placement.frame) {
            view.setFrame(rect(placement.frame));
        }
        if let Some(effect) = view.downcast_ref::<NSVisualEffectView>() {
            if previous.is_none_or(|previous| previous.material != placement.material) {
                effect.setMaterial(ns_material(placement.material));
            }
            if previous.is_none_or(|previous| previous.blending != placement.blending) {
                effect.setBlendingMode(ns_blending(placement.blending));
            }
            if previous.is_none_or(|previous| previous.state != placement.state) {
                effect.setState(ns_state(placement.state));
            }
            if previous.is_none_or(|previous| previous.emphasized != placement.emphasized) {
                effect.setEmphasized(placement.emphasized);
            }
        }
        if previous.is_none_or(|previous| previous.mask != placement.mask) {
            placement.mask.apply(view);
        }
    }

    fn show(&mut self, view: &Retained<NSView>) {
        view.setHidden(false);
    }

    fn hide(&mut self, view: &Retained<NSView>) {
        view.setHidden(true);
    }

    fn discard(&mut self, view: Retained<NSView>) {
        view.removeFromSuperview();
    }
}

fn rect([x, y, width, height]: [f64; 4]) -> NSRect {
    NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{Bounds, Corners, point, size};

    fn region(x: f32, radii: [f32; 4]) -> VisualEffectRegion {
        VisualEffectRegion {
            id: 1,
            order: 1,
            bounds: Bounds {
                origin: point(ScaledPixels(x), ScaledPixels(40.)),
                size: size(ScaledPixels(100.), ScaledPixels(60.)),
            },
            content_mask: Bounds {
                origin: point(ScaledPixels(0.), ScaledPixels(0.)),
                size: size(ScaledPixels(800.), ScaledPixels(600.)),
            },
            corner_radii: Corners {
                top_left: ScaledPixels(radii[0]),
                top_right: ScaledPixels(radii[1]),
                bottom_right: ScaledPixels(radii[2]),
                bottom_left: ScaledPixels(radii[3]),
            },
            material: VisualEffectMaterial::HudWindow,
            blending: VisualEffectBlending::WithinWindow,
            state: VisualEffectState::Active,
            emphasized: true,
        }
    }

    #[test]
    fn materials_blending_and_states_map_to_appkit_values() {
        let raw = VisualEffectMaterial::ALL.map(|material| ns_material(material).0);
        assert_eq!(raw, [3, 4, 5, 6, 7, 10, 11, 12, 13, 15, 17, 18, 21, 22]);
        assert_eq!(ns_blending(VisualEffectBlending::BehindWindow).0, 0);
        assert_eq!(ns_blending(VisualEffectBlending::WithinWindow).0, 1);
        assert_eq!(ns_state(VisualEffectState::FollowsWindowActiveState).0, 0);
        assert_eq!(ns_state(VisualEffectState::Active).0, 1);
        assert_eq!(ns_state(VisualEffectState::Inactive).0, 2);
    }

    #[test]
    fn placement_converts_device_pixels_to_flipped_points() {
        let placement =
            EffectPlacement::new(&region(60., [0.; 4]), 2., [0., 10., 400., 300.]).unwrap();
        assert_eq!(placement.frame, [30., 260., 50., 30.]);
        assert_eq!(placement.mask, EffectMask::Square);
        assert_eq!(placement.material, VisualEffectMaterial::HudWindow);
        assert!(placement.emphasized);

        let mut broken = region(60., [0.; 4]);
        broken.bounds.size.width = ScaledPixels(f32::NAN);
        assert_eq!(
            EffectPlacement::new(&broken, 2., [0., 0., 400., 300.]),
            None
        );
    }

    #[test]
    fn corner_masks_round_whole_views_and_shape_uneven_or_clipped_ones() {
        let rounded = EffectPlacement::new(&region(0., [20., 20., 0., 0.]), 2., [0.; 4]).unwrap();
        assert_eq!(
            rounded.mask,
            EffectMask::Rounded {
                radius: 10.,
                corners: 4 | 8
            }
        );

        let uneven = EffectPlacement::new(&region(0., [20., 8., 400., 0.]), 2., [0.; 4]).unwrap();
        assert_eq!(
            uneven.mask,
            EffectMask::Shaped {
                clip: [0., 0., 50., 30.],
                size: [50., 30.],
                radii: [10., 4., 15., 0.],
            }
        );

        let mut clipped = region(60., [20.; 4]);
        clipped.content_mask = Bounds {
            origin: point(ScaledPixels(80.), ScaledPixels(60.)),
            size: size(ScaledPixels(800.), ScaledPixels(600.)),
        };
        let clipped = EffectPlacement::new(&clipped, 2., [0., 0., 400., 300.]).unwrap();
        assert_eq!(
            clipped.mask,
            EffectMask::Shaped {
                clip: [10., 0., 40., 20.],
                size: [50., 30.],
                radii: [10.; 4],
            }
        );

        assert_eq!(
            EffectMask::new([50., 30.], None, [f64::NAN, -3., 0., 0.]),
            EffectMask::Square
        );
    }

    #[test]
    fn layout_skips_regions_it_cannot_place() {
        let mut broken = region(0., [0.; 4]);
        broken.bounds.origin.x = ScaledPixels(f32::INFINITY);
        let layout = EffectLayout::new(&[region(0., [0.; 4]), broken], 2., [0.; 4]);
        assert_eq!(layout.regions.len(), 1);
        assert!(!layout.is_empty());
        assert!(EffectLayout::new(&[], 2., [0.; 4]).is_empty());
    }
}
