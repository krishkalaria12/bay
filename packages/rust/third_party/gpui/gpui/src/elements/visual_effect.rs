use crate::{
    AnyElement, App, Bounds, Corners, Div, DivFrameState, Edges, Element, ElementId,
    GlobalElementId, Hitbox, InspectorElementId, InteractiveElement, Interactivity, LayoutId,
    PaintVisualEffect, ParentElement, Pixels, Position, Stateful, Style, StyleRefinement, Styled,
    VisualEffectBlending, VisualEffectMaterial, VisualEffectState, Window, div, px,
};
use std::{cell::Cell, rc::Rc};

/// A container whose background is a system material, such as an
/// `NSVisualEffectView` on macOS, with its children drawn on top.
///
/// The material follows the element's bounds and rounded corners and is
/// clipped like any other content. Where the platform has no system
/// materials, or while the element is translucent, only the children and the
/// element's own style are drawn.
#[track_caller]
pub fn visual_effect(material: VisualEffectMaterial) -> VisualEffect {
    let look = Rc::new(Cell::new(EffectLook {
        material,
        ..EffectLook::default()
    }));
    VisualEffect {
        div: div().child(EffectLayer(look.clone())),
        look,
    }
}

/// An element that shows a system material beneath its children, created with
/// [`visual_effect`].
pub struct VisualEffect {
    div: Div,
    look: Rc<Cell<EffectLook>>,
}

#[derive(Clone, Copy, Default)]
struct EffectLook {
    material: VisualEffectMaterial,
    blending: VisualEffectBlending,
    state: VisualEffectState,
    emphasized: bool,
    frame: Option<EffectFrame>,
}

#[derive(Clone, Copy)]
struct EffectFrame {
    id: Option<u64>,
    bounds: Bounds<Pixels>,
    corner_radii: Corners<Pixels>,
}

impl VisualEffect {
    /// Sets the material shown.
    pub fn material(self, material: VisualEffectMaterial) -> Self {
        self.update(|look| look.material = material)
    }

    /// Sets what the material blurs.
    pub fn blending(self, blending: VisualEffectBlending) -> Self {
        self.update(|look| look.blending = blending)
    }

    /// Sets whether the material looks active.
    pub fn state(self, state: VisualEffectState) -> Self {
        self.update(|look| look.state = state)
    }

    /// Sets whether the material uses its emphasized look.
    pub fn emphasized(self, emphasized: bool) -> Self {
        self.update(|look| look.emphasized = emphasized)
    }

    fn update(self, change: impl FnOnce(&mut EffectLook)) -> Self {
        let mut look = self.look.get();
        change(&mut look);
        self.look.set(look);
        self
    }

    fn corner_radii_for(&mut self, rem_size: Pixels) -> Corners<Pixels> {
        let radii = &Styled::style(&mut self.div).corner_radii;
        Corners {
            top_left: radii.top_left.unwrap_or_default(),
            top_right: radii.top_right.unwrap_or_default(),
            bottom_right: radii.bottom_right.unwrap_or_default(),
            bottom_left: radii.bottom_left.unwrap_or_default(),
        }
        .to_pixels(rem_size)
    }
}

impl Stateful<VisualEffect> {
    /// Sets the material shown.
    pub fn material(mut self, material: VisualEffectMaterial) -> Self {
        self.element = self.element.material(material);
        self
    }

    /// Sets what the material blurs.
    pub fn blending(mut self, blending: VisualEffectBlending) -> Self {
        self.element = self.element.blending(blending);
        self
    }

    /// Sets whether the material looks active.
    pub fn state(mut self, state: VisualEffectState) -> Self {
        self.element = self.element.state(state);
        self
    }

    /// Sets whether the material uses its emphasized look.
    pub fn emphasized(mut self, emphasized: bool) -> Self {
        self.element = self.element.emphasized(emphasized);
        self
    }
}

