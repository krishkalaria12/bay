//! Composites platform views beneath a window's GPUI content.
//!
//! GPUI's focus decides which view receives keyboard input: the window's first
//! responder is the native view whose handle GPUI has focused, and GPUI's own
//! view otherwise. The overrides here keep AppKit from moving it anywhere else,
//! except when the user clicks into a native view.
//!
//! A native view with keyboard input sees each key press first. GPUI is only
//! offered a key ahead of it for a pending or reserved binding, and otherwise
//! receives the keys that no view used, as AppKit passes them back up.

use super::{
    MacWindowState, convert_mouse_position, current_capslock, current_modifiers,
    gesture_forwarding::GestureMonitor,
    liquid_glass::{GlassLayout, new_layer, set_layer_color, with_disabled_actions},
    visual_effect::EffectLayout,
    window_state_if_set, with_input_handler,
};
use crate::events::platform_input_from_native;
use gpui::{
    Bounds, DrawOrder, KeyDownEvent, ModifiersChangedEvent, NativeViewId, PaintNativeView, Pixels,
    PlatformInput, Point, Rgba, ScaledPixels, Scene, WindowBackgroundAppearance,
};
use objc2::{
    class, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel},
    sel,
};
use objc2_app_kit::{NSColor, NSEventType, NSView, NSWindowOrderingMode, NSWorkspace};
use objc2_core_graphics::{CGMutablePath, CGPath};
use objc2_foundation::{NSComparisonResult, NSPoint, NSRect, NSSize, NSString};
use parking_lot::Mutex;
use std::{
    any::Any,
    ffi::c_void,
    ptr::{self, NonNull},
    rc::{Rc, Weak},
    sync::OnceLock,
};

type HitTestCallback = Box<dyn FnMut(Point<Pixels>) -> Option<NativeViewId>>;

#[derive(Default)]
pub(super) struct NativeViews {
    views: Vec<AttachedView>,
    /// The view GPUI has focused, which is the one that should be first responder.
    focused: Option<NativeViewId>,
    /// The view a mouse-down event is being delivered to, which may take
    /// first responder even though GPUI has not focused it yet.
    clicked: Option<NativeViewId>,
    /// The view that was asked to take keyboard input and didn't. It isn't
    /// asked again until it takes keyboard input itself or GPUI's focus moves,
    /// and the GPUI view has keyboard input in its place.
    declined: Option<NativeViewId>,
    /// Set while first responder is being matched to GPUI's focus, so that
    /// the requests this makes don't each start matching it again.
    reconciling: bool,
    /// The mouse buttons, by number, whose presses went to a native view. GPUI
    /// was told of each press, and is owed its release.
    buttons_pressed_in_view: Vec<isize>,
    /// The keys, by key code, whose presses GPUI took ahead of a native view.
    /// Their releases are GPUI's too, and not the view's, which never saw them
    /// pressed.
    keys_taken_before_view: Vec<u16>,
    /// Whether the pointer is over a native view, which then sets the cursor.
    pointer_over_view: bool,
    /// Whether a scene has been drawn since the pointer was last looked for.
    /// What is under a pointer that isn't moving can change with any scene.
    drew_since_pointer_check: bool,
    /// Set while the window routes a key equivalent between a native view and
    /// GPUI itself, so the GPUI view doesn't also handle it.
    routing_key_equivalent: bool,
    /// Set while a key press is delivered to a native view, which can ask the
    /// window to perform the same key as an equivalent before it has decided
    /// whether to use it.
    delivering_key_down: bool,
    /// The key equivalent GPUI was already offered once no view performed it.
    /// AppKit delivers it again as a key press, which must not reach GPUI twice.
    passed_up_key_equivalent: Option<Retained<AnyObject>>,
    stacked: Vec<*const NSView>,
    /// The color the window was last given behind its native views.
    pub(super) background: Option<Rgba>,
    pub(super) hit_test_callback: Option<HitTestCallback>,
    pub(super) focused_callback: Option<Box<dyn FnMut(NativeViewId)>>,
    pub(super) key_down_before_callback: Option<Box<dyn FnMut(KeyDownEvent) -> bool>>,
}

struct AttachedView {
    id: NativeViewId,
    view: Retained<NSView>,
    /// The view's superview, which clips it to its element's content mask.
    container: Retained<NSView>,
    /// Where the view was last placed, or `None` while it is hidden.
    placement: Option<Placement>,
    /// Whether the last placement was applied while the view was outside its
    /// container, which leaves the view itself to be placed once it returns.
    placed_while_away: bool,
    corner_radii: [f64; 4],
    corners: CornerShape,
    /// Keeps gestures over attached views reaching GPUI while any view is attached.
    _gesture_monitor: Option<Rc<GestureMonitor>>,
}

/// Where a native view is shown, as `[x, y, width, height]` frames in points.
///
/// A scaled view is scaled through its container's bounds, along each axis,
/// which AppKit accounts for when it converts points and hit-tests, so the
/// view keeps its frame and lays nothing out again as the scale changes.
/// GPUI never turns a native view, so the container's frame is always where
/// GPUI hit-tests the view and where the renderer erases for it.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Placement {
    /// The visible part of the view, in the window's content view.
    container: [f64; 4],
    /// The size of the container's bounds: its frame's size, divided by the
    /// view's scale along each axis.
    bounds: [f64; 2],
    /// The whole view, in its container's bounds.
    view: [f64; 4],
    /// The container's alpha value.
    alpha: f64,
}

impl Placement {
    /// Places a view with the bounds and clip of `native_view`, both in
    /// device pixels from the top left of the GPUI view, whose frame is
    /// `gpui_frame`. Returns `None` if the clip leaves none of the view visible.
    fn new(native_view: &PaintNativeView, scale_factor: f64, gpui_frame: [f64; 4]) -> Option<Self> {
        let bounds = native_view.bounds;
        let visible = bounds.intersect(&native_view.content_mask.bounds);
        if visible.is_empty() {
            return None;
        }
        let to_points = |value: ScaledPixels| f64::from(value) / scale_factor;
        // AppKit measures from the bottom left of the enclosing view.
        let to_frame = |bounds: Bounds<ScaledPixels>| {
            let [gpui_x, gpui_y, _, gpui_height] = gpui_frame;
            let height = to_points(bounds.size.height);
            [
                gpui_x + to_points(bounds.origin.x),
                gpui_y + gpui_height - to_points(bounds.origin.y) - height,
                to_points(bounds.size.width),
                height,
            ]
        };
        let container = to_frame(visible);
        let [x, y, width, height] = to_frame(bounds);
        let alpha = f64::from(native_view.opacity).clamp(0., 1.);
        let alpha = if alpha.is_nan() { 1. } else { alpha };
        if !native_view.is_transformed() {
            return Some(Self {
                container,
                bounds: [container[2], container[3]],
                view: [x - container[0], y - container[1], width, height],
                alpha,
            });
        }
        let positive_or_one = |scale: f32| {
            let scale = f64::from(scale);
            if scale.is_finite() && scale > 0. {
                scale
            } else {
                1.
            }
        };
        let scales = native_view.scales();
        let (scale_x, scale_y) = (positive_or_one(scales.x), positive_or_one(scales.y));
        let layout = native_view.layout_size;
        let (layout_width, layout_height) = (to_points(layout.width), to_points(layout.height));
        let center = [
            x + width / 2. - container[0],
            y + height / 2. - container[1],
        ];
        Some(Self {
            container,
            bounds: [container[2] / scale_x, container[3] / scale_y],
            view: [
                center[0] / scale_x - layout_width / 2.,
                center[1] / scale_y - layout_height / 2.,
                layout_width,
                layout_height,
            ],
            alpha,
        })
    }

    /// Scales the container's bounds and fades it, or resets both to exactly
    /// none.
    fn transform_container(&self, container: &NSView) {
        let [width, height] = self.bounds;
        let bounds = container.bounds();
        if bounds.size.width != width || bounds.size.height != height {
            container.setBoundsSize(NSSize::new(width, height));
        }
        if bounds.origin.x != 0. || bounds.origin.y != 0. {
            container.setBoundsOrigin(NSPoint::new(0., 0.));
        }
        if container.alphaValue() != self.alpha {
            container.setAlphaValue(self.alpha);
        }
    }
}

impl NativeViews {
    pub(super) fn detach_all(&mut self) -> Vec<Retained<NSView>> {
        self.focused = None;
        self.stacked.clear();
        self.views
            .drain(..)
            .map(|attached| attached.container)
            .collect()
    }

    /// The view with `id` if it is on screen in this window, which is where
    /// input and focus can reach it.
    fn shown(&self, id: NativeViewId) -> Option<&AttachedView> {
        self.views.iter().find(|attached| {
            attached.id == id && attached.placement.is_some() && attached.is_in_container()
        })
    }

    fn focused(&self) -> Option<FocusedNativeView> {
        self.focused.map(|id| FocusedNativeView {
            id,
            shown: self.shown(id).is_some(),
            declined: self.declined == Some(id),
        })
    }

    fn is_showing_any(&self) -> bool {
        self.views
            .iter()
            .any(|attached| attached.placement.is_some() && attached.is_in_container())
    }

    fn note_button_pressed_in_view(&mut self, button: isize) {
        if !self.buttons_pressed_in_view.contains(&button) {
            self.buttons_pressed_in_view.push(button);
        }
    }

    /// Returns whether GPUI is owed the release of `button`, which settles it.
    fn take_button_pressed_in_view(&mut self, button: isize) -> bool {
        let count = self.buttons_pressed_in_view.len();
        self.buttons_pressed_in_view
            .retain(|pressed| *pressed != button);
        self.buttons_pressed_in_view.len() != count
    }

    /// What `responder` is to the window whose own view is `gpui_view`.
    fn holder(
        &self,
        responder: *mut AnyObject,
        native_window: *mut AnyObject,
        gpui_view: *mut AnyObject,
    ) -> InputHolder {
        if responder.is_null() || responder == native_window {
            InputHolder::Window
        } else if responder == gpui_view {
            InputHolder::GpuiView
        } else if let Some(id) = self.containing(responder) {
            InputHolder::NativeView(id)
        } else {
            InputHolder::Other
        }
    }

    /// The attached view that contains `responder`, if it is a view inside one.
    ///
    /// Attached views are assumed not to contain one another, which holds
    /// unless the app moves one after attaching it.
    fn containing(&self, responder: *mut AnyObject) -> Option<NativeViewId> {
        if responder.is_null() {
            return None;
        }
        // SAFETY: `responder` is a live object AppKit passed as a responder, and the
        // attached views are retained.
        unsafe {
            let is_view: bool = msg_send![responder, isKindOfClass: class!(NSView)];
            if !is_view {
                return None;
            }
            self.views.iter().find_map(|attached| {
                let inside: bool = msg_send![responder, isDescendantOf: &*attached.view];
                inside.then_some(attached.id)
            })
        }
    }
}

struct Attachment {
    window_state: Weak<Mutex<MacWindowState>>,
    id: NativeViewId,
}

impl Drop for Attachment {
    fn drop(&mut self) {
        let Some(window_state) = self.window_state.upgrade() else {
            return;
        };
        let (attached, native_window, gpui_view) = {
            let mut lock = window_state.lock();
            let Some(index) = lock
                .native_views
                .views
                .iter()
                .position(|attached| attached.id == self.id)
            else {
                return;
            };
            if lock.native_views.focused == Some(self.id) {
                lock.native_views.focused = None;
            }
            let attached = lock.native_views.views.remove(index);
            (attached, lock.native_window, lock.native_view.as_ptr())
        };
        // SAFETY: The window and both views are live, and attachments are dropped on
        // the main thread because `gpui::NativeView` is not `Send`.
        unsafe {
            // AppKit would otherwise hand first responder to the window itself.
            give_up_first_responder(native_window, gpui_view, &attached.view);
            detach_view(&attached.container, &attached.view);
        }
    }
}

/// Adds `view` beneath the window's GPUI view, hidden until a scene shows it.
///
/// # Safety
///
/// `view` must point to a live `NSView` that is not in another view hierarchy,
/// and this must be called on the main thread.
pub(super) unsafe fn attach(
    window_state: &Rc<Mutex<MacWindowState>>,
    id: NativeViewId,
    view: NonNull<c_void>,
) -> Option<Box<dyn Any>> {
    // SAFETY: The caller guarantees `view` is a live `NSView`.
    let view = unsafe { Retained::retain(view.as_ptr().cast::<NSView>()) }?;
    let gpui_view = window_state.lock().native_view.as_ptr();
    // SAFETY: The GPUI view is live and in the window's content view, and this
    // runs on the main thread. The window state is unlocked because AppKit calls
    // back into the window as its view hierarchy changes.
    let container = unsafe {
        let container: Retained<NSView> = msg_send![container_class(), new];
        let _: () = msg_send![&*container, setClipsToBounds: true];
        container.setHidden(true);
        container.addSubview(&view);
        let content_view: *mut AnyObject = msg_send![gpui_view, superview];
        let _: () = msg_send![
            content_view,
            addSubview: &*container,
            positioned: NSWindowOrderingMode::Below,
            relativeTo: gpui_view
        ];
        container
    };
    window_state.lock().native_views.views.push(AttachedView {
        id,
        view,
        container,
        placement: None,
        placed_while_away: false,
        corner_radii: [0.; 4],
        corners: CornerShape::Square,
        _gesture_monitor: GestureMonitor::acquire(),
    });
    Some(Box::new(Attachment {
        window_state: Rc::downgrade(window_state),
        id,
    }))
}

