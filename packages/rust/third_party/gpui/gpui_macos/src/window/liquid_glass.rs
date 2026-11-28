use super::is_macos_version_at_least;
use gpui::{
    BackdropAppearance, Bounds, DrawOrder, LiquidGlassRegion, LiquidGlassStyle, Rgba, ScaledPixels,
};
use objc2::{
    class, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel},
    sel,
};
use objc2_app_kit::{
    NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
    NSColor, NSView, NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState,
    NSVisualEffectView, NSWindowOrderingMode,
};
use objc2_core_graphics::CGColor;
use objc2_foundation::{
    NSComparisonResult, NSOperatingSystemVersion, NSPoint, NSRect, NSSize, NSString,
};
use std::{
    cmp::Ordering,
    ffi::{CStr, c_void},
    ptr::{self, NonNull},
    sync::OnceLock,
};

const SPARE_VIEWS: usize = 8;
const SPARE_IDLE_SYNCS: u32 = 600;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct GroupKey {
    id: u64,
    alpha: u32,
    clip: [f64; 4],
    run: u32,
}

pub(super) fn liquid_glass_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        is_macos_version_at_least(NSOperatingSystemVersion {
            majorVersion: 26,
            minorVersion: 0,
            patchVersion: 0,
        }) && AnyClass::get(c"NSGlassEffectView").is_some()
    })
}

fn glass_groups_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        liquid_glass_available()
            && AnyClass::get(c"NSGlassEffectContainerView")
                .is_some_and(|class| class.instance_method(sel!(setContentView:)).is_some())
    })
}

pub(super) fn transparent_class(
    name: &'static CStr,
    superclass: &'static AnyClass,
) -> &'static AnyClass {
    let Some(mut builder) = ClassBuilder::new(name, superclass) else {
        return AnyClass::get(name).unwrap_or(superclass);
    };
    unsafe {
        builder.add_method(
            sel!(hitTest:),
            ignore_hit_test as extern "C" fn(_, Sel, NSPoint) -> *mut AnyObject,
        );
    }
    builder.register()
}

extern "C" fn ignore_hit_test(_: &AnyObject, _: Sel, _: NSPoint) -> *mut AnyObject {
    ptr::null_mut()
}

fn glass_class() -> &'static AnyClass {
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    CLASS.get_or_init(|| match AnyClass::get(c"NSGlassEffectView") {
        Some(glass) if liquid_glass_available() => transparent_class(c"GPUILiquidGlassView", glass),
        _ => transparent_class(c"GPUILiquidGlassVibrancyView", class!(NSVisualEffectView)),
    })
}

fn group_class() -> Option<&'static AnyClass> {
    static CLASS: OnceLock<Option<&'static AnyClass>> = OnceLock::new();
    *CLASS.get_or_init(|| {
        glass_groups_available()
            .then(|| AnyClass::get(c"NSGlassEffectContainerView"))
            .flatten()
            .map(|container| transparent_class(c"GPUILiquidGlassGroupView", container))
    })
}

fn slot_class() -> &'static AnyClass {
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    CLASS.get_or_init(|| transparent_class(c"GPUILiquidGlassSlotView", class!(NSView)))
}

pub(super) trait PoolOps<V, P> {
    fn create(&mut self) -> V;
    fn apply(&mut self, view: &V, placement: &P, previous: Option<&P>);
    fn show(&mut self, view: &V);
    fn hide(&mut self, view: &V);
    fn discard(&mut self, view: V);
}

struct PoolEntry<V, K, P> {
    view: V,
    key: Option<K>,
    applied: Option<P>,
    shown: bool,
    idle_syncs: u32,
}

pub(super) struct Pool<V, K, P> {
    entries: Vec<PoolEntry<V, K, P>>,
}

impl<V, K, P> Default for Pool<V, K, P> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
        }
    }
}

impl<V: Clone, K: Copy + PartialEq, P: Clone + PartialEq> Pool<V, K, P> {
    pub(super) fn sync(&mut self, wanted: &[(K, P)], ops: &mut impl PoolOps<V, P>) -> Vec<V> {
        let mut used = vec![false; self.entries.len()];
        let mut slots = Vec::with_capacity(wanted.len());
        for (key, _) in wanted {
            let unused_with_key =
                |index: &usize| !used[*index] && self.entries[*index].key.as_ref() == Some(key);
            let bound = (0..self.entries.len())
                .filter(unused_with_key)
                .find(|&index| self.entries[index].shown)
                .or_else(|| (0..self.entries.len()).find(unused_with_key));
            if let Some(index) = bound {
                used[index] = true;
            }
            slots.push(bound);
        }
        for (slot, (_, placement)) in slots.iter_mut().zip(wanted) {
            if slot.is_some() {
                continue;
            }
            let unused = |index: &usize| !used[*index];
            let index = (0..self.entries.len())
                .filter(unused)
                .find(|&index| self.entries[index].applied.as_ref() == Some(placement))
                .or_else(|| (0..self.entries.len()).find(unused))
                .unwrap_or_else(|| {
                    self.entries.push(PoolEntry {
                        view: ops.create(),
                        key: None,
                        applied: None,
                        shown: false,
                        idle_syncs: 0,
                    });
                    used.push(false);
                    self.entries.len() - 1
                });
            used[index] = true;
            *slot = Some(index);
        }
        for (entry, used) in self.entries.iter_mut().zip(&used) {
            if *used {
                continue;
            }
            if entry.shown {
                entry.shown = false;
                entry.idle_syncs = 0;
                ops.hide(&entry.view);
            } else {
                entry.idle_syncs = entry.idle_syncs.saturating_add(1);
            }
        }
        let mut views = Vec::with_capacity(wanted.len());
        for ((key, placement), index) in wanted.iter().zip(slots.into_iter().flatten()) {
            let entry = &mut self.entries[index];
            if entry.applied.as_ref() != Some(placement) {
                ops.apply(&entry.view, placement, entry.applied.as_ref());
                entry.applied = Some(placement.clone());
            }
            if !entry.shown {
                ops.show(&entry.view);
                entry.shown = true;
            }
            entry.key = Some(*key);
            entry.idle_syncs = 0;
            views.push(entry.view.clone());
        }
        let mut spares = 0;
        let mut index = 0;
        while index < self.entries.len() {
            let entry = &self.entries[index];
            if !entry.shown {
                if spares >= SPARE_VIEWS || entry.idle_syncs >= SPARE_IDLE_SYNCS {
                    ops.discard(self.entries.remove(index).view);
                    continue;
                }
                spares += 1;
            }
            index += 1;
        }
        views
    }

    pub(super) fn views(&self) -> impl Iterator<Item = &V> {
        self.entries.iter().map(|entry| &entry.view)
    }

