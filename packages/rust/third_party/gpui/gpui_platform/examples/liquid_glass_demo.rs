use gpui::{
    ActivationPolicy, AnyElement, App, BackdropAppearance, BackdropLayerSpec, Bounds, Context, Div,
    GrainTexture, Hsla, LiquidGlass, LiquidGlassStyle, MouseButton, MouseDownEvent, MouseMoveEvent,
    NativeView, Pixels, Point, Rgba, SharedString, Stateful, TitlebarOptions, Window,
    WindowBackgroundAppearance, WindowBounds, WindowOptions, canvas, div, hsla, linear_color_stop,
    linear_gradient, liquid_glass, point, prelude::*, px, rgb, size,
};
use gpui_platform::application;
use std::{cell::Cell, rc::Rc, time::Instant};

const DOCK: u64 = 7;
const TILE: f32 = 60.;
const TILE_GAP: f32 = 14.;
const ICONS: [&str; 6] = ["★", "♪", "✉", "☀", "☾", "⌘"];

struct Preset {
    name: &'static str,
    tint: u32,
}

const PRESETS: [Preset; 5] = [
    Preset {
        name: "Neutral",
        tint: 0x808080,
    },
    Preset {
        name: "Plum",
        tint: 0xb25b6b,
    },
    Preset {
        name: "Ocean",
        tint: 0x3a7bd5,
    },
    Preset {
        name: "Sunglow",
        tint: 0xf2b33d,
    },
    Preset {
        name: "Forest",
        tint: 0x3f9a6b,
    },
];

#[derive(Clone, Copy, PartialEq)]
enum Slider {
    Grain,
    Radius,
}

struct Demo {
    preset: usize,
    dark: bool,
    grain: f32,
    texture: GrainTexture,
    style: LiquidGlassStyle,
    tinted: bool,
    radius: f32,
    selected: usize,
    lens: f32,
    pill: Point<Pixels>,
    drag: Option<Point<Pixels>>,
    orbit: bool,
    started: Instant,
    sliding: Option<Slider>,
    grain_track: Rc<Cell<Bounds<Pixels>>>,
    radius_track: Rc<Cell<Bounds<Pixels>>>,
    page: Option<NativeView>,
}

impl Demo {
    fn new(window: &mut Window, cx: &mut App) -> Self {
        let page = striped_page(window, cx);
        if let Some(page) = &page {
            window.set_native_view_corner_radius(page, px(22.));
        }
        let demo = Self {
            preset: 1,
            dark: true,
            grain: 0.2,
            texture: GrainTexture::Film,
            style: LiquidGlassStyle::Regular,
            tinted: false,
            radius: 24.,
            selected: 0,
            lens: 0.,
            pill: point(px(TILE_GAP), px(TILE + 2. * TILE_GAP + 16.)),
            drag: None,
            orbit: false,
            started: Instant::now(),
            sliding: None,
            grain_track: Rc::default(),
            radius_track: Rc::default(),
            page,
        };
        demo.apply_backdrop(window);
        demo
    }

    fn apply_backdrop(&self, window: &mut Window) {
        let appearance = if self.dark {
            BackdropAppearance::Dark
        } else {
            BackdropAppearance::Light
        };
        let tint = Rgba {
            a: 0.36,
            ..rgb(PRESETS[self.preset].tint)
        };
        window.set_backdrop_layer(Some(BackdropLayerSpec {
            grain_intensity: self.grain,
            grain_texture: self.texture,
            inactive_opacity: 0.85,
            ..BackdropLayerSpec::treatment(appearance, tint)
        }));
    }

    fn ink(&self) -> Hsla {
        if self.dark {
            hsla(0., 0., 1., 0.92)
        } else {
            hsla(0., 0., 0., 0.82)
        }
    }

    fn muted(&self) -> Hsla {
        self.ink().opacity(0.6)
    }

    fn accent(&self) -> Rgba {
        Rgba {
            a: 0.55,
            ..rgb(PRESETS[self.preset].tint)
        }
    }

    fn slide(&mut self, slider: Slider, position: Point<Pixels>) {
        let track = match slider {
            Slider::Grain => self.grain_track.get(),
            Slider::Radius => self.radius_track.get(),
        };
        if track.size.width <= px(0.) {
            return;
        }
        let fraction = ((position.x - track.left()) / track.size.width).clamp(0., 1.);
        match slider {
            Slider::Grain => self.grain = fraction,
            Slider::Radius => self.radius = (fraction * 48.).round(),
        }
    }