/// The class of the view each native view is put inside.
fn container_class() -> &'static AnyClass {
    static CONTAINER_CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    CONTAINER_CLASS.get_or_init(|| {
        let name = c"GPUINativeViewContainer";
        let Some(mut decl) = ClassBuilder::new(name, class!(NSView)) else {
            // Another copy of GPUI in this process has registered the class.
            return AnyClass::get(name).unwrap_or(class!(NSView));
        };
        // SAFETY: The function signature matches the selector's Objective-C signature.
        unsafe {
            decl.add_method(
                sel!(performKeyEquivalent:),
                container_perform_key_equivalent as extern "C" fn(_, Sel, *mut AnyObject) -> Bool,
            );
        }
        decl.register()
    })
}

/// Keeps a key equivalent from the native view inside, which AppKit would
/// otherwise offer it whether or not the view has keyboard input. The window
/// offers key equivalents to the view that has keyboard input itself.
extern "C" fn container_perform_key_equivalent(_: &AnyObject, _: Sel, _: *mut AnyObject) -> Bool {
    Bool::NO
}

/// Shows the scene's native view background behind the window's content.
///
/// A view's frame change reaches the screen a frame or two before the scene
/// that moves its opening, so the opening briefly uncovers whatever is behind
/// the views. That is the window's background, which is given the color the
/// scene asks for. Presenting scenes in step with AppKit would close the gap,
/// but costs every frame of a window that shows a native view.
///
/// The color stays until a scene without native views is drawn. The last
/// view's opening is still on screen when the view goes, and would show the
/// window's own black through it if the color went with the view.
pub(super) fn update_background(state: &mut MacWindowState, scene: &Scene) {
    // The background of a transparent or blurred window is meant to show through.
    if state.background_appearance != WindowBackgroundAppearance::Opaque {
        return;
    }
    let background = scene
        .attached_native_views()
        .rev()
        .map(|native_view| Rgba::from(native_view.background))
        .find(|background| background.a > 0.);
    if state.native_views.background == background {
        return;
    }
    state.native_views.background = background;
    // SAFETY: The window is live for as long as its state.
    unsafe {
        let _: () = msg_send![
            state.native_window,
            setBackgroundColor: &*background_color(background)
        ];
    }
}

/// The background of an opaque window, which is black unless a native view asks for a color.
fn background_color(color: Option<Rgba>) -> Retained<NSColor> {
    let Rgba { r, g, b, .. } = color.unwrap_or_default();
    NSColor::colorWithSRGBRed_green_blue_alpha(r as f64, g as f64, b as f64, 1.)
}

/// What a scene changes about the window's attached views.
#[derive(Default)]
pub(super) struct Layout {
    /// Views to place somewhere new, or to hide for `None`.
    placements: Vec<(NativeViewId, Option<Placement>)>,
    shown: Vec<(DrawOrder, NativeViewId)>,
    glass: GlassLayout,
    effects: EffectLayout,
    idle: bool,
}

/// Works out which attached views the scene moves, shows, hides, or restacks.
pub(super) fn plan_layout(state: &MacWindowState, scene: &Scene) -> Layout {
    let scale_factor = state.scale_factor() as f64;
    // SAFETY: The GPUI view is live for as long as the window state.
    let gpui_frame: NSRect = unsafe { msg_send![state.native_view.as_ptr(), frame] };
    let gpui_frame = [
        gpui_frame.origin.x,
        gpui_frame.origin.y,
        gpui_frame.size.width,
        gpui_frame.size.height,
    ];
    let glass = GlassLayout::new(
        &scene.liquid_glass_regions,
        glass_occluders(scene),
        scale_factor,
        gpui_frame,
        state.glass_appearance(),
    );
    let glass_idle = state
        .liquid_glass
        .as_ref()
        .is_none_or(|glass| glass.is_idle());
    let effects = EffectLayout::new(&scene.visual_effect_regions, scale_factor, gpui_frame);
    let effects_idle = state
        .visual_effects
        .as_ref()
        .is_none_or(|effects| effects.is_idle());
    if state.native_views.views.is_empty()
        && glass.is_empty()
        && glass_idle
        && effects.is_empty()
        && effects_idle
    {
        return Layout {
            idle: true,
            ..Layout::default()
        };
    }
    if state.native_views.views.is_empty() {
        return Layout {
            glass,
            effects,
            ..Layout::default()
        };
    }

    let mut placements = Vec::new();
    for attached in &state.native_views.views {
        let placement = scene
            .attached_native_views()
            .find(|native_view| native_view.id == attached.id)
            .and_then(|native_view| Placement::new(native_view, scale_factor, gpui_frame));
        if attached.needs_placement(placement) {
            placements.push((attached.id, placement));
        }
    }

    // The scene's native views are sorted by draw order, so the ones painted
    // later, which belong in front, come last.
    let mut shown: Vec<(DrawOrder, NativeViewId)> = Vec::new();
    for native_view in scene.attached_native_views() {
        if !shown.iter().any(|(_, id)| *id == native_view.id) {
            shown.push((native_view.order, native_view.id));
        }
    }
    Layout {
        placements,
        shown,
        glass,
        effects,
        idle: false,
    }
}

fn glass_occluders(scene: &Scene) -> Vec<(DrawOrder, Bounds<ScaledPixels>)> {
    let mut occluders = scene
        .attached_native_views()
        .map(|native_view| {
            (
                native_view.order,
                native_view
                    .bounds
                    .intersect(&native_view.content_mask.bounds),
            )
        })
        .chain(
            scene
                .visual_effect_regions
                .iter()
                .map(|region| (region.order, region.visible_bounds())),
        )
        .collect::<Vec<_>>();
    occluders.sort_by_key(|(order, _)| *order);
    occluders
}

/// Applies a planned layout. The window state must be unlocked, because AppKit
/// calls back into it when a view's frame or first responder changes.
pub(super) fn apply_layout(window_state: &Rc<Mutex<MacWindowState>>, layout: Layout) {
    if layout.idle {
        return;
    }
    let (native_window, gpui_view, placements, shown, glass, effects) = {
        let mut lock = window_state.lock();
        let mut placements = Vec::new();
        for (id, placement) in layout.placements {
            if let Some(attached) = lock
                .native_views
                .views
                .iter_mut()
                .find(|attached| attached.id == id)
            {
                attached.placement = placement;
                attached.placed_while_away = !attached.is_in_container();
                let corners = placement
                    .map(|placement| CornerShape::new(&placement, attached.corner_radii))
                    .filter(|corners| *corners != attached.corners);
                if let Some(corners) = corners {
                    attached.corners = corners;
                }
                placements.push((
                    attached.view.clone(),
                    attached.container.clone(),
                    placement,
                    corners,
                ));
            }
        }
        let shown = layout
            .shown
            .iter()
            .filter_map(|(order, id)| {
                let attached = lock.native_views.views.iter().find(|view| view.id == *id)?;
                Some((*order, attached.container.clone()))
            })
            .collect::<Vec<_>>();
        (
            lock.native_window,
            lock.native_view.as_ptr(),
            placements,
            shown,
            lock.liquid_glass.take(),
            lock.visual_effects.take(),
        )
    };
    let placed_any = !placements.is_empty();
    for (view, container, placement, corners) in placements {
        match placement {
            Some(placement) => {
                place_view(&view, &container, &placement);
                if let Some(corners) = corners {
                    with_disabled_actions(|| corners.apply(&container));
                }
                container.setHidden(false);
            }
            None => {
                // SAFETY: The window and both views are live, and drawing runs on the main thread.
                unsafe { give_up_first_responder(native_window, gpui_view, &view) };
                container.setHidden(true);
            }
        }
    }
    let gpui_ns_view = unsafe { &*gpui_view.cast::<NSView>() };
    let glass = match glass {
        Some(glass) if layout.glass.is_empty() && glass.is_idle() => {
            window_state.lock().liquid_glass = Some(glass);
            None
        }
        glass => glass,
    };
    let host = glass
        .as_ref()
        .and_then(|_| unsafe { gpui_ns_view.superview() });
    let glass_units = match (host, glass) {
        (Some(host), Some(mut glass)) => {
            let units = with_disabled_actions(|| glass.sync(&layout.glass, &host, gpui_ns_view));
            window_state.lock().liquid_glass = Some(glass);
            units
        }
        (_, glass) => {
            if glass.is_some() {
                window_state.lock().liquid_glass = glass;
            }
            Vec::new()
        }
    };
    let effect_units = match (unsafe { gpui_ns_view.superview() }, effects) {
        (Some(host), Some(mut effects)) if !(layout.effects.is_empty() && effects.is_idle()) => {
            let units =
                with_disabled_actions(|| effects.sync(&layout.effects, &host, gpui_ns_view));
            window_state.lock().visual_effects = Some(effects);
            units
        }
        (_, effects) => {
            if effects.is_some() {
                window_state.lock().visual_effects = effects;
            }
            Vec::new()
        }
    };
    let glass_units = merge_units(effect_units, glass_units);
    let stacked = merge_by_order(glass_units, shown)
        .iter()
        .map(Retained::as_ptr)
        .collect::<Vec<_>>();
    let stacking = {
        let mut lock = window_state.lock();
        (lock.native_views.stacked != stacked).then(|| {
            lock.native_views.stacked = stacked.clone();
            let mut attached = lock
                .native_views
                .views
                .iter()
                .map(|attached| Retained::as_ptr(&attached.container))
                .collect::<Vec<_>>();
            if let Some(glass) = &lock.liquid_glass {
                attached.extend(glass.owned_views().map(Retained::as_ptr));
            }
            if let Some(effects) = &lock.visual_effects {
                attached.extend(effects.owned_views().map(Retained::as_ptr));
            }
            Stacking {
                gpui_view: gpui_view.cast_const().cast(),
                front_to_back: stacked.iter().rev().copied().collect(),
                attached,
                back_layers: lock.back_layers(),
                current: Vec::new(),
            }
        })
    };
    let restacked = stacking.is_some();
    if let Some(mut stacking) = stacking
        && stacking.front_to_back.len() > 1
    {
        // SAFETY: The GPUI view is live and in the content view, the comparison
        // function only reads `stacking`, which outlives the call, and sorting
        // reorders the subviews in place, so none of them leaves the window.
        unsafe {
            let content_view: *mut NSView = msg_send![gpui_view, superview];
            if let Some(content_view) = content_view.as_ref() {
                stacking.current = content_view
                    .subviews()
                    .iter()
                    .map(|subview| Retained::as_ptr(&subview))
                    .collect();
                content_view.sortSubviewsUsingFunction_context(
                    compare_stacking,
                    (&raw mut stacking).cast(),
                );
            }
        }
    }
    // A view that GPUI focused while it was hidden can take keyboard input now.
    if placed_any || restacked {
        reconcile_first_responder(window_state);
    }
}

fn is_in_container(view: &NSView, container: &NSView) -> bool {
    // SAFETY: The view is live, and views are only read on the main thread.
    unsafe { view.superview() }.is_some_and(|superview| ptr::eq(&*superview, container))
}

/// Places `container`, and `view` inside it if it is still there, returning
/// whether it was. A view another window has taken keeps the frame that
/// window gave it, and whatever was left in its place, such as WebKit's
/// full screen placeholder, is given the view's frame, so that the view comes
/// back at the size GPUI has since laid out.
fn place_view(view: &NSView, container: &NSView, placement: &Placement) -> bool {
    let to_rect = |[x, y, width, height]: [f64; 4]| {
        NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
    };
    container.setFrame(to_rect(placement.container));
    placement.transform_container(container);
    let frame = to_rect(placement.view);
    if is_in_container(view, container) {
        view.setFrame(frame);
        return true;
    }
    for placeholder in container.subviews().iter() {
        if placeholder.frame() != frame {
            placeholder.setFrame(frame);
        }
    }
    false
}

/// Takes `container` out of the window, with `view` if it is still inside.
///
/// A view another window has taken, such as for HTML full screen, is left
/// where it is: GPUI only lets go of it, and whatever owns that window decides
/// where it goes next.
fn detach_view(container: &NSView, view: &NSView) {
    let in_container = is_in_container(view, container);
    container.removeFromSuperview();
    if in_container {
        view.removeFromSuperview();
    }
}

