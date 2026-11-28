// todo("windows"): remove
#![cfg_attr(windows, allow(dead_code))]

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    AtlasTextureId, AtlasTile, Background, Bounds, ContentMask, Corners, Edges, HitboxId, Hsla,
    NativeViewId, Path, PathTiles, Pixels, Point, Radians, Rgba, ScaledPixels, Size,
    TimedTransformation, bounds_tree::BoundsTree, point,
};
use smallvec::{SmallVec, smallvec};
use std::{
    collections::VecDeque, fmt::Debug, iter::Peekable, ops::Range, rc::Rc, slice, time::Duration,
};

mod paint_effects;
mod visual_effect;

pub use paint_effects::{FadeEdge, FadeMask};
pub(crate) use paint_effects::{FadeRamp, PaintTransform};

pub use visual_effect::*;

#[expect(missing_docs)]
pub type DrawOrder = u32;

/// A boolean stored as a `u32` so that GPU-facing structs contain no
/// compiler-inserted padding bytes, which would be undefined behavior to
/// reinterpret as `&[u8]` when writing instance buffers. Guaranteed to be
/// `0` or `1` by construction; shaders read it as a `u32`/`uint`.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
#[repr(transparent)]
pub struct PaddedBool32(u32);

impl From<bool> for PaddedBool32 {
    fn from(value: bool) -> Self {
        PaddedBool32(value as u32)
    }
}

impl PaddedBool32 {
    /// The wrapped boolean.
    pub fn as_bool(self) -> bool {
        self.0 != 0
    }
}

struct Layer {
    primitives: SmallVec<[Range<usize>; 1]>,
    bounds: Bounds<ScaledPixels>,
    max_kind: PrimitiveKind,
    max_shared_kind: PrimitiveKind,
    /// Whether a native view was painted in the layer, which then can't be
    /// drawn as one: what was painted after the view has to cover it.
    has_native_view: bool,
}

#[derive(Default)]
#[expect(missing_docs)]
pub struct Scene {
    pub(crate) paint_operations: Vec<PaintOperation>,
    primitive_bounds: BoundsTree<ScaledPixels>,
    layer_stack: Vec<usize>,
    layers: VecDeque<Layer>,
    pub shadows: Vec<Shadow>,
    pub quads: Vec<Quad>,
    pub paths: Vec<PaintedPath>,
    pub underlines: Vec<Underline>,
    pub monochrome_sprites: Vec<MonochromeSprite>,
    pub subpixel_sprites: Vec<SubpixelSprite>,
    pub polychrome_sprites: Vec<PolychromeSprite>,
    pub surfaces: Vec<PaintSurface>,
    pub native_views: Vec<PaintNativeView>,
    pub liquid_glass_regions: Vec<LiquidGlassRegion>,
    pub visual_effect_regions: Vec<VisualEffectRegion>,
    animations: Vec<SpriteAnimation>,
    paint_transform: Option<PaintTransform>,
    fade_ramps: SmallVec<[FadeRamp; 2]>,
}

#[expect(missing_docs)]
impl Scene {
    pub fn clear(&mut self) {
        self.paint_operations.clear();
        self.primitive_bounds.clear();
        self.layer_stack.clear();
        self.layers.clear();
        self.paths.clear();
        self.shadows.clear();
        self.quads.clear();
        self.underlines.clear();
        self.monochrome_sprites.clear();
        self.subpixel_sprites.clear();
        self.polychrome_sprites.clear();
        self.surfaces.clear();
        self.native_views.clear();
        self.liquid_glass_regions.clear();
        self.visual_effect_regions.clear();
        self.animations.clear();
        self.paint_transform = None;
        self.fade_ramps.clear();
    }

    /// The scale applied to what is inserted now.
    pub(crate) fn paint_transform(&self) -> Option<PaintTransform> {
        self.paint_transform
    }

    /// Replaces the scale applied to what is inserted, returning the last.
    pub(crate) fn set_paint_transform(
        &mut self,
        transform: Option<PaintTransform>,
    ) -> Option<PaintTransform> {
        std::mem::replace(&mut self.paint_transform, transform)
    }

    /// What changes the primitives inserted now, which a replayed range of
    /// a previous scene must have been inserted under too.
    pub(crate) fn paint_effects(&self) -> (Option<PaintTransform>, SmallVec<[FadeRamp; 2]>) {
        (self.paint_transform, self.fade_ramps.clone())
    }

    /// Fades what is inserted until the matching [`Self::pop_fade_ramp`].
    pub(crate) fn push_fade_ramp(&mut self, ramp: FadeRamp) {
        self.fade_ramps.push(ramp);
    }

    pub(crate) fn pop_fade_ramp(&mut self) {
        self.fade_ramps.pop();
    }

    /// Calls `insert` with what `primitive` becomes under the active scale
    /// and fades.
    fn apply_paint_effects(&self, primitive: Primitive, mut insert: impl FnMut(Primitive)) {
        let mut transformed = SmallVec::<[Primitive; 2]>::new();
        match self.paint_transform {
            Some(transform) => transform.apply(primitive, &mut |piece| transformed.push(piece)),
            None => transformed.push(primitive),
        }
        for primitive in transformed {
            let steps = FadeRamp::steps(&self.fade_ramps, &primitive);
            let mut pieces: SmallVec<[Primitive; 1]> = smallvec![primitive];
            for (ramp, step) in self.fade_ramps.iter().zip(steps) {
                let mut faded = SmallVec::new();
                for piece in pieces {
                    ramp.apply(piece, step, &mut |piece| faded.push(piece));
                }
                pieces = faded;
            }
            pieces.into_iter().for_each(&mut insert);
        }
    }

    /// Inserts a sprite that [`Self::advance_animations`] keeps moving. The
    /// sprite's color is taken as its color before the animation's alpha.
    pub(crate) fn insert_animated_sprite(
        &mut self,
        mut sprite: MonochromeSprite,
        animation: SpriteAnimation,
    ) {
        if self.paint_transform.is_none() && self.fade_ramps.is_empty() {
            self.insert_animated_sprite_unaffected(sprite, animation);
            return;
        }
        sprite.animation = SpriteAnimationId(self.animations.len() as u32);
        let animation = match self.paint_transform {
            Some(transform) => transform.animation(animation),
            None => animation,
        };
        let mut pieces = SmallVec::<[MonochromeSprite; 1]>::new();
        self.apply_paint_effects(sprite.into(), |piece| {
            if let Primitive::MonochromeSprite(sprite) = piece {
                pieces.push(sprite);
            }
        });
        for piece in pieces {
            self.insert_animated_sprite_unaffected(piece, animation);
        }
    }

    fn insert_animated_sprite_unaffected(
        &mut self,
        mut sprite: MonochromeSprite,
        mut animation: SpriteAnimation,
    ) {
        sprite.animation = SpriteAnimationId(self.animations.len() as u32);
        animation.base_color = sprite.color;
        if self.try_insert_primitive(sprite.into()) {
            self.animations.push(animation);
        }
    }

    /// How long the window may wait between presents of this scene while only
    /// its animations need a frame: `None` when nothing in it animates, and
    /// zero when an animation wants every frame.
    pub(crate) fn animation_frame_interval(&self) -> Option<Duration> {
        self.animations
            .iter()
            .map(|animation| {
                animation
                    .transformation
                    .min_frame_interval()
                    .unwrap_or_default()
            })
            .min()
    }

    /// Moves every animated sprite to its pose at `elapsed` time on the app's
    /// synced animation clock, without the scene being rebuilt.
    pub(crate) fn advance_animations(&mut self, elapsed: Duration) {
        for animation in &self.animations {
            let Some(sprite) = self.monochrome_sprites.get_mut(animation.sprite_index) else {
                continue;
            };
            let pose = animation.transformation.at(elapsed);
            let matrix = pose.into_matrix(animation.center, animation.scale_factor);
            sprite.transformation = match animation.paint_matrix {
                Some(paint_matrix) => paint_matrix.compose(matrix),
                None => matrix,
            };
            sprite.color = animation.base_color.opacity(pose.alpha_factor());
        }
    }

    pub fn len(&self) -> usize {
        self.paint_operations.len()
    }

