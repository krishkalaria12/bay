use std::{cell::Cell, rc::Rc};

use crate::{
    Bounds, Context, ExternalPaths, FadeEdge, FadeMask, FileDropEvent, InteractiveElement as _,
    IntoElement, Modifiers, MonochromeSprite, ParentElement as _, Pixels, Render, ScaledPixels,
    StatefulInteractiveElement as _, Styled as _, TestAppContext, VisualTestContext, Window, div,
    point, px, rgb, size, svg,
};

const SQUARE_SVG: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>"#;

struct Scaled {
    outer: f32,
    inner: f32,
    clicks: Rc<Cell<usize>>,
}

impl Render for Scaled {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let clicks = self.clicks.clone();
        div().size_full().child(
            div()
                .absolute()
                .left(px(100.))
                .top(px(100.))
                .size(px(200.))
                .scale(self.outer)
                .child(
                    div()
                        .id("inner")
                        .absolute()
                        .left(px(50.))
                        .top(px(50.))
                        .size(px(100.))
                        .scale(self.inner)
                        .rounded(px(10.))
                        .border_2()
                        .border_color(rgb(0x00ff00))
                        .bg(rgb(0xff0000))
                        .on_click(move |_, _, _| clicks.set(clicks.get() + 1))
                        .child(
                            svg()
                                .data(SQUARE_SVG)
                                .size(px(16.))
                                .text_color(rgb(0x0000ff)),
                        ),
                ),
        )
    }
}

fn open(
    outer: f32,
    inner: f32,
    cx: &mut TestAppContext,
) -> (Rc<Cell<usize>>, &mut VisualTestContext) {
    let clicks = Rc::new(Cell::new(0));
    let (_, cx) = cx.add_window_view({
        let clicks = clicks.clone();
        move |_, _| Scaled {
            outer,
            inner,
            clicks,
        }
    });
    cx.run_until_parked();
    (clicks, cx)
}

fn scaled(x: f32, y: f32, width: f32, height: f32, scale_factor: f32) -> Bounds<ScaledPixels> {
    Bounds {
        origin: point(
            ScaledPixels(x * scale_factor),
            ScaledPixels(y * scale_factor),
        ),
        size: size(
            ScaledPixels(width * scale_factor),
            ScaledPixels(height * scale_factor),
        ),
    }
}

fn scene_dump(cx: &mut VisualTestContext) -> String {
    cx.update(|window, _| {
        let scene = &window.rendered_frame.scene;
        format!(
            "{:?}{:?}{:?}{:?}",
            scene.quads, scene.shadows, scene.monochrome_sprites, scene.polychrome_sprites
        )
    })
}

fn sprite(cx: &mut VisualTestContext) -> MonochromeSprite {
    cx.update(|window, _| {
        let sprites = &window.rendered_frame.scene.monochrome_sprites;
        assert_eq!(sprites.len(), 1);
        sprites[0]
    })
}

fn assert_rounded_quad(
    cx: &mut VisualTestContext,
    expected: (f32, f32, f32, f32),
    radius: f32,
    border: f32,
) {
    cx.update(|window, _| {
        let scale_factor = window.scale_factor();
        let (x, y, width, height) = expected;
        let expected = scaled(x, y, width, height, scale_factor);
        let quads = window.painted_quads();
        let shaped = quads
            .iter()
            .filter(|quad| quad.corner_radii != Default::default())
            .collect::<Vec<_>>();
        assert!(!shaped.is_empty());
        for quad in &shaped {
            assert_eq!(quad.bounds, expected);
            assert_eq!(
                quad.corner_radii.top_left,
                ScaledPixels(radius * scale_factor)
            );
        }
        let bordered = shaped
            .iter()
            .filter(|quad| quad.border_widths != Default::default())
            .collect::<Vec<_>>();
        assert!(!bordered.is_empty());
        for quad in bordered {
            assert_eq!(quad.border_widths.left, ScaledPixels(border * scale_factor));
        }
        for quad in &quads {
            let visible = quad.bounds.intersect(&quad.content_mask.bounds);
            assert!(visible.is_empty() || expected.contains(&visible.origin));
            assert!(visible.is_empty() || visible.bottom_right().x <= expected.right());
        }
    });
}