fn merge_units<V>(first: Vec<(DrawOrder, V)>, second: Vec<(DrawOrder, V)>) -> Vec<(DrawOrder, V)> {
    let mut merged = first;
    merged.extend(second);
    merged.sort_by_key(|(order, _)| *order);
    merged
}

fn merge_by_order<V>(glass: Vec<(DrawOrder, V)>, native: Vec<(DrawOrder, V)>) -> Vec<V> {
    let mut merged = Vec::with_capacity(glass.len() + native.len());
    let mut glass = glass.into_iter().peekable();
    let mut native = native.into_iter().peekable();
    loop {
        let take_glass = match (glass.peek(), native.peek()) {
            (Some((glass_order, _)), Some((native_order, _))) => glass_order <= native_order,
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (None, None) => break,
        };
        let next = if take_glass {
            glass.next()
        } else {
            native.next()
        };
        merged.extend(next.map(|(_, view)| view));
    }
    merged
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum CornerShape {
    Square,
    Rounded {
        radius: f64,
        corners: usize,
    },
    Masked {
        frame: [f64; 4],
        radius: f64,
        corners: usize,
    },
    Shaped {
        container: [f64; 2],
        frame: [f64; 4],
        radii: [f64; 4],
    },
}

impl CornerShape {
    fn new(placement: &Placement, radii: [f64; 4]) -> Self {
        let [x, y, width, height] = placement.view;
        let radii = clamped_radii(radii, width, height);
        let mut corners = 0;
        let mut radius: f64 = 0.;
        for (corner_radius, corner) in radii.into_iter().zip([4, 8, 2, 1]) {
            if corner_radius > 0. {
                corners |= corner;
                radius = radius.max(corner_radius);
            }
        }
        // A scaled view's frame is worked out from its scaled bounds, so it
        // can be a rounding error away from filling its container.
        let fills = |position: f64, length: f64, container: f64| {
            position.abs() < 1e-6 && (length - container).abs() < 1e-6
        };
        let [bounds_width, bounds_height] = placement.bounds;
        if radius <= 0. {
            Self::Square
        } else if radii.iter().any(|corner| *corner > 0. && *corner != radius) {
            Self::Shaped {
                container: placement.bounds,
                frame: placement.view,
                radii,
            }
        } else if fills(x, width, bounds_width) && fills(y, height, bounds_height) {
            Self::Rounded { radius, corners }
        } else {
            Self::Masked {
                frame: placement.view,
                radius,
                corners,
            }
        }
    }

    fn apply(self, container: &NSView) {
        container.setWantsLayer(true);
        let layer: Option<Retained<AnyObject>> = unsafe { msg_send![container, layer] };
        let Some(layer) = layer else {
            return;
        };
        let continuous = NSString::from_str("continuous");
        unsafe {
            let (radius, corners, mask) = match self {
                Self::Square => (0., 15, None),
                Self::Rounded { radius, corners } => (radius, corners, None),
                Self::Masked {
                    frame,
                    radius,
                    corners,
                } => {
                    let mask = new_layer();
                    let [x, y, width, height] = frame;
                    let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
                    let _: () = msg_send![&*mask, setFrame: frame];
                    let _: () = msg_send![&*mask, setCornerRadius: radius];
                    let _: () = msg_send![&*mask, setCornerCurve: &*continuous];
                    let _: () = msg_send![&*mask, setMaskedCorners: corners];
                    set_layer_color(&mask, Some(&NSColor::blackColor()));
                    (0., 15, Some(mask))
                }
                Self::Shaped {
                    container: [width, height],
                    frame,
                    radii,
                } => {
                    let mask: Retained<AnyObject> = msg_send![class!(CAShapeLayer), layer];
                    let bounds = NSRect::new(NSPoint::new(0., 0.), NSSize::new(width, height));
                    let _: () = msg_send![&*mask, setFrame: bounds];
                    set_rounded_path(&mask, frame, radii);
                    (0., 15, Some(mask))
                }
            };
            let _: () = msg_send![&*layer, setCornerRadius: radius];
            let _: () = msg_send![&*layer, setCornerCurve: &*continuous];
            let _: () = msg_send![&*layer, setMaskedCorners: corners];
            if radius > 0. {
                let _: () = msg_send![&*layer, setMasksToBounds: Bool::YES];
            }
            let _: () = msg_send![&*layer, setMask: mask.as_deref()];
        }
    }
}

fn clamped_radii(radii: [f64; 4], width: f64, height: f64) -> [f64; 4] {
    let limit = width.min(height) / 2.;
    radii.map(|radius| radius.max(0.).min(limit))
}

pub(super) unsafe fn set_rounded_path(
    mask: &AnyObject,
    [left, bottom, width, height]: [f64; 4],
    [top_left, top_right, bottom_right, bottom_left]: [f64; 4],
) {
    let (right, top) = (left + width, bottom + height);
    let path = CGMutablePath::new();
    let no_transform = ptr::null();
    unsafe {
        CGMutablePath::move_to_point(Some(&path), no_transform, left + top_left, top);
        CGMutablePath::add_arc_to_point(
            Some(&path),
            no_transform,
            right,
            top,
            right,
            top - top_right,
            top_right,
        );
        CGMutablePath::add_arc_to_point(
            Some(&path),
            no_transform,
            right,
            bottom,
            right - bottom_right,
            bottom,
            bottom_right,
        );
        CGMutablePath::add_arc_to_point(
            Some(&path),
            no_transform,
            left,
            bottom,
            left,
            bottom + bottom_left,
            bottom_left,
        );
        CGMutablePath::add_arc_to_point(
            Some(&path),
            no_transform,
            left,
            top,
            left + top_left,
            top,
            top_left,
        );
    }
    CGMutablePath::close_subpath(Some(&path));
    let path: *const CGPath = &**path;
    unsafe {
        let _: () = msg_send![mask, setPath: path];
    }
}

fn rounded_rect_contains([width, height]: [f64; 2], radii: [f64; 4], [x, y]: [f64; 2]) -> bool {
    if !((0. ..=width).contains(&x) && (0. ..=height).contains(&y)) {
        return false;
    }
    let [top_left, top_right, bottom_right, bottom_left] = clamped_radii(radii, width, height);
    [
        (top_left, [top_left, height - top_left], [-1., 1.]),
        (top_right, [width - top_right, height - top_right], [1., 1.]),
        (
            bottom_right,
            [width - bottom_right, bottom_right],
            [1., -1.],
        ),
        (bottom_left, [bottom_left, bottom_left], [-1., -1.]),
    ]
    .into_iter()
    .all(|(radius, [center_x, center_y], [side_x, side_y])| {
        let (dx, dy) = (x - center_x, y - center_y);
        dx * side_x <= 0. || dy * side_y <= 0. || dx * dx + dy * dy <= radius * radius
    })
}

impl AttachedView {
    /// Whether the view is still inside its container. WebKit and Chromium
    /// move a page's view into their own window for HTML full screen, leaving
    /// a placeholder in the container, and put it back when full screen ends.
    fn is_in_container(&self) -> bool {
        is_in_container(&self.view, &self.container)
    }

    fn needs_placement(&self, placement: Option<Placement>) -> bool {
        self.placement != placement || (self.placed_while_away && self.is_in_container())
    }

    fn covers(&self, position_in_window: NSPoint) -> bool {
        let Some(placement) = self.placement else {
            return false;
        };
        let point = self
            .container
            .convertPoint_fromView(position_in_window, None);
        let [x, y, width, height] = placement.view;
        rounded_rect_contains(
            [width, height],
            self.corner_radii,
            [point.x - x, point.y - y],
        )
    }
}

pub(super) fn set_corner_radius(
    window_state: &Rc<Mutex<MacWindowState>>,
    id: NativeViewId,
    radii: gpui::Corners<Pixels>,
) {
    let change = {
        let mut lock = window_state.lock();
        let Some(attached) = lock
            .native_views
            .views
            .iter_mut()
            .find(|attached| attached.id == id)
        else {
            return;
        };
        attached.corner_radii = [
            radii.top_left,
            radii.top_right,
            radii.bottom_right,
            radii.bottom_left,
        ]
        .map(|radius| radius.to_f64().max(0.));
        let corners = attached.placement.map_or(CornerShape::Square, |placement| {
            CornerShape::new(&placement, attached.corner_radii)
        });
        (attached.corners != corners && attached.placement.is_some()).then(|| {
            attached.corners = corners;
            (attached.container.clone(), corners)
        })
    };
    if let Some((container, corners)) = change {
        with_disabled_actions(|| corners.apply(&container));
    }
}

/// The order to give the content view's subviews.
struct Stacking {
    gpui_view: *const NSView,
    /// The containers of the views the scene shows, starting with the one painted last.
    front_to_back: Vec<*const NSView>,
    attached: Vec<*const NSView>,
    back_layers: Vec<*const NSView>,
    /// The subviews as they are ordered now, from the back. Those that aren't
    /// native views keep their places among themselves and their side of the
    /// GPUI view.
    current: Vec<*const NSView>,
}

impl Stacking {
    /// How far forward a subview belongs, with greater values in front.
    fn rank(&self, view: *const NSView) -> (u8, usize) {
        let place = |view| self.current.iter().position(|current| *current == view);
        if view == self.gpui_view {
            (3, 0)
        } else if let Some(index) = self.front_to_back.iter().position(|shown| *shown == view) {
            // Shown views sit above hidden ones, in the scene's order.
            (2, self.front_to_back.len() - index)
        } else if self.attached.contains(&view) {
            (1, 0)
        } else if let Some(index) = self.back_layers.iter().position(|layer| *layer == view) {
            (0, index)
        } else if place(view) > place(self.gpui_view) {
            // A view the app put in front of GPUI's content stays there.
            (4, place(view).unwrap_or_default())
        } else {
            (0, self.back_layers.len() + place(view).unwrap_or_default())
        }
    }
}

unsafe extern "C-unwind" fn compare_stacking(
    first: NonNull<NSView>,
    second: NonNull<NSView>,
    stacking: *mut c_void,
) -> NSComparisonResult {
    // SAFETY: `apply_layout` passes a `Stacking` that outlives the sort.
    let stacking = unsafe { &*stacking.cast::<Stacking>() };
    match stacking
        .rank(first.as_ptr())
        .cmp(&stacking.rank(second.as_ptr()))
    {
        std::cmp::Ordering::Less => NSComparisonResult::Ascending,
        std::cmp::Ordering::Equal => NSComparisonResult::Same,
        std::cmp::Ordering::Greater => NSComparisonResult::Descending,
    }
}

/// What has, or is asking for, a window's keyboard input.
#[derive(Clone, Copy, Debug, PartialEq)]
enum InputHolder {
    /// The window itself, which has it when no view does.
    Window,
    /// The view GPUI draws its own content in.
    GpuiView,
    /// An attached native view, or a view inside it.
    NativeView(NativeViewId),
    /// A view GPUI didn't attach, such as a control the app or AppKit put in
    /// the titlebar. GPUI's focus says nothing about those.
    Other,
}

/// The native view GPUI has focused.
#[derive(Clone, Copy, Debug, PartialEq)]
struct FocusedNativeView {
    id: NativeViewId,
    /// Whether it is on screen. A view can be focused before it is shown, and
    /// stays focused when it is hidden.
    shown: bool,
    /// Whether it was asked to take keyboard input and didn't.
    declined: bool,
}

/// A view keyboard input is moved to so that it matches GPUI's focus.
#[derive(Clone, Copy, Debug, PartialEq)]
enum InputTarget {
    GpuiView,
    NativeView(NativeViewId),
}

/// Where keyboard input should move so that it matches GPUI's focus, or `None`
/// to leave it with `current`.
fn input_target_for_focus(
    focused: Option<FocusedNativeView>,
    current: InputHolder,
) -> Option<InputTarget> {
    let (target, holder) = match focused {
        Some(FocusedNativeView {
            id,
            shown: true,
            declined: false,
        }) => (InputTarget::NativeView(id), InputHolder::NativeView(id)),
        // A hidden view can't take keyboard input until it is shown, and a view
        // that declined it would only decline again.
        Some(_) | None => (InputTarget::GpuiView, InputHolder::GpuiView),
    };
    (current != InputHolder::Other && current != holder).then_some(target)
}

/// Whether `requested` may take keyboard input from `current` when AppKit or
/// the view itself asks.
///
/// `clicked` is the native view a mouse press is being delivered to.
/// `voice_over_reaches_it` is whether VoiceOver is on and `requested` is a
/// native view on screen, which is where its cursor can go. A hidden view
/// asking for keyboard input is a page script, VoiceOver or not.
fn may_take_input(
    requested: InputHolder,
    current: InputHolder,
    focused: Option<FocusedNativeView>,
    clicked: Option<NativeViewId>,
    voice_over_reaches_it: bool,
) -> bool {
    match requested {
        // AppKit offers the GPUI view keyboard input on every press inside it.
        // While GPUI's focus stays on a native view, taking it and handing it
        // straight back would make the native view lose and regain keyboard
        // input, so it is refused. A press that moves GPUI's focus does so
        // first, and is accepted.
        InputHolder::GpuiView => !matches!(
            focused,
            Some(FocusedNativeView { id, shown: true, .. }) if current == InputHolder::NativeView(id)
        ),
        // Web views ask for keyboard input on their own, such as when a page
        // script focuses its window. Only GPUI's focus, a click, or VoiceOver's
        // cursor may move it.
        InputHolder::NativeView(requested) => {
            focused.is_some_and(|focused| focused.id == requested)
                || clicked == Some(requested)
                || voice_over_reaches_it
        }
        InputHolder::Window | InputHolder::Other => true,
    }
}

/// Records the view GPUI has focused and gives it keyboard input.
pub(super) fn set_focused(window_state: &Rc<Mutex<MacWindowState>>, id: Option<NativeViewId>) {
    {
        let mut lock = window_state.lock();
        let views = &mut lock.native_views;
        if views.focused != id {
            views.declined = None;
        }
        views.focused = id;
    }
    reconcile_first_responder(window_state);
}

/// Makes the window's first responder match the view GPUI has focused.
///
/// A responder that is neither the window, the GPUI view, nor inside an
/// attached view is left with keyboard input, such as a control the app or
/// AppKit put in the titlebar. GPUI's focus says nothing about those.
pub(super) fn reconcile_first_responder(window_state: &Rc<Mutex<MacWindowState>>) {
    // The window is asked to move first responder, and reconciles again as it
    // does. This call sees to whatever those requests leave.
    if std::mem::replace(&mut window_state.lock().native_views.reconciling, true) {
        return;
    }
    // One request gives keyboard input to the view GPUI has focused, and a
    // second returns it to the GPUI view if that view declined. Nothing takes
    // a third, so a responder that never settles can't keep this going.
    for _ in 0..2 {
        if !request_first_responder_for_focus(window_state) {
            break;
        }
    }
    window_state.lock().native_views.reconciling = false;
}

/// Asks the window to make the view GPUI has focused first responder, and
/// returns whether there was anything to ask for.
fn request_first_responder_for_focus(window_state: &Rc<Mutex<MacWindowState>>) -> bool {
    // SAFETY: The window and views are live, and this runs on the main thread. The
    // window state is unlocked for `makeFirstResponder:` because AppKit calls back
    // into it synchronously, and the target is retained in case that detaches it.
    unsafe {
        let (native_window, target) = {
            let lock = window_state.lock();
            let native_window = lock.native_window;
            let gpui_view = lock.native_view.as_ptr();
            let current: *mut AnyObject = msg_send![native_window, firstResponder];
            let views = &lock.native_views;
            let current = views.holder(current, native_window, gpui_view);
            let target = match input_target_for_focus(views.focused(), current) {
                Some(InputTarget::NativeView(id)) => match views.shown(id) {
                    Some(attached) => Some(attached.view.clone()),
                    None => return false,
                },
                Some(InputTarget::GpuiView) => None,
                None => return false,
            };
            (native_window, target.ok_or(gpui_view))
        };
        let _: Bool = match &target {
            Ok(view) => msg_send![native_window, makeFirstResponder: &**view],
            Err(gpui_view) => msg_send![native_window, makeFirstResponder: *gpui_view],
        };
        true
    }
}

/// Returns first responder to the GPUI view if it is inside `view`.
///
/// # Safety
///
/// All three objects must be live, and this must be called on the main thread
/// without the window state locked.
unsafe fn give_up_first_responder(
    native_window: *mut AnyObject,
    gpui_view: *mut AnyObject,
    view: &NSView,
) {
    unsafe {
        let current: *mut AnyObject = msg_send![native_window, firstResponder];
        let is_view: bool = !current.is_null() && msg_send![current, isKindOfClass: class!(NSView)];
        let inside: bool = is_view && msg_send![current, isDescendantOf: view];
        if inside {
            let _: Bool = msg_send![native_window, makeFirstResponder: gpui_view];
        }
    }
}

pub(super) fn add_window_methods(decl: &mut ClassBuilder) {
    // SAFETY: The function signatures match the selectors' Objective-C signatures.
    unsafe {
        decl.add_method(
            sel!(makeFirstResponder:),
            make_first_responder as extern "C" fn(_, Sel, *mut AnyObject) -> Bool,
        );
        decl.add_method(
            sel!(sendEvent:),
            send_event as extern "C" fn(_, Sel, *mut AnyObject),
        );
        decl.add_method(
            sel!(performKeyEquivalent:),
            window_perform_key_equivalent as extern "C" fn(_, Sel, *mut AnyObject) -> Bool,
        );
        decl.add_method(
            sel!(keyDown:),
            window_key_down as extern "C" fn(_, Sel, *mut AnyObject),
        );
    }
}

pub(super) fn add_view_methods(decl: &mut ClassBuilder) {
    // SAFETY: The function signatures match the selectors' Objective-C signatures.
    unsafe {
        decl.add_method(
            sel!(hitTest:),
            hit_test as extern "C" fn(_, Sel, NSPoint) -> *mut AnyObject,
        );
        decl.add_method(
            sel!(becomeFirstResponder),
            become_first_responder as extern "C" fn(_, Sel) -> Bool,
        );
        decl.add_method(
            sel!(resignFirstResponder),
            resign_first_responder as extern "C" fn(_, Sel) -> Bool,
        );
    }
}

/// GPUI windows subclass either `NSWindow` or `NSPanel`.
fn window_superclass(this: &AnyObject) -> &'static AnyClass {
    // SAFETY: `this` is a live window.
    let is_panel: bool = unsafe { msg_send![this, isKindOfClass: class!(NSPanel)] };
    if is_panel {
        class!(NSPanel)
    } else {
        class!(NSWindow)
    }
}