    pub(super) fn is_idle(&self) -> bool {
        self.entries.iter().all(|entry| !entry.shown)
    }
}

fn is_finite(region: &LiquidGlassRegion) -> bool {
    let bounds = region.bounds;
    [
        bounds.origin.x,
        bounds.origin.y,
        bounds.size.width,
        bounds.size.height,
        region.corner_radius,
    ]
    .iter()
    .all(|value| value.0.is_finite())
}

fn native_alpha(region: &LiquidGlassRegion) -> f32 {
    if region.alpha.is_finite() {
        region.alpha.clamp(0., 1.)
    } else {
        1.
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct GlassPlacement {
    pub(super) frame: [f64; 4],
    pub(super) clip: Option<[f64; 4]>,
    pub(super) corner_radius: f64,
    pub(super) tint: Option<Rgba>,
    pub(super) style: LiquidGlassStyle,
    pub(super) group: Option<GroupKey>,
    pub(super) appearance: Option<BackdropAppearance>,
    pub(super) alpha: f64,
}

impl GlassPlacement {
    fn new(
        region: &LiquidGlassRegion,
        scale_factor: f64,
        gpui_frame: [f64; 4],
        group: Option<GroupKey>,
        appearance: Option<BackdropAppearance>,
    ) -> Self {
        let points = |value: ScaledPixels| f64::from(value) / scale_factor;
        let [gpui_x, gpui_y, _, gpui_height] = gpui_frame;
        let bounds = region.bounds;
        let (x, top) = (points(bounds.origin.x), points(bounds.origin.y));
        let (width, height) = (points(bounds.size.width), points(bounds.size.height));
        let y = gpui_y + gpui_height - top - height;
        let frame = match group {
            Some(GroupKey {
                clip: [clip_x, clip_y, _, _],
                ..
            }) => [gpui_x + x - clip_x, y - clip_y, width, height],
            None => [gpui_x + x, y, width, height],
        };
        let clip = (group.is_none() && region.is_clipped()).then(|| {
            let visible = region.visible_bounds();
            let visible_height = points(visible.size.height);
            [
                points(visible.origin.x) - x,
                top + height - points(visible.origin.y) - visible_height,
                points(visible.size.width),
                visible_height,
            ]
        });
        Self {
            frame,
            clip,
            corner_radius: points(region.corner_radius),
            tint: region.tint,
            style: region.style,
            group,
            appearance,
            alpha: match group {
                Some(_) => 1.,
                None => f64::from(native_alpha(region)),
            },
        }
    }
}

#[derive(Default, Debug, PartialEq)]
pub(super) struct GlassLayout {
    regions: Vec<(u64, DrawOrder, GlassPlacement)>,
    groups: Vec<(GroupKey, DrawOrder)>,
}

type AlphaGroup = (u64, u32, [f64; 4]);

fn clip_frame(
    content_mask: Bounds<ScaledPixels>,
    scale_factor: f64,
    [gpui_x, gpui_y, _, gpui_height]: [f64; 4],
) -> [f64; 4] {
    let points = |value: ScaledPixels| f64::from(value) / scale_factor;
    let height = points(content_mask.size.height);
    [
        gpui_x + points(content_mask.origin.x),
        gpui_y + gpui_height - points(content_mask.origin.y) - height,
        points(content_mask.size.width),
        height,
    ]
}

#[derive(Default)]
struct GroupRuns(Vec<(AlphaGroup, u32, Vec<Bounds<ScaledPixels>>)>);

impl GroupRuns {
    fn close_under(&mut self, bounds: &Bounds<ScaledPixels>, group: Option<AlphaGroup>) {
        for (id, run, members) in &mut self.0 {
            if Some(*id) != group && members.iter().any(|member| member.intersects(bounds)) {
                members.clear();
                *run += 1;
            }
        }
    }

    fn join(&mut self, group: AlphaGroup, bounds: Bounds<ScaledPixels>) -> GroupKey {
        let (id, alpha, clip) = group;
        let run = match self.0.iter_mut().find(|(joined, _, _)| *joined == group) {
            Some((_, run, members)) => {
                members.push(bounds);
                *run
            }
            None => {
                self.0.push((group, 0, vec![bounds]));
                0
            }
        };
        GroupKey {
            id,
            alpha,
            clip,
            run,
        }
    }
}

impl GlassLayout {
    pub(super) fn new(
        regions: &[LiquidGlassRegion],
        occluders: impl IntoIterator<Item = (DrawOrder, Bounds<ScaledPixels>)>,
        scale_factor: f64,
        gpui_frame: [f64; 4],
        appearance: Option<BackdropAppearance>,
    ) -> Self {
        Self::with_groups(
            regions,
            occluders,
            scale_factor,
            gpui_frame,
            appearance,
            group_class().is_some(),
        )
    }

    pub(super) fn with_groups(
        regions: &[LiquidGlassRegion],
        occluders: impl IntoIterator<Item = (DrawOrder, Bounds<ScaledPixels>)>,
        scale_factor: f64,
        gpui_frame: [f64; 4],
        appearance: Option<BackdropAppearance>,
        groups_available: bool,
    ) -> Self {
        let mut layout = Self::default();
        let mut runs = GroupRuns::default();
        let mut occluders = occluders.into_iter().peekable();
        for region in regions.iter().filter(|region| is_finite(region)) {
            while let Some((_, bounds)) = occluders.next_if(|(order, _)| *order < region.order) {
                runs.close_under(&bounds, None);
            }
            let visible = region.visible_bounds();
            let group = region.group_id.filter(|_| groups_available).map(|group| {
                (
                    group,
                    native_alpha(region).to_bits(),
                    clip_frame(region.content_mask, scale_factor, gpui_frame),
                )
            });
            runs.close_under(&visible, group);
            let group = group.map(|group| runs.join(group, visible));
            if let Some(group) = group {
                match layout.groups.iter_mut().find(|(key, _)| *key == group) {
                    Some((_, order)) => *order = (*order).max(region.order),
                    None => layout.groups.push((group, region.order)),
                }
            }
            layout.regions.push((
                region.id,
                region.order,
                GlassPlacement::new(region, scale_factor, gpui_frame, group, appearance),
            ));
        }
        layout
    }

    pub(super) fn is_empty(&self) -> bool {
        self.regions.is_empty()
    }

    pub(super) fn units<V: Clone>(&self, views: &[V], containers: &[V]) -> Vec<(DrawOrder, V)> {
        let mut units = self
            .regions
            .iter()
            .zip(views)
            .filter(|((_, _, placement), _)| placement.group.is_none())
            .map(|((_, order, _), view)| (*order, view.clone()))
            .chain(
                self.groups
                    .iter()
                    .zip(containers)
                    .map(|((_, order), container)| (*order, container.clone())),
            )
            .collect::<Vec<_>>();
        units.sort_by_key(|(order, _)| *order);
        units
    }
}

#[derive(Default)]
pub(super) struct GlassHost {
    views: Pool<Retained<NSView>, u64, GlassPlacement>,
    groups: Pool<Retained<NSView>, GroupKey, ([f64; 4], f64)>,
    slot_members: Vec<Vec<*const NSView>>,
}

impl GlassHost {
    pub(super) fn sync(
        &mut self,
        layout: &GlassLayout,
        host: &NSView,
        gpui_view: &NSView,
    ) -> Vec<(DrawOrder, Retained<NSView>)> {
        let group_frames = layout
            .groups
            .iter()
            .map(|(group, _)| (*group, (group.clip, f64::from(f32::from_bits(group.alpha)))))
            .collect::<Vec<_>>();
        let containers = self
            .groups
            .sync(&group_frames, &mut GroupOps { host, gpui_view });
        let slots = layout
            .groups
            .iter()
            .zip(&containers)
            .filter_map(|((group, _), container)| {
                let slot: Option<Retained<NSView>> =
                    unsafe { msg_send![&**container, contentView] };
                Some((*group, slot?))
            })
            .collect::<Vec<_>>();
        let wanted = layout
            .regions
            .iter()
            .map(|(id, _, placement)| (*id, *placement))
            .collect::<Vec<_>>();
        let views = self.views.sync(
            &wanted,
            &mut GlassOps {
                host,
                gpui_view,
                slots: &slots,
            },
        );
        let slot_members = slots
            .iter()
            .map(|(group, _)| {
                layout
                    .regions
                    .iter()
                    .zip(&views)
                    .filter(|((_, _, placement), _)| placement.group == Some(*group))
                    .map(|(_, view)| Retained::as_ptr(view))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        if slot_members != self.slot_members {
            for ((_, slot), members) in slots.iter().zip(&slot_members) {
                order_slot(slot, members);
            }
            self.slot_members = slot_members;
        }
        layout.units(&views, &containers)
    }

    pub(super) fn is_idle(&self) -> bool {
        self.views.is_idle() && self.groups.is_idle()
    }

    pub(super) fn owned_views(&self) -> impl Iterator<Item = &Retained<NSView>> {
        self.groups.views().chain(self.views.views())
    }

    pub(super) fn remove(self) {
        for view in self.owned_views() {
            view.removeFromSuperview();
        }
    }
}

fn is_subview(parent: &NSView, view: &NSView) -> bool {
    unsafe { view.superview() }.is_some_and(|superview| ptr::eq(&*superview, parent))
}

fn is_below(host: &NSView, view: &NSView, gpui_view: &NSView) -> bool {
    if !is_subview(host, view) || !is_subview(host, gpui_view) {
        return false;
    }
    for subview in host.subviews().iter() {
        if ptr::eq(&*subview, view) {
            return true;
        }
        if ptr::eq(&*subview, gpui_view) {
            return false;
        }
    }
    false
}

fn order_slot(slot: &NSView, members: &[*const NSView]) {
    let current = slot
        .subviews()
        .iter()
        .map(|view| Retained::as_ptr(&view))
        .collect::<Vec<_>>();
    let in_order = current
        .iter()
        .filter(|view| members.contains(view))
        .eq(members.iter());
    if in_order {
        return;
    }
    let mut ranking = (members, current);
    unsafe {
        slot.sortSubviewsUsingFunction_context(compare_slot_order, (&raw mut ranking).cast());
    }
}

unsafe extern "C-unwind" fn compare_slot_order(
    first: NonNull<NSView>,
    second: NonNull<NSView>,
    ranking: *mut c_void,
) -> NSComparisonResult {
    let (members, current) = unsafe { &*ranking.cast::<(&[*const NSView], Vec<*const NSView>)>() };
    let rank = |view: NonNull<NSView>| {
        let view = view.as_ptr().cast_const();
        match members.iter().position(|member| *member == view) {
            Some(index) => (1, index),
            None => (
                0,
                current
                    .iter()
                    .position(|current| *current == view)
                    .unwrap_or_default(),
            ),
        }
    };
    match rank(first).cmp(&rank(second)) {
        Ordering::Less => NSComparisonResult::Ascending,
        Ordering::Equal => NSComparisonResult::Same,
        Ordering::Greater => NSComparisonResult::Descending,
    }
}

struct GlassOps<'a> {
    host: &'a NSView,
    gpui_view: &'a NSView,
    slots: &'a [(GroupKey, Retained<NSView>)],
}

impl PoolOps<Retained<NSView>, GlassPlacement> for GlassOps<'_> {
    fn create(&mut self) -> Retained<NSView> {
        let frame = NSRect::new(NSPoint::new(0., 0.), NSSize::new(0., 0.));
        let view: Retained<NSView> =
            unsafe { msg_send![msg_send![glass_class(), alloc], initWithFrame: frame] };
        view.setWantsLayer(true);
        view.setHidden(true);
        if let Some(vibrancy) = view.downcast_ref::<NSVisualEffectView>() {
            vibrancy.setMaterial(NSVisualEffectMaterial::Sidebar);
            vibrancy.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
            vibrancy.setState(NSVisualEffectState::FollowsWindowActiveState);
        }
        view
    }

    fn apply(
        &mut self,
        view: &Retained<NSView>,
        placement: &GlassPlacement,
        previous: Option<&GlassPlacement>,
    ) {
        let slot = placement
            .group
            .and_then(|group| self.slots.iter().find(|(id, _)| *id == group));
        let placed = match slot {
            Some((_, slot)) => is_subview(slot, view),
            None => is_below(self.host, view, self.gpui_view),
        };
        if !placed {
            note("add");
            match slot {
                Some((_, slot)) => slot.addSubview(view),
                None => self.host.addSubview_positioned_relativeTo(
                    view,
                    NSWindowOrderingMode::Below,
                    Some(self.gpui_view),
                ),
            }
        }
        if previous.is_none_or(|previous| previous.frame != placement.frame) {
            note("frame");
            view.setFrame(rect(placement.frame));
        }
        if previous.is_none_or(|previous| previous.appearance != placement.appearance) {
            note("appearance");
            view.setAppearance(appearance(placement.appearance).as_deref());
        }
        if previous.is_none_or(|previous| {
            previous.clip != placement.clip || previous.frame != placement.frame
        }) {
            note("clip");
            set_clip(view, placement.clip);
        }
        if previous.is_none_or(|previous| previous.alpha != placement.alpha) {
            note("alpha");
            view.setAlphaValue(placement.alpha);
        }
        if previous.is_none_or(|previous| {
            previous.corner_radius != placement.corner_radius
                || previous.tint != placement.tint
                || previous.style != placement.style
                || previous.frame != placement.frame
        }) {
            note("style");
            style_glass(view, placement);
        }
    }

    fn show(&mut self, view: &Retained<NSView>) {
        note("show");
        view.setHidden(false);
    }

    fn hide(&mut self, view: &Retained<NSView>) {
        note("hide");
        view.setHidden(true);
    }

    fn discard(&mut self, view: Retained<NSView>) {
        view.removeFromSuperview();
    }
}

struct GroupOps<'a> {
    host: &'a NSView,
    gpui_view: &'a NSView,
}

impl PoolOps<Retained<NSView>, ([f64; 4], f64)> for GroupOps<'_> {
    fn create(&mut self) -> Retained<NSView> {
        let frame = NSRect::new(NSPoint::new(0., 0.), NSSize::new(0., 0.));
        let class = group_class().unwrap_or(slot_class());
        unsafe {
            let container: Retained<NSView> =
                msg_send![msg_send![class, alloc], initWithFrame: frame];
            let slot: Retained<NSView> =
                msg_send![msg_send![slot_class(), alloc], initWithFrame: frame];
            if group_class().is_some() {
                let _: () = msg_send![&*container, setContentView: &*slot];
            }
            container.setWantsLayer(true);
            let _: () = msg_send![&*container, setClipsToBounds: true];
            container.setHidden(true);
            container
        }
    }

    fn apply(
        &mut self,
        container: &Retained<NSView>,
        (frame, alpha): &([f64; 4], f64),
        previous: Option<&([f64; 4], f64)>,
    ) {
        if !is_below(self.host, container, self.gpui_view) {
            note("group add");
            self.host.addSubview_positioned_relativeTo(
                container,
                NSWindowOrderingMode::Below,
                Some(self.gpui_view),
            );
        }
        if previous.is_none_or(|(previous, _)| previous != frame) {
            note("group frame");
            container.setFrame(rect(*frame));
            let slot: Option<Retained<NSView>> = unsafe { msg_send![&**container, contentView] };
            if let Some(slot) = slot {
                slot.setFrame(container.bounds());
            }
        }
        if previous.is_none_or(|(_, previous)| previous != alpha) {
            note("group alpha");
            container.setAlphaValue(*alpha);
        }
    }

    fn show(&mut self, container: &Retained<NSView>) {
        note("group show");
        container.setHidden(false);
    }

    fn hide(&mut self, container: &Retained<NSView>) {
        note("group hide");
        container.setHidden(true);
    }

    fn discard(&mut self, container: Retained<NSView>) {
        container.removeFromSuperview();
    }
}