    pub fn push_layer(&mut self) {
        self.layer_stack.push(self.layers.len());
        self.layers.push_back(Layer {
            primitives: SmallVec::new(),
            bounds: Bounds::default(),
            max_kind: PrimitiveKind::Shadow,
            max_shared_kind: PrimitiveKind::NativeView,
            has_native_view: false,
        });
        self.paint_operations.push(PaintOperation::StartLayer);
    }

    pub fn pop_layer(&mut self) {
        self.layer_stack.pop();
        if self.layer_stack.is_empty() {
            while let Some(layer) = self.layers.pop_front() {
                self.insert_layer(layer);
            }
        }
        self.paint_operations.push(PaintOperation::EndLayer);
    }

    fn insert_layer(&mut self, layer: Layer) {
        if layer.primitives.is_empty() {
            return;
        }
        if layer.has_native_view {
            self.insert_layer_around_native_views(layer);
            return;
        }
        let order =
            self.primitive_bounds
                .insert(layer.bounds, layer.max_kind, layer.max_shared_kind);
        for index in layer.primitives.into_iter().flatten() {
            if let PaintOperation::Primitive(primitive) = &self.paint_operations[index] {
                let primitive = primitive.clone();
                self.push_primitive(primitive, order);
            }
        }
    }

    /// Inserts a layer that a native view was painted in.
    ///
    /// A layer's primitives share one place in the drawing order, where they
    /// are drawn by kind and not in the order they were painted. A native
    /// view erases what is drawn before it, so the layer is inserted in parts:
    /// what was painted before each view, the view, and what was painted after.
    fn insert_layer_around_native_views(&mut self, layer: Layer) {
        let mut part = Vec::new();
        for index in layer.primitives.into_iter().flatten() {
            match &self.paint_operations[index] {
                PaintOperation::Primitive(primitive)
                    if primitive.kind() == PrimitiveKind::NativeView =>
                {
                    let primitive = primitive.clone();
                    self.insert_layer_part(std::mem::take(&mut part));
                    self.insert_layer_part(vec![primitive]);
                }
                PaintOperation::Primitive(primitive) => part.push(primitive.clone()),
                PaintOperation::LiquidGlass(region) => {
                    let region = *region;
                    self.insert_layer_part(std::mem::take(&mut part));
                    self.place_liquid_glass(region);
                }
                PaintOperation::VisualEffect(region) => {
                    let region = *region;
                    self.insert_layer_part(std::mem::take(&mut part));
                    self.place_visual_effect(region);
                }
                PaintOperation::StartLayer | PaintOperation::EndLayer => {}
            }
        }
        self.insert_layer_part(part);
    }

    fn insert_layer_part(&mut self, primitives: Vec<Primitive>) {
        let Some(first) = primitives.first() else {
            return;
        };
        let mut bounds = first.clipped_bounds();
        let mut max_kind = PrimitiveKind::Shadow;
        let mut max_shared_kind = PrimitiveKind::NativeView;
        for primitive in &primitives {
            let kind = primitive.kind();
            bounds = bounds.join(&primitive.clipped_bounds());
            max_kind = max_kind.max(kind);
            max_shared_kind = max_shared_kind.min(kind.max_shared_kind());
        }
        let order = self
            .primitive_bounds
            .insert(bounds, max_kind, max_shared_kind);
        for primitive in primitives {
            self.push_primitive(primitive, order);
        }
    }

    pub fn insert_primitive(&mut self, primitive: impl Into<Primitive>) {
        let primitive = primitive.into();
        if self.paint_transform.is_none() && self.fade_ramps.is_empty() {
            self.try_insert_primitive(primitive);
            return;
        }
        let mut pieces = SmallVec::<[Primitive; 1]>::new();
        self.apply_paint_effects(primitive, |piece| pieces.push(piece));
        for piece in pieces {
            self.try_insert_primitive(piece);
        }
    }

    pub fn insert_liquid_glass(&mut self, region: LiquidGlassRegion) {
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
            self.place_liquid_glass(region);
        }
        self.paint_operations
            .push(PaintOperation::LiquidGlass(region));
    }

    fn place_liquid_glass(&mut self, mut region: LiquidGlassRegion) {
        region.order = self.primitive_bounds.insert(
            region.visible_bounds(),
            PrimitiveKind::NativeView,
            PrimitiveKind::Surface,
        );
        let content_mask = ContentMask {
            bounds: region.content_mask,
        };
        for bounds in liquid_glass_cutouts(region.bounds, region.corner_radius) {
            if bounds.intersects(&region.content_mask) {
                self.native_views
                    .push(PaintNativeView::cutout(region.order, bounds, content_mask));
            }
        }
        self.liquid_glass_regions.push(region);
    }

    pub fn attached_native_views(&self) -> impl DoubleEndedIterator<Item = &PaintNativeView> {
        self.native_views
            .iter()
            .filter(|native_view| native_view.id != NativeViewId::LIQUID_GLASS)
    }

    /// Returns whether the primitive was kept, rather than clipped away.
    fn try_insert_primitive(&mut self, primitive: Primitive) -> bool {
        let clipped_bounds = primitive.clipped_bounds();
        if clipped_bounds.is_empty() {
            return false;
        }

        let kind = primitive.kind();
        if let Some(&layer) = self.layer_stack.last()
            && let Some(layer) = self.layers.get_mut(layer)
        {
            layer.bounds = layer.bounds.join(&clipped_bounds);
            layer.max_kind = layer.max_kind.max(kind);
            layer.max_shared_kind = layer.max_shared_kind.min(kind.max_shared_kind());
            layer.has_native_view |= kind == PrimitiveKind::NativeView;
            let index = self.paint_operations.len();
            match layer.primitives.last_mut() {
                Some(range) if range.end == index => range.end += 1,
                _ => layer.primitives.push(index..index + 1),
            }
        } else {
            let order = self
                .primitive_bounds
                .insert(clipped_bounds, kind, kind.max_shared_kind());
            self.push_primitive(primitive.clone(), order);
        }
        self.paint_operations
            .push(PaintOperation::Primitive(primitive));
        true
    }

    fn push_primitive(&mut self, primitive: Primitive, order: DrawOrder) {
        match primitive {
            Primitive::Shadow(shadow) => self.shadows.push(Shadow { order, ..shadow }),
            Primitive::Quad(quad) => self.quads.push(Quad { order, ..quad }),
            Primitive::Path(mut path) => {
                path.order = order;
                self.paths.push(path);
            }
            Primitive::Underline(underline) => {
                self.underlines.push(Underline { order, ..underline })
            }
            Primitive::MonochromeSprite(sprite) => self
                .monochrome_sprites
                .push(MonochromeSprite { order, ..sprite }),
            Primitive::SubpixelSprite(sprite) => self
                .subpixel_sprites
                .push(SubpixelSprite { order, ..sprite }),
            Primitive::PolychromeSprite(sprite) => self
                .polychrome_sprites
                .push(PolychromeSprite { order, ..sprite }),
            Primitive::Surface(mut surface) => {
                surface.order = order;
                self.surfaces.push(surface);
            }
            Primitive::NativeView(native_view) => self.native_views.push(PaintNativeView {
                order,
                ..native_view
            }),
        }
    }

    pub fn replay(&mut self, range: Range<usize>, prev_scene: &Scene) {
        for operation in &prev_scene.paint_operations[range] {
            match operation {
                PaintOperation::Primitive(primitive) => {
                    // Animation ids index the scene they were inserted into.
                    if let Primitive::MonochromeSprite(sprite) = primitive
                        && let Some(animation) =
                            prev_scene.animations.get(sprite.animation.0 as usize)
                    {
                        self.insert_animated_sprite_unaffected(*sprite, *animation);
                    } else {
                        self.try_insert_primitive(primitive.clone());
                    }
                }
                PaintOperation::StartLayer => self.push_layer(),
                PaintOperation::EndLayer => self.pop_layer(),
                PaintOperation::LiquidGlass(region) => self.insert_liquid_glass(*region),
                PaintOperation::VisualEffect(region) => self.insert_visual_effect(*region),
            }
        }
    }

    pub fn finish(&mut self) {
        debug_assert!(self.layer_stack.is_empty(), "unbalanced scene layers");
        let keys = &mut Vec::new();
        sort_in_place(&mut self.shadows, keys, |shadow| (shadow.order, 0));
        sort_in_place(&mut self.quads, keys, |quad| (quad.order, 0));
        self.paths.sort_by_key(|path| path.order);
        sort_in_place(&mut self.underlines, keys, |underline| (underline.order, 0));
        sort_in_place(&mut self.monochrome_sprites, keys, |sprite| {
            (sprite.order, sprite.tile.texture_id.index)
        });
        sort_in_place(&mut self.subpixel_sprites, keys, |sprite| {
            (sprite.order, sprite.tile.texture_id.index)
        });
        sort_in_place(&mut self.polychrome_sprites, keys, |sprite| {
            (sprite.order, sprite.tile.texture_id.index)
        });
        self.surfaces.sort_by_key(|surface| surface.order);
        self.native_views
            .sort_by_key(|native_view| native_view.order);
        self.keep_first_painted_native_views();
        self.liquid_glass_regions.sort_by_key(|region| region.order);
        self.visual_effect_regions
            .sort_by_key(|region| region.order);

        // Sorting moved the sprites, so animations learn where theirs ended up.
        if !self.animations.is_empty() {
            for (index, sprite) in self.monochrome_sprites.iter().enumerate() {
                if let Some(animation) = self.animations.get_mut(sprite.animation.0 as usize) {
                    animation.sprite_index = index;
                }
            }
        }
    }

    /// Drops every occurrence of a native view but the one painted first,
    /// because a platform view can only be in one place.
    ///
    /// That is the occurrence whose hitbox takes the view's mouse input. It
    /// isn't always the first in the drawing order, which depends on what each
    /// occurrence overlaps.
    fn keep_first_painted_native_views(&mut self) {
        let attached = self
            .attached_native_views()
            .map(|native_view| native_view.id)
            .collect::<SmallVec<[_; 8]>>();
        let is_repeated = attached
            .iter()
            .enumerate()
            .any(|(index, id)| attached[..index].contains(id));
        if !is_repeated {
            return;
        }
        let mut first_painted: Vec<(NativeViewId, HitboxId)> = Vec::new();
        for operation in &self.paint_operations {
            if let PaintOperation::Primitive(Primitive::NativeView(native_view)) = operation
                && !first_painted.iter().any(|(id, _)| *id == native_view.id)
            {
                first_painted.push((native_view.id, native_view.hitbox_id));
            }
        }
        self.native_views.retain(|native_view| {
            native_view.id == NativeViewId::LIQUID_GLASS
                || first_painted.contains(&(native_view.id, native_view.hitbox_id))
        });
    }

    #[cfg_attr(
        all(
            any(target_os = "linux", target_os = "freebsd"),
            not(any(feature = "x11", feature = "wayland"))
        ),
        allow(dead_code)
    )]
    pub fn batches(&self) -> impl Iterator<Item = PrimitiveBatch> + '_ {
        BatchIterator {
            shadows_start: 0,
            shadows_iter: self.shadows.iter().peekable(),
            quads_start: 0,
            quads_iter: self.quads.iter().peekable(),
            paths_start: 0,
            paths_iter: self.paths.iter().peekable(),
            underlines_start: 0,
            underlines_iter: self.underlines.iter().peekable(),
            monochrome_sprites_start: 0,
            monochrome_sprites_iter: self.monochrome_sprites.iter().peekable(),
            subpixel_sprites_start: 0,
            subpixel_sprites_iter: self.subpixel_sprites.iter().peekable(),
            polychrome_sprites_start: 0,
            polychrome_sprites_iter: self.polychrome_sprites.iter().peekable(),
            surfaces_start: 0,
            surfaces_iter: self.surfaces.iter().peekable(),
            native_views_start: 0,
            native_views_iter: self.native_views.iter().peekable(),
        }
    }
}