/// Asks GPUI which native view, if any, a point in window coordinates reaches.
pub(super) fn hit_test_native_view(
    window_state: &Rc<Mutex<MacWindowState>>,
    position_in_window: NSPoint,
) -> Option<NativeViewId> {
    // AppKit can hit-test while the state is locked for another call into it.
    let mut lock = window_state.try_lock()?;
    if !lock.native_views.is_showing_any() {
        return None;
    }
    let position = convert_mouse_position(position_in_window, lock.view_frame());
    let mut callback = lock.native_views.hit_test_callback.take()?;
    drop(lock);
    let id = callback(position);
    let mut lock = window_state.lock();
    lock.native_views.hit_test_callback = Some(callback);
    id.filter(|id| {
        lock.native_views
            .shown(*id)
            .is_some_and(|attached| attached.covers(position_in_window))
    })
}

/// The view inside `container` that a point in the container's superview
/// reaches. GPUI's unsnapped bounds can take in an edge that AppKit leaves out,
/// so a miss is tried again just inside the container, and only then given to
/// the native view itself.
fn hit_test_container(container: &NSView, view: &NSView, point: NSPoint) -> *mut AnyObject {
    // SAFETY: The container is a live view.
    let hit: *mut AnyObject = unsafe { msg_send![container, hitTest: point] };
    if !hit.is_null() {
        return hit;
    }
    let frame = container.frame();
    let inside = |value: f64, origin: f64, length: f64| {
        if length.is_nan() || length <= 0. || !value.is_finite() {
            return origin;
        }
        let margin = (length / 2.).min(1. / 1024.);
        value.clamp(origin + margin, origin + length - margin)
    };
    let inner = NSPoint::new(
        inside(point.x, frame.origin.x, frame.size.width),
        inside(point.y, frame.origin.y, frame.size.height),
    );
    // SAFETY: The container is a live view.
    let hit: *mut AnyObject = unsafe { msg_send![container, hitTest: inner] };
    if hit.is_null() {
        view as *const NSView as *mut AnyObject
    } else {
        hit
    }
}

/// The container of the native view GPUI routes a point in window coordinates
/// to, with the view inside it that the point reaches.
pub(super) fn native_view_hit_at(
    window_state: &Rc<Mutex<MacWindowState>>,
    position_in_window: NSPoint,
) -> Option<(Retained<NSView>, Retained<NSView>)> {
    let id = hit_test_native_view(window_state, position_in_window)?;
    let (container, view) = {
        let lock = window_state.try_lock()?;
        let attached = lock.native_views.shown(id)?;
        (attached.container.clone(), attached.view.clone())
    };
    let superview = unsafe { container.superview() }?;
    let point = superview.convertPoint_fromView(position_in_window, None);
    let hit = hit_test_container(&container, &view, point);
    let hit = unsafe { Retained::retain(hit.cast::<NSView>()) }?;
    Some((container, hit))
}

/// Lets mouse events that GPUI routes to a native view fall through to it.
extern "C" fn hit_test(this: &AnyObject, _: Sel, point: NSPoint) -> *mut AnyObject {
    // SAFETY: `this` is the live GPUI view, whose state outlives it.
    unsafe {
        // AppKit can ask while the view is being torn down, after its state
        // has gone and it has left its superview.
        let superview: *mut AnyObject = msg_send![this, superview];
        if let Some(window_state) = window_state_if_set(this)
            && !superview.is_null()
        {
            let position_in_window: NSPoint =
                msg_send![superview, convertPoint: point, toView: ptr::null::<AnyObject>()];
            if let Some(id) = hit_test_native_view(&window_state, position_in_window) {
                // AppKit would pass the point to the frontmost sibling, which
                // takes it even where its rounded corners show the view behind.
                let shown = window_state.try_lock().and_then(|lock| {
                    lock.native_views
                        .shown(id)
                        .map(|attached| (attached.container.clone(), attached.view.clone()))
                });
                return shown.map_or(ptr::null_mut(), |(container, view)| {
                    hit_test_container(&container, &view, point)
                });
            }
        }
        msg_send![super(this, class!(NSView)), hitTest: point]
    }
}

/// Notes which native view a mouse-down is headed for while AppKit delivers it,
/// which is the only time a native view may take first responder on its own, and
/// offers GPUI a key press ahead of the native view that would receive it.
///
/// GPUI is also given the mouse-down, which reaches nothing behind the view but
/// lets the window's own content notice a press outside it.
extern "C" fn send_event(this: &AnyObject, _: Sel, event: *mut AnyObject) {
    let superclass = window_superclass(this);
    // SAFETY: `this` is a live GPUI window and `event` a live `NSEvent`.
    unsafe {
        route_send_event(
            this,
            window_state_if_set(this),
            event,
            || msg_send![super(this, superclass), sendEvent: event],
        )
    }
}

pub(super) unsafe fn route_send_event(
    this: &AnyObject,
    window_state: Option<Rc<Mutex<MacWindowState>>>,
    event: *mut AnyObject,
    call_super: impl FnOnce(),
) {
    unsafe {
        let Some(window_state) = window_state else {
            return call_super();
        };
        if let Some(key_down) = key_down_for_native_view(&window_state, this, event) {
            let key_code: u16 = msg_send![event, keyCode];
            if offer_key_down_before_native_view(&window_state, key_down) {
                note_key_taken_before_view(&window_state, key_code, true);
                return;
            }
            note_key_taken_before_view(&window_state, key_code, false);
            window_state.lock().native_views.delivering_key_down = true;
            call_super();
            window_state.lock().native_views.delivering_key_down = false;
            return;
        }

        let event_type: NSEventType = msg_send![event, type];
        if event_type == NSEventType::KeyUp {
            let key_code: u16 = msg_send![event, keyCode];
            let was_taken = window_state.try_lock().is_some_and(|mut lock| {
                let taken = &mut lock.native_views.keys_taken_before_view;
                let count = taken.len();
                taken.retain(|taken| *taken != key_code);
                taken.len() != count
            });
            if was_taken {
                if let Some(key_up) = platform_input_from_native(event, None) {
                    pass_input_to_gpui(&window_state, key_up);
                }
                return;
            }
        }
        if event_type == NSEventType::FlagsChanged {
            // The view with keyboard input is sent the change, and GPUI isn't,
            // though what GPUI draws can depend on the modifiers held.
            call_super();
            if let Some(modifiers_changed) =
                modifiers_changed_beside_view(&window_state, this, event)
            {
                pass_input_to_gpui(&window_state, modifiers_changed);
            }
            return;
        }
        if event_type == NSEventType::MouseMoved {
            let position: NSPoint = msg_send![event, locationInWindow];
            update_pointer_over_view(&window_state, position);
        }
        let clicked = if matches!(
            event_type,
            NSEventType::LeftMouseDown | NSEventType::RightMouseDown | NSEventType::OtherMouseDown
        ) {
            let position: NSPoint = msg_send![event, locationInWindow];
            // GPUI knows where its own content leaves a native view uncovered,
            // but not what else AppKit has in front of the view there.
            hit_test_native_view(&window_state, position)
                .and_then(|_| native_view_under_press(&window_state, this, position))
        } else {
            None
        };
        if clicked.is_none() {
            let is_release = matches!(
                event_type,
                NSEventType::LeftMouseUp | NSEventType::RightMouseUp | NSEventType::OtherMouseUp
            );
            // GPUI was told of the press, so it is told of the release too, or
            // it would go on treating the button as held.
            let release = is_release
                .then(|| {
                    let button: isize = msg_send![event, buttonNumber];
                    let mut lock = window_state.try_lock()?;
                    lock.native_views
                        .take_button_pressed_in_view(button)
                        .then(|| lock.view_frame())
                })
                .flatten()
                .and_then(|view_frame| platform_input_from_native(event, Some(view_frame)));
            call_super();
            if let Some(release) = release {
                pass_input_to_gpui(&window_state, release);
            }
            return;
        }
        let button: isize = msg_send![event, buttonNumber];
        let view_frame = {
            let mut lock = window_state.lock();
            lock.native_views.clicked = clicked;
            lock.native_views.note_button_pressed_in_view(button);
            lock.view_frame()
        };
        // GPUI goes first, so that focus it moves in response, such as a dismissed
        // popover restoring focus, doesn't take keyboard input back from the view.
        if let Some(mouse_down) = platform_input_from_native(event, Some(view_frame)) {
            pass_input_to_gpui(&window_state, mouse_down);
        }
        call_super();
        window_state.lock().native_views.clicked = None;
    }
}

