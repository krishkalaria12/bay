use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use smallvec::SmallVec;

use super::{
    PaintedPath, Primitive, Quad, SpriteAnimation, SpriteAnimationId, TransformationMatrix,
};
use crate::{
    AtlasTile, Axis, Background, BackgroundTag, Bounds, ContentMask, Corners, DevicePixels, Edges,
    FillRule, Pixels, Point, Radians, ScaledPixels, path_builder::Outline, point, px, size,
};

/// A scale along each axis and a turn about a point, in device pixels, that
/// the scene applies to every primitive inserted while it is active.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct PaintTransform {
    scale: Point<f32>,
    linear: [[f32; 2]; 2],
    translation: Point<ScaledPixels>,
    clip: Bounds<ScaledPixels>,
}

impl PaintTransform {
    /// Scales by `scale.x` horizontally and `scale.y` vertically, and then
    /// turns clockwise by `rotation`, about `origin`, given in `parent`'s
    /// untransformed space if there is a parent. Nothing transformed shows
    /// outside `clip`, the content mask where the transform begins, in
    /// window space.
    pub(crate) fn about(
        origin: Point<ScaledPixels>,
        scale: Point<f32>,
        rotation: Radians,
        clip: Bounds<ScaledPixels>,
        parent: Option<Self>,
    ) -> Self {
        let linear = if rotation.0 == 0. {
            [[scale.x, 0.], [0., scale.y]]
        } else {
            let (sin, cos) = rotation.0.sin_cos();
            [
                [scale.x * cos, -scale.y * sin],
                [scale.x * sin, scale.y * cos],
            ]
        };
        let turned_origin = multiply(linear, origin);
        let local = Self {
            scale,
            linear,
            translation: point(
                ScaledPixels(origin.x.0 - turned_origin.x.0),
                ScaledPixels(origin.y.0 - turned_origin.y.0),
            ),
            clip,
        };
        let Some(parent) = parent else {
            return local;
        };
        let linear = compose(parent.linear, local.linear);
        let scale = if (parent.is_uniform() && local.is_uniform())
            || (!parent.rotates() && !local.rotates())
        {
            point(
                parent.scale.x * local.scale.x,
                parent.scale.y * local.scale.y,
            )
        } else {
            point(
                linear[0][0].hypot(linear[1][0]),
                linear[0][1].hypot(linear[1][1]),
            )
        };
        Self {
            scale,
            linear,
            translation: parent.point(local.translation),
            clip,
        }
    }

    /// How much the transform stretches lengths along its x and y axes.
    pub(crate) fn scale(&self) -> Point<f32> {
        self.scale
    }

    /// Whether the transform scales both axes alike.
    pub(crate) fn is_uniform(&self) -> bool {
        self.scale.x == self.scale.y
    }

    /// Whether `quad` can only be drawn as path fills under the transform:
    /// a turned quad, or a rounded one scaled unevenly, whose corners become
    /// elliptical.
    pub(crate) fn fills_quad_as_paths(&self, quad: &Quad) -> bool {
        self.rotates() || (!self.is_uniform() && quad.corner_radii != Corners::default())
    }

    /// How far the transform turns what it draws, clockwise.
    #[cfg(test)]
    pub(crate) fn rotation(&self) -> Radians {
        if !self.rotates() {
            return Radians(0.);
        }
        Radians(self.linear[1][0].atan2(self.linear[0][0]))
    }

    /// Whether the transform turns what it draws, so that rectangles no
    /// longer stay axis-aligned.
    pub(crate) fn rotates(&self) -> bool {
        self.linear[0][1] != 0. || self.linear[1][0] != 0.
    }

    pub(crate) fn point(&self, point: Point<ScaledPixels>) -> Point<ScaledPixels> {
        if !self.rotates() {
            return Point::new(
                ScaledPixels(point.x.0 * self.scale.x + self.translation.x.0),
                ScaledPixels(point.y.0 * self.scale.y + self.translation.y.0),
            );
        }
        let turned = multiply(self.linear, point);
        Point::new(
            ScaledPixels(turned.x.0 + self.translation.x.0),
            ScaledPixels(turned.y.0 + self.translation.y.0),
        )
    }

    /// A length that has no direction, such as a corner radius or a blur,
    /// scaled by the smaller of the two axes so it still fits what it
    /// rounds or blurs.
    fn length(&self, length: ScaledPixels) -> ScaledPixels {
        ScaledPixels(length.0 * self.scale.x.min(self.scale.y))
    }

    fn size(&self, size: crate::Size<ScaledPixels>) -> crate::Size<ScaledPixels> {
        crate::size(
            ScaledPixels(size.width.0 * self.scale.x),
            ScaledPixels(size.height.0 * self.scale.y),
        )
    }

    /// The smallest axis-aligned bounds that contain `bounds` once it is
    /// transformed.
    pub(crate) fn bounds(&self, bounds: Bounds<ScaledPixels>) -> Bounds<ScaledPixels> {
        if self.rotates() {
            return self.matrix_of_transform().transform_bounds(bounds);
        }
        Bounds {
            origin: self.point(bounds.origin),
            size: self.size(bounds.size),
        }
    }

    /// `bounds` scaled about where its center moves to, without turning.
    fn upright_bounds(&self, bounds: Bounds<ScaledPixels>) -> Bounds<ScaledPixels> {
        let center = self.point(bounds.center());
        let size = self.size(bounds.size);
        Bounds {
            origin: point(center.x - size.width / 2., center.y - size.height / 2.),
            size,
        }
    }

    fn content_mask(&self, mask: ContentMask<ScaledPixels>) -> ContentMask<ScaledPixels> {
        ContentMask {
            bounds: self.bounds(mask.bounds).intersect(&self.clip),
        }
    }

    fn corners(&self, corners: Corners<ScaledPixels>) -> Corners<ScaledPixels> {
        corners.map(|radius| self.length(*radius))
    }

    /// Border widths, the left and right scaled horizontally and the top
    /// and bottom vertically.
    fn edges(&self, edges: Edges<ScaledPixels>) -> Edges<ScaledPixels> {
        Edges {
            top: ScaledPixels(edges.top.0 * self.scale.y),
            right: ScaledPixels(edges.right.0 * self.scale.x),
            bottom: ScaledPixels(edges.bottom.0 * self.scale.y),
            left: ScaledPixels(edges.left.0 * self.scale.x),
        }
    }

    /// The translation in logical pixels.
    pub(crate) fn logical_translation(&self, scale_factor: f32) -> Point<f32> {
        point(
            self.translation.x.0 / scale_factor,
            self.translation.y.0 / scale_factor,
        )
    }

    /// The linear part of the transform, which is the same in logical and
    /// device pixels.
    pub(crate) fn linear(&self) -> [[f32; 2]; 2] {
        self.linear
    }

    /// Bounds in logical pixels, untransformed: the smallest bounds whose
    /// transform covers `bounds`.
    pub(crate) fn inverse_logical_bounds(
        &self,
        bounds: Bounds<Pixels>,
        scale_factor: f32,
    ) -> Bounds<Pixels> {
        let bounds = bounds.scale(scale_factor);
        if self.rotates() {
            let [[a, b], [c, d]] = self.linear;
            let determinant = a * d - b * c;
            let inverse = TransformationMatrix {
                rotation_scale: [
                    [d / determinant, -b / determinant],
                    [-c / determinant, a / determinant],
                ],
                translation: [0., 0.],
            }
            .translate(point(-self.translation.x, -self.translation.y));
            return to_logical(inverse.transform_bounds(bounds), scale_factor);
        }
        let inverse = |value: f32, translation: f32, scale: f32| (value - translation) / scale;
        to_logical(
            Bounds {
                origin: point(
                    ScaledPixels(inverse(
                        bounds.origin.x.0,
                        self.translation.x.0,
                        self.scale.x,
                    )),
                    ScaledPixels(inverse(
                        bounds.origin.y.0,
                        self.translation.y.0,
                        self.scale.y,
                    )),
                ),
                size: size(
                    ScaledPixels(bounds.size.width.0 / self.scale.x),
                    ScaledPixels(bounds.size.height.0 / self.scale.y),
                ),
            },
            scale_factor,
        )
    }

    /// Bounds in logical pixels, transformed: the smallest axis-aligned
    /// bounds that contain `bounds` once it is transformed.
    pub(crate) fn logical_bounds(
        &self,
        bounds: Bounds<Pixels>,
        scale_factor: f32,
    ) -> Bounds<Pixels> {
        to_logical(self.bounds(bounds.scale(scale_factor)), scale_factor)
    }

    /// A content mask in logical pixels, transformed and clipped to where the
    /// transform began.
    pub(crate) fn logical_content_mask(
        &self,
        mask: ContentMask<Pixels>,
        scale_factor: f32,
    ) -> ContentMask<Pixels> {
        ContentMask {
            bounds: to_logical(
                self.content_mask(mask.scale(scale_factor)).bounds,
                scale_factor,
            ),
        }
    }

    /// The whole transform as a matrix in device pixels.
    fn matrix_of_transform(&self) -> TransformationMatrix {
        TransformationMatrix {
            rotation_scale: self.linear,
            translation: [self.translation.x.0, self.translation.y.0],
        }
    }

    /// The matrix that moves a sprite drawn into transformed bounds as
    /// `matrix` moved it in its original bounds, for a uniform transform
    /// that doesn't turn.
    fn matrix(&self, matrix: TransformationMatrix) -> TransformationMatrix {
        if matrix == TransformationMatrix::unit() {
            return matrix;
        }
        let [[xx, xy], [yx, yy]] = matrix.rotation_scale;
        let (tx, ty) = (self.translation.x.0, self.translation.y.0);
        TransformationMatrix {
            rotation_scale: matrix.rotation_scale,
            translation: [
                self.scale.x * matrix.translation[0] + tx - (xx * tx + xy * ty),
                self.scale.y * matrix.translation[1] + ty - (yx * tx + yy * ty),
            ],
        }
    }