#[cfg(test)]
thread_local! {
    static NATIVE_CALLS: std::cell::RefCell<Vec<&'static str>> = const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(test)]
fn note(call: &'static str) {
    NATIVE_CALLS.with_borrow_mut(|calls| calls.push(call));
}

#[cfg(not(test))]
fn note(_: &'static str) {}

fn rect([x, y, width, height]: [f64; 4]) -> NSRect {
    NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
}

pub(super) fn appearance(appearance: Option<BackdropAppearance>) -> Option<Retained<NSAppearance>> {
    let name = unsafe {
        match appearance? {
            BackdropAppearance::Light => NSAppearanceNameAqua,
            BackdropAppearance::Dark => NSAppearanceNameDarkAqua,
        }
    };
    NSAppearance::appearanceNamed(name)
}

pub(super) fn ns_color(color: Rgba, display_p3: bool) -> Retained<NSColor> {
    let channel = |value: f32| f64::from(value.clamp(0., 1.));
    let (red, green, blue, alpha) = (
        channel(color.r),
        channel(color.g),
        channel(color.b),
        channel(color.a),
    );
    if display_p3 {
        NSColor::colorWithDisplayP3Red_green_blue_alpha(red, green, blue, alpha)
    } else {
        NSColor::colorWithSRGBRed_green_blue_alpha(red, green, blue, alpha)
    }
}

pub(super) unsafe fn set_layer_color(layer: &AnyObject, color: Option<&NSColor>) {
    unsafe {
        let cg_color: *const CGColor = match color {
            Some(color) => msg_send![color, CGColor],
            None => ptr::null(),
        };
        let _: () = msg_send![layer, setBackgroundColor: cg_color];
    }
}

pub(super) unsafe fn new_layer() -> Retained<AnyObject> {
    unsafe { msg_send![class!(CALayer), layer] }
}

fn layer_of(view: &NSView) -> Option<Retained<AnyObject>> {
    unsafe { msg_send![view, layer] }
}

fn set_clip(view: &NSView, clip: Option<[f64; 4]>) {
    let Some(layer) = layer_of(view) else {
        return;
    };
    unsafe {
        match clip {
            Some(clip) => {
                let mask = new_layer();
                let _: () = msg_send![&*mask, setFrame: rect(clip)];
                set_layer_color(&mask, Some(&NSColor::blackColor()));
                let _: () = msg_send![&*layer, setMask: &*mask];
            }
            None => {
                let _: () = msg_send![&*layer, setMask: ptr::null::<AnyObject>()];
            }
        }
    }
}

const TINT_LAYER: &str = "gpui.glass.tint";

fn style_glass(view: &NSView, placement: &GlassPlacement) {
    let responds =
        |selector: Sel| -> bool { unsafe { msg_send![view, respondsToSelector: selector] } };
    let tint = placement.tint.map(|tint| ns_color(tint, false));
    if view.downcast_ref::<NSVisualEffectView>().is_none() {
        unsafe {
            if responds(sel!(setCornerRadius:)) {
                let _: () = msg_send![view, setCornerRadius: placement.corner_radius];
            }
            if responds(sel!(setTintColor:)) {
                let _: () = msg_send![view, setTintColor: tint.as_deref()];
            }
            if responds(sel!(setStyle:)) {
                let style: isize = match placement.style {
                    LiquidGlassStyle::Regular => 0,
                    LiquidGlassStyle::Clear => 1,
                };
                let _: () = msg_send![view, setStyle: style];
            }
        }
        return;
    }
    let Some(layer) = layer_of(view) else {
        return;
    };
    unsafe {
        let _: () = msg_send![&*layer, setCornerRadius: placement.corner_radius];
        let _: () = msg_send![&*layer, setCornerCurve: &*NSString::from_str("continuous")];
        let _: () = msg_send![&*layer, setMasksToBounds: Bool::new(placement.corner_radius > 0.)];
        let name = NSString::from_str(TINT_LAYER);
        let sublayers: Option<Retained<objc2_foundation::NSArray<AnyObject>>> =
            msg_send![&*layer, sublayers];
        let existing = sublayers.and_then(|sublayers| {
            sublayers.iter().find(|sublayer| {
                let sublayer_name: Option<Retained<NSString>> = msg_send![&**sublayer, name];
                sublayer_name.is_some_and(|sublayer_name| sublayer_name.isEqualToString(&name))
            })
        });
        let tint_layer = match existing {
            Some(existing) => existing,
            None => {
                let tint_layer = new_layer();
                let _: () = msg_send![&*tint_layer, setName: &*name];
                let _: () = msg_send![&*layer, addSublayer: &*tint_layer];
                tint_layer
            }
        };
        let [_, _, width, height] = placement.frame;
        let _: () = msg_send![&*tint_layer, setFrame: rect([0., 0., width, height])];
        set_layer_color(&tint_layer, tint.as_deref());
    }
}

pub(super) fn with_disabled_actions<R>(f: impl FnOnce() -> R) -> R {
    unsafe {
        let _: () = msg_send![class!(CATransaction), begin];
        let _: () = msg_send![class!(CATransaction), setDisableActions: Bool::YES];
    }
    let result = f();
    unsafe {
        let _: () = msg_send![class!(CATransaction), commit];
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{Bounds, point, size};
    use std::cell::RefCell;

    #[derive(Default)]
    struct Recorder {
        next: u32,
        log: RefCell<Vec<String>>,
    }

    impl PoolOps<u32, &'static str> for Recorder {
        fn create(&mut self) -> u32 {
            self.next += 1;
            self.log.borrow_mut().push(format!("create {}", self.next));
            self.next
        }

        fn apply(&mut self, view: &u32, placement: &&'static str, previous: Option<&&'static str>) {
            self.log
                .borrow_mut()
                .push(format!("apply {view} {placement} from {previous:?}"));
        }

        fn show(&mut self, view: &u32) {
            self.log.borrow_mut().push(format!("show {view}"));
        }

        fn hide(&mut self, view: &u32) {
            self.log.borrow_mut().push(format!("hide {view}"));
        }

        fn discard(&mut self, view: u32) {
            self.log.borrow_mut().push(format!("discard {view}"));
        }
    }

    fn take_log(recorder: &Recorder) -> Vec<String> {
        recorder.log.take()
    }

    #[test]
    fn pool_reuses_views_by_key_and_applies_only_changes() {
        let mut pool = Pool::<u32, u64, &'static str>::default();
        let mut ops = Recorder::default();
        assert_eq!(pool.sync(&[(1, "a"), (2, "b")], &mut ops), [1, 2]);
        assert_eq!(
            take_log(&ops),
            [
                "create 1",
                "create 2",
                "apply 1 a from None",
                "show 1",
                "apply 2 b from None",
                "show 2"
            ]
        );

        assert_eq!(pool.sync(&[(2, "b"), (1, "a")], &mut ops), [2, 1]);
        assert_eq!(take_log(&ops), [] as [String; 0]);

        assert_eq!(pool.sync(&[(1, "moved")], &mut ops), [1]);
        assert_eq!(take_log(&ops), ["hide 2", "apply 1 moved from Some(\"a\")"]);
    }

    #[test]
    fn pool_rebinds_hidden_views_before_creating_new_ones() {
        let mut pool = Pool::<u32, u64, &'static str>::default();
        let mut ops = Recorder::default();
        pool.sync(&[(1, "a"), (2, "b")], &mut ops);
        pool.sync(&[], &mut ops);
        take_log(&ops);

        assert_eq!(pool.sync(&[(3, "c")], &mut ops), [1]);
        assert_eq!(take_log(&ops), ["apply 1 c from Some(\"a\")", "show 1"]);
    }

    #[test]
    fn pool_reshows_a_hidden_view_without_reapplying_its_placement() {
        let mut pool = Pool::<u32, u64, &'static str>::default();
        let mut ops = Recorder::default();
        pool.sync(&[(1, "a"), (2, "b"), (3, "c")], &mut ops);
        pool.sync(&[(1, "a")], &mut ops);
        assert_eq!(take_log(&ops)[9..], ["hide 2", "hide 3"]);
        assert!(!pool.is_idle());

        assert_eq!(
            pool.sync(&[(3, "c"), (1, "a"), (2, "b")], &mut ops),
            [3, 1, 2]
        );
        assert_eq!(take_log(&ops), ["show 3", "show 2"]);

        pool.sync(&[], &mut ops);
        assert!(pool.is_idle());
        take_log(&ops);
        assert_eq!(pool.sync(&[(8, "b"), (9, "z")], &mut ops), [2, 1]);
        assert_eq!(
            take_log(&ops),
            ["show 2", "apply 1 z from Some(\"a\")", "show 1"]
        );
    }

    #[test]
    fn pool_discards_spare_views_left_idle_too_long() {
        let mut pool = Pool::<u32, u64, &'static str>::default();
        let mut ops = Recorder::default();
        pool.sync(&[(1, "a"), (2, "b")], &mut ops);
        pool.sync(&[(1, "a")], &mut ops);
        take_log(&ops);

        for _ in 1..SPARE_IDLE_SYNCS {
            pool.sync(&[(1, "a")], &mut ops);
        }
        assert_eq!(take_log(&ops), [] as [String; 0]);
        assert_eq!(pool.views().count(), 2);

        pool.sync(&[(1, "a")], &mut ops);
        assert_eq!(take_log(&ops), ["discard 2"]);
        assert_eq!(pool.views().collect::<Vec<_>>(), [&1]);

        for _ in 0..SPARE_IDLE_SYNCS {
            pool.sync(&[], &mut ops);
        }
        pool.sync(&[(1, "a")], &mut ops);
        assert_eq!(take_log(&ops), ["hide 1", "show 1"]);
    }

    #[test]
    fn pool_rebinds_a_stale_view_from_its_previous_placement() {
        let mut pool = Pool::<u32, u64, &'static str>::default();
        let mut ops = Recorder::default();
        pool.sync(&[(1, "a")], &mut ops);
        take_log(&ops);

        assert_eq!(pool.sync(&[(9, "a")], &mut ops), [1]);
        assert_eq!(take_log(&ops), [] as [String; 0]);
    }

    #[test]
    fn pool_gives_duplicate_keys_their_own_views() {
        let mut pool = Pool::<u32, u64, &'static str>::default();
        let mut ops = Recorder::default();
        assert_eq!(pool.sync(&[(7, "a"), (7, "b")], &mut ops), [1, 2]);
        take_log(&ops);
        assert_eq!(pool.sync(&[(7, "a"), (7, "b")], &mut ops), [1, 2]);
        assert_eq!(take_log(&ops), [] as [String; 0]);
    }

    #[test]
    fn pool_keeps_a_few_spare_views_and_discards_the_rest() {
        let mut pool = Pool::<u32, u64, &'static str>::default();
        let mut ops = Recorder::default();
        let wanted = (0..12).map(|key| (key, "x")).collect::<Vec<_>>();
        pool.sync(&wanted, &mut ops);
        take_log(&ops);

        pool.sync(&[], &mut ops);
        let log = take_log(&ops);
        assert_eq!(
            log.iter().filter(|entry| entry.starts_with("hide")).count(),
            12
        );
        assert_eq!(
            log.iter()
                .filter(|entry| entry.starts_with("discard"))
                .count(),
            12 - SPARE_VIEWS
        );
        assert_eq!(pool.views().count(), SPARE_VIEWS);
    }

    const WINDOW_CLIP: [f64; 4] = [0., 300., 400., 300.];

    fn group_key(id: u64, alpha: f32, run: u32) -> GroupKey {
        GroupKey {
            id,
            alpha: alpha.to_bits(),
            clip: WINDOW_CLIP,
            run,
        }
    }

    fn opaque_group(id: u64, run: u32) -> GroupKey {
        group_key(id, 1., run)
    }

    fn region(id: u64, order: DrawOrder, x: f32, group_id: Option<u64>) -> LiquidGlassRegion {
        let bounds = Bounds {
            origin: point(ScaledPixels(x), ScaledPixels(40.)),
            size: size(ScaledPixels(100.), ScaledPixels(60.)),
        };
        LiquidGlassRegion {
            id,
            order,
            bounds,
            content_mask: Bounds {
                origin: point(ScaledPixels(0.), ScaledPixels(0.)),
                size: size(ScaledPixels(800.), ScaledPixels(600.)),
            },
            corner_radius: ScaledPixels(20.),
            tint: None,
            style: LiquidGlassStyle::Regular,
            group_id,
            alpha: 1.,
        }
    }

    #[test]
    fn placement_converts_device_pixels_to_flipped_points() {
        let gpui_frame = [0., 10., 400., 300.];
        let placement = GlassPlacement::new(&region(1, 1, 60., None), 2., gpui_frame, None, None);
        assert_eq!(placement.frame, [30., 260., 50., 30.]);
        assert_eq!(placement.corner_radius, 10.);
        assert_eq!(placement.clip, None);

        let grouped = GlassPlacement::new(
            &region(1, 1, 60., Some(4)),
            2.,
            gpui_frame,
            Some(GroupKey {
                clip: [0., 10., 400., 300.],
                ..opaque_group(4, 0)
            }),
            None,
        );
        assert_eq!(grouped.frame, [30., 250., 50., 30.]);
        assert_eq!(grouped.clip, None);
    }

    #[test]
    fn placement_masks_the_part_clipped_by_the_content_mask() {
        let mut clipped = region(1, 1, 60., None);
        clipped.content_mask = Bounds {
            origin: point(ScaledPixels(80.), ScaledPixels(60.)),
            size: size(ScaledPixels(800.), ScaledPixels(600.)),
        };
        let placement = GlassPlacement::new(&clipped, 2., [0., 0., 400., 300.], None, None);
        assert_eq!(placement.frame, [30., 250., 50., 30.]);
        assert_eq!(placement.clip, Some([10., 0., 40., 20.]));
    }

    fn sidebar_mask() -> Bounds<ScaledPixels> {
        Bounds {
            origin: point(ScaledPixels(20.), ScaledPixels(10.)),
            size: size(ScaledPixels(280.), ScaledPixels(500.)),
        }
    }

    fn masked(region: LiquidGlassRegion, content_mask: Bounds<ScaledPixels>) -> LiquidGlassRegion {
        LiquidGlassRegion {
            content_mask,
            ..region
        }
    }

    #[test]
    fn layout_splits_a_group_whose_members_have_different_content_masks() {
        let regions = [
            masked(region(1, 1, 0., Some(9)), sidebar_mask()),
            masked(region(2, 2, 240., Some(9)), sidebar_mask()),
            region(3, 3, 400., Some(9)),
        ];
        let layout = GlassLayout::with_groups(&regions, [], 2., [0., 0., 400., 300.], None, true);
        assert_eq!(layout.groups.len(), 2);
        let groups = layout
            .regions
            .iter()
            .map(|(_, _, placement)| placement.group)
            .collect::<Vec<_>>();
        assert_eq!(groups[0], groups[1]);
        assert_ne!(groups[1], groups[2]);
    }

    #[test]
    fn a_glass_group_is_clipped_to_its_members_content_mask() {
        let mut fixture = GlassFixture::new();
        if group_class().is_none() {
            return;
        }
        let regions = [
            masked(region(1, 1, 0., Some(9)), sidebar_mask()),
            masked(region(2, 2, 240., Some(9)), sidebar_mask()),
        ];
        let layout = GlassLayout::new(&regions, [], 2., [0., 0., 400., 300.], None);
        let units = with_disabled_actions(|| {
            fixture
                .glass
                .sync(&layout, &fixture.host, &fixture.gpui_view)
        });
        assert_eq!(units.len(), 1);
        let (_, container) = &units[0];
        let frame = container.frame();
        assert_eq!(
            [
                frame.origin.x,
                frame.origin.y,
                frame.size.width,
                frame.size.height
            ],
            [10., 45., 140., 250.]
        );
        let clips: Bool = unsafe { msg_send![&**container, clipsToBounds] };
        assert!(clips.as_bool());
        let slot: Retained<NSView> = unsafe { msg_send![&**container, contentView] };
        assert_eq!(slot.frame().size.width, 140.);
        let members = slot
            .subviews()
            .iter()
            .map(|member| {
                let frame = member.frame();
                [
                    frame.origin.x,
                    frame.origin.y,
                    frame.size.width,
                    frame.size.height,
                ]
            })
            .collect::<Vec<_>>();
        assert_eq!(members, [[-10., 205., 50., 30.], [110., 205., 50., 30.]]);
        fixture.glass.remove();
    }

    #[test]
    fn layout_groups_regions_and_orders_units_by_draw_order() {
        let regions = [
            region(1, 3, 0., Some(9)),
            region(2, 1, 200., None),
            region(3, 5, 400., Some(9)),
            region(4, 4, 600., None),
        ];
        let layout = GlassLayout::with_groups(&regions, [], 2., [0., 0., 800., 600.], None, true);
        assert_eq!(layout.groups, [(opaque_group(9, 0), 5)]);
        let views = ["one", "two", "three", "four"];
        assert_eq!(
            layout.units(&views, &["group"]),
            [(1, "two"), (4, "four"), (5, "group")]
        );

        let mut broken = region(5, 6, 0., None);
        broken.bounds.size.width = ScaledPixels(f32::NAN);
        let with_broken = [regions[1], broken];
        let layout_without_broken =
            GlassLayout::with_groups(&with_broken, [], 2., [0., 0., 800., 600.], None, true);
        assert_eq!(layout_without_broken.regions.len(), 1);

        let ungrouped =
            GlassLayout::with_groups(&regions, [], 2., [0., 0., 800., 600.], None, false);
        assert!(ungrouped.groups.is_empty());
        assert_eq!(
            ungrouped.units(&views, &[]),
            [(1, "two"), (3, "one"), (4, "four"), (5, "three")]
        );
    }

    #[test]
    fn layout_splits_a_group_around_what_is_painted_between_overlapping_members() {
        let frame = [0., 0., 800., 600.];
        let page = |x: f32| Bounds {
            origin: point(ScaledPixels(x), ScaledPixels(0.)),
            size: size(ScaledPixels(150.), ScaledPixels(600.)),
        };
        let regions = [region(1, 1, 0., Some(9)), region(2, 3, 120., Some(9))];

        let split = GlassLayout::with_groups(&regions, [(2, page(50.))], 2., frame, None, true);
        assert_eq!(
            split.groups,
            [(opaque_group(9, 0), 1), (opaque_group(9, 1), 3)]
        );
        assert_eq!(
            split.units(&["first", "second"], &["lower", "upper"]),
            [(1, "lower"), (3, "upper")]
        );

        let apart = GlassLayout::with_groups(&regions, [(2, page(400.))], 2., frame, None, true);
        assert_eq!(apart.groups, [(opaque_group(9, 0), 3)]);

        let tied = GlassLayout::with_groups(&regions, [(3, page(50.))], 2., frame, None, true);
        assert_eq!(tied.groups, [(opaque_group(9, 0), 3)]);

        let between = [
            region(1, 1, 0., Some(9)),
            region(3, 2, 40., None),
            region(2, 3, 120., Some(9)),
        ];
        let split_by_glass = GlassLayout::with_groups(&between, [], 2., frame, None, true);
        assert_eq!(
            split_by_glass.groups,
            [(opaque_group(9, 0), 1), (opaque_group(9, 1), 3)]
        );
    }

    #[test]
    fn layout_keeps_differing_alphas_in_separate_groups() {
        let frame = [0., 0., 800., 600.];
        let faint = |id, order, x, group_id| LiquidGlassRegion {
            alpha: 0.5,
            ..region(id, order, x, group_id)
        };
        let regions = [
            region(1, 1, 0., Some(9)),
            faint(2, 2, 120., Some(9)),
            faint(3, 3, 240., Some(9)),
            faint(4, 4, 400., None),
            LiquidGlassRegion {
                alpha: f32::NAN,
                ..region(5, 5, 600., None)
            },
            LiquidGlassRegion {
                alpha: 3.,
                ..region(6, 6, 600., None)
            },
        ];
        let layout = GlassLayout::with_groups(&regions, [], 2., frame, None, true);
        let faint_group = group_key(9, 0.5, 0);
        assert_eq!(layout.groups, [(opaque_group(9, 0), 1), (faint_group, 3)]);
        let placed = layout
            .regions
            .iter()
            .map(|(_, _, placement)| (placement.group, placement.alpha))
            .collect::<Vec<_>>();
        assert_eq!(
            placed,
            [
                (Some(opaque_group(9, 0)), 1.),
                (Some(faint_group), 1.),
                (Some(faint_group), 1.),
                (None, 0.5),
                (None, 1.),
                (None, 1.),
            ]
        );

        let ungrouped = GlassLayout::with_groups(&regions, [], 2., frame, None, false);
        assert!(ungrouped.groups.is_empty());
        assert_eq!(
            ungrouped
                .regions
                .iter()
                .map(|(_, _, placement)| placement.alpha)
                .collect::<Vec<_>>(),
            [1., 0.5, 0.5, 0.5, 1., 1.]
        );
    }

    #[test]
    fn native_glass_views_take_the_alpha_and_stay_real_glass() {
        let frame = NSRect::new(NSPoint::new(0., 0.), NSSize::new(400., 300.));
        let (host, gpui_view): (Retained<NSView>, Retained<NSView>) = unsafe {
            (
                msg_send![msg_send![class!(NSView), alloc], initWithFrame: frame],
                msg_send![msg_send![class!(NSView), alloc], initWithFrame: frame],
            )
        };
        host.addSubview(&gpui_view);
        let mut glass = GlassHost::default();
        let sync = |glass: &mut GlassHost, alpha: f32| {
            let regions = [
                LiquidGlassRegion {
                    alpha,
                    ..region(1, 1, 0., None)
                },
                LiquidGlassRegion {
                    alpha,
                    ..region(2, 2, 200., Some(9))
                },
                LiquidGlassRegion {
                    alpha,
                    ..region(3, 3, 400., Some(9))
                },
            ];
            let layout = GlassLayout::new(&regions, [], 2., [0., 0., 400., 300.], None);
            with_disabled_actions(|| glass.sync(&layout, &host, &gpui_view))
        };
        let real_glass = |view: &NSView| -> bool {
            let class = AnyClass::get(c"NSGlassEffectView").unwrap();
            unsafe { msg_send![view, isKindOfClass: class] }
        };
        let grouped = group_class().is_some();

        let units = sync(&mut glass, 1.);
        assert_eq!(units.len(), if grouped { 2 } else { 3 });
        assert!(units.iter().all(|(_, view)| view.alphaValue() == 1.));

        let units = sync(&mut glass, 0.5);
        let (_, single) = &units[0];
        assert_eq!(single.alphaValue(), 0.5);
        assert!(!single.isHidden());
        assert_eq!(real_glass(single), liquid_glass_available());
        assert_eq!(
            single.downcast_ref::<NSVisualEffectView>().is_some(),
            !liquid_glass_available()
        );
        if grouped {
            let (_, container) = &units[1];
            assert_eq!(container.alphaValue(), 0.5);
            let slot: Retained<NSView> = unsafe { msg_send![&**container, contentView] };
            let members = slot.subviews();
            assert_eq!(members.len(), 2);
            for member in members.iter() {
                assert_eq!(member.alphaValue(), 1.);
                assert!(real_glass(&member));
            }
        } else {
            assert!(units.iter().all(|(_, view)| view.alphaValue() == 0.5));
        }

        let units = sync(&mut glass, 1.);
        assert!(units.iter().all(|(_, view)| view.alphaValue() == 1.));
        assert!(units.iter().all(|(_, view)| !view.isHidden()));
        glass.remove();
    }

    struct GlassFixture {
        host: Retained<NSView>,
        gpui_view: Retained<NSView>,
        glass: GlassHost,
    }

    impl GlassFixture {
        fn new() -> Self {
            let frame = NSRect::new(NSPoint::new(0., 0.), NSSize::new(400., 300.));
            let (host, gpui_view): (Retained<NSView>, Retained<NSView>) = unsafe {
                (
                    msg_send![msg_send![class!(NSView), alloc], initWithFrame: frame],
                    msg_send![msg_send![class!(NSView), alloc], initWithFrame: frame],
                )
            };
            host.addSubview(&gpui_view);
            NATIVE_CALLS.take();
            Self {
                host,
                gpui_view,
                glass: GlassHost::default(),
            }
        }

        fn sync(&mut self, regions: &[LiquidGlassRegion]) -> Vec<&'static str> {
            let layout = GlassLayout::new(regions, [], 2., [0., 0., 400., 300.], None);
            with_disabled_actions(|| self.glass.sync(&layout, &self.host, &self.gpui_view));
            NATIVE_CALLS.take()
        }

        fn placed(&self) -> Vec<(*const NSView, Option<*const NSView>, usize)> {
            self.glass
                .owned_views()
                .map(|view| {
                    let parent = unsafe { view.superview() };
                    let index = parent
                        .as_ref()
                        .and_then(|parent| {
                            parent.subviews().iter().position(|subview| {
                                Retained::as_ptr(&subview) == Retained::as_ptr(view)
                            })
                        })
                        .unwrap_or(usize::MAX);
                    (
                        Retained::as_ptr(view),
                        parent.as_ref().map(Retained::as_ptr),
                        index,
                    )
                })
                .collect()
        }

        fn below_gpui_view(&self, view: &NSView) -> bool {
            let subviews = self.host.subviews();
            let position = |target: &NSView| {
                subviews
                    .iter()
                    .position(|subview| ptr::eq(&*subview, target))
            };
            position(view) < position(&self.gpui_view)
        }
    }

    fn count(calls: &[&str], call: &str) -> usize {
        calls.iter().filter(|recorded| **recorded == call).count()
    }

    #[test]
    fn reshowing_a_hidden_glass_view_only_unhides_it() {
        let mut fixture = GlassFixture::new();
        let regions = [region(1, 1, 0., None)];
        fixture.sync(&regions);
        let placed = fixture.placed();

        assert_eq!(fixture.sync(&[]), ["hide"]);
        assert_eq!(fixture.sync(&regions), ["show"]);
        assert_eq!(fixture.placed(), placed);
        fixture.glass.remove();
    }

    #[test]
    fn a_profile_switch_and_back_reparents_nothing() {
        let mut fixture = GlassFixture::new();
        let grouped = group_class().is_some();
        let profile = [
            region(1, 1, 0., None),
            region(2, 2, 120., Some(9)),
            region(3, 3, 240., Some(9)),
            region(4, 4, 600., None),
        ];
        let other = [region(1, 1, 0., None)];
        fixture.sync(&profile);
        let placed = fixture.placed();

        let switched = fixture.sync(&other);
        assert_eq!(count(&switched, "hide"), 3);
        assert_eq!(count(&switched, "group hide"), usize::from(grouped));

        let back = fixture.sync(&profile);
        assert_eq!(count(&back, "add"), 0, "{back:?}");
        assert_eq!(count(&back, "group add"), 0, "{back:?}");
        let mut expected = vec!["show"; 3];
        if grouped {
            expected.insert(0, "group show");
        }
        assert_eq!(back, expected);
        assert_eq!(fixture.placed(), placed);

        fixture.sync(&other);
        let moved = [
            region(1, 1, 0., None),
            region(3, 2, 240., Some(9)),
            region(2, 3, 120., Some(9)),
            LiquidGlassRegion {
                alpha: 0.5,
                ..region(4, 4, 650., None)
            },
        ];
        let calls = fixture.sync(&moved);
        assert_eq!(count(&calls, "add"), 0, "{calls:?}");
        assert_eq!(count(&calls, "frame"), 1, "{calls:?}");
        assert_eq!(count(&calls, "alpha"), 1, "{calls:?}");
        let units = with_disabled_actions(|| {
            fixture.glass.sync(
                &GlassLayout::new(&moved, [], 2., [0., 0., 400., 300.], None),
                &fixture.host,
                &fixture.gpui_view,
            )
        });
        assert!(NATIVE_CALLS.take().is_empty());
        assert!(units.iter().all(|(_, unit)| !unit.isHidden()));
        assert!(units.iter().all(|(_, unit)| fixture.below_gpui_view(unit)));
        if grouped {
            let (_, container) = &units[1];
            let slot: Retained<NSView> = unsafe { msg_send![&**container, contentView] };
            let members = slot
                .subviews()
                .iter()
                .map(|member| member.frame().origin.x)
                .collect::<Vec<_>>();
            assert_eq!(members, [120., 60.]);
        }
        fixture.glass.remove();
    }

    #[test]
    fn a_reused_view_moves_to_its_new_group_and_keeps_the_slot_order() {
        let mut fixture = GlassFixture::new();
        if group_class().is_none() {
            return;
        }
        fixture.sync(&[region(1, 1, 0., Some(9)), region(2, 2, 200., None)]);
        fixture.sync(&[]);

        let calls = fixture.sync(&[region(1, 1, 0., Some(9)), region(2, 2, 200., Some(9))]);
        assert_eq!(count(&calls, "add"), 1, "{calls:?}");
        let units = with_disabled_actions(|| {
            fixture.glass.sync(
                &GlassLayout::new(
                    &[region(1, 1, 0., Some(9)), region(2, 2, 200., Some(9))],
                    [],
                    2.,
                    [0., 0., 400., 300.],
                    None,
                ),
                &fixture.host,
                &fixture.gpui_view,
            )
        });
        assert_eq!(units.len(), 1);
        let (_, container) = &units[0];
        assert!(fixture.below_gpui_view(container));
        let slot: Retained<NSView> = unsafe { msg_send![&**container, contentView] };
        let members = slot.subviews();
        assert_eq!(members.len(), 2);
        assert!(members.iter().all(|member| !member.isHidden()));
        assert_eq!(
            members
                .iter()
                .map(|member| member.frame().origin.x)
                .collect::<Vec<_>>(),
            [0., 100.]
        );
        fixture.glass.remove();
    }
}
