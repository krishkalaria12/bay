#![allow(missing_docs)]

use crate::{Hsla, Rgba};
use serde::{Deserialize, Serialize};

pub const DEFAULT_GRAIN_SEED: u32 = 0x9e37_79b9;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum BackdropAppearance {
    Light,
    #[default]
    Dark,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum GrainTexture {
    #[default]
    Film,
    Grain,
    Sand,
    Denim,
    Tweed,
}

impl GrainTexture {
    pub const ALL: [Self; 5] = [
        Self::Film,
        Self::Grain,
        Self::Sand,
        Self::Denim,
        Self::Tweed,
    ];

    pub fn index(self) -> usize {
        self as usize
    }

    pub fn from_index(index: usize) -> Option<Self> {
        Self::ALL.get(index).copied()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BackdropLayerSpec {
    pub top: Rgba,
    pub mid: Rgba,
    pub bottom: Rgba,
    pub gradient_angle: f32,
    pub gradient_stops: [f32; 3],
    pub base_tint: Rgba,
    pub grain_intensity: f32,
    pub grain_seed: u32,
    pub grain_texture: GrainTexture,
    pub appearance: BackdropAppearance,
    pub display_p3: bool,
    pub active_opacity: f32,
    pub inactive_opacity: f32,
}

impl Default for BackdropLayerSpec {
    fn default() -> Self {
        let gray = 128. / 255.;
        Self::treatment(
            BackdropAppearance::Dark,
            Rgba {
                r: gray,
                g: gray,
                b: gray,
                a: 0.36,
            },
        )
    }
}

impl BackdropLayerSpec {
    pub fn treatment(appearance: BackdropAppearance, tint: Rgba) -> Self {
        let dark = appearance == BackdropAppearance::Dark;
        let alpha = unit(tint.a, 0.) * if dark { 0.5 } else { 0.75 };
        let top = Rgba { a: alpha, ..tint };
        let mut lightened = Hsla::from(tint);
        lightened.l = (lightened.l + 0.25).min(1.);
        let bottom = Rgba {
            a: alpha,
            ..Rgba::from(lightened)
        };
        let base = if dark { 0. } else { 1. };
        Self {
            top,
            mid: mix(top, bottom),
            bottom,
            gradient_angle: 180.,
            gradient_stops: [0., 0.5, 1.],
            base_tint: Rgba {
                r: base,
                g: base,
                b: base,
                a: if dark { 0.4 } else { 0.8 },
            },
            grain_intensity: 0.,
            grain_seed: DEFAULT_GRAIN_SEED,
            grain_texture: GrainTexture::Film,
            appearance,
            display_p3: true,
            active_opacity: 1.,
            inactive_opacity: 1.,
        }
    }

    pub fn sanitized(self) -> Self {
        let color = |color: Rgba| Rgba {
            r: unit(color.r, 0.),
            g: unit(color.g, 0.),
            b: unit(color.b, 0.),
            a: unit(color.a, 0.),
        };
        let [first, second, third] = self.gradient_stops.map(|stop| unit(stop, 0.));
        let second = second.max(first);
        Self {
            top: color(self.top),
            mid: color(self.mid),
            bottom: color(self.bottom),
            gradient_angle: if self.gradient_angle.is_finite() {
                self.gradient_angle.rem_euclid(360.)
            } else {
                180.
            },
            gradient_stops: [first, second, third.max(second)],
            base_tint: color(self.base_tint),
            grain_intensity: unit(self.grain_intensity, 0.),
            active_opacity: unit(self.active_opacity, 1.),
            inactive_opacity: unit(self.inactive_opacity, 1.),
            ..self
        }
    }
}

pub const MAX_BACKDROP_GRADIENT_STOPS: usize = 17;
pub const ARC_GRADIENT_SAMPLES: usize = 16;
pub const ARC_GRADIENT_REACH: f32 = 0.75;
pub const ARC_GRADIENT_DEFAULT_ANGLE: f32 = 135.;

/// A linear gradient drawn across the backdrop, in the unit space of its
/// bounds with the origin at the bottom left.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BackdropGradient {
    colors: [Rgba; MAX_BACKDROP_GRADIENT_STOPS],
    locations: [f32; MAX_BACKDROP_GRADIENT_STOPS],
    count: usize,
    start_point: [f32; 2],
    end_point: [f32; 2],
}

impl Default for BackdropGradient {
    fn default() -> Self {
        Self {
            colors: [Rgba::default(); MAX_BACKDROP_GRADIENT_STOPS],
            locations: [0.; MAX_BACKDROP_GRADIENT_STOPS],
            count: 0,
            start_point: [0.5, 1.],
            end_point: [0.5, 0.],
        }
    }
}

impl BackdropGradient {
    /// A gradient through `stops` of colour and location, keeping the first
    /// [`MAX_BACKDROP_GRADIENT_STOPS`].
    pub fn new(
        stops: impl IntoIterator<Item = (Rgba, f32)>,
        start_point: [f32; 2],
        end_point: [f32; 2],
    ) -> Self {
        let mut gradient = Self {
            start_point,
            end_point,
            ..Self::default()
        };
        for (color, location) in stops.into_iter().take(MAX_BACKDROP_GRADIENT_STOPS) {
            gradient.colors[gradient.count] = color;
            gradient.locations[gradient.count] = location;
            gradient.count += 1;
        }
        gradient
    }

    /// A gradient through `colors` spread evenly from start to end.
    pub fn even(colors: &[Rgba], start_point: [f32; 2], end_point: [f32; 2]) -> Self {
        let steps = colors
            .len()
            .min(MAX_BACKDROP_GRADIENT_STOPS)
            .saturating_sub(1)
            .max(1);
        Self::new(
            colors
                .iter()
                .enumerate()
                .map(|(index, color)| (*color, index as f32 / steps as f32)),
            start_point,
            end_point,
        )
    }

    /// The base layer of Ardia's theme gradient (`ArcGradientLayer`): the
    /// first two colours mixed in OKLab over [`ARC_GRADIENT_SAMPLES`] steps,
    /// laid along `angle` (clockwise degrees from up) for bounds of `size`.
    pub fn arc_base(angle: f32, colors: &[Rgba], size: [f32; 2]) -> Option<Self> {
        let first = *colors.first()?;
        let second = colors.get(1).copied().unwrap_or(first);
        let steps = if colors.len() > 1 {
            ARC_GRADIENT_SAMPLES
        } else {
            1
        };
        let (from, to) = (oklab(first), oklab(second));
        let (start_point, end_point) = arc_base_points(angle, size);
        Some(Self::new(
            (0..=steps).map(|step| {
                let t = step as f32 / steps as f32;
                let mixed: [f32; 4] = std::array::from_fn(|i| from[i] + (to[i] - from[i]) * t);
                (srgb(mixed), (f64::from(step as u32) / steps as f64) as f32)
            }),
            start_point,
            end_point,
        ))
    }

    /// The overlay layer of Ardia's theme gradient: the third colour faded
    /// in from transparent along `angle + 45°`, across the full bounds.
    pub fn arc_overlay(angle: f32, colors: &[Rgba], size: [f32; 2]) -> Option<Self> {
        let color = *colors.get(2)?;
        let (start_point, end_point) = arc_overlay_points(angle, size);
        Some(Self::even(
            &[Rgba { a: 0., ..color }, color],
            start_point,
            end_point,
        ))
    }

    pub fn colors(&self) -> &[Rgba] {
        &self.colors[..self.len()]
    }

    pub fn locations(&self) -> &[f32] {
        &self.locations[..self.len()]
    }

    pub fn start_point(&self) -> [f32; 2] {
        self.start_point
    }

    pub fn end_point(&self) -> [f32; 2] {
        self.end_point
    }

    pub fn len(&self) -> usize {
        self.count.min(MAX_BACKDROP_GRADIENT_STOPS)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn sanitized(self) -> Self {
        let finite = |value: f32| if value.is_finite() { value } else { 0. };
        let point = |point: [f32; 2]| point.map(finite);
        let mut previous = 0f32;
        Self::new(
            self.colors()
                .iter()
                .zip(self.locations())
                .map(|(color, location)| {
                    previous = unit(*location, previous).max(previous);
                    (
                        Rgba {
                            r: finite(color.r),
                            g: finite(color.g),
                            b: finite(color.b),
                            a: unit(color.a, 0.),
                        },
                        previous,
                    )
                }),
            point(self.start_point),
            point(self.end_point),
        )
    }
}

/// The gradients a backdrop draws above its base tint and below its grain,
/// replacing the spec's three-stop gradient when `base` is set.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BackdropGradients {
    pub base: Option<BackdropGradient>,
    pub overlay: Option<BackdropGradient>,
    /// The opacity of the base and overlay gradients together, composited as
    /// one group so where they overlap isn't blended twice.
    pub opacity: f32,
}

impl Default for BackdropGradients {
    fn default() -> Self {
        Self {
            base: None,
            overlay: None,
            opacity: 1.,
        }
    }
}

impl BackdropGradients {
    /// Both layers of Ardia's theme gradient (`ArcGradientLayer`) for theme
    /// `colors`, `angle` and backdrop bounds of `size`, in points.
    pub fn arc(angle: f32, colors: &[Rgba], size: [f32; 2]) -> Self {
        Self {
            base: BackdropGradient::arc_base(angle, colors, size),
            overlay: BackdropGradient::arc_overlay(angle, colors, size),
            opacity: 1.,
        }
    }

    /// These gradients drawn at `opacity` as one group.
    pub fn opacity(mut self, opacity: f32) -> Self {
        self.opacity = opacity;
        self
    }

    pub fn is_empty(&self) -> bool {
        self.base.is_none() && self.overlay.is_none()
    }

    pub fn sanitized(self) -> Self {
        Self {
            base: self.base.map(BackdropGradient::sanitized),
            overlay: self.overlay.map(BackdropGradient::sanitized),
            opacity: if self.opacity.is_finite() {
                self.opacity.clamp(0., 1.)
            } else {
                1.
            },
        }
    }
}

/// `ArcGradientLayer`'s base start and end points: a line along `angle`
/// through the centre, reaching [`ARC_GRADIENT_REACH`] of the way to the
/// corner of a box scaled to the longer side.
pub fn arc_base_points(angle: f32, size: [f32; 2]) -> ([f32; 2], [f32; 2]) {
    arc_points(
        f64::from(angle),
        size,
        f64::from(ARC_GRADIENT_REACH),
        |w, h, dx, dy| (w * dx).hypot(h * dy) * w.hypot(h) / (2. * w.max(h)),
    )
}

/// `ArcGradientLayer`'s overlay start and end points: along `angle + 45°`,
/// corner to corner.
pub fn arc_overlay_points(angle: f32, size: [f32; 2]) -> ([f32; 2], [f32; 2]) {
    arc_points(f64::from(angle) + 45., size, 1., |w, h, dx, dy| {
        (w * dx.abs() + h * dy.abs()) / 2.
    })
}

fn arc_points(
    degrees: f64,
    size: [f32; 2],
    reach: f64,
    half: impl Fn(f64, f64, f64, f64) -> f64,
) -> ([f32; 2], [f32; 2]) {
    let side = |value: f32| {
        let value = f64::from(value);
        if value.is_finite() { value.max(1.) } else { 1. }
    };
    let (w, h) = (side(size[0]), side(size[1]));
    let radians = if degrees.is_finite() { degrees } else { 0. }.to_radians();
    let (dx, dy) = (radians.sin(), -radians.cos());
    let length = half(w, h, dx, dy);
    let (ax, ay) = (w * dx, h * dy);
    let scale = 2. * length * reach / (ax * ax + ay * ay);
    let (u, v) = (0.5 - length * dx / w, 0.5 - length * dy / h);
    let unit = |u: f64, v: f64| [u as f32, (1. - v) as f32];
    (unit(u, v), unit(u + ax * scale, v + ay * scale))
}

#[allow(clippy::excessive_precision)]
fn oklab(color: Rgba) -> [f32; 4] {
    let linear = |x: f32| {
        if x.abs() <= 0.04045 {
            x / 12.92
        } else {
            x.signum() * ((x.abs() + 0.055) / 1.055).powf(2.4)
        }
    };
    let (r, g, b) = (linear(color.r), linear(color.g), linear(color.b));
    let l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b).cbrt();
    let m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b).cbrt();
    let s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b).cbrt();
    [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
        color.a,
    ]
}