/// The native view that AppKit delivers a mouse press at this position to, if
/// it delivers it to one.
///
/// # Safety
///
/// `window` must be a live GPUI window, and the window state must be unlocked,
/// because hit-testing calls back into the GPUI view.
pub(super) unsafe fn native_view_under_press(
    window_state: &Rc<Mutex<MacWindowState>>,
    window: &AnyObject,
    position_in_window: NSPoint,
) -> Option<NativeViewId> {
    // SAFETY: The caller guarantees that `window` is live, and its views are live
    // while they are in it.
    let recipient: *mut AnyObject = unsafe {
        let content_view: *mut AnyObject = msg_send![window, contentView];
        if content_view.is_null() {
            return None;
        }
        // The view around the content view holds the titlebar's controls too.
        // It has no superview, so it is asked in the window's coordinates.
        let frame_view: *mut AnyObject = msg_send![content_view, superview];
        let root_view = if frame_view.is_null() {
            content_view
        } else {
            frame_view
        };
        msg_send![root_view, hitTest: position_in_window]
    };
    window_state.try_lock()?.native_views.containing(recipient)
}

/// Notes whether the pointer is over a native view, and has AppKit rebuild the
/// GPUI view's cursor rectangles when that changes.
fn update_pointer_over_view(window_state: &Rc<Mutex<MacWindowState>>, position_in_window: NSPoint) {
    let over_view = hit_test_native_view(window_state, position_in_window).is_some();
    let Some(mut lock) = window_state.try_lock() else {
        return;
    };
    if lock.native_views.pointer_over_view == over_view {
        return;
    }
    lock.native_views.pointer_over_view = over_view;
    let native_window = lock.native_window;
    let gpui_view = lock.native_view.as_ptr();
    drop(lock);
    // SAFETY: The window and the GPUI view are live, and events are sent on the main
    // thread. The state is unlocked in case AppKit rebuilds the rectangles at once,
    // which calls back into the view.
    unsafe {
        let _: () = msg_send![native_window, invalidateCursorRectsForView: gpui_view];
    }
}

/// Notes that a scene was drawn, after which [`check_pointer_after_frame`]
/// looks for the pointer again.
pub(super) fn scene_drawn(state: &mut MacWindowState, scene: &Scene) {
    let views = &mut state.native_views;
    // A scene that shows no view can only take the pointer off one.
    views.drew_since_pointer_check =
        views.pointer_over_view || scene.attached_native_views().next().is_some();
}

/// Looks again for whether the pointer is over a native view, if a scene was
/// drawn since it last moved: something GPUI drew may now be under it, or
/// may have gone from over the view.
///
/// This runs after a frame, not as its scene is drawn, because finding what
/// is under the pointer calls back into the window.
pub(super) fn check_pointer_after_frame(window_state: &Rc<Mutex<MacWindowState>>) {
    let native_window = {
        let Some(mut lock) = window_state.try_lock() else {
            return;
        };
        if !std::mem::take(&mut lock.native_views.drew_since_pointer_check) {
            return;
        }
        lock.native_window
    };
    // SAFETY: The window is live for as long as its state, and frames are
    // drawn on the main thread.
    let position: NSPoint = unsafe { msg_send![native_window, mouseLocationOutsideOfEventStream] };
    update_pointer_over_view(window_state, position);
}

/// Whether a native view sets the cursor, because the pointer is over it.
///
/// The GPUI view lies over every native view, so its own cursor would
/// otherwise replace the one the native view chooses.
pub(super) fn native_view_sets_cursor(state: &MacWindowState) -> bool {
    state.native_views.pointer_over_view && state.native_views.is_showing_any()
}

extern "C" fn make_first_responder(this: &AnyObject, _: Sel, responder: *mut AnyObject) -> Bool {
    let superclass = window_superclass(this);
    // SAFETY: `this` is a live GPUI window and `responder` is null or a live responder.
    unsafe {
        route_make_first_responder(
            this,
            window_state_if_set(this),
            responder,
            || msg_send![super(this, superclass), makeFirstResponder: responder],
        )
    }
}

pub(super) unsafe fn route_make_first_responder(
    this: &AnyObject,
    window_state: Option<Rc<Mutex<MacWindowState>>>,
    responder: *mut AnyObject,
    call_super: impl FnOnce() -> Bool,
) -> Bool {
    unsafe {
        let Some(window_state) = window_state else {
            return call_super();
        };
        // The state is locked while a window is still being set up, before it has native views.
        let Some(lock) = window_state.try_lock() else {
            return call_super();
        };
        if lock.native_views.views.is_empty() {
            drop(lock);
            return call_super();
        }
        let views = &lock.native_views;
        let gpui_view = lock.native_view.as_ptr();
        let native_window = lock.native_window;
        let current: *mut AnyObject = msg_send![this, firstResponder];
        let current = views.holder(current, native_window, gpui_view);
        let requested = views.holder(responder, native_window, gpui_view);
        let focused = views.focused();
        let clicked = views.clicked;
        let requested_is_shown =
            matches!(requested, InputHolder::NativeView(id) if views.shown(id).is_some());
        drop(lock);

        let voice_over_enabled: bool =
            msg_send![&*NSWorkspace::sharedWorkspace(), isVoiceOverEnabled];
        let voice_over_reaches_it = voice_over_enabled && requested_is_shown;
        if !may_take_input(requested, current, focused, clicked, voice_over_reaches_it) {
            return Bool::NO;
        }

        let accepted = call_super();
        if !accepted.as_bool() {
            return accepted;
        }

        if let InputHolder::NativeView(requested) = requested {
            // AppKit reports success even when the view declines to become first
            // responder, which leaves the window itself with keyboard input.
            let took_input = {
                let mut lock = window_state.lock();
                let current: *mut AnyObject = msg_send![this, firstResponder];
                let views = &mut lock.native_views;
                let took_input = views.containing(current) == Some(requested);
                if !took_input {
                    views.declined = Some(requested);
                } else if views.declined == Some(requested) {
                    views.declined = None;
                }
                took_input
            };
            if took_input && focused.is_none_or(|focused| focused.id != requested) {
                let callback = window_state.lock().native_views.focused_callback.take();
                if let Some(mut callback) = callback {
                    callback(requested);
                    window_state.lock().native_views.focused_callback = Some(callback);
                }
            }
        }
        // GPUI records a view that took keyboard input as focused when it follows.
        // If it could not, such as while the window's focus is disabled, this takes
        // first responder back so the two never disagree. Anything else that moved
        // first responder away from the view GPUI has focused is undone too, such as
        // AppKit handing it to the window itself, or a full screen transition
        // restoring it to the GPUI view. A view that declined keyboard input isn't
        // asked again, and the GPUI view takes it.
        reconcile_first_responder(&window_state);
        accepted
    }
}

/// Returns the key press `event` describes, if a native view would receive it.
///
/// # Safety
///
/// `window` must be a live GPUI window and `event` a live `NSEvent`.
unsafe fn key_down_for_native_view(
    window_state: &Rc<Mutex<MacWindowState>>,
    window: &AnyObject,
    event: *mut AnyObject,
) -> Option<KeyDownEvent> {
    // SAFETY: The caller guarantees that `window` and `event` are live.
    unsafe {
        let event_type: NSEventType = msg_send![event, type];
        if event_type != NSEventType::KeyDown {
            return None;
        }
        let mut lock = window_state.try_lock()?;
        if lock.native_views.views.is_empty() {
            return None;
        }
        // AppKit can move first responder without asking the window, such as when
        // the responder leaves the view hierarchy. The press belongs to the view
        // GPUI has focused, so first responder is returned to it before routing.
        if lock
            .native_views
            .focused
            .is_some_and(|id| lock.native_views.shown(id).is_some())
        {
            drop(lock);
            reconcile_first_responder(window_state);
            lock = window_state.try_lock()?;
        }
        let first_responder: *mut AnyObject = msg_send![window, firstResponder];
        lock.native_views.containing(first_responder)?;
        let view_frame = lock.view_frame();
        drop(lock);
        match platform_input_from_native(event, Some(view_frame))? {
            PlatformInput::KeyDown(key_down) => Some(key_down),
            _ => None,
        }
    }
}

/// Records whether GPUI took the press of a key ahead of the native view,
/// which decides where the key's release goes.
fn note_key_taken_before_view(
    window_state: &Rc<Mutex<MacWindowState>>,
    key_code: u16,
    taken: bool,
) {
    let mut lock = window_state.lock();
    let keys = &mut lock.native_views.keys_taken_before_view;
    keys.retain(|key| *key != key_code);
    if taken {
        keys.push(key_code);
    }
}

/// Returns a change of modifiers for GPUI to hear of, if a native view has
/// keyboard input and GPUI hasn't heard of this change.
///
/// # Safety
///
/// `window` must be a live GPUI window and `event` a live `NSEvent`.
unsafe fn modifiers_changed_beside_view(
    window_state: &Rc<Mutex<MacWindowState>>,
    window: &AnyObject,
    event: *mut AnyObject,
) -> Option<PlatformInput> {
    // SAFETY: The caller guarantees that `window` and `event` are live.
    unsafe {
        let mut lock = window_state.try_lock()?;
        if lock.native_views.views.is_empty() {
            return None;
        }
        let first_responder: *mut AnyObject = msg_send![window, firstResponder];
        lock.native_views.containing(first_responder)?;
        let input = platform_input_from_native(event, None)?;
        let PlatformInput::ModifiersChanged(current) = &input else {
            return None;
        };
        if let Some(PlatformInput::ModifiersChanged(previous)) =
            &lock.previous_modifiers_changed_event
            && previous.modifiers == current.modifiers
            && previous.capslock == current.capslock
        {
            return None;
        }
        lock.previous_modifiers_changed_event = Some(input.clone());
        Some(input)
    }
}

/// Offers GPUI a key press that a native view has not seen, and returns whether GPUI used it.
fn offer_key_down_before_native_view(
    window_state: &Rc<Mutex<MacWindowState>>,
    key_down: KeyDownEvent,
) -> bool {
    let Some(mut callback) = window_state
        .lock()
        .native_views
        .key_down_before_callback
        .take()
    else {
        return false;
    };
    let handled = callback(key_down);
    window_state.lock().native_views.key_down_before_callback = Some(callback);
    handled
}

/// Dispatches a key press that no native view used, and returns whether GPUI used it.
///
/// This skips the input method handling a key press gets when the GPUI view
/// has keyboard input, because the native view has already done its own.
fn pass_key_down_to_gpui(window_state: &Rc<Mutex<MacWindowState>>, key_down: KeyDownEvent) -> bool {
    pass_input_to_gpui(window_state, PlatformInput::KeyDown(key_down))
}

/// Dispatches input in GPUI, and returns whether GPUI used it.
fn pass_input_to_gpui(window_state: &Rc<Mutex<MacWindowState>>, input: PlatformInput) -> bool {
    let Some(mut callback) = window_state.lock().event_callback.take() else {
        return false;
    };
    let handled = !callback(input).propagate;
    window_state.lock().event_callback = Some(callback);
    handled
}

/// Lets the native view with keyboard input perform a key equivalent before GPUI.
///
/// AppKit otherwise asks the views in an order that doesn't depend on which
/// one has keyboard input, so that view is asked here, and the containers of
/// the native views keep AppKit's own search out of them.
extern "C" fn window_perform_key_equivalent(
    this: &AnyObject,
    _: Sel,
    event: *mut AnyObject,
) -> Bool {
    let superclass = window_superclass(this);
    // SAFETY: `this` is a live GPUI window and `event` a live `NSEvent`.
    unsafe {
        route_perform_key_equivalent(
            this,
            window_state_if_set(this),
            event,
            || msg_send![super(this, superclass), performKeyEquivalent: event],
        )
    }
}