    fn chip(
        &self,
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        on: bool,
        cx: &mut Context<Self>,
        action: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) -> Stateful<LiquidGlass> {
        let label = label.into();
        liquid_glass()
            .id(id.into())
            .px_3()
            .h(px(28.))
            .flex()
            .items_center()
            .rounded(px(14.))
            .style(LiquidGlassStyle::Clear)
            .when(on, |glass| glass.tint(self.accent()))
            .text_sm()
            .text_color(self.ink())
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, window, cx| {
                action(this, window, cx);
                cx.notify();
            }))
            .child(label)
    }

    fn slider(
        &self,
        slider: Slider,
        value: f32,
        track: Rc<Cell<Bounds<Pixels>>>,
        cx: &mut Context<Self>,
    ) -> Stateful<LiquidGlass> {
        let width = px(196.);
        liquid_glass()
            .id(match slider {
                Slider::Grain => "grain-slider",
                Slider::Radius => "radius-slider",
            })
            .relative()
            .w(width)
            .h(px(22.))
            .rounded(px(11.))
            .style(LiquidGlassStyle::Clear)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                    this.sliding = Some(slider);
                    this.slide(slider, event.position);
                    this.apply_backdrop(window);
                    cx.notify();
                }),
            )
            .child(
                canvas(move |bounds, _, _| track.set(bounds), |_, _, _, _| {})
                    .absolute()
                    .size_full(),
            )
            .child(
                div()
                    .absolute()
                    .left(px(2.))
                    .top(px(2.))
                    .h(px(18.))
                    .w((width - px(4.)) * value.clamp(0.05, 1.))
                    .rounded(px(9.))
                    .bg(self.accent()),
            )
    }

    fn panel(&self, title: &'static str) -> LiquidGlass {
        liquid_glass()
            .flex()
            .flex_col()
            .gap_3()
            .p_4()
            .rounded(px(20.))
            .text_color(self.ink())
            .child(div().text_xs().text_color(self.muted()).child(title))
    }

    fn controls(&self, cx: &mut Context<Self>) -> Div {
        let presets = PRESETS
            .iter()
            .enumerate()
            .map(|(index, preset)| {
                self.chip(
                    format!("preset-{index}"),
                    preset.name,
                    self.preset == index,
                    cx,
                    move |this, window, _| {
                        this.preset = index;
                        this.apply_backdrop(window);
                    },
                )
            })
            .collect::<Vec<_>>();
        let textures = GrainTexture::ALL
            .into_iter()
            .map(|texture| {
                self.chip(
                    format!("texture-{}", texture.index()),
                    format!("{texture:?}"),
                    self.texture == texture,
                    cx,
                    move |this, window, _| {
                        this.texture = texture;
                        this.apply_backdrop(window);
                    },
                )
            })
            .collect::<Vec<_>>();
        div()
            .flex()
            .flex_col()
            .gap_4()
            .w(px(260.))
            .child(
                self.panel("BACKDROP")
                    .child(div().flex().flex_wrap().gap_2().children(presets))
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(self.chip("dark", "Dark", self.dark, cx, |this, window, _| {
                                this.dark = true;
                                this.apply_backdrop(window);
                            }))
                            .child(self.chip(
                                "light",
                                "Light",
                                !self.dark,
                                cx,
                                |this, window, _| {
                                    this.dark = false;
                                    this.apply_backdrop(window);
                                },
                            )),
                    )
                    .child(
                        div()
                            .text_sm()
                            .child(format!("Grain {:.0}%", self.grain * 100.)),
                    )
                    .child(self.slider(Slider::Grain, self.grain, self.grain_track.clone(), cx))
                    .child(div().flex().flex_wrap().gap_2().children(textures)),
            )
            .child(
                self.panel("GLASS")
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(self.chip(
                                "regular",
                                "Regular",
                                self.style == LiquidGlassStyle::Regular,
                                cx,
                                |this, _, _| this.style = LiquidGlassStyle::Regular,
                            ))
                            .child(self.chip(
                                "clear",
                                "Clear",
                                self.style == LiquidGlassStyle::Clear,
                                cx,
                                |this, _, _| this.style = LiquidGlassStyle::Clear,
                            ))
                            .child(self.chip("tint", "Tint", self.tinted, cx, |this, _, _| {
                                this.tinted = !this.tinted
                            })),
                    )
                    .child(
                        div()
                            .text_sm()
                            .child(format!("Corner radius {:.0}pt", self.radius)),
                    )
                    .child(self.slider(
                        Slider::Radius,
                        self.radius / 48.,
                        self.radius_track.clone(),
                        cx,
                    )),
            )
            .child(
                self.panel("DOCK")
                    .child(
                        div()
                            .text_sm()
                            .text_color(self.muted())
                            .child("Click a tile, drag the pill onto the dock, or let it orbit."),
                    )
                    .child(div().flex().child(self.chip(
                        "orbit",
                        "Orbit",
                        self.orbit,
                        cx,
                        |this, _, _| {
                            this.orbit = !this.orbit;
                            this.started = Instant::now();
                        },
                    ))),
            )
    }

    fn dock(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let target = self.selected as f32 * (TILE + TILE_GAP);
        self.lens += (target - self.lens) * 0.22;
        if (target - self.lens).abs() > 0.25 {
            window.request_animation_frame();
        } else {
            self.lens = target;
        }
        if self.orbit && self.drag.is_none() {
            let time = self.started.elapsed().as_secs_f32();
            let span = (ICONS.len() as f32 - 1.) * (TILE + TILE_GAP);
            self.pill = point(
                px(TILE_GAP + span * (0.5 + 0.5 * (time * 0.9).sin())),
                px(TILE + 2. * TILE_GAP + 16. + 26. * (time * 1.7).sin().max(-0.9)),
            );
            window.request_animation_frame();
        }
        let tiles = ICONS.iter().enumerate().map(|(index, icon)| {
            liquid_glass()
                .id(("tile", index))
                .absolute()
                .left(px(TILE_GAP + index as f32 * (TILE + TILE_GAP)))
                .top(px(TILE_GAP))
                .size(px(TILE))
                .rounded(px(18.))
                .group_id(DOCK)
                .flex()
                .items_center()
                .justify_center()
                .text_2xl()
                .text_color(self.ink())
                .cursor_pointer()
                .hover(|style| style.border_1().border_color(hsla(0., 0., 1., 0.35)))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.selected = index;
                    cx.notify();
                }))
                .child(*icon)
        });
        let width = px(TILE_GAP + ICONS.len() as f32 * (TILE + TILE_GAP));
        let page: AnyElement = match &self.page {
            Some(page) => page.clone().into_any_element(),
            None => div()
                .size_full()
                .bg(linear_gradient(
                    90.,
                    linear_color_stop(rgb(0xff5f6d), 0.),
                    linear_color_stop(rgb(0x2bc0e4), 1.),
                ))
                .into_any_element(),
        };
        div()
            .relative()
            .w(width)
            .h(px(2. * TILE + 4. * TILE_GAP + 32.))
            .child(div().absolute().size_full().rounded(px(22.)).child(page))
            .child(
                liquid_glass()
                    .absolute()
                    .left(px(TILE_GAP - 6. + self.lens))
                    .top(px(TILE_GAP - 6.))
                    .size(px(TILE + 12.))
                    .rounded(px(24.))
                    .group_id(DOCK)
                    .tint(self.accent()),
            )
            .children(tiles)
            .child(
                liquid_glass()
                    .id("pill")
                    .absolute()
                    .left(self.pill.x)
                    .top(self.pill.y)
                    .w(px(120.))
                    .h(px(44.))
                    .rounded(px(22.))
                    .group_id(DOCK)
                    .when(self.tinted, |glass| glass.tint(self.accent()))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_sm()
                    .text_color(self.ink())
                    .cursor_grab()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, event: &MouseDownEvent, _, cx| {
                            this.drag = Some(event.position - this.pill);
                            this.orbit = false;
                            cx.notify();
                        }),
                    )
                    .child("Drag me"),
            )
    }

    fn stage(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let card_fill = if self.dark {
            hsla(0., 0., 0.07, 0.5)
        } else {
            hsla(0., 0., 1., 0.7)
        };
        let status = if !window.composites_liquid_glass() {
            "GPUI frosted fallback"
        } else if window.liquid_glass_available() {
            "Native NSGlassEffectView, grouped in NSGlassEffectContainerView"
        } else {
            "Native NSVisualEffectView fallback"
        };
        let card = div()
            .flex()
            .flex_col()
            .gap_6()
            .p_8()
            .rounded(px(16.))
            .bg(card_fill)
            .text_color(self.ink())
            .child(div().text_xs().text_color(self.muted()).child(status))
            .child(
                liquid_glass()
                    .w(px(460.))
                    .h(px(220.))
                    .p_6()
                    .corner_radius(px(self.radius))
                    .style(self.style)
                    .when(self.tinted, |glass| glass.tint(self.accent()))
                    .flex()
                    .flex_col()
                    .justify_between()
                    .child(div().text_2xl().child("Liquid Glass"))
                    .child(div().text_sm().text_color(self.muted()).child(format!(
                        "{} · radius {:.0}pt{}",
                        match self.style {
                            LiquidGlassStyle::Regular => "Regular",
                            LiquidGlassStyle::Clear => "Clear",
                        },
                        self.radius,
                        if self.tinted { " · tinted" } else { "" }
                    ))),
            );
        div()
            .flex_1()
            .flex()
            .flex_col()
            .gap_6()
            .child(card)
            .child(self.dock(window, cx))
    }
}

