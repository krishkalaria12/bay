use crate::{
    AnyElement, App, Bounds, Corners, Div, DivFrameState, Edges, Element, ElementId,
    GlobalElementId, Hitbox, InspectorElementId, InteractiveElement, Interactivity, LayoutId,
    LiquidGlassStyle, PaintLiquidGlass, ParentElement, Pixels, Position, Rgba, Size, Stateful,
    Style, StyleRefinement, Styled, Window, div, px,
};
use std::{cell::Cell, rc::Rc};

#[allow(missing_docs)]
#[track_caller]
pub fn liquid_glass() -> LiquidGlass {
    let look = Rc::new(Cell::new(GlassLook::default()));
    LiquidGlass {
        div: div().child(GlassLayer(look.clone())),
        look,
    }
}

#[allow(missing_docs)]
pub struct LiquidGlass {
    div: Div,
    look: Rc<Cell<GlassLook>>,
}

#[derive(Clone, Copy, Default)]
struct GlassLook {
    tint: Option<Rgba>,
    style: LiquidGlassStyle,
    group_id: Option<u64>,
    alpha: Option<f32>,
    frame: Option<GlassFrame>,
}

#[derive(Clone, Copy)]
struct GlassFrame {
    id: Option<u64>,
    bounds: Bounds<Pixels>,
    corner_radius: Pixels,
}

#[allow(missing_docs)]
impl LiquidGlass {
    pub fn tint(self, tint: impl Into<Rgba>) -> Self {
        let tint = tint.into();
        self.update(|look| look.tint = Some(tint))
    }

    pub fn style(self, style: LiquidGlassStyle) -> Self {
        self.update(|look| look.style = style)
    }

    pub fn group_id(self, group_id: u64) -> Self {
        self.update(|look| look.group_id = Some(group_id))
    }

    /// Sets the alpha of the native glass view, from 0 to 1, keeping it real glass rather than
    /// the painted frost a fading element falls back to.
    pub fn alpha(self, alpha: f32) -> Self {
        self.update(|look| look.alpha = Some(alpha))
    }

    pub fn corner_radius(self, corner_radius: impl Into<Pixels>) -> Self {
        self.rounded(corner_radius.into())
    }

    fn update(self, change: impl FnOnce(&mut GlassLook)) -> Self {
        let mut look = self.look.get();
        change(&mut look);
        self.look.set(look);
        self
    }

    fn corner_radius_for(&mut self, size: Size<Pixels>, rem_size: Pixels) -> Pixels {
        let radii = &Styled::style(&mut self.div).corner_radii;
        let corners = Corners {
            top_left: radii.top_left.unwrap_or_default(),
            top_right: radii.top_right.unwrap_or_default(),
            bottom_right: radii.bottom_right.unwrap_or_default(),
            bottom_left: radii.bottom_left.unwrap_or_default(),
        }
        .to_pixels(rem_size)
        .clamp_radii_for_quad_size(size);
        corners
            .top_left
            .max(corners.top_right)
            .max(corners.bottom_right)
            .max(corners.bottom_left)
    }
}

#[allow(missing_docs)]
impl Stateful<LiquidGlass> {
    pub fn tint(mut self, tint: impl Into<Rgba>) -> Self {
        self.element = self.element.tint(tint);
        self
    }

    pub fn style(mut self, style: LiquidGlassStyle) -> Self {
        self.element = self.element.style(style);
        self
    }

    pub fn group_id(mut self, group_id: u64) -> Self {
        self.element = self.element.group_id(group_id);
        self
    }

    /// Sets the alpha of the native glass view, from 0 to 1, keeping it real glass rather than
    /// the painted frost a fading element falls back to.
    pub fn alpha(mut self, alpha: f32) -> Self {
        self.element = self.element.alpha(alpha);
        self
    }

    pub fn corner_radius(mut self, corner_radius: impl Into<Pixels>) -> Self {
        self.element = self.element.corner_radius(corner_radius);
        self
    }
}

impl Styled for LiquidGlass {
    fn style(&mut self) -> &mut StyleRefinement {
        Styled::style(&mut self.div)
    }
}

impl ParentElement for LiquidGlass {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.div.extend(elements);
    }
}

impl InteractiveElement for LiquidGlass {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.div.interactivity()
    }
}

impl Element for LiquidGlass {
    type RequestLayoutState = DivFrameState;
    type PrepaintState = Option<Hitbox>;

    fn id(&self) -> Option<ElementId> {
        Element::id(&self.div)
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        self.div.source_location()
    }

    fn a11y_role(&self) -> Option<accesskit::Role> {
        self.div.a11y_role()
    }

    fn write_a11y_info(&self, node: &mut accesskit::Node) {
        self.div.write_a11y_info(node);
    }