pub(super) unsafe fn route_perform_key_equivalent(
    this: &AnyObject,
    window_state: Option<Rc<Mutex<MacWindowState>>>,
    event: *mut AnyObject,
    call_super: impl FnOnce() -> Bool,
) -> Bool {
    unsafe {
        let Some(window_state) = window_state else {
            return call_super();
        };
        let Some(key_down) = key_down_for_native_view(&window_state, this, event) else {
            return call_super();
        };
        let delivering_key_down = window_state.lock().native_views.delivering_key_down;
        if !delivering_key_down
            && offer_key_down_before_native_view(&window_state, key_down.clone())
        {
            let key_code: u16 = msg_send![event, keyCode];
            note_key_taken_before_view(&window_state, key_code, true);
            return Bool::YES;
        }

        let view = native_view_with_keyboard_input(&window_state, this);
        window_state.lock().native_views.routing_key_equivalent = true;
        let mut performed = match &view {
            Some(view) => msg_send![&**view, performKeyEquivalent: event],
            None => Bool::NO,
        };
        if !performed.as_bool() {
            // The rest of the window is asked next, such as a control in the titlebar.
            performed = call_super();
        }
        window_state.lock().native_views.routing_key_equivalent = false;
        if performed.as_bool() || delivering_key_down {
            return performed;
        }

        // No view performed it. For a web view that means the page has already
        // seen the key and left it, since a web view claims every key equivalent
        // the first time and sends back the ones its page doesn't use.
        window_state.lock().native_views.passed_up_key_equivalent = Retained::retain(event);
        Bool::new(pass_key_down_to_gpui(&window_state, key_down))
    }
}

/// The attached view that first responder is, or is inside.
///
/// # Safety
///
/// `window` must be a live GPUI window.
unsafe fn native_view_with_keyboard_input(
    window_state: &Rc<Mutex<MacWindowState>>,
    window: &AnyObject,
) -> Option<Retained<NSView>> {
    let lock = window_state.try_lock()?;
    // SAFETY: The caller guarantees that `window` is live.
    let first_responder: *mut AnyObject = unsafe { msg_send![window, firstResponder] };
    let id = lock.native_views.containing(first_responder)?;
    let attached = lock.native_views.views.iter().find(|view| view.id == id)?;
    Some(attached.view.clone())
}

/// Gives GPUI a key press that came back up the responder chain unused.
extern "C" fn window_key_down(this: &AnyObject, _: Sel, event: *mut AnyObject) {
    let superclass = window_superclass(this);
    // SAFETY: `this` is a live GPUI window and `event` a live `NSEvent`.
    unsafe {
        route_key_down(
            this,
            window_state_if_set(this),
            event,
            || msg_send![super(this, superclass), keyDown: event],
        )
    }
}

pub(super) unsafe fn route_key_down(
    this: &AnyObject,
    window_state: Option<Rc<Mutex<MacWindowState>>>,
    event: *mut AnyObject,
    call_super: impl FnOnce(),
) {
    unsafe {
        let Some(window_state) = window_state else {
            return call_super();
        };
        let Some(key_down) = key_down_for_native_view(&window_state, this, event) else {
            return call_super();
        };
        let passed_up = window_state
            .lock()
            .native_views
            .passed_up_key_equivalent
            .take();
        let already_passed_up =
            passed_up.is_some_and(|passed_up| ptr::eq(Retained::as_ptr(&passed_up), event));
        if !already_passed_up {
            pass_key_down_to_gpui(&window_state, key_down);
        }
        // The window's own handling of an unused key press is to beep.
    }
}

/// Whether the window is routing the current key equivalent itself.
pub(super) fn is_routing_key_equivalent(window_state: &Rc<Mutex<MacWindowState>>) -> bool {
    window_state
        .try_lock()
        .is_some_and(|lock| lock.native_views.routing_key_equivalent)
}

/// Whether assistive technology should treat the GPUI view as focused, which
/// it isn't while a native view has keyboard input.
pub(super) fn gpui_view_is_focused(state: &MacWindowState) -> bool {
    let native_window = state.native_window();
    if !native_window.isKeyWindow() {
        return false;
    }
    if state.native_views.views.is_empty() {
        return true;
    }
    // SAFETY: The window is live for as long as its state.
    let first_responder: *mut AnyObject = unsafe { msg_send![state.native_window, firstResponder] };
    first_responder == state.native_view.as_ptr()
}

/// Tells the accessibility adapter whether the GPUI view is first responder,
/// which the window does not report correctly while that is changing.
fn update_accessibility_focus(window_state: &Rc<Mutex<MacWindowState>>, is_first_responder: bool) {
    let events = {
        let Some(mut lock) = window_state.try_lock() else {
            return;
        };
        let is_focused = is_first_responder && lock.native_window().isKeyWindow();
        lock.accesskit_adapter
            .as_mut()
            .and_then(|adapter| adapter.update_view_focus_state(is_focused))
    };
    if let Some(events) = events {
        events.raise();
    }
}

extern "C" fn become_first_responder(this: &AnyObject, _: Sel) -> Bool {
    // SAFETY: `this` is the live GPUI view, whose state outlives it.
    unsafe {
        let accepted: Bool = msg_send![super(this, class!(NSView)), becomeFirstResponder];
        let Some(window_state) = window_state_if_set(this) else {
            return accepted;
        };
        // The state is locked while the window is still being set up.
        let Some(lock) = window_state.try_lock() else {
            return accepted;
        };
        if !accepted.as_bool() || lock.native_views.views.is_empty() {
            return accepted;
        }
        // A native first responder consumes modifier changes, so GPUI may have missed
        // some. GPUI can be in the middle of an update here, so report them afterwards.
        let executor = lock.foreground_executor.clone();
        drop(lock);
        update_accessibility_focus(&window_state, true);
        executor
            .spawn(async move {
                let event = PlatformInput::ModifiersChanged(ModifiersChangedEvent {
                    modifiers: current_modifiers(),
                    capslock: current_capslock(),
                });
                let mut lock = window_state.lock();
                let unchanged = matches!(
                    (&lock.previous_modifiers_changed_event, &event),
                    (
                        Some(PlatformInput::ModifiersChanged(previous)),
                        PlatformInput::ModifiersChanged(current),
                    ) if previous.modifiers == current.modifiers
                        && previous.capslock == current.capslock
                );
                if unchanged {
                    return;
                }
                lock.previous_modifiers_changed_event = Some(event.clone());
                if let Some(mut callback) = lock.event_callback.take() {
                    drop(lock);
                    callback(event);
                    window_state.lock().event_callback = Some(callback);
                }
            })
            .detach();
        accepted
    }
}