#[allow(clippy::excessive_precision)]
fn srgb(lab: [f32; 4]) -> Rgba {
    let l = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2];
    let m = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2];
    let s = lab[0] - 0.0894841775 * lab[1] - 1.2914855480 * lab[2];
    let (l, m, s) = (l * l * l, m * m * m, s * s * s);
    let encode = |x: f32| {
        if x.abs() <= 0.0031308 {
            x * 12.92
        } else {
            x.signum() * (1.055 * x.abs().powf(1. / 2.4) - 0.055)
        }
    };
    Rgba {
        r: encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        g: encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        b: encode(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
        a: lab[3],
    }
}

fn unit(value: f32, fallback: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0., 1.)
    } else {
        fallback
    }
}

fn mix(first: Rgba, second: Rgba) -> Rgba {
    Rgba {
        r: (first.r + second.r) / 2.,
        g: (first.g + second.g) / 2.,
        b: (first.b + second.b) / 2.,
        a: (first.a + second.a) / 2.,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(first: Rgba, second: Rgba) -> bool {
        [
            (first.r, second.r),
            (first.g, second.g),
            (first.b, second.b),
            (first.a, second.a),
        ]
        .iter()
        .all(|(first, second)| (first - second).abs() < 0.01)
    }

    #[test]
    fn default_spec_is_the_dia_window_treatment() {
        let spec = BackdropLayerSpec::default();
        let gray = 128. / 255.;
        assert_eq!(spec.appearance, BackdropAppearance::Dark);
        assert!(close(
            spec.base_tint,
            Rgba {
                r: 0.,
                g: 0.,
                b: 0.,
                a: 0.4
            }
        ));
        assert!(close(
            spec.top,
            Rgba {
                r: gray,
                g: gray,
                b: gray,
                a: 0.18
            }
        ));
        assert!(spec.bottom.r > spec.top.r);
        assert!((spec.bottom.a - 0.18).abs() < 1e-6);
        assert_eq!(spec.gradient_angle, 180.);
        assert_eq!(spec.gradient_stops, [0., 0.5, 1.]);
        assert_eq!(spec.grain_intensity, 0.);
        assert_eq!(spec.grain_seed, DEFAULT_GRAIN_SEED);
        assert_eq!(spec.grain_texture, GrainTexture::Film);
        assert!(spec.display_p3);
        assert_eq!((spec.active_opacity, spec.inactive_opacity), (1., 1.));
    }

    #[test]
    fn light_treatment_lightens_the_bottom_stop_by_a_quarter() {
        let plum = Rgba {
            r: 0.698,
            g: 0.357,
            b: 0.42,
            a: 0.36,
        };
        let spec = BackdropLayerSpec::treatment(BackdropAppearance::Light, plum);
        assert!(close(
            spec.base_tint,
            Rgba {
                r: 1.,
                g: 1.,
                b: 1.,
                a: 0.8
            }
        ));
        assert!((spec.top.a - 0.27).abs() < 1e-6);
        let top = Hsla::from(spec.top);
        let bottom = Hsla::from(spec.bottom);
        assert!((bottom.l - top.l - 0.25).abs() < 0.01);
        assert!((bottom.h - top.h).abs() < 0.01);
    }

    #[test]
    fn spec_round_trips_through_json_and_fills_missing_fields() {
        let spec = BackdropLayerSpec {
            grain_intensity: 0.4,
            grain_seed: 7,
            grain_texture: GrainTexture::Tweed,
            appearance: BackdropAppearance::Light,
            ..BackdropLayerSpec::default()
        };
        let json = serde_json::to_string(&spec).unwrap();
        let parsed: BackdropLayerSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(serde_json::to_string(&parsed).unwrap(), json);
        assert_eq!(parsed.grain_texture, GrainTexture::Tweed);

        let partial: BackdropLayerSpec =
            serde_json::from_str(r#"{"grain_intensity":0.5,"appearance":"Light"}"#).unwrap();
        assert_eq!(partial.grain_intensity, 0.5);
        assert_eq!(partial.appearance, BackdropAppearance::Light);
        assert_eq!(
            partial.gradient_stops,
            BackdropLayerSpec::default().gradient_stops
        );
    }

    #[test]
    fn sanitizing_clamps_values_a_platform_cannot_draw() {
        let spec = BackdropLayerSpec {
            top: Rgba {
                r: f32::NAN,
                g: 2.,
                b: -1.,
                a: 0.5,
            },
            gradient_angle: f32::INFINITY,
            gradient_stops: [0.8, 0.2, f32::NAN],
            grain_intensity: 3.,
            active_opacity: f32::NAN,
            inactive_opacity: -2.,
            ..BackdropLayerSpec::default()
        }
        .sanitized();
        assert_eq!(
            (spec.top.r, spec.top.g, spec.top.b, spec.top.a),
            (0., 1., 0., 0.5)
        );
        assert_eq!(spec.gradient_angle, 180.);
        assert_eq!(spec.gradient_stops, [0.8, 0.8, 0.8]);
        assert_eq!(spec.grain_intensity, 1.);
        assert_eq!((spec.active_opacity, spec.inactive_opacity), (1., 0.));
        assert_eq!(
            BackdropLayerSpec {
                gradient_angle: -90.,
                ..BackdropLayerSpec::default()
            }
            .sanitized()
            .gradient_angle,
            270.
        );
    }

    fn swift_place(
        w: f64,
        h: f64,
        degrees: f64,
        reach: f64,
        half: impl Fn(f64, f64) -> f64,
    ) -> ([f64; 2], [f64; 2]) {
        let (w, h) = (w.max(1.), h.max(1.));
        let unit = |u: f64, v: f64| [u, 1. - v];
        let r = degrees * std::f64::consts::PI / 180.;
        let (dx, dy) = (r.sin(), -r.cos());
        let length = half(dx, dy);
        let (ax, ay) = (w * dx, h * dy);
        let scale = 2. * length * reach / (ax * ax + ay * ay);
        let (u, v) = (0.5 - length * dx / w, 0.5 - length * dy / h);
        (unit(u, v), unit(u + ax * scale, v + ay * scale))
    }

    fn swift_base(angle: f64, w: f64, h: f64) -> ([f64; 2], [f64; 2]) {
        let (cw, ch) = (w.max(1.), h.max(1.));
        swift_place(w, h, angle, 0.75, |dx, dy| {
            (cw * dx).hypot(ch * dy) * cw.hypot(ch) / (2. * cw.max(ch))
        })
    }

    fn swift_overlay(angle: f64, w: f64, h: f64) -> ([f64; 2], [f64; 2]) {
        let (cw, ch) = (w.max(1.), h.max(1.));
        swift_place(w, h, angle + 45., 1., |dx, dy| {
            (cw * dx.abs() + ch * dy.abs()) / 2.
        })
    }

    fn assert_points(actual: ([f32; 2], [f32; 2]), expected: ([f64; 2], [f64; 2]), label: &str) {
        let actual = [actual.0, actual.1].concat();
        let expected = [expected.0, expected.1].concat();
        for (actual, expected) in actual.iter().zip(expected) {
            assert!(
                (f64::from(*actual) - expected).abs() < 1e-5,
                "{label}: {actual} != {expected}"
            );
        }
    }

    #[test]
    fn arc_points_match_arc_gradient_layer() {
        let angles = [0., 17.5, 45., 90., 135., 180., 225., 270., 315., -30., 400.];
        let sizes = [
            [300., 900.],
            [1200., 800.],
            [800., 200.],
            [400., 400.],
            [1., 500.],
            [0., 0.],
        ];
        for angle in angles {
            for [w, h] in sizes {
                let label = format!("{angle}° {w}x{h}");
                assert_points(
                    arc_base_points(angle, [w, h]),
                    swift_base(f64::from(angle), f64::from(w), f64::from(h)),
                    &label,
                );
                assert_points(
                    arc_overlay_points(angle, [w, h]),
                    swift_overlay(f64::from(angle), f64::from(w), f64::from(h)),
                    &label,
                );
            }
        }
        assert_points(
            arc_base_points(135., [400., 400.]),
            ([0., 1.], [0.75, 0.25]),
            "square base",
        );
        assert_points(
            arc_overlay_points(135., [400., 400.]),
            ([0.5, 1.], [0.5, 0.]),
            "square overlay",
        );
    }

    fn rgba(r: f32, g: f32, b: f32, a: f32) -> Rgba {
        Rgba { r, g, b, a }
    }

    #[test]
    fn arc_gradients_mix_in_oklab_like_arc_gradient_layer() {
        let black = rgba(0., 0., 0., 1.);
        let white = rgba(1., 1., 1., 0.5);
        let plum = rgba(0.698, 0.357, 0.42, 0.8);
        let size = [1200., 800.];

        let gradients = BackdropGradients::arc(135., &[black, white], size);
        let base = gradients.base.expect("a base gradient");
        assert!(gradients.overlay.is_none());
        assert_eq!(base.len(), ARC_GRADIENT_SAMPLES + 1);
        for (index, location) in base.locations().iter().enumerate() {
            assert_eq!(*location, index as f32 / ARC_GRADIENT_SAMPLES as f32);
        }
        assert!(close(base.colors()[0], black));
        assert!(close(base.colors()[ARC_GRADIENT_SAMPLES], white));
        let middle = base.colors()[ARC_GRADIENT_SAMPLES / 2];
        for channel in [middle.r, middle.g, middle.b] {
            assert!((channel - 0.3885).abs() < 1e-3, "{middle:?}");
        }
        assert!((middle.a - 0.75).abs() < 1e-6);
        assert_eq!(
            (base.start_point(), base.end_point()),
            arc_base_points(135., size)
        );

        let single = BackdropGradients::arc(90., &[plum], size);
        let base = single.base.expect("a base gradient");
        assert_eq!(base.locations(), &[0., 1.]);
        assert!(close(base.colors()[0], plum) && close(base.colors()[1], plum));

        let three = BackdropGradients::arc(200., &[black, white, plum], size);
        let overlay = three.overlay.expect("an overlay for a third colour");
        assert_eq!(overlay.colors(), &[rgba(0.698, 0.357, 0.42, 0.), plum]);
        assert_eq!(overlay.locations(), &[0., 1.]);
        assert_eq!(
            (overlay.start_point(), overlay.end_point()),
            arc_overlay_points(200., size)
        );

        assert!(BackdropGradients::arc(0., &[], size).is_empty());
    }

    #[test]
    fn backdrop_gradients_keep_at_most_the_stops_a_layer_takes() {
        let stops = (0..40).map(|index| (rgba(1., 0., 0., 1.), index as f32 / 39.));
        let gradient = BackdropGradient::new(stops, [0., 0.], [1., 1.]);
        assert_eq!(gradient.len(), MAX_BACKDROP_GRADIENT_STOPS);

        let messy = BackdropGradient::new(
            [
                (rgba(f32::NAN, 1.5, 0., 2.), 0.6),
                (rgba(0., 0., 0., -1.), 0.2),
                (rgba(0., 0., 0., 1.), f32::NAN),
            ],
            [f32::INFINITY, 0.],
            [1., f32::NAN],
        )
        .sanitized();
        assert_eq!(messy.colors()[0], rgba(0., 1.5, 0., 1.));
        assert_eq!(messy.colors()[1].a, 0.);
        assert_eq!(messy.locations(), &[0.6, 0.6, 0.6]);
        assert_eq!(
            (messy.start_point(), messy.end_point()),
            ([0., 0.], [1., 0.])
        );

        let json = serde_json::to_string(&BackdropGradients::arc(
            135.,
            &[rgba(1., 0., 0., 1.)],
            [10., 10.],
        ))
        .unwrap();
        let parsed: BackdropGradients = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.base.map(|base| base.len()), Some(2));
        assert_eq!(
            serde_json::from_str::<BackdropGradients>("{}").unwrap(),
            BackdropGradients::default()
        );
    }

    #[test]
    fn gradients_composite_at_one_group_opacity() {
        assert_eq!(BackdropGradients::default().opacity, 1.);
        assert_eq!(
            serde_json::from_str::<BackdropGradients>("{}")
                .unwrap()
                .opacity,
            1.
        );
        let arc = BackdropGradients::arc(135., &[rgba(1., 0., 0., 1.)], [10., 10.]);
        assert_eq!(arc.opacity, 1.);
        assert_eq!(arc.opacity(0.65).opacity, 0.65);
        assert_eq!(arc.opacity(0.65).sanitized().opacity, 0.65);
        for (given, kept) in [(2., 1.), (-1., 0.), (f32::NAN, 1.), (f32::INFINITY, 1.)] {
            assert_eq!(arc.opacity(given).sanitized().opacity, kept);
        }
    }

    #[test]
    fn grain_textures_index_round_trip() {
        for (index, texture) in GrainTexture::ALL.into_iter().enumerate() {
            assert_eq!(texture.index(), index);
            assert_eq!(GrainTexture::from_index(index), Some(texture));
        }
        assert_eq!(GrainTexture::from_index(GrainTexture::ALL.len()), None);
    }
}