/// Sorts small `(key, index)` pairs instead of the primitives themselves, then moves each
/// primitive into place once. Primitives are large, so a comparison sort that shuffles them
/// directly spends most of its time copying. Ties keep insertion order, as `sort_by_key`
/// does, because the index is part of what is sorted.
fn sort_in_place<T: Copy>(
    primitives: &mut [T],
    keys: &mut Vec<(u64, u32)>,
    key: impl Fn(&T) -> (u32, u32),
) {
    if primitives.is_sorted_by_key(&key) {
        return;
    }
    keys.clear();
    keys.extend(primitives.iter().enumerate().map(|(index, primitive)| {
        let (major, minor) = key(primitive);
        ((major as u64) << 32 | minor as u64, index as u32)
    }));
    keys.sort_unstable();

    // `keys[target].1` is the source index for `target`. Follow each cycle of that
    // permutation, marking visited slots by pointing them at themselves.
    for start in 0..primitives.len() {
        if keys[start].1 as usize == start {
            continue;
        }
        let displaced = primitives[start];
        let mut target = start;
        loop {
            let source = keys[target].1 as usize;
            keys[target].1 = target as u32;
            if source == start {
                primitives[target] = displaced;
                break;
            }
            primitives[target] = primitives[source];
            target = source;
        }
    }
}

/// The depth step between consecutive quads in a frame with `quad_count` quads.
pub fn quad_depth_scale(quad_count: usize) -> f32 {
    let denominator = (quad_count.min((1 << 24) - 1) + 1).next_power_of_two();
    1.0 / denominator as f32
}

/// Maps a quad's index in [`Scene::quads`] to depth, with greater values closer.
pub fn quad_depth(quad_id: u32, scale: f32) -> f32 {
    ((quad_id + 1) as f32 * scale).min(1.0)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Default)]
#[cfg_attr(
    all(
        any(target_os = "linux", target_os = "freebsd"),
        not(any(feature = "x11", feature = "wayland"))
    ),
    allow(dead_code)
)]
pub(crate) enum PrimitiveKind {
    Shadow,
    #[default]
    Quad,
    Path,
    Underline,
    MonochromeSprite,
    SubpixelSprite,
    PolychromeSprite,
    Surface,
    NativeView,
}

impl PrimitiveKind {
    /// We guarantee that overlapping primitives are drawn in paint order.
    /// But, to improve GPU draw batching, the renderer sorts primitives that
    /// share a draw order by kind, then by atlas texture, and only then in
    /// paint order. So, a primitive can only share the draw order of the
    /// topmost primitive it overlaps if that primitive's kind is at most the
    /// one returned here. Otherwise, it needs a new draw order.
    fn max_shared_kind(self) -> Self {
        match self {
            Self::MonochromeSprite => Self::Underline,
            Self::SubpixelSprite => Self::MonochromeSprite,
            Self::PolychromeSprite => Self::SubpixelSprite,
            kind => kind,
        }
    }
}

pub(crate) enum PaintOperation {
    Primitive(Primitive),
    LiquidGlass(LiquidGlassRegion),
    VisualEffect(VisualEffectRegion),
    StartLayer,
    EndLayer,
}

#[derive(Clone)]
#[expect(missing_docs)]
pub enum Primitive {
    Shadow(Shadow),
    Quad(Quad),
    Path(PaintedPath),
    Underline(Underline),
    MonochromeSprite(MonochromeSprite),
    SubpixelSprite(SubpixelSprite),
    PolychromeSprite(PolychromeSprite),
    Surface(PaintSurface),
    NativeView(PaintNativeView),
}

#[expect(missing_docs)]
impl Primitive {
    pub(crate) fn kind(&self) -> PrimitiveKind {
        match self {
            Primitive::Shadow(_) => PrimitiveKind::Shadow,
            Primitive::Quad(_) => PrimitiveKind::Quad,
            Primitive::Path(_) => PrimitiveKind::Path,
            Primitive::Underline(_) => PrimitiveKind::Underline,
            Primitive::MonochromeSprite(_) => PrimitiveKind::MonochromeSprite,
            Primitive::SubpixelSprite(_) => PrimitiveKind::SubpixelSprite,
            Primitive::PolychromeSprite(_) => PrimitiveKind::PolychromeSprite,
            Primitive::Surface(_) => PrimitiveKind::Surface,
            Primitive::NativeView(_) => PrimitiveKind::NativeView,
        }
    }