#[crate::test]
fn a_scaled_quad_shrinks_about_its_center(cx: &mut TestAppContext) {
    let (_, cx) = open(1., 0.5, cx);
    assert_rounded_quad(cx, (175., 175., 50., 50.), 5., 1.);
}

#[crate::test]
fn nested_scales_compose(cx: &mut TestAppContext) {
    let (_, cx) = open(0.5, 0.5, cx);
    assert_rounded_quad(cx, (187.5, 187.5, 25., 25.), 2.5, 0.5);
}

#[crate::test]
fn sprites_scale_with_their_element(cx: &mut TestAppContext) {
    let plain = sprite(open(1., 1., cx).1);
    let sprite = sprite(open(1., 0.5, cx).1);
    let center = point(ScaledPixels(200.), ScaledPixels(200.));
    let scale_factor = plain.bounds.size.width.0 / 16.;
    let center = point(center.x * scale_factor, center.y * scale_factor);
    let expected = Bounds {
        origin: point(
            center.x + (plain.bounds.origin.x - center.x) * 0.5,
            center.y + (plain.bounds.origin.y - center.y) * 0.5,
        ),
        size: plain.bounds.size.map(|length| length * 0.5),
    };
    assert_eq!(sprite.bounds, expected);
    assert_eq!(sprite.tile, plain.tile);
}

#[crate::test]
fn a_scaled_element_is_hit_where_it_is_drawn(cx: &mut TestAppContext) {
    let (clicks, cx) = open(1., 0.5, cx);
    cx.simulate_click(point(px(180.), px(180.)), Modifiers::none());
    assert_eq!(clicks.get(), 1);
    cx.simulate_click(point(px(160.), px(160.)), Modifiers::none());
    cx.simulate_click(point(px(240.), px(200.)), Modifiers::none());
    assert_eq!(clicks.get(), 1);
}

#[crate::test]
fn a_scale_of_one_leaves_the_scene_unchanged(cx: &mut TestAppContext) {
    struct Plain;
    impl Render for Plain {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().size_full().child(
                div()
                    .absolute()
                    .left(px(150.))
                    .top(px(150.))
                    .size(px(100.))
                    .rounded(px(10.))
                    .border_2()
                    .border_color(rgb(0x00ff00))
                    .bg(rgb(0xff0000))
                    .shadow_md()
                    .child(
                        svg()
                            .data(SQUARE_SVG)
                            .size(px(16.))
                            .text_color(rgb(0x0000ff)),
                    ),
            )
        }
    }
    struct One;
    impl Render for One {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
                .size_full()
                .child(
                    div()
                        .absolute()
                        .left(px(150.))
                        .top(px(150.))
                        .size(px(100.))
                        .scale(1.)
                        .rounded(px(10.))
                        .border_2()
                        .border_color(rgb(0x00ff00))
                        .bg(rgb(0xff0000))
                        .shadow_md()
                        .child(
                            svg()
                                .data(SQUARE_SVG)
                                .size(px(16.))
                                .text_color(rgb(0x0000ff)),
                        ),
                )
                .child(crate::canvas(
                    |_, _, _| {},
                    |_, _, window, _| window.with_scale(point(px(10.), px(10.)), 1., |_| {}),
                ))
        }
    }
    let (_, plain) = cx.add_window_view(|_, _| Plain);
    plain.run_until_parked();
    let plain = scene_dump(plain);
    let (_, one) = cx.add_window_view(|_, _| One);
    one.run_until_parked();
    assert_eq!(scene_dump(one), plain);
}

struct Faded {
    length: Pixels,
}

impl Render for Faded {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let length = self.length;
        div().size_full().child(crate::canvas(
            |_, _, _| {},
            move |_, _, window, cx| {
                let mask = FadeMask {
                    bounds: Bounds {
                        origin: point(px(0.), px(0.)),
                        size: size(px(100.), px(20.)),
                    },
                    edge: FadeEdge::Trailing,
                    length,
                };
                window.with_fade_mask(mask, |window| {
                    for x in [40., 90., 120.] {
                        window
                            .paint_svg(
                                Bounds {
                                    origin: point(px(x), px(0.)),
                                    size: size(px(16.), px(16.)),
                                },
                                "fade-square".into(),
                                Some(SQUARE_SVG),
                                crate::TransformationMatrix::unit(),
                                crate::hsla(0., 0., 0., 1.),
                                cx,
                            )
                            .unwrap();
                    }
                });
            },
        ))
    }
}