impl Styled for VisualEffect {
    fn style(&mut self) -> &mut StyleRefinement {
        Styled::style(&mut self.div)
    }
}

impl ParentElement for VisualEffect {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.div.extend(elements);
    }
}

impl InteractiveElement for VisualEffect {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.div.interactivity()
    }
}

impl Element for VisualEffect {
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
        let corner_radii = self.corner_radii_for(window.rem_size());
        let mut look = self.look.get();
        look.frame = Some(EffectFrame {
            id: id.map(GlobalElementId::path_hash),
            bounds,
            corner_radii,
        });
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

struct EffectLayer(Rc<Cell<EffectLook>>);

impl Element for EffectLayer {
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
            window.paint_visual_effect(PaintVisualEffect {
                id: frame.id,
                bounds: frame.bounds,
                corner_radii: frame.corner_radii,
                material: look.material,
                blending: look.blending,
                state: look.state,
                emphasized: look.emphasized,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Context, IntoElement, LiquidGlassStyle, Render, RequestFrameOptions, ScaledPixels,
        TestAppContext, VisualEffectRegion, WindowBackgroundAppearance, WindowHandle, liquid_glass,
        point, prelude::*, rgb, size,
    };

    struct EffectView {
        shown: bool,
        opacity: f32,
        clip: bool,
    }

    impl Render for EffectView {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let mut root = div().size_full().opacity(self.opacity);
            if self.shown {
                root = root
                    .child(
                        visual_effect(VisualEffectMaterial::HudWindow)
                            .absolute()
                            .left(px(10.))
                            .top(px(20.))
                            .w(px(100.))
                            .h(px(50.))
                            .rounded_tl(px(12.))
                            .rounded_br(px(400.))
                            .bg(rgb(0x202020))
                            .blending(VisualEffectBlending::WithinWindow)
                            .state(VisualEffectState::Active)
                            .emphasized(true)
                            .child(div().size(px(10.)).bg(rgb(0xff0000))),
                    )
                    .child(
                        liquid_glass()
                            .absolute()
                            .left(px(190.))
                            .top(px(0.))
                            .size(px(30.))
                            .style(LiquidGlassStyle::Regular),
                    )
                    .child(
                        div()
                            .absolute()
                            .left(px(200.))
                            .top(px(0.))
                            .size(px(40.))
                            .when(self.clip, |this| this.overflow_hidden().w(px(20.)))
                            .child(
                                visual_effect(VisualEffectMaterial::Sidebar)
                                    .id("named")
                                    .size(px(40.))
                                    .material(VisualEffectMaterial::Menu),
                            ),
                    );
            }
            root
        }
    }

    fn open(cx: &mut TestAppContext, composites: bool) -> WindowHandle<EffectView> {
        let window = cx.add_window(|_, _| EffectView {
            shown: true,
            opacity: 1.,
            clip: false,
        });
        let platform_window = cx.test_window(window.into());
        platform_window.set_composites_visual_effects(composites);
        platform_window.set_composites_liquid_glass(composites);
        window
            .update(cx, |_, window, _| {
                window.set_background_appearance(WindowBackgroundAppearance::Transparent);
                window.refresh();
            })
            .unwrap();
        cx.run_until_parked();
        window
    }