    pub fn bounds(&self) -> &Bounds<ScaledPixels> {
        match self {
            Primitive::Shadow(shadow) => &shadow.bounds,
            Primitive::Quad(quad) => &quad.bounds,
            Primitive::Path(path) => &path.bounds,
            Primitive::Underline(underline) => &underline.bounds,
            Primitive::MonochromeSprite(sprite) => &sprite.bounds,
            Primitive::SubpixelSprite(sprite) => &sprite.bounds,
            Primitive::PolychromeSprite(sprite) => &sprite.bounds,
            Primitive::Surface(surface) => &surface.bounds,
            Primitive::NativeView(native_view) => &native_view.bounds,
        }
    }

    fn transformation(&self) -> TransformationMatrix {
        match self {
            Primitive::MonochromeSprite(sprite) => sprite.transformation,
            Primitive::SubpixelSprite(sprite) => sprite.transformation,
            _ => TransformationMatrix::unit(),
        }
    }

    fn clipped_bounds(&self) -> Bounds<ScaledPixels> {
        self.transformation()
            .transform_bounds(*self.bounds())
            .intersect(&self.content_mask().bounds)
    }

    pub fn content_mask(&self) -> &ContentMask<ScaledPixels> {
        match self {
            Primitive::Shadow(shadow) => &shadow.content_mask,
            Primitive::Quad(quad) => &quad.content_mask,
            Primitive::Path(path) => &path.paint.content_mask,
            Primitive::Underline(underline) => &underline.content_mask,
            Primitive::MonochromeSprite(sprite) => &sprite.content_mask,
            Primitive::SubpixelSprite(sprite) => &sprite.content_mask,
            Primitive::PolychromeSprite(sprite) => &sprite.content_mask,
            Primitive::Surface(surface) => &surface.content_mask,
            Primitive::NativeView(native_view) => &native_view.content_mask,
        }
    }
}

#[cfg_attr(
    all(
        any(target_os = "linux", target_os = "freebsd"),
        not(any(feature = "x11", feature = "wayland"))
    ),
    allow(dead_code)
)]
struct BatchIterator<'a> {
    shadows_start: usize,
    shadows_iter: Peekable<slice::Iter<'a, Shadow>>,
    quads_start: usize,
    quads_iter: Peekable<slice::Iter<'a, Quad>>,
    paths_start: usize,
    paths_iter: Peekable<slice::Iter<'a, PaintedPath>>,
    underlines_start: usize,
    underlines_iter: Peekable<slice::Iter<'a, Underline>>,
    monochrome_sprites_start: usize,
    monochrome_sprites_iter: Peekable<slice::Iter<'a, MonochromeSprite>>,
    subpixel_sprites_start: usize,
    subpixel_sprites_iter: Peekable<slice::Iter<'a, SubpixelSprite>>,
    polychrome_sprites_start: usize,
    polychrome_sprites_iter: Peekable<slice::Iter<'a, PolychromeSprite>>,
    surfaces_start: usize,
    surfaces_iter: Peekable<slice::Iter<'a, PaintSurface>>,
    native_views_start: usize,
    native_views_iter: Peekable<slice::Iter<'a, PaintNativeView>>,
}

impl<'a> Iterator for BatchIterator<'a> {
    type Item = PrimitiveBatch;

    fn next(&mut self) -> Option<Self::Item> {
        let mut orders_and_kinds = [
            (
                self.shadows_iter.peek().map(|s| s.order),
                PrimitiveKind::Shadow,
            ),
            (self.quads_iter.peek().map(|q| q.order), PrimitiveKind::Quad),
            (
                self.paths_iter.peek().map(|path| path.order),
                PrimitiveKind::Path,
            ),
            (
                self.underlines_iter.peek().map(|u| u.order),
                PrimitiveKind::Underline,
            ),
            (
                self.monochrome_sprites_iter.peek().map(|s| s.order),
                PrimitiveKind::MonochromeSprite,
            ),
            (
                self.subpixel_sprites_iter.peek().map(|s| s.order),
                PrimitiveKind::SubpixelSprite,
            ),
            (
                self.polychrome_sprites_iter.peek().map(|s| s.order),
                PrimitiveKind::PolychromeSprite,
            ),
            (
                self.surfaces_iter.peek().map(|s| s.order),
                PrimitiveKind::Surface,
            ),
            (
                self.native_views_iter
                    .peek()
                    .map(|native_view| native_view.order),
                PrimitiveKind::NativeView,
            ),
        ];
        orders_and_kinds.sort_by_key(|(order, kind)| (order.unwrap_or(u32::MAX), *kind));

        let first = orders_and_kinds[0];
        let second = orders_and_kinds[1];
        let (batch_kind, max_order_and_kind) = if first.0.is_some() {
            (first.1, (second.0.unwrap_or(u32::MAX), second.1))
        } else {
            return None;
        };

        match batch_kind {
            PrimitiveKind::Shadow => {
                let shadows_start = self.shadows_start;
                let mut shadows_end = shadows_start + 1;
                self.shadows_iter.next();
                while self
                    .shadows_iter
                    .next_if(|shadow| (shadow.order, batch_kind) < max_order_and_kind)
                    .is_some()
                {
                    shadows_end += 1;
                }
                self.shadows_start = shadows_end;
                Some(PrimitiveBatch::Shadows(shadows_start..shadows_end))
            }
            PrimitiveKind::Quad => {
                let quads_start = self.quads_start;
                let mut quads_end = quads_start + 1;
                self.quads_iter.next();
                while self
                    .quads_iter
                    .next_if(|quad| (quad.order, batch_kind) < max_order_and_kind)
                    .is_some()
                {
                    quads_end += 1;
                }
                self.quads_start = quads_end;
                Some(PrimitiveBatch::Quads(quads_start..quads_end))
            }
            PrimitiveKind::Path => {
                let paths_start = self.paths_start;
                let mut paths_end = paths_start + 1;
                self.paths_iter.next();
                while self
                    .paths_iter
                    .next_if(|path| (path.order, batch_kind) < max_order_and_kind)
                    .is_some()
                {
                    paths_end += 1;
                }
                self.paths_start = paths_end;
                Some(PrimitiveBatch::Paths(paths_start..paths_end))
            }
            PrimitiveKind::Underline => {
                let underlines_start = self.underlines_start;
                let mut underlines_end = underlines_start + 1;
                self.underlines_iter.next();
                while self
                    .underlines_iter
                    .next_if(|underline| (underline.order, batch_kind) < max_order_and_kind)
                    .is_some()
                {
                    underlines_end += 1;
                }
                self.underlines_start = underlines_end;
                Some(PrimitiveBatch::Underlines(underlines_start..underlines_end))
            }
            PrimitiveKind::MonochromeSprite => {
                let texture_id = self.monochrome_sprites_iter.peek().unwrap().tile.texture_id;
                let sprites_start = self.monochrome_sprites_start;
                let mut sprites_end = sprites_start + 1;
                self.monochrome_sprites_iter.next();
                while self
                    .monochrome_sprites_iter
                    .next_if(|sprite| {
                        (sprite.order, batch_kind) < max_order_and_kind
                            && sprite.tile.texture_id == texture_id
                    })
                    .is_some()
                {
                    sprites_end += 1;
                }
                self.monochrome_sprites_start = sprites_end;
                Some(PrimitiveBatch::MonochromeSprites {
                    texture_id,
                    range: sprites_start..sprites_end,
                })
            }
            PrimitiveKind::SubpixelSprite => {
                let texture_id = self.subpixel_sprites_iter.peek().unwrap().tile.texture_id;
                let sprites_start = self.subpixel_sprites_start;
                let mut sprites_end = sprites_start + 1;
                self.subpixel_sprites_iter.next();
                while self
                    .subpixel_sprites_iter
                    .next_if(|sprite| {
                        (sprite.order, batch_kind) < max_order_and_kind
                            && sprite.tile.texture_id == texture_id
                    })
                    .is_some()
                {
                    sprites_end += 1;
                }
                self.subpixel_sprites_start = sprites_end;
                Some(PrimitiveBatch::SubpixelSprites {
                    texture_id,
                    range: sprites_start..sprites_end,
                })
            }
            PrimitiveKind::PolychromeSprite => {
                let texture_id = self.polychrome_sprites_iter.peek().unwrap().tile.texture_id;
                let sprites_start = self.polychrome_sprites_start;
                let mut sprites_end = sprites_start + 1;
                self.polychrome_sprites_iter.next();
                while self
                    .polychrome_sprites_iter
                    .next_if(|sprite| {
                        (sprite.order, batch_kind) < max_order_and_kind
                            && sprite.tile.texture_id == texture_id
                    })
                    .is_some()
                {
                    sprites_end += 1;
                }
                self.polychrome_sprites_start = sprites_end;
                Some(PrimitiveBatch::PolychromeSprites {
                    texture_id,
                    range: sprites_start..sprites_end,
                })
            }
            PrimitiveKind::Surface => {
                let surfaces_start = self.surfaces_start;
                let mut surfaces_end = surfaces_start + 1;
                self.surfaces_iter.next();
                while self
                    .surfaces_iter
                    .next_if(|surface| (surface.order, batch_kind) < max_order_and_kind)
                    .is_some()
                {
                    surfaces_end += 1;
                }
                self.surfaces_start = surfaces_end;
                Some(PrimitiveBatch::Surfaces(surfaces_start..surfaces_end))
            }
            PrimitiveKind::NativeView => {
                let native_views_start = self.native_views_start;
                let mut native_views_end = native_views_start + 1;
                self.native_views_iter.next();
                while self
                    .native_views_iter
                    .next_if(|native_view| (native_view.order, batch_kind) < max_order_and_kind)
                    .is_some()
                {
                    native_views_end += 1;
                }
                self.native_views_start = native_views_end;
                Some(PrimitiveBatch::NativeViews(
                    native_views_start..native_views_end,
                ))
            }
        }
    }
}