#[crate::test]
fn a_fade_mask_slices_what_crosses_it_and_drops_what_is_past_it(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| Faded { length: px(20.) });
    cx.run_until_parked();
    cx.update(|window, _| {
        let scale_factor = window.scale_factor();
        let sprites = &window.rendered_frame.scene.monochrome_sprites;
        let before = sprites
            .iter()
            .filter(|sprite| sprite.bounds.left().0 < 80. * scale_factor)
            .collect::<Vec<_>>();
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].color.a, 1.);
        let sliced = sprites
            .iter()
            .filter(|sprite| sprite.bounds.left().0 >= 90. * scale_factor)
            .collect::<Vec<_>>();
        assert!(sliced.len() > 2);
        assert!(
            sliced
                .iter()
                .all(|sprite| sprite.bounds.right().0 <= 100. * scale_factor)
        );
        assert!(
            sliced
                .windows(2)
                .all(|pair| pair[1].color.a < pair[0].color.a)
        );
        assert!(
            sprites
                .iter()
                .all(|sprite| sprite.bounds.left().0 < 120. * scale_factor)
        );
    });
}

struct DropTarget {
    drops: Rc<Cell<usize>>,
    anonymous: bool,
}

impl Render for DropTarget {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let drops = self.drops.clone();
        let target = div()
            .absolute()
            .left(px(0.))
            .top(px(0.))
            .w(px(100.))
            .h(px(40.))
            .bg(rgb(0xff0000))
            .drag_over::<ExternalPaths>(|style, _, _, _| style.scale(0.5))
            .on_drop(move |_: &ExternalPaths, _, _| drops.set(drops.get() + 1));
        div().size_full().child(if self.anonymous {
            target.into_any_element()
        } else {
            target.id("target").into_any_element()
        })
    }
}

fn drawn_target(cx: &mut VisualTestContext) -> Bounds<Pixels> {
    cx.update(|window, _| {
        let scale_factor = window.scale_factor();
        let quads = window.painted_quads();
        assert_eq!(quads.len(), 1);
        let bounds = quads[0].bounds;
        Bounds {
            origin: point(
                px(bounds.origin.x.0 / scale_factor),
                px(bounds.origin.y.0 / scale_factor),
            ),
            size: size(
                px(bounds.size.width.0 / scale_factor),
                px(bounds.size.height.0 / scale_factor),
            ),
        }
    })
}

#[crate::test]
fn a_drop_lands_only_where_a_drag_over_scaled_target_is_drawn(cx: &mut TestAppContext) {
    drop_onto_a_drag_over_scaled_target(false, cx);
}

#[crate::test]
fn an_anonymous_target_keeps_its_size_under_a_drag_over_scale(cx: &mut TestAppContext) {
    drop_onto_a_drag_over_scaled_target(true, cx);
}

fn drop_onto_a_drag_over_scaled_target(anonymous: bool, cx: &mut TestAppContext) {
    let paths = || {
        ExternalPaths(
            [std::path::PathBuf::from("/tmp/dropped")]
                .into_iter()
                .collect(),
        )
    };
    for x in [10., 30.] {
        let drops = Rc::new(Cell::new(0));
        let (_, cx) = cx.add_window_view({
            let drops = drops.clone();
            move |_, _| DropTarget { drops, anonymous }
        });
        cx.run_until_parked();
        cx.simulate_event(FileDropEvent::Entered {
            position: point(px(50.), px(20.)),
            paths: paths(),
        });
        cx.run_until_parked();
        let position = point(px(x), px(20.));
        for _ in 0..3 {
            cx.simulate_event(FileDropEvent::Pending { position });
            cx.run_until_parked();
        }
        let drawn = drawn_target(cx);
        let hit = cx.update(|window, _| {
            window
                .rendered_frame
                .hitboxes
                .iter()
                .any(|hitbox| hitbox.bounds == drawn)
        });
        cx.simulate_event(FileDropEvent::Submit { position });
        cx.run_until_parked();
        assert_eq!(drops.get(), usize::from(drawn.contains(&position)), "{x}");
        assert!(hit, "the target is hit where it is drawn, {drawn:?}");
        if anonymous {
            assert_eq!(
                drawn,
                Bounds::new(point(px(0.), px(0.)), size(px(100.), px(40.)))
            );
        } else if x == 30. {
            assert_eq!(drawn.size.width, px(50.));
        }
    }
}