    pub(crate) fn animation(&self, mut animation: SpriteAnimation) -> SpriteAnimation {
        if self.rotates() || !self.is_uniform() {
            animation.paint_matrix = Some(self.matrix_of_transform());
            return animation;
        }
        let scale_factor = animation.scale_factor * self.scale.x;
        animation.center = point(
            animation.center.x + px(self.translation.x.0 / scale_factor),
            animation.center.y + px(self.translation.y.0 / scale_factor),
        );
        animation.scale_factor = scale_factor;
        animation
    }

    /// Calls `insert` with what `primitive` becomes under the transform.
    ///
    /// Native views are platform views laid out by the platform, and paths
    /// are binned into device pixels when they are created, so the window
    /// transforms both before they get here.
    ///
    /// Scaled unevenly, rectangles stretch along each axis: borders take the
    /// scale of the axis they run across and underlines thicken vertically.
    /// Corner radii and blurs, which the GPU draws circular, take the
    /// smaller scale, except on quads, whose rounded corners turn into path
    /// fills of their elliptical shape. Monochrome and subpixel sprites
    /// stretch through their matrix.
    pub(crate) fn apply(&self, primitive: Primitive, insert: &mut impl FnMut(Primitive)) {
        if self.rotates() {
            self.apply_turned(primitive, insert);
            return;
        }
        if !self.is_uniform() {
            match primitive {
                Primitive::Quad(quad) if self.fills_quad_as_paths(&quad) => {
                    self.fill_quad(quad, insert);
                    return;
                }
                Primitive::MonochromeSprite(_) | Primitive::SubpixelSprite(_) => {
                    self.apply_turned(primitive, insert);
                    return;
                }
                _ => {}
            }
        }
        insert(match primitive {
            Primitive::Shadow(mut shadow) => {
                shadow.blur_radius = self.length(shadow.blur_radius);
                shadow.bounds = self.bounds(shadow.bounds);
                shadow.corner_radii = self.corners(shadow.corner_radii);
                shadow.content_mask = self.content_mask(shadow.content_mask);
                shadow.shape_bounds = self.bounds(shadow.shape_bounds);
                shadow.shape_corner_radii = self.corners(shadow.shape_corner_radii);
                Primitive::Shadow(shadow)
            }
            Primitive::Quad(mut quad) => {
                quad.bounds = self.bounds(quad.bounds);
                quad.content_mask = self.content_mask(quad.content_mask);
                quad.corner_radii = self.corners(quad.corner_radii);
                quad.border_widths = self.edges(quad.border_widths);
                Primitive::Quad(quad)
            }
            Primitive::Underline(mut underline) => {
                underline.bounds = self.bounds(underline.bounds);
                underline.content_mask = self.content_mask(underline.content_mask);
                underline.thickness = ScaledPixels(underline.thickness.0 * self.scale.y);
                Primitive::Underline(underline)
            }
            Primitive::MonochromeSprite(mut sprite) => {
                sprite.bounds = self.bounds(sprite.bounds);
                sprite.content_mask = self.content_mask(sprite.content_mask);
                sprite.transformation = self.matrix(sprite.transformation);
                Primitive::MonochromeSprite(sprite)
            }
            Primitive::SubpixelSprite(mut sprite) => {
                sprite.bounds = self.bounds(sprite.bounds);
                sprite.content_mask = self.content_mask(sprite.content_mask);
                sprite.transformation = self.matrix(sprite.transformation);
                Primitive::SubpixelSprite(sprite)
            }
            Primitive::PolychromeSprite(mut sprite) => {
                sprite.bounds = self.bounds(sprite.bounds);
                sprite.content_mask = self.content_mask(sprite.content_mask);
                sprite.corner_radii = self.corners(sprite.corner_radii);
                Primitive::PolychromeSprite(sprite)
            }
            Primitive::Surface(mut surface) => {
                surface.bounds = self.bounds(surface.bounds);
                surface.content_mask = self.content_mask(surface.content_mask);
                Primitive::Surface(surface)
            }
            primitive @ (Primitive::Path(_) | Primitive::NativeView(_)) => primitive,
        })
    }

    /// [`Self::apply`] for a transform that turns. Sprites with a matrix turn
    /// through it; quads and underlines become path fills of their turned
    /// shapes. Shadows, polychrome sprites and surfaces have no way to turn
    /// on the GPU, so they stay upright, scaled about where their center
    /// moves to. Content masks become the bounds of their turned rectangles.
    fn apply_turned(&self, primitive: Primitive, insert: &mut impl FnMut(Primitive)) {
        match primitive {
            Primitive::Shadow(mut shadow) => {
                shadow.blur_radius = self.length(shadow.blur_radius);
                shadow.bounds = self.upright_bounds(shadow.bounds);
                shadow.corner_radii = self.corners(shadow.corner_radii);
                shadow.content_mask = self.content_mask(shadow.content_mask);
                shadow.shape_bounds = self.upright_bounds(shadow.shape_bounds);
                shadow.shape_corner_radii = self.corners(shadow.shape_corner_radii);
                insert(Primitive::Shadow(shadow));
            }
            Primitive::Quad(quad) => self.fill_quad(quad, insert),
            Primitive::Underline(underline) => {
                let bounds = if underline.wavy.as_bool() {
                    let thickness = underline.thickness.min(underline.bounds.size.height);
                    Bounds {
                        origin: point(
                            underline.bounds.origin.x,
                            underline.bounds.center().y - thickness / 2.,
                        ),
                        size: size(underline.bounds.size.width, thickness),
                    }
                } else {
                    underline.bounds
                };
                let content_mask = self.content_mask(underline.content_mask);
                if let Some(path) =
                    self.fill(content_mask, underline.color.into(), false, |outline| {
                        self.rounded_rect(outline, bounds, Corners::default(), None)
                    })
                {
                    insert(path);
                }
            }
            Primitive::MonochromeSprite(mut sprite) => {
                sprite.content_mask = self.content_mask(sprite.content_mask);
                sprite.transformation = self.matrix_of_transform().compose(sprite.transformation);
                insert(Primitive::MonochromeSprite(sprite));
            }
            Primitive::SubpixelSprite(mut sprite) => {
                sprite.content_mask = self.content_mask(sprite.content_mask);
                sprite.transformation = self.matrix_of_transform().compose(sprite.transformation);
                insert(Primitive::SubpixelSprite(sprite));
            }
            Primitive::PolychromeSprite(mut sprite) => {
                sprite.bounds = self.upright_bounds(sprite.bounds);
                sprite.content_mask = self.content_mask(sprite.content_mask);
                sprite.corner_radii = self.corners(sprite.corner_radii);
                insert(Primitive::PolychromeSprite(sprite));
            }
            Primitive::Surface(mut surface) => {
                surface.bounds = self.upright_bounds(surface.bounds);
                surface.content_mask = self.content_mask(surface.content_mask);
                insert(Primitive::Surface(surface));
            }
            primitive @ (Primitive::Path(_) | Primitive::NativeView(_)) => insert(primitive),
        }
    }

    /// Inserts path fills of `quad`'s transformed background and border ring.
    fn fill_quad(&self, quad: Quad, insert: &mut impl FnMut(Primitive)) {
        let content_mask = self.content_mask(quad.content_mask);
        if !quad.background.is_transparent() {
            let background = self.turned_background(quad.background);
            if let Some(path) = self.fill(content_mask, background, false, |outline| {
                self.rounded_rect(outline, quad.bounds, quad.corner_radii, None)
            }) {
                insert(path);
            }
        }
        if quad.border_widths != Edges::default() && !quad.border_color.is_transparent() {
            let border = Background::from(quad.border_color);
            if let Some(path) = self.fill(content_mask, border, true, |outline| {
                self.rounded_rect(outline, quad.bounds, quad.corner_radii, None);
                self.rounded_rect(
                    outline,
                    quad.bounds,
                    quad.corner_radii,
                    Some(quad.border_widths),
                );
            }) {
                insert(path);
            }
        }
    }

    /// A linear gradient turned with the shape it fills. Its stops still span
    /// the bounds of the turned shape.
    fn turned_background(&self, mut background: Background) -> Background {
        if background.tag == BackgroundTag::LinearGradient {
            let turn = self.linear[1][0].atan2(self.linear[0][0]).to_degrees();
            background.gradient_angle_or_pattern_height += turn;
        }
        background
    }

    fn fill(
        &self,
        content_mask: ContentMask<ScaledPixels>,
        color: Background,
        even_odd: bool,
        build: impl FnOnce(&mut Outline),
    ) -> Option<Primitive> {
        let mut outline = Outline::default();
        build(&mut outline);
        let curves = outline.into_curves().ok()?;
        if curves.is_empty() {
            return None;
        }
        let fill_rule = if even_odd {
            FillRule::EvenOdd
        } else {
            FillRule::NonZero
        };
        Some(Primitive::Path(PaintedPath::in_device_pixels(
            crate::Path::from_curves(curves, fill_rule),
            content_mask,
            color,
        )))
    }