    fn change(
        cx: &mut TestAppContext,
        window: WindowHandle<EffectView>,
        update: impl FnOnce(&mut EffectView),
    ) {
        window
            .update(cx, |view, _, cx| {
                update(view);
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();
    }

    fn shown(cx: &mut TestAppContext, window: WindowHandle<EffectView>) -> Vec<VisualEffectRegion> {
        let platform_window = cx.test_window(window.into());
        platform_window.simulate_frame_request(RequestFrameOptions {
            require_presentation: true,
            ..RequestFrameOptions::default()
        });
        platform_window.visual_effects()
    }

    fn scaled(x: f32, y: f32, width: f32, height: f32) -> Bounds<ScaledPixels> {
        Bounds {
            origin: point(ScaledPixels(x), ScaledPixels(y)),
            size: size(ScaledPixels(width), ScaledPixels(height)),
        }
    }

    #[crate::test]
    fn visual_effects_are_shown_beneath_their_children_in_paint_order(cx: &mut TestAppContext) {
        let window = open(cx, true);
        let regions = shown(cx, window);
        assert_eq!(regions.len(), 2);

        let hud = regions[0];
        assert_eq!(hud.bounds, scaled(20., 40., 200., 100.));
        assert_eq!(hud.material, VisualEffectMaterial::HudWindow);
        assert_eq!(hud.blending, VisualEffectBlending::WithinWindow);
        assert_eq!(hud.state, VisualEffectState::Active);
        assert!(hud.emphasized);
        assert_eq!(
            hud.corner_radii,
            Corners {
                top_left: ScaledPixels(24.),
                top_right: ScaledPixels(0.),
                bottom_right: ScaledPixels(50.),
                bottom_left: ScaledPixels(0.),
            }
        );
        assert_ne!(hud.id & (1 << 63), 0);

        let named = regions[1];
        assert_eq!(named.bounds, scaled(400., 0., 80., 80.));
        assert_eq!(named.material, VisualEffectMaterial::Menu);
        assert_eq!(named.blending, VisualEffectBlending::BehindWindow);
        assert_eq!(named.state, VisualEffectState::FollowsWindowActiveState);
        assert!(!named.emphasized);
        assert!(!named.is_clipped());
        assert_eq!(named.id & (1 << 63), 0);

        window
            .update(cx, |_, window, _| {
                let scene = &window.rendered_frame.scene;
                let glass = scene.liquid_glass_regions[0];
                assert!(glass.order < named.order);
                let red = scene
                    .quads
                    .iter()
                    .find(|quad| quad.bounds == scaled(20., 40., 20., 20.))
                    .expect("the child is painted");
                assert!(red.order > hud.order);
                let background = scene
                    .quads
                    .iter()
                    .find(|quad| quad.bounds == hud.bounds)
                    .expect("the element's own background is painted");
                assert!(background.order <= hud.order);
                assert_eq!(scene.attached_native_views().count(), 0);
            })
            .unwrap();
    }

    #[crate::test]
    fn visual_effects_follow_bounds_and_clipping_and_go_when_not_painted(cx: &mut TestAppContext) {
        let window = open(cx, true);
        let ids = shown(cx, window)
            .iter()
            .map(|region| region.id)
            .collect::<Vec<_>>();

        change(cx, window, |view| view.clip = true);
        let named = shown(cx, window)[1];
        assert!(named.is_clipped());
        assert_eq!(named.visible_bounds(), scaled(400., 0., 40., 80.));

        change(cx, window, |view| view.opacity = 0.5);
        assert!(shown(cx, window).is_empty());

        change(cx, window, |view| view.opacity = 1.);
        assert_eq!(
            shown(cx, window)
                .iter()
                .map(|region| region.id)
                .collect::<Vec<_>>(),
            ids
        );

        change(cx, window, |view| view.shown = false);
        assert!(shown(cx, window).is_empty());
        window
            .update(cx, |_, window, _| {
                assert!(window.rendered_frame.scene.native_views.is_empty());
            })
            .unwrap();
    }

    #[crate::test]
    fn visual_effects_only_paint_their_children_where_the_platform_has_no_materials(
        cx: &mut TestAppContext,
    ) {
        let window = open(cx, false);
        assert!(shown(cx, window).is_empty());
        window
            .update(cx, |_, window, _| {
                assert!(!window.composites_visual_effects());
                let scene = &window.rendered_frame.scene;
                assert!(scene.visual_effect_regions.is_empty());
                assert!(
                    scene
                        .quads
                        .iter()
                        .any(|quad| quad.bounds == scaled(20., 40., 20., 20.))
                );
            })
            .unwrap();
    }
}