extern "C" fn resign_first_responder(this: &AnyObject, _: Sel) -> Bool {
    // SAFETY: `this` is the live GPUI view, whose state outlives it.
    unsafe {
        let accepted: Bool = msg_send![super(this, class!(NSView)), resignFirstResponder];
        let Some(window_state) = window_state_if_set(this) else {
            return accepted;
        };
        let has_native_views = window_state
            .try_lock()
            .is_some_and(|lock| !lock.native_views.views.is_empty());
        if accepted.as_bool() && has_native_views {
            // Keyboard input is leaving GPUI, so an unfinished composition ends here,
            // as it would in a native text view.
            with_input_handler(this, |input_handler| input_handler.unmark_text());
            let input_context: *mut AnyObject = msg_send![this, inputContext];
            let _: () = msg_send![input_context, discardMarkedText];
            update_accessibility_focus(&window_state, false);
        }
        accepted
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{point, size};

    #[test]
    fn placement_clips_a_view_to_its_content_mask() {
        let scaled = |x: f32, y: f32, width: f32, height: f32| Bounds {
            origin: point(ScaledPixels::from(x), ScaledPixels::from(y)),
            size: size(ScaledPixels::from(width), ScaledPixels::from(height)),
        };
        // A 400 by 300 point GPUI view at twice the scale, 10 points above the
        // bottom of the content view.
        let gpui_frame = [0., 10., 400., 300.];
        let bounds = scaled(100., 40., 200., 400.);
        let place = |mask| Placement::new(&native_view(bounds, mask), 2., gpui_frame);

        let unclipped = place(scaled(0., 0., 800., 600.));
        assert_eq!(
            unclipped,
            Some(Placement {
                container: [50., 90., 100., 200.],
                bounds: [100., 200.],
                view: [0., 0., 100., 200.],
                alpha: 1.,
            })
        );

        // Clipping the top 60 and left 20 pixels shrinks the container, and the
        // view keeps its size and stays where it was in the window.
        let clipped = place(scaled(120., 100., 800., 600.));
        assert_eq!(
            clipped,
            Some(Placement {
                container: [60., 90., 90., 170.],
                bounds: [90., 170.],
                view: [-10., 0., 100., 200.],
                alpha: 1.,
            })
        );

        let hidden = place(scaled(0., 500., 800., 100.));
        assert_eq!(hidden, None);
    }

    #[test]
    fn keyboard_input_follows_gpui_focus_except_from_views_gpui_did_not_attach() {
        use InputHolder::{GpuiView, NativeView, Other, Window};
        let shown = focused(1, true);
        let hidden = focused(1, false);
        let to_view = Some(InputTarget::NativeView(id(1)));
        let to_gpui = Some(InputTarget::GpuiView);
        for (focused, current, moves_to) in [
            // Focusing a native view gives it keyboard input, wherever that was.
            (shown, GpuiView, to_view),
            (shown, Window, to_view),
            (shown, NativeView(id(2)), to_view),
            (shown, NativeView(id(1)), None),
            // Focusing GPUI's own content takes it back.
            (None, NativeView(id(1)), to_gpui),
            (None, Window, to_gpui),
            (None, GpuiView, None),
            // So does hiding the focused view.
            (hidden, NativeView(id(1)), to_gpui),
            (hidden, GpuiView, None),
            // A control GPUI knows nothing about keeps it either way.
            (shown, Other, None),
            (None, Other, None),
        ] {
            assert_eq!(
                input_target_for_focus(focused, current),
                moves_to,
                "focused: {focused:?}, current: {current:?}"
            );
        }
    }

    #[test]
    fn views_take_keyboard_input_only_when_gpui_focus_a_click_or_voice_over_allows() {
        use InputHolder::{GpuiView, NativeView, Other};
        let (view, view_2) = (NativeView(id(1)), NativeView(id(2)));
        let (shown, hidden) = (focused(1, true), focused(1, false));
        let (click, click_2) = (Some(id(1)), Some(id(2)));

        // A page asking on its own is refused, as is a view other than the one
        // GPUI focused or the one being clicked.
        assert!(!may_take_input(view, GpuiView, None, None, false));
        assert!(!may_take_input(view_2, GpuiView, shown, None, false));
        assert!(!may_take_input(view, GpuiView, None, click_2, false));
        // GPUI's focus allows it, even before the view is shown. So do a click
        // on the view and VoiceOver's cursor.
        assert!(may_take_input(view, GpuiView, shown, None, false));
        assert!(may_take_input(view, GpuiView, hidden, None, false));
        assert!(may_take_input(view, GpuiView, None, click, false));
        assert!(may_take_input(view, GpuiView, None, None, true));

        // AppKit offers the GPUI view every press inside it, which is refused
        // while the focused native view is shown and has keyboard input.
        assert!(!may_take_input(GpuiView, view, shown, None, false));
        // It is accepted once GPUI's focus has left the view, while the view is
        // being hidden, and from a view that isn't the focused one.
        assert!(may_take_input(GpuiView, view, None, None, false));
        assert!(may_take_input(GpuiView, view, hidden, None, false));
        assert!(may_take_input(GpuiView, view_2, shown, None, false));

        // A control GPUI did not attach takes it freely.
        assert!(may_take_input(Other, view, shown, None, false));
    }

    #[test]
    fn a_view_that_declines_keyboard_input_leaves_it_with_the_gpui_view() {
        use InputHolder::{GpuiView, NativeView, Window};
        let declined = Some(FocusedNativeView {
            id: id(1),
            shown: true,
            declined: true,
        });
        // AppKit leaves the window itself with keyboard input when a view
        // declines it. Asking the view again would never end.
        assert_eq!(
            input_target_for_focus(declined, Window),
            Some(InputTarget::GpuiView)
        );
        assert_eq!(input_target_for_focus(declined, GpuiView), None);
        // The view can still take keyboard input itself, such as on a click.
        assert!(may_take_input(
            NativeView(id(1)),
            GpuiView,
            declined,
            Some(id(1)),
            false
        ));
    }

    #[test]
    fn gpui_is_owed_the_release_of_each_button_pressed_in_a_native_view() {
        let mut views = NativeViews::default();
        views.note_button_pressed_in_view(0);
        views.note_button_pressed_in_view(1);
        // Releasing one button leaves the other held.
        assert!(views.take_button_pressed_in_view(0));
        assert!(!views.take_button_pressed_in_view(0));
        assert!(views.take_button_pressed_in_view(1));
        // A button pressed elsewhere reaches GPUI the usual way.
        assert!(!views.take_button_pressed_in_view(2));
    }

    #[test]
    fn stacking_puts_shown_views_between_the_gpui_view_and_everything_else() {
        // The views are only compared by address.
        let views = [0u8; 6];
        let [gpui_view, front, back, hidden, behind, above] =
            [0, 1, 2, 3, 4, 5].map(|index| NonNull::from(&views[index]).cast::<NSView>());
        // AppKit draws later subviews in front, and sorts ascending.
        let mut back_to_front = [front, behind, gpui_view, hidden, above, back];
        let mut stacking = Stacking {
            gpui_view: gpui_view.as_ptr(),
            front_to_back: vec![front.as_ptr(), back.as_ptr()],
            attached: vec![hidden.as_ptr(), back.as_ptr(), front.as_ptr()],
            back_layers: Vec::new(),
            current: back_to_front
                .iter()
                .map(|view| view.as_ptr().cast_const())
                .collect(),
        };

        back_to_front.sort_by(|first, second| {
            // SAFETY: `stacking` outlives the call, which never reads the views.
            let order = unsafe { compare_stacking(*first, *second, (&raw mut stacking).cast()) };
            match order {
                NSComparisonResult::Ascending => std::cmp::Ordering::Less,
                NSComparisonResult::Same => std::cmp::Ordering::Equal,
                NSComparisonResult::Descending => std::cmp::Ordering::Greater,
            }
        });
        // Views that aren't native views stay on their side of the GPUI view.
        assert_eq!(
            back_to_front,
            [behind, hidden, back, front, gpui_view, above]
        );
    }

    #[test]
    fn stacking_keeps_backdrop_layers_beneath_glass_and_native_views() {
        let views = [0u8; 7];
        let [gpui_view, web, glass, blur, overlay, stray, spare] =
            [0, 1, 2, 3, 4, 5, 6].map(|index| NonNull::from(&views[index]).cast::<NSView>());
        let mut back_to_front = [web, gpui_view, glass, stray, overlay, spare, blur];
        let mut stacking = Stacking {
            gpui_view: gpui_view.as_ptr(),
            front_to_back: vec![glass.as_ptr(), web.as_ptr()],
            attached: vec![web.as_ptr(), glass.as_ptr(), spare.as_ptr()],
            back_layers: vec![blur.as_ptr(), overlay.as_ptr()],
            current: back_to_front
                .iter()
                .map(|view| view.as_ptr().cast_const())
                .collect(),
        };
        back_to_front.sort_by(|first, second| {
            let order = unsafe { compare_stacking(*first, *second, (&raw mut stacking).cast()) };
            match order {
                NSComparisonResult::Ascending => std::cmp::Ordering::Less,
                NSComparisonResult::Same => std::cmp::Ordering::Equal,
                NSComparisonResult::Descending => std::cmp::Ordering::Greater,
            }
        });
        assert_eq!(
            back_to_front,
            [blur, overlay, spare, web, glass, gpui_view, stray]
        );
    }

    #[test]
    fn visual_effects_stack_with_glass_and_native_views_in_paint_order() {
        let effects = vec![(2, "sidebar material"), (5, "hud")];
        let glass = vec![(1, "tile"), (4, "popover")];
        let native = vec![(3, "page")];
        assert_eq!(
            merge_by_order(merge_units(effects, glass), native),
            ["tile", "sidebar material", "page", "popover", "hud"]
        );
    }

    #[test]
    fn glass_and_native_views_stack_in_paint_order() {
        let glass = vec![(1, "sidebar tile"), (4, "popover"), (6, "peek")];
        let native = vec![(1, "page"), (4, "devtools"), (5, "pip")];
        assert_eq!(
            merge_by_order(glass, native),
            ["sidebar tile", "page", "popover", "devtools", "pip", "peek"]
        );
        assert_eq!(merge_by_order(Vec::<(u32, u8)>::new(), vec![(2, 7)]), [7]);
    }

    fn glass_and_material_scene(material_x: f32) -> Scene {
        let rect = |x: f32| Bounds {
            origin: point(ScaledPixels(x), ScaledPixels(40.)),
            size: size(ScaledPixels(100.), ScaledPixels(60.)),
        };
        let window = Bounds {
            origin: point(ScaledPixels(0.), ScaledPixels(0.)),
            size: size(ScaledPixels(800.), ScaledPixels(600.)),
        };
        let glass = |id, order, x| gpui::LiquidGlassRegion {
            id,
            order,
            bounds: rect(x),
            content_mask: window,
            corner_radius: ScaledPixels(20.),
            tint: None,
            style: gpui::LiquidGlassStyle::Regular,
            group_id: Some(9),
            alpha: 1.,
        };
        let mut scene = Scene::default();
        scene.liquid_glass_regions = vec![glass(1, 1, 0.), glass(2, 3, 400.)];
        scene.visual_effect_regions = vec![gpui::VisualEffectRegion {
            id: 1,
            order: 2,
            bounds: rect(material_x),
            content_mask: window,
            corner_radii: gpui::Corners::default(),
            material: gpui::VisualEffectMaterial::HudWindow,
            blending: gpui::VisualEffectBlending::WithinWindow,
            state: gpui::VisualEffectState::Active,
            emphasized: false,
        }];
        scene
    }

    fn stack_glass_over_material(scene: &Scene) -> Vec<&'static str> {
        let layout = GlassLayout::with_groups(
            &scene.liquid_glass_regions,
            glass_occluders(scene),
            2.,
            [0., 0., 800., 600.],
            None,
            true,
        );
        let glass = layout.units(&["glass a", "glass b"], &["first group", "second group"]);
        merge_by_order(merge_units(vec![(2, "material")], glass), Vec::new())
    }

    #[test]
    fn a_material_painted_over_grouped_glass_splits_the_group_beneath_it() {
        let scene = glass_and_material_scene(0.);
        assert_eq!(
            stack_glass_over_material(&scene),
            ["first group", "material", "second group"]
        );
    }

    #[test]
    fn a_material_painted_between_grouped_glass_without_overlapping_it_keeps_the_group_like_a_native_view()
     {
        let scene = glass_and_material_scene(200.);
        assert_eq!(
            stack_glass_over_material(&scene),
            ["material", "first group"]
        );
    }

    #[test]
    fn corner_shape_rounds_whole_views_and_masks_clipped_ones() {
        let whole = Placement {
            container: [50., 90., 100., 200.],
            bounds: [100., 200.],
            view: [0., 0., 100., 200.],
            alpha: 1.,
        };
        assert_eq!(
            CornerShape::new(&whole, [10.; 4]),
            CornerShape::Rounded {
                radius: 10.,
                corners: 15
            }
        );
        assert_eq!(CornerShape::new(&whole, [0.; 4]), CornerShape::Square);
        assert_eq!(
            CornerShape::new(&whole, [400.; 4]),
            CornerShape::Rounded {
                radius: 50.,
                corners: 15
            }
        );
        assert_eq!(
            CornerShape::new(&whole, [0., 0., 10., 10.]),
            CornerShape::Rounded {
                radius: 10.,
                corners: 1 | 2
            }
        );

        let clipped = Placement {
            container: [60., 90., 90., 170.],
            bounds: [90., 170.],
            view: [-10., 0., 100., 200.],
            alpha: 1.,
        };
        assert_eq!(
            CornerShape::new(&clipped, [10., 10., 0., 0.]),
            CornerShape::Masked {
                frame: [-10., 0., 100., 200.],
                radius: 10.,
                corners: 4 | 8,
            }
        );

        assert_eq!(
            CornerShape::new(&whole, [4., 24., 0., f64::NAN]),
            CornerShape::Shaped {
                container: [100., 200.],
                frame: [0., 0., 100., 200.],
                radii: [4., 24., 0., 0.],
            }
        );
    }

    #[test]
    fn a_press_gpui_routes_beneath_a_rounded_view_reaches_the_view_beneath() {
        unsafe {
            let make = |x: f64, y: f64, size: f64| -> (Retained<NSView>, Retained<NSView>) {
                let container: Retained<NSView> = msg_send![container_class(), new];
                let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(size, size));
                let _: () = msg_send![&*container, setFrame: frame];
                let inner: Retained<NSView> = msg_send![class!(NSView), new];
                let bounds = NSRect::new(NSPoint::new(0., 0.), NSSize::new(size, size));
                let _: () = msg_send![&*inner, setFrame: bounds];
                container.addSubview(&inner);
                (container, inner)
            };
            let renderer: Retained<NSView> = msg_send![class!(NSView), new];
            let content: Retained<NSView> = msg_send![class!(NSView), new];
            let frame = NSRect::new(NSPoint::new(0., 0.), NSSize::new(200., 200.));
            let _: () = msg_send![&*content, setFrame: frame];
            let (lower, lower_inner) = make(0., 0., 100.);
            let (upper, upper_inner) = make(60., 60., 40.);
            CornerShape::new(
                &Placement {
                    container: [60., 60., 40., 40.],
                    bounds: [40., 40.],
                    view: [0., 0., 40., 40.],
                    alpha: 1.,
                },
                [20.; 4],
            )
            .apply(&upper);
            let whole = NSRect::new(NSPoint::new(0., 0.), NSSize::new(100., 100.));
            let _: () = msg_send![&*renderer, setFrame: whole];
            lower_inner.addSubview(&renderer);
            content.addSubview(&lower);
            content.addSubview(&upper);
            let corner = NSPoint::new(61., 99.);
            let appkit: *mut AnyObject = msg_send![&*content, hitTest: corner];
            assert_eq!(
                appkit,
                Retained::as_ptr(&upper_inner) as *mut AnyObject,
                "AppKit ignores the rounded mask"
            );
            let renderer_view = Retained::as_ptr(&renderer) as *mut AnyObject;
            assert_eq!(
                hit_test_container(&lower, &lower_inner, corner),
                renderer_view
            );
            let mut missed = 0;
            for edge in [
                NSPoint::new(100., 99.),
                NSPoint::new(40., 100.),
                NSPoint::new(40., 0.),
            ] {
                let lower_edge: *mut AnyObject = msg_send![&*lower, hitTest: edge];
                missed += usize::from(lower_edge.is_null());
                assert_eq!(
                    hit_test_container(&lower, &lower_inner, edge),
                    renderer_view,
                    "a press on the edge reaches the interactive view inside"
                );
            }
            assert!(missed >= 2, "AppKit leaves out the far edges");
        }
    }

    #[test]
    fn rounded_corners_are_left_out_of_hit_testing() {
        let size = [100., 200.];
        let radii = [4., 24., 0., 400.];
        assert!(rounded_rect_contains(size, radii, [50., 100.]));
        assert!(rounded_rect_contains(size, radii, [1.5, 198.5]));
        assert!(!rounded_rect_contains(size, radii, [0.5, 199.5]));
        assert!(!rounded_rect_contains(size, radii, [98., 198.]));
        assert!(rounded_rect_contains(size, radii, [90., 190.]));
        assert!(rounded_rect_contains(size, radii, [99.9, 0.1]));
        assert!(!rounded_rect_contains(size, radii, [2., 2.]));
        assert!(rounded_rect_contains(size, radii, [50., 50.]));
        assert!(!rounded_rect_contains(size, radii, [-1., 100.]));
        assert!(!rounded_rect_contains(size, radii, [50., 200.5]));
        assert!(rounded_rect_contains(size, [0.; 4], [0., 0.]));
    }

    fn native_view(bounds: Bounds<ScaledPixels>, mask: Bounds<ScaledPixels>) -> PaintNativeView {
        PaintNativeView::new(
            id(1),
            gpui::HitboxId::placeholder(),
            bounds,
            gpui::ContentMask { bounds: mask },
            gpui::Hsla::default(),
        )
    }

    #[test]
    fn placement_scales_a_view_through_its_container_at_its_layout_size() {
        let scaled = |x: f32, y: f32, width: f32, height: f32| Bounds {
            origin: point(ScaledPixels(x), ScaledPixels(y)),
            size: size(ScaledPixels(width), ScaledPixels(height)),
        };
        // A 100 by 200 point view at twice the scale, shown at half size
        // about the center of where it is laid out, and faded.
        let mut half = native_view(scaled(150., 140., 100., 200.), scaled(0., 0., 800., 600.));
        half.layout_size = size(ScaledPixels(200.), ScaledPixels(400.));
        half.scale = 0.5;
        half.opacity = 0.4;
        let gpui_frame = [0., 10., 400., 300.];
        assert_eq!(
            Placement::new(&half, 2., gpui_frame),
            Some(Placement {
                container: [75., 140., 50., 100.],
                bounds: [100., 200.],
                view: [0., 0., 100., 200.],
                alpha: f64::from(0.4f32),
            })
        );

        // Clipped, the view stays at its layout size and the container's
        // bounds take in only what shows.
        half.content_mask.bounds = scaled(0., 0., 800., 240.);
        assert_eq!(
            Placement::new(&half, 2., gpui_frame),
            Some(Placement {
                container: [75., 190., 50., 50.],
                bounds: [100., 100.],
                view: [0., -100., 100., 200.],
                alpha: f64::from(0.4f32),
            })
        );
    }

    #[test]
    fn placement_scales_a_view_along_each_axis_through_its_container_bounds() {
        let scaled = |x: f32, y: f32, width: f32, height: f32| Bounds {
            origin: point(ScaledPixels(x), ScaledPixels(y)),
            size: size(ScaledPixels(width), ScaledPixels(height)),
        };
        // A 100 point square at twice the scale, shown half as wide and
        // twice as tall about the center of where it is laid out.
        let mut stretched = native_view(scaled(150., 0., 100., 400.), scaled(0., 0., 800., 800.));
        stretched.layout_size = size(ScaledPixels(200.), ScaledPixels(200.));
        stretched.axis_scale = point(0.5, 2.);
        let gpui_frame = [0., 0., 400., 400.];
        assert_eq!(
            Placement::new(&stretched, 2., gpui_frame),
            Some(Placement {
                container: [75., 200., 50., 200.],
                bounds: [100., 100.],
                view: [0., 0., 100., 100.],
                alpha: 1.,
            })
        );

        // Along with a uniform scale, the axis scales multiply it.
        stretched.scale = 0.5;
        stretched.axis_scale = point(1., 4.);
        let placement = Placement::new(&stretched, 2., gpui_frame).unwrap();
        assert_eq!(placement.bounds, [100., 100.]);
    }

    #[test]
    fn an_upright_view_from_a_sheared_transform_fills_the_frame_gpui_hits() {
        let scaled = |x: f32, y: f32, width: f32, height: f32| Bounds {
            origin: point(ScaledPixels(x), ScaledPixels(y)),
            size: size(ScaledPixels(width), ScaledPixels(height)),
        };
        // What GPUI paints for a 200 by 100 point view centered on (200, 150)
        // inside `scale_xy(2., 1.)` and then `rotate` by an eighth of a turn:
        // upright, both axes stretched by the square root of 2.5, at twice
        // the scale in a 400 by 300 point GPUI view.
        let scale = 2.5f32.sqrt();
        let (width, height) = (200. * scale, 100. * scale);
        let bounds = scaled(
            2. * (200. - width / 2.),
            2. * (150. - height / 2.),
            2. * width,
            2. * height,
        );
        let mut upright = native_view(bounds, scaled(0., 0., 800., 600.));
        upright.layout_size = size(ScaledPixels(400.), ScaledPixels(200.));
        upright.scale = scale;
        let gpui_frame = [0., 0., 400., 300.];
        let placement = Placement::new(&upright, 2., gpui_frame).unwrap();
        let near = |actual: [f64; 4], expected: [f64; 4]| {
            actual
                .iter()
                .zip(expected)
                .all(|(actual, expected)| (actual - expected).abs() < 1e-3)
        };
        let (width, height) = (f64::from(width), f64::from(height));
        let frame = [200. - width / 2., 150. - height / 2., width, height];
        assert!(near(placement.container, frame), "{placement:?}");
        assert!(near(
            [0., 0., placement.bounds[0], placement.bounds[1]],
            [0., 0., 200., 100.]
        ));
        assert!(near(placement.view, [0., 0., 200., 100.]), "{placement:?}");

        unsafe {
            let content: Retained<NSView> = msg_send![class!(NSView), new];
            content.setFrame(NSRect::new(NSPoint::new(0., 0.), NSSize::new(400., 300.)));
            let container: Retained<NSView> = msg_send![container_class(), new];
            let page: Retained<NSView> = msg_send![class!(NSView), new];
            container.addSubview(&page);
            content.addSubview(&container);
            place(&container, &page, &placement);
            let corner =
                |x: f64, y: f64| page.convertPoint_toView(NSPoint::new(x, y), Some(&content));
            let (low, high) = (corner(0., 0.), corner(200., 100.));
            assert!(
                near([low.x, low.y, high.x - low.x, high.y - low.y], frame),
                "AppKit shows the page across exactly the frame GPUI hits"
            );
            let container_frame = container.frame();
            assert!(near(
                [
                    container_frame.origin.x,
                    container_frame.origin.y,
                    container_frame.size.width,
                    container_frame.size.height
                ],
                frame
            ));
            let layer: *mut AnyObject = msg_send![&*container, layer];
            if !layer.is_null() {
                let sublayer_transform: [f64; 16] = {
                    let transform: CATransform3DProbe = msg_send![layer, sublayerTransform];
                    transform.0
                };
                assert_eq!(sublayer_transform, CATransform3DProbe::IDENTITY.0);
            }
        }
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CATransform3DProbe([f64; 16]);

    impl CATransform3DProbe {
        const IDENTITY: Self = Self([
            1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
        ]);
    }

    // SAFETY: The layout matches `CATransform3D`, sixteen `CGFloat`s.
    unsafe impl objc2::Encode for CATransform3DProbe {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CATransform3D", &[f64::ENCODING; 16]);
    }

    fn place(container: &NSView, page: &NSView, placement: &Placement) {
        let to_rect = |[x, y, width, height]: [f64; 4]| {
            NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
        };
        container.setFrame(to_rect(placement.container));
        placement.transform_container(container);
        page.setFrame(to_rect(placement.view));
    }

    #[test]
    fn a_transformed_container_scales_and_fades_its_view_and_resets_exactly() {
        unsafe {
            let content: Retained<NSView> = msg_send![class!(NSView), new];
            content.setFrame(NSRect::new(NSPoint::new(0., 0.), NSSize::new(400., 400.)));
            content.setWantsLayer(true);
            let container: Retained<NSView> = msg_send![container_class(), new];
            let page: Retained<NSView> = msg_send![class!(NSView), new];
            let renderer: Retained<NSView> = msg_send![class!(NSView), new];
            renderer.setFrame(NSRect::new(NSPoint::new(50., 0.), NSSize::new(50., 50.)));
            page.addSubview(&renderer);
            container.addSubview(&page);
            content.addSubview(&container);

            // A 100 by 50 point page shown twice as wide and half as tall.
            let animated = Placement {
                container: [100., 100., 200., 25.],
                bounds: [100., 50.],
                view: [0., 0., 100., 50.],
                alpha: 0.5,
            };
            place(&container, &page, &animated);
            assert_eq!(container.alphaValue(), 0.5);
            let bounds = container.bounds();
            assert!(
                (bounds.size.width - 100.).abs() < 1e-9 && (bounds.size.height - 50.).abs() < 1e-9,
                "the container's bounds scale the view"
            );
            assert_eq!(page.frame().size, NSSize::new(100., 50.));
            let corner = page.convertPoint_toView(NSPoint::new(100., 50.), Some(&content));
            assert!((corner.x - 300.).abs() < 1e-9 && (corner.y - 125.).abs() < 1e-9);
            let renderer_view = Retained::as_ptr(&renderer) as *mut AnyObject;
            let page_view = Retained::as_ptr(&page) as *mut AnyObject;
            assert_eq!(
                hit_test_container(&container, &page, NSPoint::new(250., 110.)),
                renderer_view,
                "a press reaches what shows of the scaled page"
            );
            assert_eq!(
                hit_test_container(&container, &page, NSPoint::new(150., 110.)),
                page_view
            );

            let identity = Placement {
                container: [100., 100., 100., 50.],
                bounds: [100., 50.],
                view: [0., 0., 100., 50.],
                alpha: 1.,
            };
            place(&container, &page, &identity);
            assert_eq!(container.alphaValue(), 1.);
            assert_eq!(
                container.bounds(),
                NSRect::new(NSPoint::new(0., 0.), NSSize::new(100., 50.))
            );
            assert_eq!(
                page.convertPoint_toView(NSPoint::new(100., 50.), Some(&content)),
                NSPoint::new(200., 150.)
            );
        }
    }

    #[test]
    fn corner_shape_rounds_a_scaled_view_with_it() {
        let scaled = Placement {
            container: [50., 90., 50., 100.],
            bounds: [100., 200.],
            view: [0., 0., 100., 200.],
            alpha: 1.,
        };
        assert_eq!(
            CornerShape::new(&scaled, [10.; 4]),
            CornerShape::Rounded {
                radius: 10.,
                corners: 15
            },
            "the container's bounds scale its corners with the view"
        );
        let clipped = Placement {
            view: [0., -20., 100., 200.],
            ..scaled
        };
        assert_eq!(
            CornerShape::new(&clipped, [10.; 4]),
            CornerShape::Masked {
                frame: [0., -20., 100., 200.],
                radius: 10.,
                corners: 15,
            }
        );
        assert_eq!(CornerShape::new(&clipped, [0.; 4]), CornerShape::Square);
    }

    #[test]
    fn a_view_moved_into_a_full_screen_window_is_left_where_it_is_until_it_returns() {
        let rect = |[x, y, width, height]: [f64; 4]| {
            NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
        };
        let windowed = Placement {
            container: [100., 100., 400., 300.],
            bounds: [400., 300.],
            view: [0., 0., 400., 300.],
            alpha: 1.,
        };
        let resized = Placement {
            container: [50., 50., 600., 500.],
            bounds: [600., 500.],
            view: [0., 0., 600., 500.],
            alpha: 1.,
        };
        unsafe {
            let content: Retained<NSView> = msg_send![class!(NSView), new];
            let full_screen: Retained<NSView> = msg_send![class!(NSView), new];
            let container: Retained<NSView> = msg_send![container_class(), new];
            let page: Retained<NSView> = msg_send![class!(NSView), new];
            container.addSubview(&page);
            content.addSubview(&container);
            let mut attached = AttachedView {
                id: id(1),
                view: page.clone(),
                container: container.clone(),
                placement: None,
                placed_while_away: false,
                corner_radii: [0.; 4],
                corners: CornerShape::Square,
                _gesture_monitor: None,
            };
            assert!(attached.needs_placement(Some(windowed)));
            attached.placed_while_away = !place_view(&page, &container, &windowed);
            attached.placement = Some(windowed);
            assert_eq!(page.frame(), rect(windowed.view));

            // WebKit moves the page into its full-screen window and leaves a
            // placeholder in its place.
            page.removeFromSuperview();
            let placeholder: Retained<NSView> = msg_send![class!(NSView), new];
            container.addSubview(&placeholder);
            full_screen.addSubview(&page);
            page.setFrame(rect([0., 0., 1440., 900.]));
            let views = NativeViews {
                views: vec![attached],
                ..NativeViews::default()
            };
            assert!(views.shown(id(1)).is_none(), "nothing routes into it");
            assert!(!views.is_showing_any());
            let [mut attached] = <[AttachedView; 1]>::try_from(views.views).ok().unwrap();

            assert!(attached.needs_placement(Some(resized)));
            attached.placed_while_away = !place_view(&page, &container, &resized);
            attached.placement = Some(resized);
            assert!(attached.placed_while_away);
            assert_eq!(page.frame(), rect([0., 0., 1440., 900.]));
            assert!(
                page.superview()
                    .is_some_and(|superview| superview == full_screen)
            );
            assert_eq!(container.frame(), rect(resized.container));
            assert_eq!(placeholder.frame(), rect(resized.view));
            assert!(!attached.needs_placement(Some(resized)));

            // WebKit puts the page back at the size it had before full screen.
            placeholder.removeFromSuperview();
            page.removeFromSuperview();
            container.addSubview(&page);
            page.setFrame(rect(windowed.view));
            assert!(
                attached.needs_placement(Some(resized)),
                "the next sync places it again"
            );
            attached.placed_while_away = !place_view(&page, &container, &resized);
            assert!(!attached.placed_while_away);
            assert_eq!(page.frame(), rect(resized.view));

            // An attachment dropped while the page is away leaves it with WebKit.
            page.removeFromSuperview();
            full_screen.addSubview(&page);
            detach_view(&container, &page);
            assert!(container.superview().is_none());
            assert!(
                page.superview()
                    .is_some_and(|superview| superview == full_screen)
            );

            let home: Retained<NSView> = msg_send![class!(NSView), new];
            let other: Retained<NSView> = msg_send![class!(NSView), new];
            home.addSubview(&other);
            content.addSubview(&home);
            detach_view(&home, &other);
            assert!(home.superview().is_none() && other.superview().is_none());
        }
    }

    fn focused(view: u64, shown: bool) -> Option<FocusedNativeView> {
        Some(FocusedNativeView {
            id: id(view),
            shown,
            declined: false,
        })
    }

    fn id(id: u64) -> NativeViewId {
        NativeViewId::for_test(id)
    }
}