    /// Adds the turned outline of a rounded rectangle, or of the inside of
    /// its border when `border_widths` are given.
    fn rounded_rect(
        &self,
        outline: &mut Outline,
        bounds: Bounds<ScaledPixels>,
        corner_radii: Corners<ScaledPixels>,
        border_widths: Option<Edges<ScaledPixels>>,
    ) {
        let limit = bounds.size.width.0.min(bounds.size.height.0).max(0.) / 2.;
        let radius = |radius: ScaledPixels| radius.0.clamp(0., limit);
        let insets = border_widths
            .unwrap_or_default()
            .map(|width| width.0.max(0.));
        let (left, top) = (bounds.left().0 + insets.left, bounds.top().0 + insets.top);
        let (right, bottom) = (
            bounds.right().0 - insets.right,
            bounds.bottom().0 - insets.bottom,
        );
        if right <= left || bottom <= top {
            return;
        }
        let corner = |radius: f32, horizontal: f32, vertical: f32| {
            ((radius - horizontal).max(0.), (radius - vertical).max(0.))
        };
        let top_left = corner(radius(corner_radii.top_left), insets.left, insets.top);
        let top_right = corner(radius(corner_radii.top_right), insets.right, insets.top);
        let bottom_right = corner(
            radius(corner_radii.bottom_right),
            insets.right,
            insets.bottom,
        );
        let bottom_left = corner(radius(corner_radii.bottom_left), insets.left, insets.bottom);
        let at = |x: f32, y: f32| {
            let moved = self.point(point(ScaledPixels(x), ScaledPixels(y)));
            point(moved.x.0, moved.y.0)
        };
        const ARC: f32 = 0.552_284_8;
        let arc = |outline: &mut Outline, from: [f32; 2], to: [f32; 2], corner: [f32; 2]| {
            if from == corner || to == corner {
                outline.line_to(at(corner[0], corner[1]));
                return;
            }
            let control = |start: [f32; 2]| {
                at(
                    start[0] + (corner[0] - start[0]) * ARC,
                    start[1] + (corner[1] - start[1]) * ARC,
                )
            };
            outline.cubic_to(at(to[0], to[1]), control(from), control(to));
        };
        outline.move_to(at(left + top_left.0, top));
        outline.line_to(at(right - top_right.0, top));
        arc(
            outline,
            [right - top_right.0, top],
            [right, top + top_right.1],
            [right, top],
        );
        outline.line_to(at(right, bottom - bottom_right.1));
        arc(
            outline,
            [right, bottom - bottom_right.1],
            [right - bottom_right.0, bottom],
            [right, bottom],
        );
        outline.line_to(at(left + bottom_left.0, bottom));
        arc(
            outline,
            [left + bottom_left.0, bottom],
            [left, bottom - bottom_left.1],
            [left, bottom],
        );
        outline.line_to(at(left, top + top_left.1));
        arc(
            outline,
            [left, top + top_left.1],
            [left + top_left.0, top],
            [left, top],
        );
        outline.close();
    }
}

fn multiply(linear: [[f32; 2]; 2], point: Point<ScaledPixels>) -> Point<ScaledPixels> {
    Point::new(
        ScaledPixels(linear[0][0] * point.x.0 + linear[0][1] * point.y.0),
        ScaledPixels(linear[1][0] * point.x.0 + linear[1][1] * point.y.0),
    )
}

fn compose(outer: [[f32; 2]; 2], inner: [[f32; 2]; 2]) -> [[f32; 2]; 2] {
    let cell = |row: usize, column: usize| {
        outer[row][0] * inner[0][column] + outer[row][1] * inner[1][column]
    };
    [[cell(0, 0), cell(0, 1)], [cell(1, 0), cell(1, 1)]]
}

fn to_logical(bounds: Bounds<ScaledPixels>, scale_factor: f32) -> Bounds<Pixels> {
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
}

/// The edge of a [`FadeMask`] that content fades out toward.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum FadeEdge {
    /// The left edge.
    Leading,
    /// The right edge.
    #[default]
    Trailing,
    /// The top edge.
    Top,
    /// The bottom edge.
    Bottom,
}

/// Fades what is painted inside [`crate::Window::with_fade_mask`] out toward
/// one edge of `bounds`: content is untouched until `length` before the edge,
/// fades smoothly to transparent at the edge, and is dropped past it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FadeMask {
    /// The bounds whose edge content fades toward. Only their extent along
    /// the faded axis matters.
    pub bounds: Bounds<Pixels>,
    /// The edge content fades toward.
    pub edge: FadeEdge,
    /// How far before the edge the fade begins.
    pub length: Pixels,
}

/// A [`FadeMask`] in device pixels: content is opaque on the side of `start`
/// away from `end`, transparent past `end`, and linearly faded between.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct FadeRamp {
    axis: Axis,
    start: f32,
    end: f32,
    direction: f32,
}

impl FadeRamp {
    pub(crate) fn new(
        mask: FadeMask,
        scale_factor: f32,
        transform: Option<PaintTransform>,
    ) -> Option<Self> {
        let bounds = mask.bounds.scale(scale_factor);
        let bounds = transform.map_or(bounds, |transform| transform.bounds(bounds));
        let (axis, end, direction) = match mask.edge {
            FadeEdge::Leading => (Axis::Horizontal, bounds.left().0, -1.),
            FadeEdge::Trailing => (Axis::Horizontal, bounds.right().0, 1.),
            FadeEdge::Top => (Axis::Vertical, bounds.top().0, -1.),
            FadeEdge::Bottom => (Axis::Vertical, bounds.bottom().0, 1.),
        };
        let scale = transform.map_or(1., |transform| match axis {
            Axis::Horizontal => transform.scale().x,
            Axis::Vertical => transform.scale().y,
        });
        let length = (mask.length.0 * scale_factor).max(0.) * scale;
        let ramp = Self {
            axis,
            start: end - direction * length,
            end,
            direction,
        };
        (ramp.start.is_finite() && ramp.end.is_finite()).then_some(ramp)
    }

    fn alpha(&self, position: f32) -> f32 {
        let remaining = (self.end - position) * self.direction;
        let length = (self.end - self.start) * self.direction;
        if length <= 0. {
            return if remaining > 0. { 1. } else { 0. };
        }
        (remaining / length).clamp(0., 1.)
    }

    fn range(bounds: &Bounds<ScaledPixels>, axis: Axis) -> (f32, f32) {
        match axis {
            Axis::Horizontal => (bounds.left().0, bounds.right().0),
            Axis::Vertical => (bounds.top().0, bounds.bottom().0),
        }
    }

    /// The pieces of `[low, high]` to keep, with their alpha: cut at `cuts`
    /// inside the ramp, the opaque pieces joined and the transparent dropped.
    fn pieces(
        &self,
        cuts: impl Iterator<Item = f32>,
        low: f32,
        high: f32,
    ) -> SmallVec<[(f32, f32, f32); 8]> {
        let mut pieces: SmallVec<[(f32, f32, f32); 8]> = SmallVec::new();
        let mut previous = low;
        for cut in cuts.filter(|cut| *cut > low && *cut < high).chain([high]) {
            if cut <= previous {
                continue;
            }
            let alpha = self.alpha((previous + cut) / 2.);
            match pieces.last_mut() {
                Some(last) if alpha >= 1. && last.2 >= 1. && last.1 == previous => last.1 = cut,
                _ if alpha <= 0. => {}
                _ => pieces.push((previous, cut, alpha)),
            }
            previous = cut;
        }
        pieces
    }

    fn pixel_cuts(&self, step: usize, low: f32, high: f32) -> impl Iterator<Item = f32> {
        let low = self.start.min(self.end).max(low).floor();
        let high = self.start.max(self.end).min(high).ceil();
        let count = (high - low).clamp(0., (1 + MAX_SLICES) as f32 * step as f32) as i32;
        stepped(0, count, step).map(move |index| low + index as f32)
    }

    /// Whether `primitive` crosses the ramp, so that the fade cuts it.
    fn crosses(&self, primitive: &Primitive) -> Option<(f32, f32)> {
        if let Primitive::NativeView(_) = primitive {
            return None;
        }
        let (low, high) = Self::range(&Self::extent(primitive), self.axis);
        let opaque_side = |position: f32| (self.start - position) * self.direction >= 0.;
        let clear_side = |position: f32| (position - self.end) * self.direction >= 0.;
        let untouched = opaque_side(low) && opaque_side(high);
        let dropped = clear_side(low) && clear_side(high);
        (!untouched && !dropped).then_some((low, high))
    }

    fn extent(primitive: &Primitive) -> Bounds<ScaledPixels> {
        match primitive {
            Primitive::MonochromeSprite(sprite) if is_animated(primitive) => sprite.bounds,
            _ => primitive.clipped_bounds(),
        }
    }

    /// How many cuts the fade makes in `primitive` at full resolution: one
    /// per device pixel, or per atlas texel for a sprite.
    fn cut_count(&self, primitive: &Primitive) -> usize {
        let Some((low, high)) = self.crosses(primitive) else {
            return 0;
        };
        let (ramp_low, ramp_high) = (self.start.min(self.end), self.start.max(self.end));
        let (low, high) = (low.max(ramp_low), high.min(ramp_high));
        if high <= low {
            return 1;
        }
        let cut_size =
            TileSlicer::for_primitive(primitive).map_or(1., |sprite| sprite.texel_size(self));
        let count = (high / cut_size).ceil() - (low / cut_size).floor() + 1.;
        count.max(1.) as usize
    }