struct Turned {
    rotation: Option<crate::Radians>,
    scale: Option<f32>,
    clicks: Rc<Cell<usize>>,
}

impl Render for Turned {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let clicks = self.clicks.clone();
        let mut element = div()
            .id("turned")
            .absolute()
            .left(px(150.))
            .top(px(150.))
            .size(px(100.))
            .bg(rgb(0xff0000))
            .shadow_md()
            .on_click(move |_, _, _| clicks.set(clicks.get() + 1))
            .child(
                svg()
                    .data(SQUARE_SVG)
                    .size(px(16.))
                    .text_color(rgb(0x0000ff)),
            );
        if let Some(rotation) = self.rotation {
            element = element.rotate(rotation);
        }
        if let Some(scale) = self.scale {
            element = element.scale(scale);
        }
        div().size_full().child(element)
    }
}

fn open_turned(
    rotation: Option<crate::Radians>,
    scale: Option<f32>,
    cx: &mut TestAppContext,
) -> (Rc<Cell<usize>>, &mut VisualTestContext) {
    let clicks = Rc::new(Cell::new(0));
    let (_, cx) = cx.add_window_view({
        let clicks = clicks.clone();
        move |_, _| Turned {
            rotation,
            scale,
            clicks,
        }
    });
    cx.run_until_parked();
    (clicks, cx)
}

fn full_scene_dump(cx: &mut VisualTestContext) -> String {
    let paths = cx.update(|window, _| window.rendered_frame.scene.paths.len());
    format!("{}{paths}", scene_dump(cx))
}

#[crate::test]
fn a_rotation_of_zero_leaves_the_scene_unchanged(cx: &mut TestAppContext) {
    let plain = full_scene_dump(open_turned(None, None, cx).1);
    let zero = full_scene_dump(open_turned(Some(crate::radians(0.)), None, cx).1);
    assert_eq!(zero, plain);
    let full_turn =
        full_scene_dump(open_turned(Some(crate::radians(std::f32::consts::TAU)), None, cx).1);
    assert_eq!(full_turn, plain);
    struct Unturned;
    impl Render for Unturned {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().size_full().child(crate::canvas(
                |_, _, _| {},
                |_, _, window, _| {
                    window.with_transform(point(px(10.), px(10.)), 1., crate::radians(0.), |_| {});
                    window.with_rotation(point(px(10.), px(10.)), crate::radians(0.), |_| {});
                },
            ))
        }
    }
    let (_, cx) = cx.add_window_view(|_, _| Unturned);
    cx.run_until_parked();
    assert_eq!(full_scene_dump(cx), "[][][][]0");
}

#[crate::test]
fn a_rotated_element_turns_its_sprite_about_the_element_center(cx: &mut TestAppContext) {
    let plain = sprite(open_turned(None, None, cx).1);
    let (_, cx) = open_turned(Some(crate::radians(std::f32::consts::FRAC_PI_2)), None, cx);
    let turned = sprite(cx);
    let scale_factor = cx.update(|window, _| window.scale_factor());
    assert_eq!(turned.bounds, plain.bounds);
    let center = 200. * scale_factor;
    let corner = turned
        .transformation
        .apply(point(px(plain.bounds.left().0), px(plain.bounds.top().0)));
    let expected = (
        center - (plain.bounds.top().0 - center),
        center + (plain.bounds.left().0 - center),
    );
    assert!(
        (corner.x.0 - expected.0).abs() < 1e-2,
        "{corner:?} {expected:?}"
    );
    assert!(
        (corner.y.0 - expected.1).abs() < 1e-2,
        "{corner:?} {expected:?}"
    );
    let (quads, paths) = cx.update(|window, _| {
        let scene = &window.rendered_frame.scene;
        (scene.quads.len(), scene.paths.len())
    });
    assert_eq!((quads, paths), (0, 1));
}