#[derive(Debug)]
#[cfg_attr(
    all(
        any(target_os = "linux", target_os = "freebsd"),
        not(any(feature = "x11", feature = "wayland"))
    ),
    allow(dead_code)
)]
#[allow(missing_docs)]
pub enum PrimitiveBatch {
    Shadows(Range<usize>),
    Quads(Range<usize>),
    Paths(Range<usize>),
    Underlines(Range<usize>),
    MonochromeSprites {
        texture_id: AtlasTextureId,
        range: Range<usize>,
    },
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    SubpixelSprites {
        texture_id: AtlasTextureId,
        range: Range<usize>,
    },
    PolychromeSprites {
        texture_id: AtlasTextureId,
        range: Range<usize>,
    },
    Surfaces(Range<usize>),
    NativeViews(Range<usize>),
}

impl PrimitiveBatch {
    #[expect(missing_docs)]
    pub fn label(&self) -> String {
        match self {
            Self::Shadows(range) => format!("shadows ({})", range.len()),
            Self::Quads(range) => format!("quads ({})", range.len()),
            Self::Paths(range) => format!("paths ({})", range.len()),
            Self::Underlines(range) => format!("underlines ({})", range.len()),
            Self::MonochromeSprites { texture_id, range } => {
                format!(
                    "monochrome sprites ({}) on atlas {}",
                    range.len(),
                    texture_id.index
                )
            }
            Self::SubpixelSprites { texture_id, range } => {
                format!(
                    "subpixel sprites ({}) on atlas {}",
                    range.len(),
                    texture_id.index
                )
            }
            Self::PolychromeSprites { texture_id, range } => {
                format!(
                    "polychrome sprites ({}) on atlas {}",
                    range.len(),
                    texture_id.index
                )
            }
            Self::Surfaces(range) => format!("surfaces ({})", range.len()),
            Self::NativeViews(range) => format!("native views ({})", range.len()),
        }
    }
}

#[derive(Default, Debug, Copy, Clone)]
#[repr(C)]
#[expect(missing_docs)]
pub struct Quad {
    pub order: DrawOrder,
    pub border_style: BorderStyle,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub background: Background,
    pub border_color: Hsla,
    pub corner_radii: Corners<ScaledPixels>,
    pub border_widths: Edges<ScaledPixels>,
}

impl From<Quad> for Primitive {
    fn from(quad: Quad) -> Self {
        Primitive::Quad(quad)
    }
}

#[derive(Debug, Copy, Clone)]
#[repr(C)]
#[expect(missing_docs)]
pub struct Underline {
    pub order: DrawOrder,
    pub pad: u32, // align to 8 bytes
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub color: Hsla,
    pub thickness: ScaledPixels,
    pub wavy: PaddedBool32,
}

impl From<Underline> for Primitive {
    fn from(underline: Underline) -> Self {
        Primitive::Underline(underline)
    }
}

#[derive(Debug, Copy, Clone)]
#[repr(C)]
#[expect(missing_docs)]
pub struct Shadow {
    pub order: DrawOrder,
    pub blur_radius: ScaledPixels,
    pub bounds: Bounds<ScaledPixels>,
    pub corner_radii: Corners<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub color: Hsla,
    pub shape_bounds: Bounds<ScaledPixels>,
    pub shape_corner_radii: Corners<ScaledPixels>,
    pub inset: PaddedBool32,
    pub pad: u32, // align to 8 bytes
}

impl From<Shadow> for Primitive {
    fn from(shadow: Shadow) -> Self {
        Primitive::Shadow(shadow)
    }
}

/// The style of a border.
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[repr(C)]
pub enum BorderStyle {
    /// A solid border.
    #[default]
    Solid = 0,
    /// A dashed border.
    Dashed = 1,
}

/// A data type representing a 2 dimensional transformation that can be applied to an element.
#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(C)]
pub struct TransformationMatrix {
    /// 2x2 matrix containing rotation and scale,
    /// stored row-major
    pub rotation_scale: [[f32; 2]; 2],
    /// translation vector
    pub translation: [f32; 2],
}

impl Eq for TransformationMatrix {}

impl TransformationMatrix {
    /// The unit matrix, has no effect.
    pub fn unit() -> Self {
        Self {
            rotation_scale: [[1.0, 0.0], [0.0, 1.0]],
            translation: [0.0, 0.0],
        }
    }

    /// Move the origin by a given point
    pub fn translate(self, point: Point<ScaledPixels>) -> Self {
        self.compose(Self {
            rotation_scale: [[1.0, 0.0], [0.0, 1.0]],
            translation: [point.x.0, point.y.0],
        })
    }

    /// Clockwise rotation in radians around the origin
    pub fn rotate(self, angle: Radians) -> Self {
        self.compose(Self {
            rotation_scale: [
                [angle.0.cos(), -angle.0.sin()],
                [angle.0.sin(), angle.0.cos()],
            ],
            translation: [0.0, 0.0],
        })
    }

    /// Scale around the origin
    pub fn scale(self, size: Size<f32>) -> Self {
        self.compose(Self {
            rotation_scale: [[size.width, 0.0], [0.0, size.height]],
            translation: [0.0, 0.0],
        })
    }

    /// Perform matrix multiplication with another transformation
    /// to produce a new transformation that is the result of
    /// applying both transformations: first, `other`, then `self`.
    #[inline]
    pub fn compose(self, other: TransformationMatrix) -> TransformationMatrix {
        if other == Self::unit() {
            return self;
        }
        // Perform matrix multiplication
        TransformationMatrix {
            rotation_scale: [
                [
                    self.rotation_scale[0][0] * other.rotation_scale[0][0]
                        + self.rotation_scale[0][1] * other.rotation_scale[1][0],
                    self.rotation_scale[0][0] * other.rotation_scale[0][1]
                        + self.rotation_scale[0][1] * other.rotation_scale[1][1],
                ],
                [
                    self.rotation_scale[1][0] * other.rotation_scale[0][0]
                        + self.rotation_scale[1][1] * other.rotation_scale[1][0],
                    self.rotation_scale[1][0] * other.rotation_scale[0][1]
                        + self.rotation_scale[1][1] * other.rotation_scale[1][1],
                ],
            ],
            translation: [
                self.translation[0]
                    + self.rotation_scale[0][0] * other.translation[0]
                    + self.rotation_scale[0][1] * other.translation[1],
                self.translation[1]
                    + self.rotation_scale[1][0] * other.translation[0]
                    + self.rotation_scale[1][1] * other.translation[1],
            ],
        }
    }