    /// How coarsely each of `ramps` cuts `primitive`, as a number of device
    /// pixels or atlas texels per piece, so that all of them together cut it
    /// into at most [`MAX_SLICES`] pieces. Ramps that make few cuts keep
    /// them, and the rest share what is left of the budget evenly.
    pub(crate) fn steps(ramps: &[FadeRamp], primitive: &Primitive) -> SmallVec<[usize; 2]> {
        let cuts = ramps
            .iter()
            .map(|ramp| ramp.cut_count(primitive))
            .collect::<SmallVec<[usize; 2]>>();
        let mut steps: SmallVec<[usize; 2]> = smallvec::smallvec![1; ramps.len()];
        let mut order = (0..ramps.len()).collect::<SmallVec<[usize; 2]>>();
        order.sort_by_key(|index| cuts[*index]);
        let mut budget = MAX_SLICES as f32;
        for (position, index) in order.into_iter().enumerate() {
            let cuts = cuts[index];
            if cuts == 0 {
                continue;
            }
            let ramps_left = (ramps.len() - position) as f32;
            let share = budget.powf(1. / ramps_left).floor().max(2.);
            let step = (cuts as f32 / (share - 1.)).ceil().max(1.) as usize;
            steps[index] = step;
            budget = (budget / (cuts.div_ceil(step) + 1) as f32).max(1.);
        }
        steps
    }

    /// Calls `insert` with what is left of `primitive` under the fade, cut
    /// every `step` device pixels or atlas texels.
    pub(crate) fn apply(
        &self,
        primitive: Primitive,
        step: usize,
        insert: &mut impl FnMut(Primitive),
    ) {
        #[cfg(test)]
        let insert = &mut |piece: Primitive| {
            tests::FADED_PIECES.with(|count| count.set(count.get() + 1));
            insert(piece)
        };
        if let Primitive::NativeView(_) = primitive {
            insert(primitive);
            return;
        }
        let Some((low, high)) = self.crosses(&primitive) else {
            let (low, _) = Self::range(&Self::extent(&primitive), self.axis);
            if (self.start - low) * self.direction >= 0. {
                insert(primitive);
            }
            return;
        };
        if let Some(sprite) = TileSlicer::for_primitive(&primitive) {
            let sprite = if is_animated(&primitive) {
                Some(sprite)
            } else {
                sprite.cropped_to(primitive.content_mask().bounds)
            };
            if let Some(sprite) = sprite {
                sprite.slice(self, step, primitive, insert);
            }
            return;
        }
        for (piece_low, piece_high, alpha) in
            self.pieces(self.pixel_cuts(step, low, high), low, high)
        {
            let mut piece = primitive.clone();
            let mask = piece.content_mask_mut();
            mask.bounds =
                mask.bounds
                    .intersect(&with_range(mask.bounds, self.axis, piece_low, piece_high));
            if mask.bounds.is_empty() {
                continue;
            }
            if let Some(piece) = piece.with_alpha(alpha) {
                insert(piece);
            }
        }
    }
}

fn is_animated(primitive: &Primitive) -> bool {
    matches!(primitive, Primitive::MonochromeSprite(sprite) if sprite.animation != SpriteAnimationId::NONE)
}

/// The most pieces one primitive is cut into by every fade it is under.
const MAX_SLICES: usize = 4096;

/// `first`, every `step` after it before `last`, and `last`.
fn stepped(first: i32, last: i32, step: usize) -> impl Iterator<Item = i32> {
    (first..last)
        .step_by(step.max(1))
        .chain((last >= first).then_some(last))
}

fn with_range(
    bounds: Bounds<ScaledPixels>,
    axis: Axis,
    low: f32,
    high: f32,
) -> Bounds<ScaledPixels> {
    let (left, right, top, bottom) = match axis {
        Axis::Horizontal => (low, high, bounds.top().0, bounds.bottom().0),
        Axis::Vertical => (bounds.left().0, bounds.right().0, low, high),
    };
    Bounds::from_corners(
        point(ScaledPixels(left), ScaledPixels(top)),
        point(ScaledPixels(right), ScaledPixels(bottom)),
    )
}

/// Slices a sprite into strips of whole atlas texels, so each strip samples
/// exactly the part of the tile it covers and can take its own alpha.
struct TileSlicer {
    bounds: Bounds<ScaledPixels>,
    tile: AtlasTile,
}

impl TileSlicer {
    fn for_primitive(primitive: &Primitive) -> Option<Self> {
        let (bounds, tile) = match primitive {
            Primitive::MonochromeSprite(sprite)
                if sprite.transformation == TransformationMatrix::unit() =>
            {
                (sprite.bounds, sprite.tile)
            }
            Primitive::SubpixelSprite(sprite)
                if sprite.transformation == TransformationMatrix::unit() =>
            {
                (sprite.bounds, sprite.tile)
            }
            Primitive::PolychromeSprite(sprite) if sprite.corner_radii == Corners::default() => {
                (sprite.bounds, sprite.tile)
            }
            _ => return None,
        };
        (tile.bounds.size.width.0 > 0
            && tile.bounds.size.height.0 > 0
            && !bounds.size.width.0.is_nan()
            && !bounds.size.height.0.is_nan())
        .then_some(Self { bounds, tile })
    }

    fn texels(&self, axis: Axis) -> i32 {
        match axis {
            Axis::Horizontal => self.tile.bounds.size.width.0,
            Axis::Vertical => self.tile.bounds.size.height.0,
        }
    }

    fn texel_size(&self, ramp: &FadeRamp) -> f32 {
        self.texel_size_along(ramp.axis)
    }

    fn texel_size_along(&self, axis: Axis) -> f32 {
        let (low, high) = FadeRamp::range(&self.bounds, axis);
        (high - low) / self.texels(axis) as f32
    }

    /// The whole texels of the sprite that show inside `visible`, so that
    /// slicing walks only what can be seen.
    fn cropped_to(self, visible: Bounds<ScaledPixels>) -> Option<Self> {
        self.cropped_along(Axis::Horizontal, visible)?
            .cropped_along(Axis::Vertical, visible)
    }

    fn cropped_along(mut self, axis: Axis, visible: Bounds<ScaledPixels>) -> Option<Self> {
        let (low, high) = FadeRamp::range(&self.bounds, axis);
        let (visible_low, visible_high) = FadeRamp::range(&visible, axis);
        let texels = self.texels(axis);
        let texel_size = self.texel_size_along(axis);
        let texel_at = |position: f32| ((position - low) / texel_size).clamp(0., texels as f32);
        let start = texel_at(visible_low).floor() as i32;
        let end = texel_at(visible_high).ceil() as i32;
        if end <= start {
            return None;
        }
        let boundary = |texel: i32| match texel {
            0 => low,
            texel if texel == texels => high,
            texel => low + texel as f32 * texel_size,
        };
        self.bounds = with_range(self.bounds, axis, boundary(start), boundary(end));
        match axis {
            Axis::Horizontal => {
                self.tile.bounds.origin.x += DevicePixels(start);
                self.tile.bounds.size.width = DevicePixels(end - start);
            }
            Axis::Vertical => {
                self.tile.bounds.origin.y += DevicePixels(start);
                self.tile.bounds.size.height = DevicePixels(end - start);
            }
        }
        Some(self)
    }

    fn slice(
        &self,
        ramp: &FadeRamp,
        step: usize,
        primitive: Primitive,
        insert: &mut impl FnMut(Primitive),
    ) {
        let (low, high) = FadeRamp::range(&self.bounds, ramp.axis);
        let texels = self.texels(ramp.axis);
        let texel_size = self.texel_size(ramp);
        let boundary = |texel: i32| low + texel as f32 * texel_size;
        let texel_at = |position: f32| ((position - low) / texel_size).clamp(0., texels as f32);
        let (ramp_low, ramp_high) = (ramp.start.min(ramp.end), ramp.start.max(ramp.end));
        let first = texel_at(ramp_low).floor() as i32;
        let last = texel_at(ramp_high).ceil() as i32;
        let span = i32::try_from(MAX_SLICES.saturating_mul(step)).unwrap_or(i32::MAX);
        let last = last.min(first.saturating_add(span));
        let cuts = stepped(first, last, step).map(boundary);
        for (piece_low, piece_high, alpha) in ramp.pieces(cuts, low, high) {
            let start = ((piece_low - low) / texel_size).round() as i32;
            let end = ((piece_high - low) / texel_size).round() as i32;
            if end <= start {
                continue;
            }
            let mut tile = self.tile;
            let bounds = with_range(self.bounds, ramp.axis, boundary(start), boundary(end));
            match ramp.axis {
                Axis::Horizontal => {
                    tile.bounds.origin.x += DevicePixels(start);
                    tile.bounds.size.width = DevicePixels(end - start);
                }
                Axis::Vertical => {
                    tile.bounds.origin.y += DevicePixels(start);
                    tile.bounds.size.height = DevicePixels(end - start);
                }
            }
            let mut piece = primitive.clone();
            match &mut piece {
                Primitive::MonochromeSprite(sprite) => {
                    sprite.bounds = bounds;
                    sprite.tile = tile;
                }
                Primitive::SubpixelSprite(sprite) => {
                    sprite.bounds = bounds;
                    sprite.tile = tile;
                }
                Primitive::PolychromeSprite(sprite) => {
                    sprite.bounds = bounds;
                    sprite.tile = tile;
                }
                _ => {}
            }
            if let Some(piece) = piece.with_alpha(alpha) {
                insert(piece);
            }
        }
    }
}

impl Primitive {
    fn content_mask_mut(&mut self) -> &mut ContentMask<ScaledPixels> {
        match self {
            Primitive::Shadow(shadow) => &mut shadow.content_mask,
            Primitive::Quad(quad) => &mut quad.content_mask,
            Primitive::Path(path) => &mut path.paint.content_mask,
            Primitive::Underline(underline) => &mut underline.content_mask,
            Primitive::MonochromeSprite(sprite) => &mut sprite.content_mask,
            Primitive::SubpixelSprite(sprite) => &mut sprite.content_mask,
            Primitive::PolychromeSprite(sprite) => &mut sprite.content_mask,
            Primitive::Surface(surface) => &mut surface.content_mask,
            Primitive::NativeView(native_view) => &mut native_view.content_mask,
        }
    }