impl Render for Demo {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("demo")
            .size_full()
            .flex()
            .gap_6()
            .pt(px(44.))
            .px_6()
            .pb_6()
            .child(self.controls(cx))
            .child(self.stage(window, cx))
            .when(self.drag.is_some() || self.sliding.is_some(), |root| {
                root.child(
                    div()
                        .absolute()
                        .size_full()
                        .occlude()
                        .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                            if let Some(slider) = this.sliding {
                                this.slide(slider, event.position);
                                if slider == Slider::Grain {
                                    this.apply_backdrop(window);
                                }
                            }
                            if let Some(offset) = this.drag {
                                this.pill = event.position - offset;
                            }
                            cx.notify();
                        }))
                        .on_mouse_up(
                            MouseButton::Left,
                            cx.listener(|this, _, _, cx| {
                                this.sliding = None;
                                this.drag = None;
                                cx.notify();
                            }),
                        ),
                )
            })
    }
}

#[cfg(target_os = "macos")]
fn striped_page(window: &mut Window, cx: &mut App) -> Option<NativeView> {
    use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
    use objc2_core_graphics::CGColor;
    use std::{ffi::c_void, ptr::NonNull};

    #[repr(C)]
    struct Rect([f64; 4]);

    unsafe impl objc2::Encode for Rect {
        const ENCODING: objc2::Encoding = objc2::Encoding::Struct(
            "CGRect",
            &[
                objc2::Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]),
                objc2::Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]),
            ],
        );
    }

    let colors = [
        0xff5f6d, 0xffc371, 0xf9f871, 0x5ee7a0, 0x2bc0e4, 0x6a5af9, 0xe85ad8,
    ];
    let (width, height) = (480., 220.);
    let band = width / colors.len() as f64;
    unsafe {
        let view: Retained<AnyObject> = msg_send![class!(NSView), new];
        let _: () = msg_send![&*view, setFrame: Rect([0., 0., width, height])];
        let _: () = msg_send![&*view, setWantsLayer: true];
        let layer: *mut AnyObject = msg_send![&*view, layer];
        for (index, hex) in colors.into_iter().enumerate() {
            let channel = |shift: u32| f64::from((hex >> shift) & 0xff) / 255.;
            let color = CGColor::new_srgb(channel(16), channel(8), channel(0), 1.);
            let stripe: Retained<AnyObject> = msg_send![class!(CALayer), layer];
            let _: () = msg_send![&*stripe, setBackgroundColor: &*color];
            let _: () = msg_send![
                &*stripe,
                setFrame: Rect([index as f64 * band, 0., band, height])
            ];
            let _: () = msg_send![layer, addSublayer: &*stripe];
            let line: Retained<AnyObject> = msg_send![class!(CALayer), layer];
            let white = CGColor::new_srgb(1., 1., 1., 0.85);
            let _: () = msg_send![&*line, setBackgroundColor: &*white];
            let _: () = msg_send![
                &*line,
                setFrame: Rect([0., index as f64 * height / 7. + 12., width, 3.])
            ];
            let _: () = msg_send![layer, addSublayer: &*line];
        }
        NativeView::new(NonNull::from(&*view).cast::<c_void>(), window, cx).ok()
    }
}

#[cfg(not(target_os = "macos"))]
fn striped_page(_: &mut Window, _: &mut App) -> Option<NativeView> {
    None
}

fn main() {
    let background = std::env::var_os("ARDIA_BACKGROUND").is_some();
    application().run(move |cx: &mut App| {
        if background {
            cx.set_activation_policy(ActivationPolicy::Accessory);
        }
        let bounds = Bounds::centered(None, size(px(1180.), px(760.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some("GPUI Liquid Glass".into()),
                    appears_transparent: true,
                    traffic_light_position: Some(point(px(16.), px(16.))),
                }),
                window_background: WindowBackgroundAppearance::LiquidGlass,
                focus: !background,
                ..Default::default()
            },
            |window, cx| cx.new(|cx| Demo::new(window, cx)),
        )
        .expect("the demo window opens");
        if !background {
            cx.activate(true);
        }
    });
}