    /// The smallest bounds that contain `bounds` once it is transformed.
    pub(crate) fn transform_bounds(&self, bounds: Bounds<ScaledPixels>) -> Bounds<ScaledPixels> {
        if *self == Self::unit() {
            return bounds;
        }
        let [[xx, xy], [yx, yy]] = self.rotation_scale;
        let [translate_x, translate_y] = self.translation;
        let corners = [
            bounds.origin,
            bounds.top_right(),
            bounds.bottom_left(),
            bounds.bottom_right(),
        ]
        .map(|corner| {
            Point::new(
                ScaledPixels(xx * corner.x.0 + xy * corner.y.0 + translate_x),
                ScaledPixels(yx * corner.x.0 + yy * corner.y.0 + translate_y),
            )
        });
        let [first, rest @ ..] = corners;
        let top_left = rest.iter().fold(first, |min, corner| min.min(corner));
        let bottom_right = rest.iter().fold(first, |max, corner| max.max(corner));
        Bounds::from_corners(top_left, bottom_right)
    }

    /// Apply transformation to a point, mainly useful for debugging
    pub fn apply(&self, point: Point<Pixels>) -> Point<Pixels> {
        let input = [point.x.0, point.y.0];
        let mut output = self.translation;
        for (i, output_cell) in output.iter_mut().enumerate() {
            for (k, input_cell) in input.iter().enumerate() {
                *output_cell += self.rotation_scale[i][k] * *input_cell;
            }
        }
        Point::new(output[0].into(), output[1].into())
    }
}

impl Default for TransformationMatrix {
    fn default() -> Self {
        Self::unit()
    }
}

#[derive(Copy, Clone, Debug)]
#[repr(C)]
#[expect(missing_docs)]
pub struct MonochromeSprite {
    pub order: DrawOrder,
    pub animation: SpriteAnimationId,
    pub tile: AtlasTile,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub color: Hsla,
    pub transformation: TransformationMatrix,
}

/// Refers to an animation of the scene a sprite is inserted into.
///
/// A single `u32` so it fits the sprite's existing padding and leaves the
/// instance layout unchanged on every backend; renderers ignore it.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(transparent)]
pub struct SpriteAnimationId(u32);

impl SpriteAnimationId {
    /// No animation.
    pub const NONE: Self = Self(u32::MAX);
}

impl Default for SpriteAnimationId {
    fn default() -> Self {
        Self::NONE
    }
}

/// A [`TimedTransformation`] the window applies to a sprite right before
/// every present, so the scene can be presented again without being redrawn.
#[derive(Copy, Clone, Debug)]
pub(crate) struct SpriteAnimation {
    transformation: TimedTransformation,
    center: Point<Pixels>,
    scale_factor: f32,
    paint_matrix: Option<TransformationMatrix>,
    base_color: Hsla,
    sprite_index: usize,
}

impl SpriteAnimation {
    pub(crate) fn new(
        transformation: TimedTransformation,
        center: Point<Pixels>,
        scale_factor: f32,
    ) -> Self {
        Self {
            transformation,
            center,
            scale_factor,
            paint_matrix: None,
            base_color: Hsla::default(),
            sprite_index: usize::MAX,
        }
    }
}

impl From<MonochromeSprite> for Primitive {
    fn from(sprite: MonochromeSprite) -> Self {
        Primitive::MonochromeSprite(sprite)
    }
}

#[derive(Copy, Clone, Debug)]
#[repr(C)]
#[expect(missing_docs)]
pub struct SubpixelSprite {
    pub order: DrawOrder,
    pub pad: u32, // align to 8 bytes
    pub tile: AtlasTile,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub color: Hsla,
    pub transformation: TransformationMatrix,
}

impl From<SubpixelSprite> for Primitive {
    fn from(sprite: SubpixelSprite) -> Self {
        Primitive::SubpixelSprite(sprite)
    }
}

#[derive(Copy, Clone, Debug)]
#[repr(C)]
#[expect(missing_docs)]
pub struct PolychromeSprite {
    pub order: DrawOrder,
    pub pad: u32,
    pub tile: AtlasTile,
    pub grayscale: PaddedBool32,
    pub opacity: f32,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub corner_radii: Corners<ScaledPixels>,
}

impl From<PolychromeSprite> for Primitive {
    fn from(sprite: PolychromeSprite) -> Self {
        Primitive::PolychromeSprite(sprite)
    }
}

#[derive(Clone, Debug)]
#[allow(missing_docs)]
pub struct PaintSurface {
    pub order: DrawOrder,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    pub image_buffer: objc2_core_foundation::CFRetained<objc2_core_video::CVPixelBuffer>,
}

impl From<PaintSurface> for Primitive {
    fn from(surface: PaintSurface) -> Self {
        Primitive::Surface(surface)
    }
}

/// Where a platform view shows through the scene.
///
/// The view sits beneath the window's rendered content, so the renderer
/// erases everything painted earlier within these bounds, and everything
/// painted later covers the view. The view is therefore treated as opaque,
/// and a view with an opacity below 1 blends with what is behind the
/// window's content rather than with what was painted beneath it.
#[derive(Clone, Copy, Debug)]
pub struct PaintNativeView {
    /// The view's position among the scene's other primitives.
    pub order: DrawOrder,
    /// The view these bounds belong to.
    pub id: NativeViewId,
    /// The hitbox that decides whether a mouse position reaches the view.
    pub hitbox_id: HitboxId,
    /// Where the view shows, before clipping: its frame once scaled. A view
    /// is never turned, so this is also its frame on the platform.
    pub bounds: Bounds<ScaledPixels>,
    /// The clip applied to the view.
    pub content_mask: ContentMask<ScaledPixels>,
    /// The color to show where the view has not caught up with these bounds,
    /// or a transparent color for none.
    pub background: Hsla,
    /// The size the view is laid out at, before `scale`.
    pub layout_size: Size<ScaledPixels>,
    /// How much the view is scaled about the center of `bounds`.
    pub scale: f32,
    /// How much more the view is scaled horizontally and vertically, on top
    /// of `scale`.
    pub axis_scale: Point<f32>,
    /// How opaque the view is, from 0 to 1.
    pub opacity: f32,
}

impl PaintNativeView {
    /// A view laid out at `bounds`, neither scaled nor faded.
    pub fn new(
        id: NativeViewId,
        hitbox_id: HitboxId,
        bounds: Bounds<ScaledPixels>,
        content_mask: ContentMask<ScaledPixels>,
        background: Hsla,
    ) -> Self {
        Self {
            order: 0,
            id,
            hitbox_id,
            bounds,
            content_mask,
            background,
            layout_size: bounds.size,
            scale: 1.,
            axis_scale: Point { x: 1., y: 1. },
            opacity: 1.,
        }
    }

    /// An opaque region erased for a platform layer that is not an attached
    /// view.
    pub(crate) fn cutout(
        order: DrawOrder,
        bounds: Bounds<ScaledPixels>,
        content_mask: ContentMask<ScaledPixels>,
    ) -> Self {
        Self {
            order,
            ..Self::new(
                NativeViewId::LIQUID_GLASS,
                HitboxId::NONE,
                bounds,
                content_mask,
                Hsla::transparent_black(),
            )
        }
    }

    /// How much the view is scaled horizontally and vertically, in all.
    pub fn scales(&self) -> Point<f32> {
        Point {
            x: self.scale * self.axis_scale.x,
            y: self.scale * self.axis_scale.y,
        }
    }

    /// Whether the view is shown scaled.
    pub fn is_transformed(&self) -> bool {
        self.scale != 1. || self.axis_scale != (Point { x: 1., y: 1. })
    }
}

impl From<PaintNativeView> for Primitive {
    fn from(native_view: PaintNativeView) -> Self {
        Primitive::NativeView(native_view)
    }
}

#[allow(missing_docs)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum LiquidGlassStyle {
    #[default]
    Regular,
    Clear,
}

#[allow(missing_docs)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LiquidGlassRegion {
    pub id: u64,
    pub order: DrawOrder,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: Bounds<ScaledPixels>,
    pub corner_radius: ScaledPixels,
    pub tint: Option<Rgba>,
    pub style: LiquidGlassStyle,
    pub group_id: Option<u64>,
    /// The native glass view's alpha, from 0 to 1. Regions with different alphas never merge.
    pub alpha: f32,
}