    /// The primitive with its alpha multiplied by `alpha`. Surfaces can't
    /// fade, so they are kept whole wherever any of them shows.
    fn with_alpha(mut self, alpha: f32) -> Option<Self> {
        if alpha >= 1. {
            return Some(self);
        }
        match &mut self {
            Primitive::Shadow(shadow) => shadow.color = shadow.color.opacity(alpha),
            Primitive::Quad(quad) => {
                quad.background = quad.background.opacity(alpha);
                quad.border_color = quad.border_color.opacity(alpha);
            }
            Primitive::Path(path) => path.paint.color = path.paint.color.opacity(alpha),
            Primitive::Underline(underline) => underline.color = underline.color.opacity(alpha),
            Primitive::MonochromeSprite(sprite) => sprite.color = sprite.color.opacity(alpha),
            Primitive::SubpixelSprite(sprite) => sprite.color = sprite.color.opacity(alpha),
            Primitive::PolychromeSprite(sprite) => sprite.opacity *= alpha,
            Primitive::Surface(_) | Primitive::NativeView(_) => {}
        }
        Some(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AtlasTextureId, AtlasTextureKind, Background, Hsla, MonochromeSprite, PolychromeSprite,
        SpriteAnimationId, TileId, Underline, bounds, hsla,
    };

    fn scaled(x: f32, y: f32, width: f32, height: f32) -> Bounds<ScaledPixels> {
        bounds(
            point(ScaledPixels(x), ScaledPixels(y)),
            size(ScaledPixels(width), ScaledPixels(height)),
        )
    }

    fn everywhere() -> ContentMask<ScaledPixels> {
        ContentMask {
            bounds: scaled(-1000., -1000., 4000., 4000.),
        }
    }

    fn tile(x: i32, width: i32) -> AtlasTile {
        AtlasTile {
            texture_id: AtlasTextureId {
                index: 0,
                kind: AtlasTextureKind::Monochrome,
            },
            tile_id: TileId(1),
            padding: 0,
            bounds: Bounds {
                origin: point(DevicePixels(x), DevicePixels(3)),
                size: size(DevicePixels(width), DevicePixels(16)),
            },
        }
    }

    fn glyph(x: f32, width: i32) -> MonochromeSprite {
        MonochromeSprite {
            order: 0,
            animation: SpriteAnimationId::NONE,
            tile: tile(100, width),
            bounds: scaled(x, 0., width as f32, 16.),
            content_mask: everywhere(),
            color: hsla(0., 0., 0., 1.),
            transformation: TransformationMatrix::unit(),
        }
    }

    fn trailing(right: f32, length: f32) -> FadeRamp {
        FadeRamp::new(
            FadeMask {
                bounds: Bounds {
                    origin: point(px(0.), px(0.)),
                    size: size(px(right), px(20.)),
                },
                edge: FadeEdge::Trailing,
                length: px(length),
            },
            1.,
            None,
        )
        .unwrap()
    }

    fn faded(ramp: &FadeRamp, primitive: impl Into<Primitive>) -> Vec<Primitive> {
        let mut pieces = Vec::new();
        ramp.apply(primitive.into(), 1, &mut |piece| pieces.push(piece));
        pieces
    }

    #[test]
    fn a_sprite_straddling_the_ramp_is_sliced_into_texel_strips_that_fade_out() {
        let ramp = trailing(100., 20.);
        let sprite = glyph(70., 20);
        let pieces = faded(&ramp, sprite);
        let slices = pieces
            .iter()
            .map(|piece| match piece {
                Primitive::MonochromeSprite(sprite) => *sprite,
                _ => panic!("expected a sprite"),
            })
            .collect::<Vec<_>>();

        assert_eq!(slices.len(), 11);
        assert_eq!(slices[0].bounds, scaled(70., 0., 10., 16.));
        assert_eq!(slices[0].tile.bounds.origin.x, DevicePixels(100));
        assert_eq!(slices[0].tile.bounds.size.width, DevicePixels(10));
        assert_eq!(slices[0].color.a, 1.);
        for pair in slices.windows(2) {
            assert_eq!(pair[0].bounds.right(), pair[1].bounds.left());
            assert_eq!(
                pair[0].tile.bounds.origin.x + pair[0].tile.bounds.size.width,
                pair[1].tile.bounds.origin.x
            );
            assert!(pair[1].color.a < pair[0].color.a);
        }
        for slice in &slices {
            assert_eq!(slice.bounds.size.height, sprite.bounds.size.height);
            assert_eq!(slice.tile.bounds.origin.y, sprite.tile.bounds.origin.y);
            assert_eq!(
                slice.bounds.size.width.0,
                slice.tile.bounds.size.width.0 as f32
            );
        }
        let last = slices.last().unwrap();
        assert_eq!(slices[0].bounds.left(), sprite.bounds.left());
        assert_eq!(last.bounds.right(), sprite.bounds.right());
        assert_eq!(
            last.tile.bounds.origin.x + last.tile.bounds.size.width,
            sprite.tile.bounds.origin.x + sprite.tile.bounds.size.width
        );
        assert_eq!(slices[1].color.a, 0.975);
        assert_eq!(last.color.a, 0.525);
    }

    #[test]
    fn a_sprite_crossing_the_edge_loses_what_is_past_it() {
        let ramp = trailing(100., 20.);
        let slices = faded(&ramp, glyph(90., 20))
            .into_iter()
            .map(|piece| match piece {
                Primitive::MonochromeSprite(sprite) => sprite,
                _ => panic!("expected a sprite"),
            })
            .collect::<Vec<_>>();
        assert_eq!(slices.len(), 10);
        assert_eq!(slices.last().unwrap().bounds.right().0, 100.);
        assert_eq!(slices.last().unwrap().color.a, 0.025);
    }

    #[test]
    fn content_past_the_edge_is_dropped_and_content_before_the_ramp_is_untouched() {
        let ramp = trailing(100., 20.);
        assert!(faded(&ramp, glyph(100., 20)).is_empty());
        let before = faded(&ramp, glyph(60., 20));
        assert_eq!(before.len(), 1);
        let Primitive::MonochromeSprite(sprite) = before[0] else {
            panic!("expected a sprite");
        };
        assert_eq!(sprite.bounds, glyph(60., 20).bounds);
        assert_eq!(sprite.tile, glyph(60., 20).tile);
        assert_eq!(sprite.color, glyph(60., 20).color);
    }

    #[test]
    fn a_leading_fade_ramps_up_from_the_left_edge() {
        let ramp = FadeRamp::new(
            FadeMask {
                bounds: Bounds {
                    origin: point(px(10.), px(0.)),
                    size: size(px(100.), px(20.)),
                },
                edge: FadeEdge::Leading,
                length: px(10.),
            },
            1.,
            None,
        )
        .unwrap();
        let slices = faded(&ramp, glyph(0., 30))
            .into_iter()
            .map(|piece| match piece {
                Primitive::MonochromeSprite(sprite) => sprite,
                _ => panic!("expected a sprite"),
            })
            .collect::<Vec<_>>();
        assert_eq!(slices.first().unwrap().bounds.left().0, 10.);
        assert_eq!(slices.last().unwrap().bounds, scaled(20., 0., 10., 16.));
        assert_eq!(slices.last().unwrap().color.a, 1.);
        for pair in slices.windows(2) {
            assert!(pair[1].color.a > pair[0].color.a);
        }
    }

    #[test]
    fn a_quad_straddling_the_ramp_is_cut_by_its_content_mask() {
        let ramp = trailing(100., 4.);
        let quad = Quad {
            bounds: scaled(50., 0., 60., 10.),
            content_mask: everywhere(),
            background: Background::from(hsla(0., 0., 0., 1.)),
            border_color: Hsla::default(),
            corner_radii: Corners::all(ScaledPixels(4.)),
            ..Default::default()
        };
        let pieces = faded(&ramp, quad)
            .into_iter()
            .map(|piece| match piece {
                Primitive::Quad(quad) => quad,
                _ => panic!("expected a quad"),
            })
            .collect::<Vec<_>>();
        assert_eq!(pieces.len(), 5);
        assert!(pieces.iter().all(|piece| piece.bounds == quad.bounds));
        assert_eq!(pieces[0].content_mask.bounds.left().0, 50.);
        assert_eq!(pieces[0].content_mask.bounds.right().0, 96.);
        assert_eq!(pieces[4].content_mask.bounds.right().0, 100.);
        let alphas = pieces
            .iter()
            .map(|piece| piece.background.as_solid().unwrap().a)
            .collect::<Vec<_>>();
        assert_eq!(alphas, [1., 0.875, 0.625, 0.375, 0.125]);
    }

    #[test]
    fn a_polychrome_sprite_fades_through_its_opacity() {
        let ramp = trailing(100., 10.);
        let sprite = PolychromeSprite {
            order: 0,
            pad: 0,
            tile: tile(0, 20),
            grayscale: false.into(),
            opacity: 0.5,
            bounds: scaled(90., 0., 20., 16.),
            content_mask: everywhere(),
            corner_radii: Corners::default(),
        };
        let opacities = faded(&ramp, sprite)
            .into_iter()
            .map(|piece| match piece {
                Primitive::PolychromeSprite(sprite) => sprite.opacity,
                _ => panic!("expected a sprite"),
            })
            .collect::<Vec<_>>();
        assert_eq!(opacities.len(), 10);
        assert_eq!(opacities[0], 0.475);
    }

    fn quad(bounds: Bounds<ScaledPixels>) -> Quad {
        Quad {
            bounds,
            content_mask: everywhere(),
            background: Background::from(hsla(0., 0., 0., 1.)),
            ..Default::default()
        }
    }

    fn square_fade(edge: FadeEdge, side: f32, scale_factor: f32) -> FadeRamp {
        FadeRamp::new(
            FadeMask {
                bounds: Bounds {
                    origin: point(px(0.), px(0.)),
                    size: size(px(side), px(side)),
                },
                edge,
                length: px(side),
            },
            scale_factor,
            None,
        )
        .unwrap()
    }

    #[test]
    fn nested_fades_expand_a_primitive_into_a_bounded_number_of_pieces() {
        let mut scene = crate::Scene::default();
        scene.push_fade_ramp(square_fade(FadeEdge::Trailing, 768., 2.));
        scene.push_fade_ramp(square_fade(FadeEdge::Bottom, 768., 2.));
        scene.insert_primitive(quad(scaled(0., 0., 1536., 1536.)));
        let count = scene.quads.len();
        assert!(count <= MAX_SLICES, "{count} pieces");
        assert!(count >= MAX_SLICES / 2, "{count} pieces");
        let columns = scene
            .quads
            .iter()
            .map(|quad| quad.content_mask.bounds.left().0.to_bits())
            .collect::<std::collections::HashSet<_>>();
        let rows = scene
            .quads
            .iter()
            .map(|quad| quad.content_mask.bounds.top().0.to_bits())
            .collect::<std::collections::HashSet<_>>();
        assert!(columns.len() > 32 && rows.len() > 32);
        let covered = scene
            .quads
            .iter()
            .map(|quad| {
                let bounds = quad.content_mask.bounds;
                bounds.size.width.0 * bounds.size.height.0
            })
            .sum::<f32>();
        assert_eq!(covered, 1536. * 1536.);
    }

    thread_local! {
        pub(super) static FADED_PIECES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    #[test]
    fn nested_fades_slice_only_the_visible_part_of_a_clipped_sprite() {
        for side in [1024, 4096] {
            let mut scene = crate::Scene::default();
            let horizontal = square_fade(FadeEdge::Trailing, side as f32, 1.);
            let vertical = square_fade(FadeEdge::Bottom, side as f32, 1.);
            scene.push_fade_ramp(horizontal);
            scene.push_fade_ramp(vertical);
            let visible = scaled(side as f32 / 2. + 0.5, side as f32 / 3., 32., 32.);
            let mut sprite_tile = tile(5, side);
            sprite_tile.bounds.origin.y = DevicePixels(7);
            sprite_tile.bounds.size.height = DevicePixels(side);
            FADED_PIECES.with(|count| count.set(0));
            scene.insert_primitive(MonochromeSprite {
                order: 0,
                animation: SpriteAnimationId::NONE,
                tile: sprite_tile,
                bounds: scaled(0., 0., side as f32, side as f32),
                content_mask: ContentMask { bounds: visible },
                color: hsla(0., 0., 0., 1.),
                transformation: TransformationMatrix::unit(),
            });
            let generated = FADED_PIECES.with(|count| count.get());
            assert!(generated <= 33 * 34, "{side}: {generated} pieces generated");

            for row in 0..32 {
                for column in 0..32 {
                    let x = visible.left().0 + column as f32 + 0.5;
                    let y = visible.top().0 + row as f32 + 0.5;
                    let covering = scene
                        .monochrome_sprites
                        .iter()
                        .filter(|sprite| {
                            let shown = sprite.bounds.intersect(&sprite.content_mask.bounds);
                            shown.left().0 <= x
                                && x < shown.right().0
                                && shown.top().0 <= y
                                && y < shown.bottom().0
                        })
                        .collect::<Vec<_>>();
                    assert_eq!(covering.len(), 1, "{side}: ({x}, {y})");
                    let piece = covering[0];
                    let texel_x = piece.tile.bounds.origin.x.0 as f32
                        + (x - piece.bounds.left().0) * piece.tile.bounds.size.width.0 as f32
                            / piece.bounds.size.width.0;
                    let texel_y = piece.tile.bounds.origin.y.0 as f32
                        + (y - piece.bounds.top().0) * piece.tile.bounds.size.height.0 as f32
                            / piece.bounds.size.height.0;
                    assert_eq!(texel_x.floor(), 5. + x.floor(), "{side}: ({x}, {y})");
                    assert_eq!(texel_y.floor(), 7. + y.floor(), "{side}: ({x}, {y})");
                    let alpha = horizontal.alpha(x.floor() + 0.5) * vertical.alpha(y.floor() + 0.5);
                    assert!(
                        (piece.color.a - alpha).abs() < 1e-5,
                        "{side}: ({x}, {y}) {} != {alpha}",
                        piece.color.a
                    );
                }
            }
        }
    }

    fn animated_sprite(
        width: i32,
        height: i32,
        visible: Bounds<ScaledPixels>,
    ) -> (MonochromeSprite, crate::SpriteAnimation) {
        let mut sprite_tile = tile(5, width);
        sprite_tile.bounds.size.height = DevicePixels(height);
        let sprite = MonochromeSprite {
            order: 0,
            animation: SpriteAnimationId::NONE,
            tile: sprite_tile,
            bounds: scaled(0., 0., width as f32, height as f32),
            content_mask: ContentMask { bounds: visible },
            color: hsla(0., 0., 0., 1.),
            transformation: TransformationMatrix::unit(),
        };
        let moved_up = crate::TimedTransformation::new(std::time::Duration::from_secs(1)).to(
            crate::Transformation::translate(point(px(0.), px(-(height as f32) / 2.))),
        );
        let center = point(px(width as f32 / 2.), px(height as f32 / 2.));
        (sprite, crate::SpriteAnimation::new(moved_up, center, 1.))
    }

    #[test]
    fn a_fade_keeps_every_row_of_an_animated_sprite_that_moves_into_view() {
        let mut scene = crate::Scene::default();
        scene.push_fade_ramp(trailing(16., 8.));
        let (sprite, animation) = animated_sprite(16, 32, scaled(0., 0., 16., 16.));
        scene.insert_animated_sprite(sprite, animation);
        assert!(scene.monochrome_sprites.len() > 1);
        for piece in &scene.monochrome_sprites {
            assert_eq!(piece.bounds.top().0, 0.);
            assert_eq!(piece.bounds.bottom().0, 32.);
            assert_eq!(piece.tile.bounds.origin.y, DevicePixels(3));
            assert_eq!(piece.tile.bounds.size.height, DevicePixels(32));
        }
    }

    fn assert_within(piece: &Primitive, clip: Bounds<ScaledPixels>) {
        let mask = piece.content_mask().bounds;
        assert!(
            mask.left() >= clip.left()
                && mask.right() <= clip.right()
                && mask.top() >= clip.top()
                && mask.bottom() <= clip.bottom(),
            "{mask:?} reaches outside {clip:?}"
        );
    }

    #[test]
    fn a_fade_keeps_a_moving_animated_sprite_within_its_clip() {
        let clip = scaled(20., 0., 20., 16.);
        let (mut sprite, animation) = animated_sprite(100, 16, clip);
        sprite.transformation =
            TransformationMatrix::unit().translate(point(ScaledPixels(1.), ScaledPixels(0.)));
        let mut scene = crate::Scene::default();
        scene.push_fade_ramp(trailing(100., 50.));
        scene.insert_animated_sprite(sprite, animation);
        assert!(!scene.monochrome_sprites.is_empty());
        for piece in &scene.monochrome_sprites {
            assert_within(&Primitive::MonochromeSprite(piece.clone()), clip);
        }
    }

    #[test]
    fn a_fade_keeps_every_piece_of_a_quad_within_its_clip() {
        let clip = scaled(40., 2., 20., 6.);
        let mut clipped = quad(scaled(0., 0., 100., 10.));
        clipped.content_mask = ContentMask { bounds: clip };
        let pieces = faded(&trailing(100., 50.), clipped);
        assert!(!pieces.is_empty());
        for piece in &pieces {
            assert_within(piece, clip);
        }
    }

    #[test]
    fn nested_fades_cut_a_huge_animated_sprite_into_a_bounded_number_of_pieces() {
        let side = 8192;
        let mut scene = crate::Scene::default();
        scene.push_fade_ramp(square_fade(FadeEdge::Trailing, side as f32, 1.));
        scene.push_fade_ramp(square_fade(FadeEdge::Bottom, side as f32, 1.));
        let (sprite, animation) = animated_sprite(side, side, scaled(4000.5, 3000., 32., 32.));
        FADED_PIECES.with(|count| count.set(0));
        scene.insert_animated_sprite(sprite, animation);
        let generated = FADED_PIECES.with(|count| count.get());
        let kept = scene.monochrome_sprites.len();
        assert!(kept <= MAX_SLICES, "{kept} pieces kept");
        assert!(generated <= 2 * MAX_SLICES, "{generated} pieces generated");
        let bottom = scene
            .monochrome_sprites
            .iter()
            .map(|piece| piece.tile.bounds.bottom().0)
            .max();
        assert!(bottom >= Some(3 + 3032 + 64), "{bottom:?}");
    }

    #[test]
    fn a_single_fade_keeps_a_piece_per_device_pixel() {
        let mut scene = crate::Scene::default();
        scene.push_fade_ramp(square_fade(FadeEdge::Trailing, 768., 2.));
        scene.insert_primitive(quad(scaled(0., 0., 1536., 1536.)));
        assert_eq!(scene.quads.len(), 1536);
        assert!(
            scene
                .quads
                .iter()
                .all(|quad| quad.content_mask.bounds.size.width.0 == 1.)
        );
    }

    #[test]
    fn nested_scales_compose() {
        let clip = scaled(0., 0., 1000., 1000.);
        let outer = PaintTransform::about(
            point(ScaledPixels(100.), ScaledPixels(100.)),
            point(0.5, 0.5),
            Radians(0.),
            clip,
            None,
        );
        let inner = PaintTransform::about(
            point(ScaledPixels(200.), ScaledPixels(200.)),
            point(0.5, 0.5),
            Radians(0.),
            clip,
            Some(outer),
        );
        let bounds = scaled(200., 200., 40., 40.);
        assert_eq!(
            inner.bounds(bounds),
            outer.bounds(scaled(200., 200., 20., 20.))
        );
        assert_eq!(inner.bounds(bounds), scaled(150., 150., 10., 10.));
    }

    #[test]
    fn a_rotated_sprite_keeps_its_rotation_about_its_scaled_center() {
        let transform = PaintTransform::about(
            point(ScaledPixels(0.), ScaledPixels(0.)),
            point(0.5, 0.5),
            Radians(0.),
            scaled(0., 0., 1000., 1000.),
            None,
        );
        let center = point(ScaledPixels(20.), ScaledPixels(20.));
        let rotation = TransformationMatrix::unit()
            .translate(center)
            .rotate(crate::radians(1.))
            .translate(point(ScaledPixels(-20.), ScaledPixels(-20.)));
        let corner = point(px(30.), px(10.));
        let expected = rotation.apply(corner);
        let moved = transform.matrix(rotation).apply(point(px(15.), px(5.)));
        assert!((moved.x.0 - expected.x.0 * 0.5).abs() < 1e-4);
        assert!((moved.y.0 - expected.y.0 * 0.5).abs() < 1e-4);
    }

    fn turn(
        center: f32,
        scale: f32,
        degrees: f32,
        parent: Option<PaintTransform>,
    ) -> PaintTransform {
        PaintTransform::about(
            point(ScaledPixels(center), ScaledPixels(center)),
            point(scale, scale),
            Radians(degrees.to_radians()),
            scaled(-1000., -1000., 4000., 4000.),
            parent,
        )
    }

    fn assert_near(actual: Point<ScaledPixels>, expected: (f32, f32)) {
        assert!(
            (actual.x.0 - expected.0).abs() < 1e-3 && (actual.y.0 - expected.1).abs() < 1e-3,
            "{actual:?} is not {expected:?}"
        );
    }

    fn transformed(transform: &PaintTransform, primitive: impl Into<Primitive>) -> Vec<Primitive> {
        let mut pieces = Vec::new();
        transform.apply(primitive.into(), &mut |piece| pieces.push(piece));
        pieces
    }

    /// The winding number of `outline`'s lines about `position`.
    fn winding(outline: &[crate::PathCurve], position: (f32, f32)) -> i32 {
        outline
            .iter()
            .filter(|curve| curve.p0.y <= position.1 && position.1 < curve.p1.y)
            .filter(|curve| {
                let t = (position.1 - curve.p0.y) / (curve.p1.y - curve.p0.y);
                curve.p0.x + (curve.p1.x - curve.p0.x) * t < position.0
            })
            .map(|curve| if curve.sign < 0. { -1 } else { 1 })
            .sum()
    }

    #[test]
    fn a_turned_quad_fills_its_turned_rectangle() {
        let transform = turn(200., 1., 30., None);
        let rectangle = scaled(150., 170., 100., 60.);
        let pieces = transformed(&transform, quad(rectangle));
        assert_eq!(pieces.len(), 1);
        let Primitive::Path(path) = &pieces[0] else {
            panic!("expected a path");
        };
        let corners = [
            rectangle.origin,
            rectangle.top_right(),
            rectangle.bottom_left(),
            rectangle.bottom_right(),
        ]
        .map(|corner| transform.point(corner));
        let low = corners
            .iter()
            .fold(corners[0], |low, corner| low.min(corner));
        let high = corners
            .iter()
            .fold(corners[0], |high, corner| high.max(corner));
        assert_near(path.paint.bounds.origin, (low.x.0, low.y.0));
        assert_near(path.paint.bounds.bottom_right(), (high.x.0, high.y.0));
        assert_eq!(path.paint.color, quad(rectangle).background);

        let mut outline = Outline::default();
        transform.rounded_rect(&mut outline, rectangle, Corners::default(), None);
        let outline = outline.into_curves().unwrap();
        let (sin, cos) = 30f32.to_radians().sin_cos();
        for x in (100..300).step_by(3) {
            for y in (100..300).step_by(3) {
                let (x, y) = (x as f32 + 0.5, y as f32 + 0.5);
                let (dx, dy) = (x - 200., y - 200.);
                let local = (cos * dx + sin * dy, -sin * dx + cos * dy);
                let distance = (local.0.abs() - 50.).max(local.1.abs() - 30.);
                if distance.abs() < 0.5 {
                    continue;
                }
                assert_eq!(winding(&outline, (x, y)) != 0, distance < 0., "{x}, {y}");
            }
        }
    }

    #[test]
    fn a_turned_bordered_quad_fills_its_background_and_border_ring() {
        let transform = turn(200., 1., 45., None);
        let pieces = transformed(
            &transform,
            Quad {
                border_color: hsla(0.5, 1., 0.5, 1.),
                border_widths: Edges::all(ScaledPixels(4.)),
                corner_radii: Corners::all(ScaledPixels(10.)),
                ..quad(scaled(150., 150., 100., 100.))
            },
        );
        let colors = pieces
            .iter()
            .map(|piece| match piece {
                Primitive::Path(path) => (path.paint.color, path.paint.even_odd.as_bool()),
                _ => panic!("expected a path"),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            colors,
            [
                (Background::from(hsla(0., 0., 0., 1.)), false),
                (Background::from(hsla(0.5, 1., 0.5, 1.)), true),
            ]
        );
        let half = 50. * std::f32::consts::SQRT_2;
        for piece in &pieces {
            let Primitive::Path(path) = piece else {
                unreachable!()
            };
            let bounds = path.paint.bounds;
            assert!(bounds.left().0 > 200. - half && bounds.right().0 < 200. + half);
            assert!(bounds.size.width.0 > 120.);
        }
    }

    #[test]
    fn a_turned_sprite_turns_through_its_matrix_about_the_center() {
        let transform = turn(200., 0.5, 90., None);
        let sprite = glyph(190., 20);
        let pieces = transformed(&transform, sprite);
        let Primitive::MonochromeSprite(turned) = pieces[0] else {
            panic!("expected a sprite");
        };
        assert_eq!(turned.bounds, sprite.bounds);
        assert_eq!(turned.tile, sprite.tile);
        let corner = turned.transformation.apply(point(px(190.), px(0.)));
        assert_near(
            point(ScaledPixels(corner.x.0), ScaledPixels(corner.y.0)),
            (300., 195.),
        );
        let center = turned.transformation.apply(point(px(200.), px(200.)));
        assert_near(
            point(ScaledPixels(center.x.0), ScaledPixels(center.y.0)),
            (200., 200.),
        );
    }

    #[test]
    fn turns_compose_with_scales_and_with_each_other() {
        let scaled_turn = turn(200., 0.5, 90., None);
        assert_near(
            scaled_turn.point(point(ScaledPixels(300.), ScaledPixels(200.))),
            (200., 250.),
        );
        assert_eq!(scaled_turn.scale(), point(0.5, 0.5));

        let outer = turn(200., 1., 30., None);
        let inner = turn(200., 1., 60., Some(outer));
        let quarter = turn(200., 1., 90., None);
        let probe = point(ScaledPixels(260.), ScaledPixels(170.));
        let expected = quarter.point(probe);
        assert_near(inner.point(probe), (expected.x.0, expected.y.0));

        let elsewhere = turn(100., 2., 45., Some(outer));
        let expected = outer.point(turn(100., 2., 45., None).point(probe));
        assert_near(elsewhere.point(probe), (expected.x.0, expected.y.0));
        assert_eq!(elsewhere.scale(), point(2., 2.));
    }

    #[test]
    fn a_turned_transform_hits_and_clips_within_the_bounds_of_turned_rectangles() {
        let transform = turn(200., 1., 45., None);
        let half = 50. * std::f32::consts::SQRT_2;
        let bounds = transform.bounds(scaled(150., 150., 100., 100.));
        assert_near(bounds.origin, (200. - half, 200. - half));
        assert_near(bounds.bottom_right(), (200. + half, 200. + half));
        let window = Bounds {
            origin: point(px(200. - half), px(200. - half)),
            size: size(px(2. * half), px(2. * half)),
        };
        let local = transform.inverse_logical_bounds(window, 1.);
        assert!(local.left().0 < 150. && local.right().0 > 250.);
    }

    fn stretch(
        origin: (f32, f32),
        scale: (f32, f32),
        degrees: f32,
        parent: Option<PaintTransform>,
    ) -> PaintTransform {
        PaintTransform::about(
            point(ScaledPixels(origin.0), ScaledPixels(origin.1)),
            point(scale.0, scale.1),
            Radians(degrees.to_radians()),
            scaled(-1000., -1000., 4000., 4000.),
            parent,
        )
    }

    #[test]
    fn an_unevenly_scaled_square_quad_stretches_its_bounds_and_borders_per_axis() {
        let transform = stretch((100., 100.), (2., 0.5), 0., None);
        let pieces = transformed(
            &transform,
            Quad {
                border_color: hsla(0.5, 1., 0.5, 1.),
                border_widths: Edges {
                    top: ScaledPixels(4.),
                    right: ScaledPixels(3.),
                    bottom: ScaledPixels(2.),
                    left: ScaledPixels(1.),
                },
                ..quad(scaled(50., 80., 40., 20.))
            },
        );
        let [Primitive::Quad(quad)] = pieces.as_slice() else {
            panic!("expected one quad");
        };
        assert_eq!(quad.bounds, scaled(0., 90., 80., 10.));
        assert_eq!(
            quad.border_widths,
            Edges {
                top: ScaledPixels(2.),
                right: ScaledPixels(6.),
                bottom: ScaledPixels(1.),
                left: ScaledPixels(2.),
            }
        );
        assert_eq!(quad.corner_radii, Corners::default());
        assert_eq!(
            quad.content_mask.bounds,
            scaled(-1000., -450., 4000., 2000.)
        );
    }

    #[test]
    fn an_unevenly_scaled_rounded_quad_fills_its_elliptical_corners_as_paths() {
        let transform = stretch((0., 0.), (2., 1.), 0., None);
        let rounded = Quad {
            border_color: hsla(0.5, 1., 0.5, 1.),
            border_widths: Edges::all(ScaledPixels(4.)),
            corner_radii: Corners::all(ScaledPixels(20.)),
            ..quad(scaled(0., 0., 100., 50.))
        };
        assert!(transform.fills_quad_as_paths(&rounded));
        let pieces = transformed(&transform, rounded);
        let fills = pieces
            .iter()
            .map(|piece| match piece {
                Primitive::Path(path) => (path.paint.even_odd.as_bool(), path.paint.bounds),
                _ => panic!("expected a path"),
            })
            .collect::<Vec<_>>();
        assert_eq!(fills.len(), 2);
        assert!(
            !fills[0].0 && fills[1].0,
            "a background, then a border ring"
        );
        for (_, bounds) in fills {
            assert_near(bounds.origin, (0., 0.));
            assert_near(bounds.bottom_right(), (200., 50.));
        }

        let mut outline = Outline::default();
        transform.rounded_rect(
            &mut outline,
            scaled(0., 0., 100., 50.),
            rounded.corner_radii,
            None,
        );
        let curves = outline.into_curves().unwrap();
        let ends = |at: (f32, f32)| {
            curves
                .iter()
                .any(|curve| [curve.p0, curve.p1].contains(&point(at.0, at.1)))
        };
        assert!(
            ends((40., 0.)) && ends((0., 20.)),
            "the corners are 40 by 20"
        );
        assert!(!ends((20., 0.)));

        let square = quad(scaled(0., 0., 100., 50.));
        assert!(!transform.fills_quad_as_paths(&square));
        let uniform = stretch((0., 0.), (2., 2.), 0., None);
        assert!(!uniform.fills_quad_as_paths(&rounded));
    }

    #[test]
    fn unevenly_scaled_sprites_stretch_through_their_matrix_or_bounds() {
        let transform = stretch((200., 0.), (0.5, 2.), 0., None);
        let sprite = glyph(190., 20);
        let pieces = transformed(&transform, sprite);
        let [Primitive::MonochromeSprite(stretched)] = pieces.as_slice() else {
            panic!("expected a sprite");
        };
        assert_eq!(stretched.bounds, sprite.bounds);
        assert_eq!(stretched.tile, sprite.tile);
        assert_eq!(
            stretched.transformation.rotation_scale,
            [[0.5, 0.], [0., 2.]]
        );
        let drawn = stretched.transformation.transform_bounds(sprite.bounds);
        assert_eq!(drawn, transform.bounds(sprite.bounds));
        assert_eq!(drawn, scaled(195., 0., 10., 32.));

        let image = PolychromeSprite {
            order: 0,
            pad: 0,
            tile: tile(0, 20),
            grayscale: false.into(),
            opacity: 1.,
            bounds: scaled(190., 10., 20., 16.),
            content_mask: everywhere(),
            corner_radii: Corners::all(ScaledPixels(4.)),
        };
        let [Primitive::PolychromeSprite(image)] = transformed(&transform, image)[..] else {
            panic!("expected a sprite");
        };
        assert_eq!(image.bounds, scaled(195., 20., 10., 32.));
        assert_eq!(image.corner_radii, Corners::all(ScaledPixels(2.)));
    }

    #[test]
    fn an_unevenly_scaled_underline_thickens_vertically() {
        let transform = stretch((0., 0.), (3., 2.), 0., None);
        let underline = Underline {
            order: 0,
            pad: 0,
            bounds: scaled(10., 20., 30., 2.),
            content_mask: everywhere(),
            color: hsla(0., 0., 0., 1.),
            thickness: ScaledPixels(1.5),
            wavy: false.into(),
        };
        let [Primitive::Underline(underline)] = transformed(&transform, underline)[..] else {
            panic!("expected an underline");
        };
        assert_eq!(underline.bounds, scaled(30., 40., 90., 4.));
        assert_eq!(underline.thickness, ScaledPixels(3.));
    }

    #[test]
    fn uneven_scales_compose_with_turns_and_nested_uniform_scales() {
        let probe = point(ScaledPixels(260.), ScaledPixels(170.));
        let outer = stretch((100., 100.), (0.5, 0.5), 0., None);
        let alone = stretch((200., 200.), (2., 1.), 90., None);
        let inner = stretch((200., 200.), (2., 1.), 90., Some(outer));
        let expected = outer.point(alone.point(probe));
        assert_near(inner.point(probe), (expected.x.0, expected.y.0));
        assert_eq!(inner.scale(), point(1., 0.5));
        assert!(!inner.is_uniform());
        assert!((inner.rotation().0 - 90f32.to_radians()).abs() < 1e-5);

        let turned = stretch((200., 200.), (2., 1.), 90., None);
        assert_near(
            turned.point(point(ScaledPixels(210.), ScaledPixels(200.))),
            (200., 220.),
        );
        assert_near(
            turned.point(point(ScaledPixels(200.), ScaledPixels(210.))),
            (190., 200.),
        );

        let wide = stretch((0., 0.), (2., 1.), 0., None);
        let tall = stretch((0., 0.), (1., 3.), 0., Some(wide));
        assert_eq!(tall.scale(), point(2., 3.));
        assert_eq!(
            tall.bounds(scaled(10., 10., 10., 10.)),
            scaled(20., 30., 20., 30.)
        );
    }

    #[test]
    fn an_even_scale_per_axis_is_the_uniform_scale() {
        let uniform = stretch((100., 60.), (0.5, 0.5), 0., None);
        assert!(uniform.is_uniform());
        let shadowed = crate::Shadow {
            order: 0,
            blur_radius: ScaledPixels(8.),
            bounds: scaled(10., 10., 40., 30.),
            corner_radii: Corners::all(ScaledPixels(6.)),
            content_mask: everywhere(),
            color: hsla(0., 0., 0., 0.5),
            shape_bounds: scaled(10., 10., 40., 30.),
            shape_corner_radii: Corners::all(ScaledPixels(6.)),
            inset: false.into(),
            pad: 0,
        };
        let rounded = Quad {
            border_color: hsla(0.5, 1., 0.5, 1.),
            border_widths: Edges::all(ScaledPixels(2.)),
            corner_radii: Corners::all(ScaledPixels(10.)),
            ..quad(scaled(10., 10., 40., 30.))
        };
        let pieces = transformed(&uniform, rounded);
        let [Primitive::Quad(quad)] = pieces.as_slice() else {
            panic!("a uniform scale keeps a rounded quad a quad");
        };
        assert_eq!(quad.bounds, scaled(55., 35., 20., 15.));
        assert_eq!(quad.corner_radii, Corners::all(ScaledPixels(5.)));
        assert_eq!(quad.border_widths, Edges::all(ScaledPixels(1.)));
        let [Primitive::MonochromeSprite(sprite)] = transformed(&uniform, glyph(30., 20))[..]
        else {
            panic!("expected a sprite");
        };
        assert_eq!(sprite.transformation, TransformationMatrix::unit());
        assert_eq!(sprite.bounds, scaled(65., 30., 10., 8.));
        let [Primitive::Shadow(shadow)] = transformed(&uniform, shadowed)[..] else {
            panic!("expected a shadow");
        };
        assert_eq!(shadow.blur_radius, ScaledPixels(4.));
        assert_eq!(shadow.corner_radii, Corners::all(ScaledPixels(3.)));
        assert_eq!(shadow.bounds, scaled(55., 35., 20., 15.));
    }

    #[test]
    fn a_fade_under_an_uneven_scale_ramps_over_the_scale_of_its_axis() {
        let transform = stretch((0., 0.), (2., 0.5), 0., None);
        let fade = |edge| {
            FadeRamp::new(
                FadeMask {
                    bounds: Bounds {
                        origin: point(px(0.), px(0.)),
                        size: size(px(100.), px(100.)),
                    },
                    edge,
                    length: px(10.),
                },
                1.,
                Some(transform),
            )
            .unwrap()
        };
        let trailing = fade(FadeEdge::Trailing);
        assert_eq!((trailing.start, trailing.end), (180., 200.));
        let bottom = fade(FadeEdge::Bottom);
        assert_eq!((bottom.start, bottom.end), (45., 50.));
    }

    #[test]
    fn an_unevenly_scaled_hitbox_matches_its_drawn_bounds() {
        let transform = stretch((100., 100.), (0.5, 2.), 0., None);
        let layout = Bounds {
            origin: point(px(50.), px(80.)),
            size: size(px(40.), px(20.)),
        };
        let drawn = transformed(&transform, quad(scaled(50., 80., 40., 20.)));
        let [Primitive::Quad(drawn)] = drawn[..] else {
            panic!("expected a quad");
        };
        let hit = transform.logical_bounds(layout, 1.);
        assert_eq!(
            hit,
            Bounds {
                origin: point(px(drawn.bounds.origin.x.0), px(drawn.bounds.origin.y.0)),
                size: size(
                    px(drawn.bounds.size.width.0),
                    px(drawn.bounds.size.height.0)
                ),
            }
        );
        assert_eq!(transform.inverse_logical_bounds(hit, 1.), layout);
    }
}