    fn a11y_synthetic_children(
        &mut self,
        prepaint: &mut Self::PrepaintState,
        builder: &mut crate::A11ySubtreeBuilder,
    ) {
        self.div.a11y_synthetic_children(prepaint, builder);
    }

    fn request_layout(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        self.div.request_layout(id, inspector_id, window, cx)
    }

    fn prepaint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        self.div
            .prepaint(id, inspector_id, bounds, request_layout, window, cx)
    }

    fn paint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        request_layout: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let corner_radius = self.corner_radius_for(bounds.size, window.rem_size());
        let frame = GlassFrame {
            id: id.map(GlobalElementId::path_hash),
            bounds,
            corner_radius,
        };
        let mut look = self.look.get();
        look.frame = Some(frame);
        self.look.set(look);
        self.div.paint(
            id,
            inspector_id,
            bounds,
            request_layout,
            prepaint,
            window,
            cx,
        );
    }
}

struct GlassLayer(Rc<Cell<GlassLook>>);

impl Element for GlassLayer {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let style = Style {
            position: Position::Absolute,
            inset: Edges::all(px(0.).into()),
            ..Style::default()
        };
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        _cx: &mut App,
    ) {
        let look = self.0.get();
        if let Some(frame) = look.frame {
            window.paint_liquid_glass(PaintLiquidGlass {
                id: frame.id,
                bounds: frame.bounds,
                corner_radius: frame.corner_radius,
                tint: look.tint,
                style: look.style,
                group_id: look.group_id,
                alpha: look.alpha.unwrap_or(1.),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        BackdropLayerSpec, Context, IntoElement, NativeView, Render, RequestFrameOptions,
        ScaledPixels, TestAppContext, WindowBackgroundAppearance, WindowHandle, point, prelude::*,
        rgb, rgba, size,
    };
    use std::ptr::NonNull;

    struct GlassView {
        opacity: f32,
        alpha: Option<f32>,
    }

    impl Render for GlassView {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let tile = liquid_glass()
                .absolute()
                .left(px(10.))
                .top(px(20.))
                .w(px(100.))
                .h(px(50.))
                .rounded(px(12.))
                .tint(rgba(0x33669980))
                .style(LiquidGlassStyle::Clear)
                .group_id(9)
                .child(div().size(px(10.)).bg(rgb(0xff0000)));
            div()
                .size_full()
                .opacity(self.opacity)
                .child(match self.alpha {
                    Some(alpha) => tile.alpha(alpha),
                    None => tile,
                })
                .child(
                    liquid_glass()
                        .id("named")
                        .absolute()
                        .left(px(200.))
                        .top(px(0.))
                        .size(px(40.))
                        .corner_radius(px(500.)),
                )
        }
    }

    fn open(cx: &mut TestAppContext, composites: bool) -> WindowHandle<GlassView> {
        let window = cx.add_window(|_, _| GlassView {
            opacity: 1.,
            alpha: None,
        });
        let platform_window = cx.test_window(window.into());
        platform_window.set_composites_liquid_glass(composites);
        window
            .update(cx, |_, window, _| {
                window.set_background_appearance(WindowBackgroundAppearance::LiquidGlass);
                window.refresh();
            })
            .unwrap();
        cx.run_until_parked();
        window
    }

    fn regions(
        cx: &mut TestAppContext,
        window: WindowHandle<GlassView>,
    ) -> Vec<crate::LiquidGlassRegion> {
        window
            .update(cx, |_, window, _| {
                window.rendered_frame.scene.liquid_glass_regions.clone()
            })
            .unwrap()
    }

    fn scaled(x: f32, y: f32, width: f32, height: f32) -> Bounds<ScaledPixels> {
        Bounds {
            origin: point(ScaledPixels(x), ScaledPixels(y)),
            size: size(ScaledPixels(width), ScaledPixels(height)),
        }
    }

    #[crate::test]
    fn liquid_glass_paints_frosted_glass_where_the_window_cannot_composite_it(
        cx: &mut TestAppContext,
    ) {
        let window = open(cx, false);
        window
            .update(cx, |_, window, _| {
                assert!(!window.composites_liquid_glass());
                assert!(!window.liquid_glass_available());
                let scene = &window.rendered_frame.scene;
                assert!(scene.liquid_glass_regions.is_empty());
                assert!(scene.native_views.is_empty());
                assert!(scene.quads.len() >= 3);
                assert_eq!(scene.paths.len(), 2);
                assert_eq!(scene.shadows.len(), 2);
            })
            .unwrap();
    }

    #[crate::test]
    fn liquid_glass_records_native_regions_beneath_its_children(cx: &mut TestAppContext) {
        let window = open(cx, true);
        let regions = regions(cx, window);
        assert_eq!(regions.len(), 2);
        let tile = regions[0];
        assert_eq!(tile.bounds, scaled(20., 40., 200., 100.));
        assert_eq!(tile.corner_radius, ScaledPixels(24.));
        assert_eq!(tile.tint, Some(rgba(0x33669980)));
        assert_eq!(tile.style, LiquidGlassStyle::Clear);
        assert_eq!(tile.group_id, Some(9));
        assert_ne!(tile.id & (1 << 63), 0);

        let named = regions[1];
        assert_eq!(named.bounds, scaled(400., 0., 80., 80.));
        assert_eq!(named.corner_radius, ScaledPixels(40.));
        assert_eq!(named.id & (1 << 63), 0);

        window
            .update(cx, |_, window, _| {
                let scene = &window.rendered_frame.scene;
                assert!(scene.quads.iter().all(|quad| quad.order > tile.order));
                assert!(scene.paths.is_empty());
                assert_eq!(scene.attached_native_views().count(), 0);
            })
            .unwrap();
    }

    #[crate::test]
    fn fading_liquid_glass_is_frosted_until_it_is_opaque_again(cx: &mut TestAppContext) {
        let window = open(cx, true);
        let set_opacity = |cx: &mut TestAppContext, opacity: f32| {
            window
                .update(cx, |view, _, cx| {
                    view.opacity = opacity;
                    cx.notify();
                })
                .unwrap();
            cx.run_until_parked();
        };
        let opaque = regions(cx, window);

        set_opacity(cx, 0.01);
        assert!(regions(cx, window).is_empty());
        window
            .update(cx, |_, window, _| {
                let scene = &window.rendered_frame.scene;
                assert!(scene.native_views.is_empty());
                assert_eq!(scene.paths.len(), 2);
            })
            .unwrap();

        set_opacity(cx, 1.);
        assert_eq!(
            opaque.iter().map(|region| region.id).collect::<Vec<_>>(),
            regions(cx, window)
                .iter()
                .map(|region| region.id)
                .collect::<Vec<_>>()
        );
    }

    #[crate::test]
    fn native_glass_alpha_reaches_the_platform_as_real_glass(cx: &mut TestAppContext) {
        let window = open(cx, true);
        let platform_window = cx.test_window(window.into());
        let set_look = |cx: &mut TestAppContext, opacity: f32, alpha: Option<f32>| {
            window
                .update(cx, |view, _, cx| {
                    view.opacity = opacity;
                    view.alpha = alpha;
                    cx.notify();
                })
                .unwrap();
            cx.run_until_parked();
        };
        let alphas = |cx: &mut TestAppContext| {
            platform_window.simulate_frame_request(RequestFrameOptions {
                require_presentation: true,
                ..RequestFrameOptions::default()
            });
            let regions = regions(cx, window);
            assert_eq!(regions, platform_window.liquid_glass());
            regions
                .iter()
                .map(|region| region.alpha)
                .collect::<Vec<_>>()
        };
        let opaque = regions(cx, window);
        assert_eq!(alphas(cx), [1., 1.]);

        set_look(cx, 1., Some(0.5));
        assert_eq!(alphas(cx), [0.5, 1.]);
        let faint = regions(cx, window);
        assert_eq!(
            faint
                .iter()
                .map(|region| (region.id, region.bounds, region.group_id))
                .collect::<Vec<_>>(),
            opaque
                .iter()
                .map(|region| (region.id, region.bounds, region.group_id))
                .collect::<Vec<_>>()
        );
        window
            .update(cx, |_, window, _| {
                let scene = &window.rendered_frame.scene;
                assert!(scene.paths.is_empty());
                assert!(!scene.native_views.is_empty());
            })
            .unwrap();

        set_look(cx, 1., Some(4.));
        assert_eq!(alphas(cx), [1., 1.]);
        set_look(cx, 1., Some(f32::NAN));
        assert_eq!(alphas(cx), [1., 1.]);
        set_look(cx, 1., Some(-1.));
        assert_eq!(alphas(cx), [1.]);

        set_look(cx, 0.5, Some(0.5));
        assert!(alphas(cx).is_empty());
        window
            .update(cx, |_, window, _| {
                assert_eq!(window.rendered_frame.scene.paths.len(), 2);
            })
            .unwrap();

        set_look(cx, 1., None);
        assert_eq!(regions(cx, window), opaque);
    }

    #[crate::test]
    fn opaque_windows_paint_frosted_glass_even_when_the_platform_composites(
        cx: &mut TestAppContext,
    ) {
        let window = open(cx, true);
        window
            .update(cx, |_, window, _| {
                window.set_background_appearance(WindowBackgroundAppearance::Opaque);
                window.refresh();
            })
            .unwrap();
        cx.run_until_parked();
        assert!(regions(cx, window).is_empty());
    }

    struct ClippedGlassView {
        opacity: f32,
    }

    impl Render for ClippedGlassView {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let favicon = std::sync::Arc::new(crate::RenderImage::new([image::Frame::new(
                image::RgbaImage::from_pixel(4, 4, image::Rgba([0, 0, 0, 255])),
            )]));
            div().size_full().child(
                div()
                    .absolute()
                    .left(px(0.))
                    .top(px(0.))
                    .size(px(100.))
                    .overflow_hidden()
                    .opacity(self.opacity)
                    .child(
                        liquid_glass()
                            .absolute()
                            .left(px(60.))
                            .top(px(10.))
                            .w(px(80.))
                            .h(px(40.))
                            .rounded(px(8.))
                            .group_id(9)
                            .child(crate::img(favicon).w(px(80.)).h(px(40.))),
                    ),
            )
        }
    }

    #[crate::test]
    fn liquid_glass_and_what_is_painted_above_it_are_clipped_by_the_parent(
        cx: &mut TestAppContext,
    ) {
        for (composites, opacity) in [(true, 1.), (false, 1.), (true, 0.5)] {
            let window = cx.add_window(|_, _| ClippedGlassView { opacity });
            cx.test_window(window.into())
                .set_composites_liquid_glass(composites);
            window
                .update(cx, |_, window, _| {
                    window.set_background_appearance(WindowBackgroundAppearance::LiquidGlass);
                    window.refresh();
                })
                .unwrap();
            cx.run_until_parked();
            window
                .update(cx, |_, window, _| {
                    let scale = window.scale_factor();
                    let parent = scaled(0., 0., 100. * scale, 100. * scale);
                    let inside = |mask: &Bounds<ScaledPixels>| {
                        mask.intersect(&parent) == *mask && !mask.is_empty()
                    };
                    let scene = &window.rendered_frame.scene;
                    if composites && opacity == 1. {
                        assert_eq!(scene.liquid_glass_regions.len(), 1);
                        let region = scene.liquid_glass_regions[0];
                        assert!(inside(&region.content_mask));
                        assert!(region.is_clipped());
                        assert_eq!(
                            region.visible_bounds(),
                            scaled(60. * scale, 10. * scale, 40. * scale, 40. * scale)
                        );
                        assert!(
                            scene
                                .native_views
                                .iter()
                                .all(|cutout| inside(&cutout.content_mask.bounds))
                        );
                    } else {
                        assert!(scene.liquid_glass_regions.is_empty());
                        assert!(!scene.quads.is_empty());
                        assert!(!scene.paths.is_empty());
                    }
                    assert_eq!(scene.polychrome_sprites.len(), 1);
                    let primitives = scene
                        .quads
                        .iter()
                        .cloned()
                        .map(crate::Primitive::from)
                        .chain(scene.shadows.iter().cloned().map(crate::Primitive::from))
                        .chain(scene.paths.iter().cloned().map(crate::Primitive::from))
                        .chain(
                            scene
                                .polychrome_sprites
                                .iter()
                                .cloned()
                                .map(crate::Primitive::from),
                        );
                    let masks = primitives
                        .map(|primitive| primitive.content_mask().bounds)
                        .collect::<Vec<_>>();
                    assert!(masks.iter().all(inside), "{masks:?}");
                })
                .unwrap();
        }
    }

    #[crate::test]
    fn window_forwards_backdrop_and_native_view_corners_to_the_platform(cx: &mut TestAppContext) {
        let window = open(cx, true);
        let platform_window = cx.test_window(window.into());
        let id = window
            .update(cx, |_, window, cx| {
                window.set_backdrop_layer(Some(BackdropLayerSpec {
                    grain_intensity: 4.,
                    ..BackdropLayerSpec::default()
                }));
                let view = unsafe { NativeView::new(NonNull::dangling(), window, cx) }.unwrap();
                window.set_native_view_corner_radius(
                    &view,
                    crate::Corners {
                        top_left: px(0.),
                        top_right: px(0.),
                        bottom_right: px(10.),
                        bottom_left: px(-3.),
                    },
                );
                view.id()
            })
            .unwrap();
        assert_eq!(
            platform_window
                .backdrop_layer()
                .map(|spec| spec.grain_intensity),
            Some(1.)
        );
        assert_eq!(
            platform_window.native_view_corner_radius(id),
            Some(crate::Corners {
                top_left: px(0.),
                top_right: px(0.),
                bottom_right: px(10.),
                bottom_left: px(0.),
            })
        );
        window
            .update(cx, |_, window, _| window.set_backdrop_layer(None))
            .unwrap();
        assert_eq!(platform_window.backdrop_layer(), None);
    }
}