#[crate::test]
fn a_rotated_and_scaled_element_composes_both_about_its_center(cx: &mut TestAppContext) {
    let plain = sprite(open_turned(None, None, cx).1);
    let (_, cx) = open_turned(
        Some(crate::radians(std::f32::consts::FRAC_PI_2)),
        Some(0.5),
        cx,
    );
    let turned = sprite(cx);
    let scale_factor = cx.update(|window, _| window.scale_factor());
    let center = 200. * scale_factor;
    let corner = turned
        .transformation
        .apply(point(px(plain.bounds.left().0), px(plain.bounds.top().0)));
    let expected = (
        center - (plain.bounds.top().0 - center) * 0.5,
        center + (plain.bounds.left().0 - center) * 0.5,
    );
    assert!(
        (corner.x.0 - expected.0).abs() < 1e-2,
        "{corner:?} {expected:?}"
    );
    assert!(
        (corner.y.0 - expected.1).abs() < 1e-2,
        "{corner:?} {expected:?}"
    );
}

#[crate::test]
fn a_rotated_element_is_hit_within_the_bounds_of_its_turned_shape(cx: &mut TestAppContext) {
    let (clicks, cx) = open_turned(Some(crate::radians(std::f32::consts::FRAC_PI_4)), None, cx);
    cx.simulate_click(point(px(200.), px(135.)), Modifiers::none());
    assert_eq!(clicks.get(), 1);
    cx.simulate_click(point(px(200.), px(125.)), Modifiers::none());
    assert_eq!(clicks.get(), 1);
    cx.simulate_click(point(px(140.), px(140.)), Modifiers::none());
    assert_eq!(clicks.get(), 2);
}

struct SpinningMask;

impl Render for SpinningMask {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(crate::canvas(
            |_, _, _| {},
            |_, _, window, _| {
                let image = std::sync::Arc::new(crate::RenderImage::new([image::Frame::new(
                    image::RgbaImage::from_pixel(8, 8, image::Rgba([0, 0, 0, 255])),
                )]));
                let bounds = Bounds {
                    origin: point(px(20.), px(20.)),
                    size: size(px(8.), px(8.)),
                };
                window.with_rotation(bounds.center(), crate::radians(1.), |window| {
                    window
                        .paint_image_mask(
                            bounds,
                            image,
                            0,
                            crate::TransformationMatrix::unit(),
                            rgb(0x0000ff).into(),
                        )
                        .unwrap();
                });
            },
        ))
    }
}

#[crate::test]
fn an_image_mask_turns_as_a_monochrome_sprite(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| SpinningMask);
    cx.run_until_parked();
    let sprite = sprite(cx);
    let scale_factor = cx.update(|window, _| window.scale_factor());
    let center = 24. * scale_factor;
    let middle = sprite.transformation.apply(point(px(center), px(center)));
    assert!((middle.x.0 - center).abs() < 1e-3 && (middle.y.0 - center).abs() < 1e-3);
    let (sin, cos) = 1f32.sin_cos();
    assert!((sprite.transformation.rotation_scale[0][0] - cos).abs() < 1e-5);
    assert!((sprite.transformation.rotation_scale[1][0] - sin).abs() < 1e-5);
    assert_eq!(sprite.color, crate::Hsla::from(rgb(0x0000ff)));
}

struct Stretched {
    scale: Option<f32>,
    scale_xy: Option<(f32, f32)>,
    rounded: bool,
    clicks: Rc<Cell<usize>>,
}

impl Render for Stretched {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let clicks = self.clicks.clone();
        let mut element = div()
            .id("stretched")
            .absolute()
            .left(px(150.))
            .top(px(150.))
            .w(px(100.))
            .h(px(40.))
            .border_2()
            .border_color(rgb(0x00ff00))
            .bg(rgb(0xff0000))
            .shadow_md()
            .on_click(move |_, _, _| clicks.set(clicks.get() + 1))
            .child(
                svg()
                    .data(SQUARE_SVG)
                    .size(px(16.))
                    .text_color(rgb(0x0000ff)),
            );
        if self.rounded {
            element = element.rounded(px(10.));
        }
        if let Some(scale) = self.scale {
            element = element.scale(scale);
        }
        if let Some((x, y)) = self.scale_xy {
            element = element.scale_xy(x, y);
        }
        div().size_full().child(element)
    }
}