#[allow(missing_docs)]
impl LiquidGlassRegion {
    pub fn visible_bounds(&self) -> Bounds<ScaledPixels> {
        self.bounds.intersect(&self.content_mask)
    }

    pub fn is_clipped(&self) -> bool {
        self.visible_bounds() != self.bounds
    }
}

fn liquid_glass_cutouts(
    bounds: Bounds<ScaledPixels>,
    corner_radius: ScaledPixels,
) -> SmallVec<[Bounds<ScaledPixels>; 32]> {
    let mut cutouts = SmallVec::new();
    let (left, top) = (bounds.left().0, bounds.top().0);
    let (right, bottom) = (bounds.right().0, bounds.bottom().0);
    let radius = corner_radius
        .0
        .min((right - left) / 2.)
        .min((bottom - top) / 2.);
    if radius.is_nan() || radius < 1. {
        if !bounds.is_empty() {
            cutouts.push(bounds);
        }
        return cutouts;
    }
    let mut push = |top: f32, bottom: f32, inset: f32| {
        if bottom > top && right - inset > left + inset {
            cutouts.push(Bounds::from_corners(
                point(ScaledPixels(left + inset), ScaledPixels(top)),
                point(ScaledPixels(right - inset), ScaledPixels(bottom)),
            ));
        }
    };
    let rows = (0..radius.ceil() as u32).map(|row| {
        let distance = radius - row as f32;
        let inset = (radius - (radius * radius - distance * distance).max(0.).sqrt()).ceil();
        (row as f32, (row as f32 + 1.).min(radius), inset)
    });
    let mut bands: SmallVec<[(f32, f32, f32); 16]> = SmallVec::new();
    for (start, end, inset) in rows {
        match bands.last_mut() {
            Some(band) if band.2 == inset => band.1 = end,
            _ => bands.push((start, end, inset)),
        }
    }
    for &(start, end, inset) in &bands {
        push(top + start, top + end, inset);
        push(bottom - end, bottom - start, inset);
    }
    push(top + radius, bottom - radius, 0.);
    cutouts
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
#[expect(missing_docs)]
pub struct PathCurve {
    pub p0: Point<f32>,
    pub p1: Point<f32>,
    pub a: Point<f32>,
    pub b: Point<f32>,
    pub sign: f32,
    pub pad: u32, // align to 8 bytes
}

#[derive(Clone, Copy, Debug)]
#[repr(C)]
#[expect(missing_docs)]
pub struct PathPaint {
    /// The path's bounds, in device pixels.
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub color: Background,
    pub even_odd: PaddedBool32,
    pub pad: u32, // align to 8 bytes
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
#[expect(missing_docs)]
pub struct PathTile {
    pub paint: u32,
    pub curve_start: u32,
    pub curve_count: u32,
    pub backdrop: i32,
    pub top_left: Point<f32>,
    pub bottom_right: Point<f32>,
    pub reference: Point<f32>,
    pub curves_top_left: Point<f32>,
    pub curves_bottom_right: Point<f32>,
}

#[derive(Clone, Debug)]
#[expect(missing_docs)]
pub struct PaintedPath {
    order: DrawOrder,
    bounds: Bounds<ScaledPixels>,
    tiles: Rc<PathTiles>,
    paint: PathPaint,
}

#[expect(missing_docs)]
impl PaintedPath {
    /// Bins `path` into tiles, to be filled with `color` within `content_mask`.
    pub fn new(
        path: Path,
        scale_factor: f32,
        content_mask: ContentMask<Pixels>,
        color: Background,
    ) -> Self {
        Self::binned(path, scale_factor, content_mask.scale(scale_factor), color)
    }

    /// Bins `path`, given in device pixels, into tiles, to be filled with
    /// `color` within `content_mask`.
    pub(crate) fn in_device_pixels(
        path: Path,
        content_mask: ContentMask<ScaledPixels>,
        color: Background,
    ) -> Self {
        Self::binned(path, 1., content_mask, color)
    }

    fn binned(
        path: Path,
        scale_factor: f32,
        content_mask: ContentMask<ScaledPixels>,
        color: Background,
    ) -> Self {
        let mut tiles = path.bin(scale_factor);
        tiles.retain_visible(content_mask.bounds);
        let paint = PathPaint {
            bounds: tiles.bounds(),
            content_mask,
            color,
            even_odd: path.even_odd().into(),
            pad: 0,
        };
        Self {
            order: 0,
            bounds: tiles.painted_bounds(),
            tiles: Rc::new(tiles),
            paint,
        }
    }

    pub fn tile_count(&self) -> usize {
        self.tiles.tiles().len()
    }

    pub fn append_to(
        &self,
        paints: &mut Vec<PathPaint>,
        curves: &mut Vec<PathCurve>,
        tiles: &mut Vec<PathTile>,
    ) {
        let paint_index = paints.len() as u32;
        let curve_start = curves.len() as u32;
        paints.push(self.paint);
        curves.extend_from_slice(self.tiles.curves());
        tiles.extend(self.tiles.tiles().iter().map(|tile| PathTile {
            paint: paint_index,
            curve_start: curve_start + tile.curve_start,
            ..*tile
        }));
    }
}

impl From<PaintedPath> for Primitive {
    fn from(path: PaintedPath) -> Self {
        Primitive::Path(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{point, size};

    fn square(x: f32) -> Bounds<ScaledPixels> {
        Bounds {
            origin: point(ScaledPixels(x), ScaledPixels(0.)),
            size: size(ScaledPixels(10.), ScaledPixels(10.)),
        }
    }

    fn quad(x: f32) -> Quad {
        Quad {
            bounds: square(x),
            content_mask: ContentMask { bounds: square(x) },
            ..Default::default()
        }
    }

    fn underline(x: f32) -> Underline {
        Underline {
            order: 0,
            pad: 0,
            bounds: square(x),
            content_mask: ContentMask { bounds: square(x) },
            color: Hsla::default(),
            thickness: ScaledPixels(1.),
            wavy: false.into(),
        }
    }

    fn batch_labels(scene: &mut Scene) -> Vec<String> {
        scene.finish();
        scene.batches().map(|batch| batch.label()).collect()
    }

    #[test]
    fn a_native_view_in_a_layer_is_covered_by_what_the_layer_paints_after_it() {
        let mut scene = Scene::default();
        scene.push_layer();
        scene.insert_primitive(quad(0.));
        scene.insert_primitive(PaintNativeView::new(
            NativeViewId::for_test(1),
            HitboxId::placeholder(),
            square(0.),
            ContentMask { bounds: square(0.) },
            Hsla::default(),
        ));
        scene.insert_primitive(quad(0.));
        // A quad beside the view shares nothing with it, so it isn't held back.
        scene.insert_primitive(quad(20.));
        scene.pop_layer();
        assert_eq!(
            batch_labels(&mut scene),
            ["quads (1)", "native views (1)", "quads (2)"]
        );
    }

    #[test]
    fn a_native_view_painted_twice_is_kept_where_it_was_painted_first() {
        let native_view = |hitbox_id: HitboxId, x: f32| {
            PaintNativeView::new(
                NativeViewId::for_test(1),
                hitbox_id,
                square(x),
                ContentMask { bounds: square(x) },
                Hsla::default(),
            )
        };
        let first_hitbox = HitboxId::placeholder();
        let second_hitbox = first_hitbox.next();
        let mut scene = Scene::default();
        // The quad can't be drawn with the underline it covers, so the first
        // occurrence, painted over both, is drawn after the second, which
        // overlaps nothing.
        scene.insert_primitive(underline(0.));
        scene.insert_primitive(quad(0.));
        scene.insert_primitive(native_view(first_hitbox, 0.));
        scene.insert_primitive(native_view(second_hitbox, 20.));
        scene.finish();

        let shown = scene
            .native_views
            .iter()
            .map(|native_view| native_view.bounds)
            .collect::<Vec<_>>();
        assert_eq!(shown, [square(0.)]);
    }

    #[test]
    fn layers_are_drawn_in_paint_order() {
        // A quad painted after a layer goes above it.
        let mut scene = Scene::default();
        scene.insert_primitive(quad(0.));
        scene.push_layer();
        scene.insert_primitive(underline(0.));
        scene.insert_primitive(underline(5.));
        scene.pop_layer();
        scene.insert_primitive(quad(5.));
        assert_eq!(
            batch_labels(&mut scene),
            ["quads (1)", "underlines (2)", "quads (1)"]
        );

        // A layer goes above the layer painted before it.
        let mut scene = Scene::default();
        scene.push_layer();
        scene.insert_primitive(underline(0.));
        scene.pop_layer();
        scene.push_layer();
        scene.insert_primitive(quad(5.));
        scene.pop_layer();
        assert_eq!(batch_labels(&mut scene), ["underlines (1)", "quads (1)"]);
    }

    fn glass(id: u64, x: f32) -> LiquidGlassRegion {
        LiquidGlassRegion {
            id,
            order: 0,
            bounds: Bounds {
                origin: point(ScaledPixels(x), ScaledPixels(0.)),
                size: size(ScaledPixels(10.), ScaledPixels(10.)),
            },
            content_mask: Bounds {
                origin: point(ScaledPixels(-100.), ScaledPixels(-100.)),
                size: size(ScaledPixels(400.), ScaledPixels(400.)),
            },
            corner_radius: ScaledPixels(0.),
            tint: None,
            style: LiquidGlassStyle::Regular,
            group_id: None,
            alpha: 1.,
        }
    }

    fn native_view(id: u64, x: f32) -> PaintNativeView {
        PaintNativeView::new(
            NativeViewId::for_test(id),
            HitboxId::placeholder(),
            square(x),
            ContentMask { bounds: square(x) },
            Hsla::default(),
        )
    }

    #[test]
    fn liquid_glass_is_clipped_to_its_content_mask_and_dropped_when_unseen() {
        let mut scene = Scene::default();
        let mut hidden = glass(1, 0.);
        hidden.content_mask = square(50.);
        scene.insert_liquid_glass(hidden);
        let mut clipped = glass(3, 0.);
        clipped.content_mask = Bounds {
            origin: point(ScaledPixels(4.), ScaledPixels(0.)),
            size: size(ScaledPixels(100.), ScaledPixels(100.)),
        };
        scene.insert_liquid_glass(clipped);
        scene.finish();

        assert_eq!(
            scene
                .liquid_glass_regions
                .iter()
                .map(|region| region.id)
                .collect::<Vec<_>>(),
            [3]
        );
        let region = scene.liquid_glass_regions[0];
        assert!(region.is_clipped());
        assert_eq!(
            region.visible_bounds(),
            Bounds {
                origin: point(ScaledPixels(4.), ScaledPixels(0.)),
                size: size(ScaledPixels(6.), ScaledPixels(10.)),
            }
        );
        assert!(
            scene
                .native_views
                .iter()
                .all(|cutout| cutout.content_mask.bounds == clipped.content_mask)
        );
    }

    #[test]
    fn liquid_glass_erases_what_is_beneath_it_and_is_covered_by_what_follows() {
        let mut scene = Scene::default();
        scene.insert_primitive(quad(0.));
        scene.insert_liquid_glass(glass(1, 0.));
        scene.insert_primitive(quad(0.));
        scene.insert_primitive(quad(40.));
        assert_eq!(
            batch_labels(&mut scene),
            ["quads (2)", "native views (1)", "quads (1)"]
        );
        assert_eq!(scene.attached_native_views().count(), 0);
        assert!(
            scene
                .native_views
                .iter()
                .all(|cutout| cutout.order == scene.liquid_glass_regions[0].order)
        );
    }

    #[test]
    fn liquid_glass_stacks_with_native_views_in_paint_order() {
        let mut scene = Scene::default();
        scene.insert_liquid_glass(glass(1, 0.));
        scene.insert_primitive(native_view(7, 0.));
        scene.insert_liquid_glass(glass(2, 0.));
        scene.insert_liquid_glass(glass(3, 100.));
        scene.finish();

        let orders = scene
            .liquid_glass_regions
            .iter()
            .map(|region| (region.id, region.order))
            .collect::<Vec<_>>();
        let page = scene
            .attached_native_views()
            .map(|native_view| native_view.order)
            .collect::<Vec<_>>();
        assert_eq!(page.len(), 1);
        assert!(orders[0].1 <= page[0]);
        let over_page = orders
            .iter()
            .find(|(id, _)| *id == 2)
            .map(|(_, order)| *order);
        assert!(over_page > Some(page[0]));
        assert_eq!(
            orders
                .iter()
                .find(|(id, _)| *id == 3)
                .map(|(_, order)| *order),
            Some(1)
        );
    }

    #[test]
    fn liquid_glass_in_a_layer_keeps_its_place_in_paint_order() {
        let mut scene = Scene::default();
        scene.push_layer();
        scene.insert_primitive(quad(0.));
        scene.insert_liquid_glass(glass(1, 0.));
        scene.insert_primitive(quad(0.));
        scene.pop_layer();
        assert_eq!(
            batch_labels(&mut scene),
            ["quads (1)", "native views (1)", "quads (1)"]
        );
        assert_eq!(scene.liquid_glass_regions.len(), 1);
    }

    #[test]
    fn replaying_a_scene_places_its_liquid_glass_again() {
        let mut previous = Scene::default();
        previous.insert_primitive(quad(0.));
        previous.insert_liquid_glass(glass(5, 0.));
        previous.finish();

        let mut scene = Scene::default();
        scene.replay(0..previous.len(), &previous);
        scene.finish();
        assert_eq!(scene.liquid_glass_regions, previous.liquid_glass_regions);
        assert_eq!(scene.native_views.len(), previous.native_views.len());
    }

    #[test]
    fn liquid_glass_cutouts_cover_the_rounded_shape_from_inside() {
        let bounds = Bounds {
            origin: point(ScaledPixels(10.), ScaledPixels(20.)),
            size: size(ScaledPixels(120.), ScaledPixels(80.)),
        };
        let radius = 24.;
        let cutouts = liquid_glass_cutouts(bounds, ScaledPixels(radius));
        let inside = |x: f32, y: f32| {
            let (left, top) = (bounds.left().0, bounds.top().0);
            let (right, bottom) = (bounds.right().0, bounds.bottom().0);
            let cx = x.clamp(left + radius, right - radius);
            let cy = y.clamp(top + radius, bottom - radius);
            (x - cx).powi(2) + (y - cy).powi(2) <= radius * radius + 1e-3
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
        let shape = 120. * 80. - (4. - std::f32::consts::PI) * radius * radius;
        assert!(area > shape * 0.97, "{area} of {shape}");
        assert!(cutouts.len() < 40);

        let square = liquid_glass_cutouts(bounds, ScaledPixels(0.));
        assert_eq!(square.as_slice(), [bounds]);
    }

    #[test]
    fn nested_layers_are_drawn_above_their_parents() {
        // A layer has one draw order, so what it paints after a nested layer
        // still goes below that layer.
        let mut scene = Scene::default();
        scene.push_layer();
        scene.insert_primitive(underline(0.));
        scene.push_layer();
        scene.insert_primitive(quad(5.));
        scene.pop_layer();
        scene.insert_primitive(underline(5.));
        scene.pop_layer();
        assert_eq!(batch_labels(&mut scene), ["underlines (2)", "quads (1)"]);

        // The same holds when the nested layer shares its parent's order.
        let mut scene = Scene::default();
        scene.push_layer();
        scene.insert_primitive(quad(0.));
        scene.push_layer();
        scene.insert_primitive(quad(5.));
        scene.pop_layer();
        scene.insert_primitive(quad(8.));
        scene.pop_layer();
        assert_eq!(batch_labels(&mut scene), ["quads (3)"]);
        assert_eq!(
            scene
                .quads
                .iter()
                .map(|quad| quad.bounds)
                .collect::<Vec<_>>(),
            [square(0.), square(8.), square(5.)]
        );

        // A layer goes above the layers nested in the layer before it.
        let mut scene = Scene::default();
        scene.push_layer();
        scene.push_layer();
        scene.insert_primitive(underline(0.));
        scene.pop_layer();
        scene.pop_layer();
        scene.push_layer();
        scene.insert_primitive(quad(5.));
        scene.pop_layer();
        assert_eq!(batch_labels(&mut scene), ["underlines (1)", "quads (1)"]);
    }
}