fn open_stretched(
    scale: Option<f32>,
    scale_xy: Option<(f32, f32)>,
    rounded: bool,
    cx: &mut TestAppContext,
) -> (Rc<Cell<usize>>, &mut VisualTestContext) {
    let clicks = Rc::new(Cell::new(0));
    let (_, cx) = cx.add_window_view({
        let clicks = clicks.clone();
        move |_, _| Stretched {
            scale,
            scale_xy,
            rounded,
            clicks,
        }
    });
    cx.run_until_parked();
    (clicks, cx)
}

#[crate::test]
fn an_even_scale_xy_draws_exactly_as_the_uniform_scale(cx: &mut TestAppContext) {
    for rounded in [false, true] {
        let uniform = full_scene_dump(open_stretched(Some(0.5), None, rounded, cx).1);
        let even = full_scene_dump(open_stretched(None, Some((0.5, 0.5)), rounded, cx).1);
        assert_eq!(even, uniform);
        let composed = full_scene_dump(open_stretched(Some(2.), Some((0.25, 0.25)), rounded, cx).1);
        assert_eq!(composed, uniform);
    }
}

#[crate::test]
fn a_scale_xy_of_one_leaves_the_scene_unchanged(cx: &mut TestAppContext) {
    let plain = full_scene_dump(open_stretched(None, None, true, cx).1);
    let one = full_scene_dump(open_stretched(None, Some((1., 1.)), true, cx).1);
    assert_eq!(one, plain);
    struct Unscaled;
    impl Render for Unscaled {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().size_full().child(crate::canvas(
                |_, _, _| {},
                |_, _, window, _| {
                    window.with_scale_xy(point(px(10.), px(10.)), 1., 1., |_| {});
                    window.with_transform_xy(
                        point(px(10.), px(10.)),
                        1.,
                        1.,
                        crate::radians(0.),
                        |_| {},
                    );
                },
            ))
        }
    }
    let (_, cx) = cx.add_window_view(|_, _| Unscaled);
    cx.run_until_parked();
    assert_eq!(full_scene_dump(cx), "[][][][]0");
}

#[crate::test]
fn an_unevenly_scaled_element_is_drawn_and_hit_stretched_per_axis(cx: &mut TestAppContext) {
    let (clicks, cx) = open_stretched(None, Some((0.5, 2.)), false, cx);
    let (scale_factor, quads, hitboxes, paths) = cx.update(|window, _| {
        (
            window.scale_factor(),
            window.painted_quads(),
            window
                .rendered_frame
                .hitboxes
                .iter()
                .map(|hitbox| hitbox.bounds)
                .collect::<Vec<_>>(),
            window.rendered_frame.scene.paths.len(),
        )
    });
    assert_eq!(paths, 0, "square corners stay quads");
    let drawn = quads
        .iter()
        .map(|quad| quad.bounds)
        .reduce(|union, bounds| union.union(&bounds))
        .unwrap();
    assert_eq!(drawn, scaled(175., 130., 50., 80., scale_factor));
    let drawn = Bounds {
        origin: point(px(175.), px(130.)),
        size: size(px(50.), px(80.)),
    };
    assert!(hitboxes.contains(&drawn), "{hitboxes:?}");

    cx.simulate_click(point(px(180.), px(135.)), Modifiers::none());
    assert_eq!(clicks.get(), 1, "inside what is drawn, above the layout");
    cx.simulate_click(point(px(165.), px(170.)), Modifiers::none());
    assert_eq!(clicks.get(), 1, "inside the layout, beside what is drawn");
    cx.simulate_click(point(px(220.), px(205.)), Modifiers::none());
    assert_eq!(clicks.get(), 2);

    let sprite = sprite(cx);
    assert_eq!(sprite.transformation.rotation_scale, [[0.5, 0.], [0., 2.]]);
}

#[crate::test]
fn an_unevenly_scaled_rounded_element_fills_its_quads_as_paths(cx: &mut TestAppContext) {
    let (_, cx) = open_stretched(None, Some((0.5, 2.)), true, cx);
    let (rounded_quads, paths) = cx.update(|window, _| {
        let scene = &window.rendered_frame.scene;
        (
            scene
                .quads
                .iter()
                .filter(|quad| quad.corner_radii != Default::default())
                .count(),
            scene.paths.len(),
        )
    });
    assert_eq!(rounded_quads, 0);
    assert_eq!(paths, 2, "a background and a border ring");
}
