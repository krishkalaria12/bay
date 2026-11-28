use crate::{Action, KeyBinding, KeyDownEvent, PlatformInput};
use crate::{
    AnyWindowHandle, App, Bounds, ContentMask, Corners, Element, ElementId, FocusHandle, FocusId,
    Focusable, GlobalElementId, Hitbox, HitboxBehavior, HitboxId, Hsla, InspectorElementId,
    InteractiveElement, IntoElement, LayoutId, PaintNativeView, ParentElement, Pixels, Point,
    ScaledPixels, Style, Styled, Window, div, px, scene::PaintTransform,
};
use anyhow::{Context as _, Result};
use collections::HashSet;
use std::{
    any::{Any, TypeId},
    cell::{Cell, RefCell},
    ffi::c_void,
    ptr::NonNull,
    rc::{Rc, Weak},
};

/// Identifies a [`NativeView`] within its window.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub struct NativeViewId(u64);

impl NativeViewId {
    pub(crate) const LIQUID_GLASS: Self = Self(u64::MAX);
}

#[cfg(any(test, feature = "test-support"))]
impl NativeViewId {
    /// Makes an ID for a test that needs one without a window to attach a view to.
    pub fn for_test(id: u64) -> Self {
        Self(id)
    }
}

/// A view owned by the platform's UI toolkit, shown inside a GPUI window.
///
/// Only macOS shows native views so far, where the view is an `NSView`.
/// [`NativeView::new`] fails on every other platform.
///
/// The view is composited beneath the window's GPUI content and shows through
/// wherever this handle is used as an element, so elements painted after it
/// cover it like they would cover any other element. The view is treated as
/// opaque.
///
/// Inside [`Window::with_transform_xy`], or an element styled with `scale` or
/// `scale_xy`, the view keeps its layout size and is scaled along each axis as
/// a whole about its center, so its content isn't laid out again while the
/// transform animates. A view is never turned: inside `rotate`, it stays
/// upright like an image, scaled by how much the transform stretches each of
/// its axes and centered where the transform moves its center, so a parent's
/// uneven scale under a turn doesn't shear it. Its frame, its hitbox and what
/// the renderer erases for it are then the same rectangle. Inside element
/// opacity, the view fades with its element. A fading view shows what is
/// behind the window's content, such as a native view beneath it, rather than
/// what the window painted beneath it.
///
/// A pinch over the view reaches the elements that hold it, which hear it
/// with [`InteractiveElement::on_pinch`], and not the elements behind it.
///
/// Mouse input over the view goes to the view, and to nothing behind it,
/// wherever no element painted after the view takes mouse input. An element
/// that is only drawn over the view covers it without taking its mouse input. The window's own content is still told of a mouse press
/// there, as a press outside every element. An element behind the view hears
/// no mouse moves while the pointer is over it, so follow a drag that can cross
/// the view with `on_drag_move`, or with an element in front of the view.
///
/// The view takes keyboard input directly from the platform while its
/// [`FocusHandle`] is focused, which a click on the view does, as can an
/// assistive technology such as VoiceOver moving its cursor into the view.
/// A key the view doesn't use is then dispatched from the view's element like
/// any other key press, so key bindings apply to what the view leaves.
///
/// Two kinds of key reach key bindings before the view. Bindings for actions
/// passed to [`reserve_action`](Self::reserve_action) apply first, and their
/// keys never reach the view. A key held with Command or Control is offered to
/// the view as a key equivalent, which is how a web view takes it; a view that
/// only takes such keys as ordinary key presses, as AppKit's text views do,
/// gets one after key bindings have had it.
///
/// The view may take a moment to leave a key, so the keys of any other
/// multi-key binding can reach the view when they are typed quickly.
///
/// The view stays attached to the window it was created in, hidden when it
/// isn't painted, until the last clone of this handle is dropped. Painted more
/// than once in a frame, it shows only where it was painted first. It shows
/// nothing as an element of any other window, so showing the same platform
/// view in another window takes dropping this handle and creating one there.
#[derive(Clone)]
pub struct NativeView(Rc<NativeViewState>);

pub(crate) struct NativeViewState {
    id: NativeViewId,
    window: AnyWindowHandle,
    focus_handle: FocusHandle,
    background: Cell<Hsla>,
    /// The hitbox of the occurrence that shows the view, which is the one
    /// painted first in a frame that paints the view more than once.
    shown_hitbox: Cell<Option<HitboxId>>,
    corner_radii: Cell<Corners<Pixels>>,
    /// The hitbox of the element that holds the shown occurrence, which a
    /// position in a rounded corner sees through along with the view.
    holder_hitbox: Cell<Option<HitboxId>>,
    reserved_actions: RefCell<HashSet<TypeId>>,
    _attachment: Box<dyn Any>,
}

impl NativeView {
    /// Attaches a platform view to the window.
    ///
    /// # Errors
    ///
    /// Fails on platforms that cannot composite native views, which is every
    /// platform but macOS for now.
    ///
    /// # Safety
    ///
    /// `view` must point to a live view of the kind the window's platform
    /// embeds, which is an `NSView` on macOS, and that view must not be in
    /// another view hierarchy.
    ///
    /// GPUI retains the view and puts it inside a view of its own, until the
    /// last clone of the returned handle is dropped. Until then GPUI decides the
    /// view's frame, whether it is hidden, and its order among the window's other
    /// views, so the caller must leave those alone and must not move the view to
    /// another superview.
    pub unsafe fn new(view: NonNull<c_void>, window: &mut Window, cx: &mut App) -> Result<Self> {
        let id = NativeViewId(window.next_native_view_id);
        // SAFETY: The caller upholds the platform's requirements for `view`.
        let attachment = unsafe { window.platform_window.attach_native_view(id, view) }
            .context("this platform cannot show native views")?;
        window.next_native_view_id += 1;
        let state = Rc::new(NativeViewState {
            id,
            window: window.handle,
            focus_handle: cx.focus_handle(),
            background: Cell::new(Hsla::transparent_black()),
            shown_hitbox: Cell::new(None),
            corner_radii: Cell::new(Corners::default()),
            holder_hitbox: Cell::new(None),
            reserved_actions: RefCell::default(),
            _attachment: attachment,
        });
        window.native_views.push(Rc::downgrade(&state));
        Ok(Self(state))
    }
}

impl NativeView {
    #[allow(missing_docs)]
    pub fn id(&self) -> NativeViewId {
        self.0.id
    }

    /// Sets the color shown where the view has not caught up with its element.
    ///
    /// The platform moves the view through its own compositor, so for a frame
    /// or two after its element moves or resizes, part of the element can be
    /// uncovered. A color close to the view's own background hides that. A
    /// window showing several native views uses the color of the one painted
    /// last.
    pub fn set_background(&self, color: impl Into<Hsla>, cx: &mut App) {
        let color = color.into();
        if self.0.background.replace(color) == color {
            return;
        }
        // The color is part of what the element paints.
        let window = self.0.window;
        cx.defer(move |cx| {
            window.update(cx, |_, window, _| window.refresh()).ok();
        });
    }

    /// Makes key bindings for `A` apply before the view sees the key.
    ///
    /// The view otherwise sees every key first and can keep any of them, so
    /// this is for the few bindings that must work whatever the view shows.
    /// The view never sees a key that such a binding starts with, even when the
    /// rest of the binding's keys don't follow.
    pub fn reserve_action<A: Action>(&self) {
        self.0
            .reserved_actions
            .borrow_mut()
            .insert(TypeId::of::<A>());
    }
}

impl Focusable for NativeView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.0.focus_handle.clone()
    }
}

impl IntoElement for NativeView {
    type Element = crate::Div;

    fn into_element(self) -> Self::Element {
        div()
            .track_focus(&self.0.focus_handle)
            .size_full()
            .child(NativeViewElement(self))
    }
}

struct NativeViewElement(NativeView);

impl Element for NativeViewElement {
    type RequestLayoutState = ();
    /// `None` in a window other than the one the view is attached to.
    type PrepaintState = Option<Hitbox>;

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
        let mut style = Style::default();
        style.size.width = crate::relative(1.).into();
        style.size.height = crate::relative(1.).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        _cx: &mut App,
    ) -> Option<Hitbox> {
        let state = &self.0.0;
        if state.window != window.handle {
            return None;
        }
        // The view is only where it is painted first, so a later occurrence
        // must not keep mouse input from what is behind it. It still has a
        // hitbox, which becomes the view's if a frame reuses this occurrence
        // after the first one has gone. An occurrence that is clipped away
        // paints nothing, and doesn't count as the first.
        let is_visible = !bounds.intersect(&window.content_mask().bounds).is_empty();
        let is_shown_elsewhere = state.shown_hitbox.get().is_some_and(|shown| {
            window
                .next_frame
                .hitboxes
                .iter()
                .any(|hitbox| hitbox.id == shown)
        });
        let shows_view = is_visible && !is_shown_elsewhere;
        let behavior = if shows_view {
            HitboxBehavior::BlockMouse
        } else {
            HitboxBehavior::Normal
        };
        let holder = window.next_frame.hitboxes.last().cloned();
        let mut hitbox = window.insert_hitbox(bounds, behavior);
        // Both hitboxes are in window space, transformed alike.
        let holder = holder
            .filter(|holder| holder.bounds == hitbox.bounds)
            .map(|holder| holder.id);
        if let Some(transform) = window.next_frame.scene.paint_transform() {
            let scale_factor = window.scale_factor();
            let upright = upright_bounds(&transform, bounds.scale(scale_factor));
            hitbox.bounds = to_logical(upright, scale_factor);
            if let Some(inserted) = window.next_frame.hitboxes.last_mut() {
                inserted.bounds = hitbox.bounds;
            }
        }
        if shows_view {
            state.shown_hitbox.set(Some(hitbox.id));
            state.holder_hitbox.set(holder);
        }
        Some(hitbox)
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        hitbox: &mut Option<Hitbox>,
        window: &mut Window,
        _cx: &mut App,
    ) {
        let Some(hitbox) = hitbox else {
            return;
        };
        let id = self.0.0.id;
        // The view keeps its layout size, so the platform scales it as a
        // whole instead of laying out its content again each frame.
        let unscaled = crate::point(1., 1.);
        let (bounds, layout_size, scale, axis_scale) =
            match window.next_frame.scene.paint_transform() {
                Some(transform) => {
                    let layout = window.snap_bounds(bounds);
                    let scales = transform.scale();
                    let (scale, axis_scale) = if transform.is_uniform() {
                        (scales.x, unscaled)
                    } else {
                        (1., scales)
                    };
                    (
                        upright_bounds(&transform, layout),
                        layout.size,
                        scale,
                        axis_scale,
                    )
                }
                None => {
                    let bounds = window.snap_bounds(hitbox.bounds);
                    (bounds, bounds.size, 1., unscaled)
                }
            };
        let content_mask = ContentMask {
            bounds: window.cover_bounds(hitbox.content_mask.bounds),
        };
        let opacity = window.element_opacity();
        window.next_frame.scene.insert_primitive(PaintNativeView {
            order: 0,
            id,
            hitbox_id: hitbox.id,
            bounds,
            content_mask,
            background: self.0.0.background.get(),
            layout_size,
            scale,
            axis_scale,
            opacity: if opacity.is_nan() {
                1.
            } else {
                opacity.clamp(0., 1.)
            },
        });
    }
}

impl Window {
    /// Tells the platform which native view, if any, the focused handle belongs to.
    pub(super) fn sync_native_view_focus(&mut self) {
        self.native_views.retain(|view| view.strong_count() > 0);
        if self.native_views.is_empty() {
            return;
        }
        let focused = self
            .focus
            .and_then(|focus| self.native_view_for_focus(focus));
        self.platform_window.set_focused_native_view(focused);
    }

    /// Ends an unfinished composition in the window's own content when keyboard
    /// input is about to move to a native view.
    ///
    /// The platform also asks for this as its own view loses keyboard input, but
    /// that request needs the app, which is already borrowed when focus is moved
    /// from inside an update. The entity being updated may also be the one that
    /// holds the composition, so this waits for the update to end.
    pub(super) fn end_composition_before_focusing_native_view(
        &mut self,
        focus: FocusId,
        cx: &mut App,
    ) {
        if self.native_view_for_focus(focus).is_none() {
            return;
        }
        self.defer(cx, |window, cx| {
            if let Some(mut input_handler) = window.platform_window.take_input_handler() {
                input_handler.unmark_text_during_update(window, cx);
                window.platform_window.set_input_handler(input_handler);
            }
        });
    }

    fn native_view_for_focus(&self, focus: FocusId) -> Option<NativeViewId> {
        self.native_views
            .iter()
            .filter_map(Weak::upgrade)
            .find(|view| view.focus_handle.id == focus)
            .map(|view| view.id)
    }

    /// The native view that a mouse event at this position reaches, if no
    /// GPUI hitbox is above it there. A native view's rounded corners are
    /// see-through, so a position in one reaches whatever is beneath the view
    /// and the element that holds it.
    pub(super) fn hit_test_native_view(&self, position: Point<Pixels>) -> Option<NativeViewId> {
        let mut see_through: Option<HitboxId> = None;
        for hitbox in self.rendered_frame.hitboxes.iter().rev() {
            let bounds = hitbox.bounds.intersect(&hitbox.content_mask.bounds);
            if !bounds.contains(&position) {
                continue;
            }
            let native_view = self
                .rendered_frame
                .scene
                .attached_native_views()
                .find(|native_view| native_view.hitbox_id == hitbox.id);
            let Some(native_view) = native_view else {
                if see_through == Some(hitbox.id) {
                    continue;
                }
                return None;
            };
            let state = self
                .native_views
                .iter()
                .filter_map(Weak::upgrade)
                .find(|view| view.id == native_view.id);
            let radii = state
                .as_ref()
                .map(|state| state.corner_radii.get())
                .unwrap_or_default();
            let contains = if native_view.is_transformed() {
                let (frame, position) = untransformed(native_view, self.scale_factor(), position);
                rounded_bounds_contain(frame, radii, position)
            } else {
                rounded_bounds_contain(hitbox.bounds, radii, position)
            };
            if contains {
                return Some(native_view.id);
            }
            see_through = state.and_then(|state| state.holder_hitbox.get());
        }
        None
    }

    /// Dispatches a key press that the focused native view has not seen yet, if
    /// it continues a pending binding or is bound to an action the view reserved.
    pub(super) fn dispatch_key_down_before_native_view(
        &mut self,
        event: KeyDownEvent,
        cx: &mut App,
    ) -> bool {
        let Some(view) = self
            .native_views
            .iter()
            .filter_map(Weak::upgrade)
            .find(|view| Some(view.focus_handle.id) == self.focus)
        else {
            return false;
        };
        let node_id = self.focus_node_id_in_rendered_frame(self.focus);
        let dispatch_path = self.rendered_frame.dispatch_tree.dispatch_path(node_id);
        let dispatch_tree = &self.rendered_frame.dispatch_tree;
        let pending = self.pending_input_keystrokes();
        let is_pending = pending.is_some();
        let continues_pending = pending.is_some_and(|pending| {
            let mut input = pending.to_vec();
            input.push(event.keystroke.clone());
            let (bindings, is_pending, _) =
                dispatch_tree.bindings_for_input(&input, &dispatch_path);
            is_pending || !bindings.is_empty()
        });
        let is_reserved = !continues_pending && {
            let input = std::slice::from_ref(&event.keystroke);
            let (bindings, _, context_stack) =
                dispatch_tree.bindings_for_input(input, &dispatch_path);
            let reserved_actions = view.reserved_actions.borrow();
            let is_reserved = |binding: &KeyBinding| {
                reserved_actions.contains(&binding.action.as_any().type_id())
            };
            // The first key of a longer binding is reserved too, or the view
            // could keep that key and the binding would never begin.
            bindings.first().is_some_and(is_reserved)
                || dispatch_tree
                    .possible_next_bindings_for_input(input, &context_stack)
                    .iter()
                    .any(is_reserved)
        };
        if is_pending && !continues_pending {
            // The pending binding ends here, as it would in the window's own
            // content. Left pending, it would be completed by a later key even
            // after the view had used this one.
            self.flush_pending_input(cx);
        }
        if !continues_pending && !is_reserved {
            // The key is left for the view like any other. Dispatching it here
            // as well would dispatch it twice when the view then leaves it.
            return false;
        }
        // The key is GPUI's whether or not anything acts on it. Leaving it to
        // the view as well would have it dispatched again when the view left it.
        self.dispatch_event(PlatformInput::KeyDown(event), cx);
        true
    }

    /// Focuses the handle of a native view that the platform gave keyboard input to.
    pub(super) fn focus_native_view(&mut self, id: NativeViewId, cx: &mut App) {
        let view = self
            .native_views
            .iter()
            .filter_map(Weak::upgrade)
            .find(|view| view.id == id);
        if let Some(view) = view {
            self.focus(&view.focus_handle, cx);
        }
    }

    #[allow(missing_docs)]
    pub fn set_native_view_corner_radius(
        &self,
        view: &NativeView,
        radii: impl Into<crate::Corners<Pixels>>,
    ) {
        if view.0.window == self.handle {
            let radii = radii.into().map(|radius| (*radius).max(Pixels::ZERO));
            view.0.corner_radii.set(radii);
            self.platform_window
                .set_native_view_corner_radius(view.0.id, radii);
        }
    }
}

/// Where a native view shows under `transform`: `bounds` scaled by how much
/// the transform stretches each of its axes, about where the transform moves
/// its center, and never turned.
///
/// A matrix that turns, or that shears because an uneven scale is applied
/// after a turn, leaves the view upright with only the length each of its
/// axes is stretched to, so its frame, its hitbox and the rect the renderer
/// erases for it stay the same axis-aligned rectangle.
fn upright_bounds(
    transform: &PaintTransform,
    bounds: Bounds<ScaledPixels>,
) -> Bounds<ScaledPixels> {
    let center = transform.point(bounds.center());
    let scale = transform.scale();
    let size = crate::size(
        ScaledPixels(bounds.size.width.0 * scale.x),
        ScaledPixels(bounds.size.height.0 * scale.y),
    );
    Bounds {
        origin: crate::point(center.x - size.width / 2., center.y - size.height / 2.),
        size,
    }
}

fn to_logical(bounds: Bounds<ScaledPixels>, scale_factor: f32) -> Bounds<Pixels> {
    Bounds {
        origin: crate::point(
            px(bounds.origin.x.0 / scale_factor),
            px(bounds.origin.y.0 / scale_factor),
        ),
        size: crate::size(
            px(bounds.size.width.0 / scale_factor),
            px(bounds.size.height.0 / scale_factor),
        ),
    }
}

/// The frame a scaled native view is laid out in, in logical pixels, and
/// `position` moved back by the view's scale into that frame.
fn untransformed(
    native_view: &PaintNativeView,
    scale_factor: f32,
    position: Point<Pixels>,
) -> (Bounds<Pixels>, Point<Pixels>) {
    let center = native_view.bounds.center();
    let center = Point::new(center.x.0 / scale_factor, center.y.0 / scale_factor);
    let size = crate::size(
        px(native_view.layout_size.width.0 / scale_factor),
        px(native_view.layout_size.height.0 / scale_factor),
    );
    let frame = Bounds {
        origin: crate::point(
            px(center.x) - size.width / 2.,
            px(center.y) - size.height / 2.,
        ),
        size,
    };
    let scales = native_view.scales();
    let (scale_x, scale_y) = (scales.x.max(f32::EPSILON), scales.y.max(f32::EPSILON));
    let position = crate::point(
        px(center.x + (position.x.0 - center.x) / scale_x),
        px(center.y + (position.y.0 - center.y) / scale_y),
    );
    (frame, position)
}

fn rounded_bounds_contain(
    bounds: Bounds<Pixels>,
    radii: Corners<Pixels>,
    position: Point<Pixels>,
) -> bool {
    if !bounds.contains(&position) {
        return false;
    }
    let (left, top) = (bounds.origin.x.0, bounds.origin.y.0);
    let (right, bottom) = (left + bounds.size.width.0, top + bounds.size.height.0);
    let limit = bounds.size.width.0.min(bounds.size.height.0) / 2.;
    let radius = |corner: Pixels| corner.0.max(0.).min(limit);
    let (x, y) = (position.x.0, position.y.0);
    [
        (radius(radii.top_left), [left, top], [-1., -1.]),
        (radius(radii.top_right), [right, top], [1., -1.]),
        (radius(radii.bottom_right), [right, bottom], [1., 1.]),
        (radius(radii.bottom_left), [left, bottom], [-1., 1.]),
    ]
    .into_iter()
    .all(|(radius, [corner_x, corner_y], [side_x, side_y])| {
        let (dx, dy) = (
            x - (corner_x - side_x * radius),
            y - (corner_y - side_y * radius),
        );
        dx * side_x <= 0. || dy * side_y <= 0. || dx * dx + dy * dy <= radius * radius
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Context, Entity, FocusHandle, InputHandler, KeyBinding, Keystroke, Modifiers, MouseButton,
        Radians, Render, TestAppContext, UTF16Selection, VisualTestContext, WindowHandle, canvas,
        point, prelude::*, px, rgb,
    };
    use std::ops::Range;

    #[gpui::test]
    fn focusing_a_native_view_gives_it_keyboard_input(cx: &mut TestAppContext) {
        let window = open_window(cx);
        let platform_window = cx.test_window(window.into());

        let id = window
            .update(cx, |view, window, cx| {
                window.focus(&view.native_view.focus_handle(cx), cx);
                view.native_view.0.id
            })
            .unwrap();
        assert_eq!(platform_window.focused_native_view(), Some(id));

        window
            .update(cx, |view, window, cx| window.focus(&view.other_focus, cx))
            .unwrap();
        assert_eq!(platform_window.focused_native_view(), None);

        window
            .update(cx, |view, window, cx| {
                window.focus(&view.native_view.focus_handle(cx), cx);
                window.blur(cx);
            })
            .unwrap();
        assert_eq!(platform_window.focused_native_view(), None);
    }

    #[gpui::test]
    fn platform_focus_of_a_native_view_focuses_its_handle(cx: &mut TestAppContext) {
        let window = open_window(cx);
        let platform_window = cx.test_window(window.into());
        let id = window
            .update(cx, |view, window, cx| {
                window.focus(&view.other_focus, cx);
                view.native_view.0.id
            })
            .unwrap();

        platform_window.simulate_native_view_focused(id);

        window
            .update(cx, |view, window, cx| {
                assert!(view.native_view.focus_handle(cx).is_focused(window));
            })
            .unwrap();
        assert_eq!(platform_window.focused_native_view(), Some(id));
    }

    #[gpui::test]
    fn only_reserved_and_pending_bindings_apply_before_a_native_view(cx: &mut TestAppContext) {
        cx.update(|cx| {
            cx.bind_keys([
                KeyBinding::new("cmd-r", Reserved, None),
                KeyBinding::new("cmd-o", Ordinary, None),
                KeyBinding::new("cmd-k o", Ordinary, None),
                KeyBinding::new("cmd-j r", Reserved, None),
            ]);
        });
        let window = open_window(cx);
        let platform_window = cx.test_window(window.into());
        window
            .update(cx, |view, window, cx| {
                view.native_view.reserve_action::<Reserved>();
                window.focus(&view.native_view.focus_handle(cx), cx);
            })
            .unwrap();
        cx.run_until_parked();
        let press = |keystroke: &'static str| KeyDownEvent {
            keystroke: Keystroke::parse(keystroke).unwrap(),
            is_held: false,
            prefer_character_input: false,
        };
        let actions = |cx: &mut TestAppContext| {
            window
                .update(cx, |view, _, _| std::mem::take(&mut view.actions))
                .unwrap()
        };

        assert!(platform_window.simulate_key_down_before_native_view(press("cmd-r")));
        assert_eq!(actions(cx), ["reserved"]);

        // The view gets to see an ordinary binding's key first.
        assert!(!platform_window.simulate_key_down_before_native_view(press("cmd-o")));
        assert_eq!(actions(cx), [] as [&str; 0]);

        // Once the view has left the first key of a binding to GPUI, the rest
        // of that binding's keys are GPUI's.
        assert!(!platform_window.simulate_key_down_before_native_view(press("cmd-k")));
        cx.simulate_keystrokes(window.into(), "cmd-k");
        // A key that doesn't continue the binding ends it. The key is the
        // view's to see first, and isn't dispatched here, which would dispatch
        // it twice if the view then left it.
        assert!(!platform_window.simulate_key_down_before_native_view(press("x")));
        assert!(
            !window
                .update(cx, |_, window, _| window.has_pending_keystrokes())
                .unwrap()
        );
        let keys = |cx: &mut TestAppContext| {
            window
                .update(cx, |view, _, _| std::mem::take(&mut view.keys))
                .unwrap()
        };
        // The binding's first key is dispatched on its own, as it is when
        // the binding times out.
        assert_eq!(keys(cx), ["k"]);
        cx.simulate_keystrokes(window.into(), "x");
        assert_eq!(keys(cx), ["x"]);
        // Whether or not the view used that key, the rest of the binding's
        // keys no longer complete it, and are the view's again.
        assert!(!platform_window.simulate_key_down_before_native_view(press("o")));
        assert_eq!(actions(cx), [] as [&str; 0]);

        // The view never sees the first key of a reserved binding, which it
        // could otherwise keep.
        assert!(platform_window.simulate_key_down_before_native_view(press("cmd-j")));
        assert!(platform_window.simulate_key_down_before_native_view(press("r")));
        assert_eq!(actions(cx), ["reserved"]);

        // Nothing applies ahead of the window's own content.
        window
            .update(cx, |view, window, cx| window.focus(&view.other_focus, cx))
            .unwrap();
        assert!(!platform_window.simulate_key_down_before_native_view(press("cmd-r")));
    }

    #[gpui::test]
    fn mouse_reaches_a_native_view_only_where_nothing_covers_it(cx: &mut TestAppContext) {
        let window = open_window(cx);
        let platform_window = cx.test_window(window.into());
        let id = window
            .update(cx, |view, _, _| view.native_view.0.id)
            .unwrap();
        cx.run_until_parked();

        let uncovered = point(px(75.), px(75.));
        let covered = point(px(25.), px(25.));
        let outside = point(px(150.), px(150.));
        assert_eq!(platform_window.hit_test_native_view(uncovered), Some(id));
        assert_eq!(platform_window.hit_test_native_view(covered), None);
        assert_eq!(platform_window.hit_test_native_view(outside), None);
    }

    #[gpui::test]
    fn mouse_in_a_rounded_corner_reaches_the_native_view_beneath(cx: &mut TestAppContext) {
        let window = open_window(cx);
        let platform_window = cx.test_window(window.into());
        let (lower, upper) = window
            .update(cx, |view, window, cx| {
                let upper = new_native_view(window, cx);
                window.set_native_view_corner_radius(&upper, px(20.));
                view.rounded_view = Some(upper.clone());
                cx.notify();
                (view.native_view.0.id, upper.0.id)
            })
            .unwrap();
        cx.run_until_parked();

        let inside_upper = point(px(80.), px(80.));
        let clipped_corner = point(px(61.), px(61.));
        assert_eq!(
            platform_window.hit_test_native_view(inside_upper),
            Some(upper)
        );
        assert_eq!(
            platform_window.hit_test_native_view(clipped_corner),
            Some(lower)
        );
        assert_eq!(
            platform_window.hit_test_native_view(point(px(99.), px(61.))),
            Some(lower)
        );

        window
            .update(cx, |view, _, cx| {
                view.occludes_under_rounded_view = true;
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();
        assert_eq!(
            platform_window.hit_test_native_view(inside_upper),
            Some(upper)
        );
        assert_eq!(
            platform_window.hit_test_native_view(clipped_corner),
            None,
            "an element between the views keeps the corner from the view beneath"
        );
    }

    #[gpui::test]
    fn mouse_press_on_a_native_view_reaches_nothing_behind_it(cx: &mut TestAppContext) {
        let window = open_window(cx);
        cx.run_until_parked();
        let mut cx = VisualTestContext::from_window(window.into(), cx);

        // The platform passes on a press that it gives to the view.
        cx.simulate_mouse_down(
            point(px(75.), px(75.)),
            MouseButton::Left,
            Modifiers::default(),
        );

        let presses = window
            .update(&mut cx, |view, _, _| std::mem::take(&mut view.presses))
            .unwrap();
        assert_eq!(presses, ["outside cover"]);
    }

    #[gpui::test]
    fn changing_the_background_repaints_the_native_view(cx: &mut TestAppContext) {
        let window = open_window(cx);
        cx.run_until_parked();

        window
            .update(cx, |view, _, cx| {
                view.native_view.set_background(rgb(0x00ff00), cx);
            })
            .unwrap();
        cx.run_until_parked();

        window
            .update(cx, |_, window, _| {
                let backgrounds = window
                    .rendered_frame
                    .scene
                    .native_views
                    .iter()
                    .map(|native_view| native_view.background)
                    .collect::<Vec<_>>();
                assert_eq!(backgrounds, [Hsla::from(rgb(0x00ff00))]);
            })
            .unwrap();
    }

    #[gpui::test]
    fn native_view_painted_twice_shows_where_it_was_painted_first(cx: &mut TestAppContext) {
        let window = open_window(cx);
        window
            .update(cx, |view, _, cx| {
                view.paints_native_view_twice = true;
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();

        window
            .update(cx, |_, window, _| {
                let bounds = window
                    .rendered_frame
                    .scene
                    .native_views
                    .iter()
                    .map(|native_view| native_view.bounds.origin.x)
                    .collect::<Vec<_>>();
                assert_eq!(bounds, [ScaledPixels::from(0.)]);
            })
            .unwrap();

        // Where the view was painted again, it isn't shown and takes no mouse
        // input, so what is behind it there gets the press.
        let id = window
            .update(cx, |view, _, _| view.native_view.0.id)
            .unwrap();
        let platform_window = cx.test_window(window.into());
        let painted_first = point(px(75.), px(75.));
        let painted_again = point(px(250.), px(50.));
        assert_eq!(
            platform_window.hit_test_native_view(painted_first),
            Some(id)
        );
        assert_eq!(platform_window.hit_test_native_view(painted_again), None);
        let mut cx = VisualTestContext::from_window(window.into(), cx);
        cx.simulate_mouse_down(painted_again, MouseButton::Left, Modifiers::default());
        let presses = window
            .update(&mut cx, |view, _, _| std::mem::take(&mut view.presses))
            .unwrap();
        assert_eq!(presses, ["outside cover", "behind second occurrence"]);
    }

    #[gpui::test]
    fn native_view_is_drawn_in_paint_order(cx: &mut TestAppContext) {
        let window = open_window(cx);
        cx.run_until_parked();

        // The view shows through its container's background, and the element
        // painted after it covers it.
        window
            .update(cx, |_, window, _| {
                let labels = window
                    .rendered_frame
                    .scene
                    .batches()
                    .map(|batch| batch.label())
                    .collect::<Vec<_>>();
                assert_eq!(labels, ["quads (1)", "native views (1)", "quads (1)"]);
            })
            .unwrap();
    }

    #[gpui::test]
    fn native_view_stays_attached_until_its_last_handle_is_dropped(cx: &mut TestAppContext) {
        let window = open_window(cx);
        let platform_window = cx.test_window(window.into());
        let other_handle = window
            .update(cx, |view, _, _| view.native_view.clone())
            .unwrap();
        assert_eq!(platform_window.attached_native_view_count(), 1);

        window
            .update(cx, |view, window, cx| {
                view.native_view = new_native_view(window, cx);
            })
            .unwrap();
        assert_eq!(platform_window.attached_native_view_count(), 2);

        drop(other_handle);
        assert_eq!(platform_window.attached_native_view_count(), 1);
    }

    #[gpui::test]
    fn native_view_shows_nothing_in_another_window(cx: &mut TestAppContext) {
        let window = open_window(cx);
        let native_view = window
            .update(cx, |view, _, _| view.native_view.clone())
            .unwrap();
        let other_window = cx.add_window(|_, cx| TestView {
            native_view,
            other_focus: cx.focus_handle(),
            actions: Vec::new(),
            keys: Vec::new(),
            presses: Vec::new(),
            paints_native_view_twice: false,
            rounded_view: None,
            occludes_under_rounded_view: false,
            unmark_count: 0,
        });
        cx.run_until_parked();

        other_window
            .update(cx, |_, window, _| {
                assert!(window.rendered_frame.scene.native_views.is_empty());
            })
            .unwrap();
        window
            .update(cx, |_, window, _| {
                assert_eq!(window.rendered_frame.scene.native_views.len(), 1);
            })
            .unwrap();
    }

    #[gpui::test]
    fn focusing_a_native_view_ends_a_composition(cx: &mut TestAppContext) {
        let window = open_window(cx);
        window
            .update(cx, |view, window, cx| window.focus(&view.other_focus, cx))
            .unwrap();
        cx.run_until_parked();

        // The view that holds the composition moves focus from inside its own
        // update, so the composition can only be ended once that is over.
        window
            .update(cx, |view, window, cx| {
                window.focus(&view.native_view.focus_handle(cx), cx);
            })
            .unwrap();
        let unmark_count = window.update(cx, |view, _, _| view.unmark_count).unwrap();
        assert_eq!(unmark_count, 1);
    }

    struct ScaledClip(NativeView);

    impl Render for ScaledClip {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().size_full().child(
                div()
                    .absolute()
                    .left(px(100.))
                    .top_0()
                    .size(px(100.))
                    .overflow_hidden()
                    .scale(0.5)
                    .child(
                        div()
                            .absolute()
                            .left(px(-50.))
                            .top_0()
                            .w(px(200.))
                            .h(px(100.))
                            .child(self.0.clone()),
                    ),
            )
        }
    }

    #[gpui::test]
    fn a_native_view_under_a_scaled_clip_is_hit_where_it_shows(cx: &mut TestAppContext) {
        let window = cx.add_window(|window, cx| ScaledClip(new_native_view(window, cx)));
        cx.run_until_parked();
        let platform_window = cx.test_window(window.into());
        let (id, shown) = window
            .update(cx, |view, window, _| {
                let native_views = &window.rendered_frame.scene.native_views;
                assert_eq!(native_views.len(), 1);
                let native_view = native_views[0];
                let scale_factor = window.scale_factor();
                let shown = native_view
                    .bounds
                    .intersect(&native_view.content_mask.bounds);
                (
                    view.0.0.id,
                    Bounds::from_corners(
                        point(
                            px(shown.left().0 / scale_factor),
                            px(shown.top().0 / scale_factor),
                        ),
                        point(
                            px(shown.right().0 / scale_factor),
                            px(shown.bottom().0 / scale_factor),
                        ),
                    ),
                )
            })
            .unwrap();
        for x in [105., 110., 124., 126., 150., 174., 176., 190.] {
            let position = point(px(x), px(50.));
            assert_eq!(
                platform_window.hit_test_native_view(position),
                shown.contains(&position).then_some(id),
                "{x}, shown {shown:?}"
            );
        }
        assert_eq!(shown.left(), px(125.));
        assert_eq!(shown.right(), px(175.));
    }

    struct Transformed {
        view: NativeView,
        effects: Option<(f32, f32, f32, f32)>,
    }

    impl Render for Transformed {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let holder = div()
                .absolute()
                .left(px(100.))
                .top(px(100.))
                .w(px(200.))
                .h(px(100.));
            let Some((outer_scale, inner_scale, angle, opacity)) = self.effects else {
                return div().size_full().child(holder.child(self.view.clone()));
            };
            div().size_full().child(
                holder.scale(outer_scale).opacity(opacity).child(
                    div()
                        .size_full()
                        .scale(inner_scale)
                        .rotate(Radians(angle))
                        .opacity(opacity)
                        .child(self.view.clone()),
                ),
            )
        }
    }

    fn painted_native_view(
        window: WindowHandle<Transformed>,
        cx: &mut TestAppContext,
    ) -> (PaintNativeView, f32) {
        window
            .update(cx, |_, window, _| {
                let native_views = &window.rendered_frame.scene.native_views;
                assert_eq!(native_views.len(), 1);
                (native_views[0], window.scale_factor())
            })
            .unwrap()
    }

    #[gpui::test]
    fn a_native_view_carries_the_scale_and_opacity_it_is_painted_in_and_stays_upright(
        cx: &mut TestAppContext,
    ) {
        let window = cx.add_window(|window, cx| Transformed {
            view: new_native_view(window, cx),
            effects: Some((0.5, 1.5, std::f32::consts::FRAC_PI_2, 0.5)),
        });
        cx.run_until_parked();
        let (native_view, scale_factor) = painted_native_view(window, cx);
        assert!((native_view.scale - 0.75).abs() < 1e-6);
        assert!((native_view.opacity - 0.25).abs() < 1e-6);
        assert!(native_view.is_transformed());
        let layout = native_view
            .layout_size
            .map(|length| length.0 / scale_factor);
        assert_eq!((layout.width, layout.height), (200., 100.));
        // Both scales are about the holder's center, so the view's center
        // stays put, and the quarter turn leaves it upright.
        let center = native_view.bounds.center();
        let shown = native_view.bounds.size;
        for (actual, expected) in [
            (center.x.0 / scale_factor, 200.),
            (center.y.0 / scale_factor, 150.),
            (shown.width.0 / scale_factor, 150.),
            (shown.height.0 / scale_factor, 75.),
        ] {
            assert!((actual - expected).abs() < 1e-3, "{actual} != {expected}");
        }

        // The view is hit inside its upright frame, which is 150 points wide
        // and 75 tall around (200, 150).
        let platform_window = cx.test_window(window.into());
        let id = window.update(cx, |view, _, _| view.view.0.id).unwrap();
        assert_eq!(
            platform_window.hit_test_native_view(point(px(270.), px(150.))),
            Some(id)
        );
        assert_eq!(
            platform_window.hit_test_native_view(point(px(200.), px(185.))),
            Some(id)
        );
        assert_eq!(
            platform_window.hit_test_native_view(point(px(200.), px(195.))),
            None
        );
        assert_eq!(
            platform_window.hit_test_native_view(point(px(280.), px(150.))),
            None
        );

        window
            .update(cx, |view, _, cx| {
                view.effects = None;
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();
        let (native_view, scale_factor) = painted_native_view(window, cx);
        assert_eq!(native_view.scale, 1.);
        assert_eq!(native_view.opacity, 1.);
        assert!(!native_view.is_transformed());
        assert_eq!(native_view.layout_size, native_view.bounds.size);
        assert_eq!(
            native_view.bounds.origin.x.0 / scale_factor,
            100.,
            "an untransformed view is placed as before"
        );
    }

    struct TurnedOverButton {
        view: NativeView,
        scale_xy: (f32, f32),
        angle: f32,
        presses: Vec<Point<Pixels>>,
    }

    impl Render for TurnedOverButton {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let (x, y) = self.scale_xy;
            div()
                .size_full()
                .child(div().id("button").absolute().size_full().on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, event: &crate::MouseDownEvent, _, _| {
                        this.presses.push(event.position)
                    }),
                ))
                .child(
                    div()
                        .absolute()
                        .left(px(100.))
                        .top(px(100.))
                        .w(px(200.))
                        .h(px(100.))
                        .scale_xy(x, y)
                        .child(
                            div()
                                .size_full()
                                .rotate(Radians(self.angle))
                                .child(self.view.clone()),
                        ),
                )
        }
    }

    /// The painted view, its hitbox, the rect the renderer erases for it, all
    /// in logical pixels, and the window's scale factor.
    fn upright_frames(
        window: WindowHandle<TurnedOverButton>,
        cx: &mut TestAppContext,
    ) -> (
        PaintNativeView,
        Bounds<Pixels>,
        Bounds<Pixels>,
        Bounds<Pixels>,
        f32,
    ) {
        window
            .update(cx, |_, window, _| {
                let native_views = &window.rendered_frame.scene.native_views;
                assert_eq!(native_views.len(), 1);
                let native_view = native_views[0];
                let scale_factor = window.scale_factor();
                let to_logical = |bounds: Bounds<ScaledPixels>| Bounds {
                    origin: point(
                        px(bounds.origin.x.0 / scale_factor),
                        px(bounds.origin.y.0 / scale_factor),
                    ),
                    size: crate::size(
                        px(bounds.size.width.0 / scale_factor),
                        px(bounds.size.height.0 / scale_factor),
                    ),
                };
                let hitbox = window
                    .rendered_frame
                    .hitboxes
                    .iter()
                    .find(|hitbox| hitbox.id == native_view.hitbox_id)
                    .expect("the view's hitbox")
                    .clone();
                let erased = native_view
                    .bounds
                    .intersect(&native_view.content_mask.bounds);
                (
                    native_view,
                    to_logical(native_view.bounds),
                    hitbox.bounds.intersect(&hitbox.content_mask.bounds),
                    to_logical(erased),
                    scale_factor,
                )
            })
            .unwrap()
    }

    fn assert_bounds_near(actual: Bounds<Pixels>, expected: [f32; 4], what: &str) {
        let actual_values = [
            actual.origin.x.0,
            actual.origin.y.0,
            actual.size.width.0,
            actual.size.height.0,
        ];
        for (actual_value, expected_value) in actual_values.into_iter().zip(expected) {
            assert!(
                (actual_value - expected_value).abs() < 1e-2,
                "{what}: {actual_values:?} != {expected:?}"
            );
        }
    }

    #[gpui::test]
    fn a_turned_native_view_stays_upright_and_leaves_its_corners_to_what_is_behind(
        cx: &mut TestAppContext,
    ) {
        let window = cx.add_window(|window, cx| TurnedOverButton {
            view: new_native_view(window, cx),
            scale_xy: (1., 1.),
            angle: std::f32::consts::FRAC_PI_4,
            presses: Vec::new(),
        });
        cx.run_until_parked();
        let (_, bounds, hitbox, erased, _) = upright_frames(window, cx);
        for (frame, what) in [(bounds, "bounds"), (hitbox, "hitbox"), (erased, "erased")] {
            assert_bounds_near(frame, [100., 100., 200., 100.], what);
        }

        let platform_window = cx.test_window(window.into());
        let id = window.update(cx, |view, _, _| view.view.0.id).unwrap();
        // Inside the bounds the turned frame would have, outside the view.
        let empty_corner = point(px(105.), px(60.));
        assert_eq!(platform_window.hit_test_native_view(empty_corner), None);
        assert_eq!(
            platform_window.hit_test_native_view(point(px(290.), px(140.))),
            Some(id),
            "the upright view is hit across its whole frame"
        );
        let mut cx = VisualTestContext::from_window(window.into(), cx);
        cx.simulate_mouse_down(empty_corner, MouseButton::Left, Modifiers::default());
        let presses = window
            .update(&mut cx, |view, _, _| std::mem::take(&mut view.presses))
            .unwrap();
        assert_eq!(presses, [empty_corner]);
    }

    #[gpui::test]
    fn a_native_view_under_an_uneven_scale_and_a_turn_has_one_upright_frame(
        cx: &mut TestAppContext,
    ) {
        let window = cx.add_window(|window, cx| TurnedOverButton {
            view: new_native_view(window, cx),
            scale_xy: (2., 1.),
            angle: std::f32::consts::FRAC_PI_4,
            presses: Vec::new(),
        });
        cx.run_until_parked();
        let (native_view, bounds, hitbox, erased, scale_factor) = upright_frames(window, cx);
        // Each of the view's axes is stretched by the length the matrix gives
        // it, which is the same for both here, and the parent's shear is left
        // out.
        let scale = 2.5f32.sqrt();
        let scales = native_view.scales();
        assert!((scales.x - scale).abs() < 1e-5 && (scales.y - scale).abs() < 1e-5);
        let expected = [
            200. - 100. * scale,
            150. - 50. * scale,
            200. * scale,
            100. * scale,
        ];
        for (frame, what) in [(bounds, "bounds"), (hitbox, "hitbox"), (erased, "erased")] {
            assert_bounds_near(frame, expected, what);
        }
        let layout = native_view
            .layout_size
            .map(|length| length.0 / scale_factor);
        assert_eq!((layout.width, layout.height), (200., 100.));

        let platform_window = cx.test_window(window.into());
        let corner = point(px(expected[0] + 1.), px(expected[1] + 1.));
        assert!(platform_window.hit_test_native_view(corner).is_some());
        let above = point(px(200.), px(expected[1] - 5.));
        assert_eq!(platform_window.hit_test_native_view(above), None);
        let mut cx = VisualTestContext::from_window(window.into(), cx);
        cx.simulate_mouse_down(above, MouseButton::Left, Modifiers::default());
        let presses = window
            .update(&mut cx, |view, _, _| std::mem::take(&mut view.presses))
            .unwrap();
        assert_eq!(presses, [above]);
    }

    #[derive(Clone, Copy, PartialEq)]
    enum PinchLayout {
        Plain,
        Deferred,
        Cached,
        Covered,
    }

    struct PinchedOverNativeView {
        view: NativeView,
        holder: Entity<NativeViewHolder>,
        layout: PinchLayout,
        pinches: Vec<&'static str>,
    }

    struct NativeViewHolder {
        view: NativeView,
        renders: usize,
    }

    impl Render for NativeViewHolder {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            self.renders += 1;
            div().size_full().child(self.view.clone())
        }
    }

    impl Render for PinchedOverNativeView {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let holder = div().absolute().left(px(50.)).top(px(50.)).size(px(100.));
            let holder = match self.layout {
                PinchLayout::Plain | PinchLayout::Covered => {
                    holder.child(self.view.clone()).into_any_element()
                }
                PinchLayout::Deferred => {
                    crate::deferred(holder.child(self.view.clone())).into_any_element()
                }
                PinchLayout::Cached => holder
                    .child(
                        crate::AnyView::from(self.holder.clone())
                            .cached(crate::StyleRefinement::default().size_full()),
                    )
                    .into_any_element(),
            };
            div()
                .size_full()
                .child(div().absolute().size_full().on_pinch(
                    cx.listener(|this, _: &crate::PinchEvent, _, _| this.pinches.push("behind")),
                ))
                .child(
                    div()
                        .absolute()
                        .left(px(100.))
                        .top(px(100.))
                        .size(px(200.))
                        .on_pinch(cx.listener(|this, _: &crate::PinchEvent, _, _| {
                            this.pinches.push("ancestor")
                        }))
                        .child(holder),
                )
                .when(self.layout == PinchLayout::Covered, |page| {
                    page.child(
                        div()
                            .absolute()
                            .left(px(180.))
                            .top(px(180.))
                            .size(px(100.))
                            .block_mouse_except_scroll(),
                    )
                })
        }
    }

    fn open_pinch_window(
        layout: PinchLayout,
        cx: &mut TestAppContext,
    ) -> (WindowHandle<PinchedOverNativeView>, VisualTestContext) {
        let window = cx.add_window(|window, cx| {
            let view = new_native_view(window, cx);
            PinchedOverNativeView {
                holder: cx.new(|_| NativeViewHolder {
                    view: view.clone(),
                    renders: 0,
                }),
                view,
                layout,
                pinches: Vec::new(),
            }
        });
        cx.run_until_parked();
        (window, VisualTestContext::from_window(window.into(), cx))
    }

    fn pinch_at(
        window: WindowHandle<PinchedOverNativeView>,
        cx: &mut VisualTestContext,
        x: f32,
        y: f32,
    ) -> Vec<&'static str> {
        cx.simulate_event(crate::PinchEvent {
            position: point(px(x), px(y)),
            delta: 0.1,
            modifiers: Modifiers::default(),
            phase: crate::TouchPhase::Moved,
            ..Default::default()
        });
        window
            .update(cx, |view, _, _| std::mem::take(&mut view.pinches))
            .unwrap()
    }

    #[gpui::test]
    fn a_pinch_over_a_native_view_reaches_its_ancestors_only(cx: &mut TestAppContext) {
        for layout in [PinchLayout::Plain, PinchLayout::Deferred] {
            let (window, mut cx) = open_pinch_window(layout, cx);
            let cx = &mut cx;
            assert_eq!(
                pinch_at(window, cx, 200., 200.),
                ["ancestor"],
                "over the native view"
            );
            assert_eq!(
                pinch_at(window, cx, 110., 110.),
                ["ancestor", "behind"],
                "beside the native view, as before"
            );
            assert_eq!(pinch_at(window, cx, 50., 50.), ["behind"]);
        }
    }

    #[gpui::test]
    fn a_pinch_over_a_native_view_in_a_reused_cached_view_reaches_its_ancestors(
        cx: &mut TestAppContext,
    ) {
        let (window, mut cx) = open_pinch_window(PinchLayout::Cached, cx);
        let cx = &mut cx;
        assert_eq!(pinch_at(window, cx, 200., 200.), ["ancestor"]);
        let renders = |cx: &mut VisualTestContext| {
            window
                .update(cx, |view, _, cx| view.holder.read(cx).renders)
                .unwrap()
        };
        let renders_before = renders(cx);
        window.update(cx, |_, _, cx| cx.notify()).unwrap();
        cx.run_until_parked();
        assert_eq!(renders(cx), renders_before, "the cached view is reused");
        assert_eq!(pinch_at(window, cx, 200., 200.), ["ancestor"]);
    }

    #[gpui::test]
    fn a_pinch_through_an_overlay_over_a_native_view_skips_its_holders(cx: &mut TestAppContext) {
        let (window, mut cx) = open_pinch_window(PinchLayout::Covered, cx);
        let cx = &mut cx;
        assert_eq!(
            pinch_at(window, cx, 190., 190.),
            Vec::<&str>::new(),
            "under the overlay"
        );
        assert_eq!(pinch_at(window, cx, 160., 160.), ["ancestor"]);
    }

    struct ClaimingPinchHolder {
        view: NativeView,
        claims: bool,
    }

    impl Render for ClaimingPinchHolder {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            div().size_full().child(
                div()
                    .absolute()
                    .left(px(50.))
                    .top(px(50.))
                    .size(px(100.))
                    .on_pinch(cx.listener(|this, _: &crate::PinchEvent, _, cx| {
                        if this.claims {
                            cx.stop_propagation();
                        }
                    }))
                    .child(self.view.clone()),
            )
        }
    }

    #[gpui::test]
    fn a_pinch_a_holder_stops_over_its_native_view_does_not_propagate(cx: &mut TestAppContext) {
        for claims in [true, false] {
            let window = cx.add_window(|window, cx| ClaimingPinchHolder {
                view: new_native_view(window, cx),
                claims,
            });
            cx.run_until_parked();
            let platform_window = cx.test_window(window.into());
            let over_view = point(px(100.), px(100.));
            assert!(platform_window.hit_test_native_view(over_view).is_some());
            let result = cx
                .update_window(window.into(), |_, window, cx| {
                    window.dispatch_event(
                        PlatformInput::Pinch(crate::PinchEvent {
                            position: over_view,
                            delta: 0.1,
                            modifiers: Modifiers::default(),
                            phase: crate::TouchPhase::Started,
                            ..Default::default()
                        }),
                        cx,
                    )
                })
                .unwrap();
            assert_eq!(result.propagate, !claims);
        }
    }

    struct RetryingHolder {
        child: crate::AnyElement,
        holder: Rc<Cell<Option<HitboxId>>>,
        pinches: Rc<Cell<usize>>,
    }

    impl Element for RetryingHolder {
        type RequestLayoutState = ();
        type PrepaintState = Hitbox;

        fn id(&self) -> Option<ElementId> {
            None
        }

        fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
            None
        }

        fn request_layout(
            &mut self,
            _: Option<&GlobalElementId>,
            _: Option<&InspectorElementId>,
            window: &mut Window,
            cx: &mut App,
        ) -> (LayoutId, ()) {
            let child = self.child.request_layout(window, cx);
            let mut style = Style::default();
            style.size.width = px(100.).into();
            style.size.height = px(100.).into();
            (window.request_layout(style, [child], cx), ())
        }

        fn prepaint(
            &mut self,
            _: Option<&GlobalElementId>,
            _: Option<&InspectorElementId>,
            bounds: Bounds<Pixels>,
            _: &mut (),
            window: &mut Window,
            cx: &mut App,
        ) -> Hitbox {
            let rolled_back = window.transact(|window| {
                window.insert_hitbox(bounds, HitboxBehavior::Normal);
                Err::<(), ()>(())
            });
            assert!(rolled_back.is_err());
            let hitbox = window.insert_hitbox(bounds, HitboxBehavior::Normal);
            self.holder.set(Some(hitbox.id));
            self.child.prepaint(window, cx);
            hitbox
        }

        fn paint(
            &mut self,
            _: Option<&GlobalElementId>,
            _: Option<&InspectorElementId>,
            _: Bounds<Pixels>,
            _: &mut (),
            hitbox: &mut Hitbox,
            window: &mut Window,
            cx: &mut App,
        ) {
            self.child.paint(window, cx);
            let hitbox = hitbox.clone();
            let pinches = self.pinches.clone();
            window.on_mouse_event(move |_: &crate::PinchEvent, phase, window, _| {
                if phase == crate::DispatchPhase::Bubble && hitbox.should_handle_pinch(window) {
                    pinches.set(pinches.get() + 1);
                }
            });
        }
    }

    struct RetriedHolderView {
        view: NativeView,
        holder: Rc<Cell<Option<HitboxId>>>,
        pinches: Rc<Cell<usize>>,
    }

    impl Render for RetriedHolderView {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().size_full().child(RetryingHolder {
                child: self.view.clone().into_any_element(),
                holder: self.holder.clone(),
                pinches: self.pinches.clone(),
            })
        }
    }

    #[gpui::test]
    fn a_rolled_back_hitbox_does_not_stay_the_holder_of_a_native_view(cx: &mut TestAppContext) {
        let holder = Rc::new(Cell::new(None));
        let pinches = Rc::new(Cell::new(0));
        let window = cx.add_window({
            let (holder, pinches) = (holder.clone(), pinches.clone());
            move |window, cx| RetriedHolderView {
                view: new_native_view(window, cx),
                holder,
                pinches,
            }
        });
        cx.run_until_parked();
        let mut cx = VisualTestContext::from_window(window.into(), cx);
        let (ancestors, dangling) = window
            .update(&mut cx, |_, window, _| {
                let frame = &window.rendered_frame;
                let parent_of = |id: HitboxId| {
                    frame
                        .hitboxes
                        .iter()
                        .find(|hitbox| hitbox.id == id)
                        .and_then(|hitbox| hitbox.parent)
                };
                let ancestors =
                    std::iter::successors(parent_of(frame.scene.native_views[0].hitbox_id), |id| {
                        parent_of(*id)
                    })
                    .collect::<Vec<_>>();
                let dangling = frame
                    .hitboxes
                    .iter()
                    .filter_map(|hitbox| hitbox.parent)
                    .filter(|parent| frame.hitboxes.iter().all(|hitbox| hitbox.id != *parent))
                    .collect::<Vec<_>>();
                (ancestors, dangling)
            })
            .unwrap();
        assert_eq!(dangling, [], "parents that were rolled back");
        assert!(
            ancestors.contains(&holder.get().unwrap()),
            "the live holder holds the native view: {ancestors:?}"
        );
        cx.simulate_event(crate::PinchEvent {
            position: point(px(50.), px(50.)),
            delta: 0.1,
            modifiers: Modifiers::default(),
            phase: crate::TouchPhase::Moved,
            ..Default::default()
        });
        assert_eq!(pinches.get(), 1, "the live holder hears the pinch");
    }

    struct PanicsInPrepaint;

    impl Element for PanicsInPrepaint {
        type RequestLayoutState = ();
        type PrepaintState = ();

        fn id(&self) -> Option<ElementId> {
            None
        }

        fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
            None
        }

        fn request_layout(
            &mut self,
            _: Option<&GlobalElementId>,
            _: Option<&InspectorElementId>,
            window: &mut Window,
            cx: &mut App,
        ) -> (LayoutId, ()) {
            (window.request_layout(Style::default(), [], cx), ())
        }

        fn prepaint(
            &mut self,
            _: Option<&GlobalElementId>,
            _: Option<&InspectorElementId>,
            _: Bounds<Pixels>,
            _: &mut (),
            _: &mut Window,
            _: &mut App,
        ) {
            panic!("prepaint failed");
        }

        fn paint(
            &mut self,
            _: Option<&GlobalElementId>,
            _: Option<&InspectorElementId>,
            _: Bounds<Pixels>,
            _: &mut (),
            _: &mut (),
            _: &mut Window,
            _: &mut App,
        ) {
        }
    }

    struct CatchingParentView {
        owners: Rc<Cell<Option<(usize, usize)>>>,
    }

    impl Render for CatchingParentView {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let owners = self.owners.clone();
            div().size_full().child(
                canvas(
                    |_, window, cx| {
                        let mut child = PanicsInPrepaint.into_any_element();
                        child.layout_as_root(crate::AvailableSpace::min_size(), window, cx);
                        let before = window.hitbox_owners.len();
                        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            child.prepaint(window, cx);
                        }));
                        assert!(caught.is_err());
                        (before, window.hitbox_owners.len())
                    },
                    move |_, depths, _, _| owners.set(Some(depths)),
                )
                .size_full(),
            )
        }
    }

    #[gpui::test]
    fn a_caught_panic_in_a_child_prepaint_leaves_the_hitbox_owners_balanced(
        cx: &mut TestAppContext,
    ) {
        let owners = Rc::new(Cell::new(None));
        let window = cx.add_window({
            let owners = owners.clone();
            move |_, _| CatchingParentView { owners }
        });
        cx.run_until_parked();
        let (before, after) = owners.get().expect("the parent painted");
        assert_eq!(after, before, "inside the parent's prepaint");
        let leftover = window
            .update(cx, |_, window, _| window.hitbox_owners.len())
            .unwrap();
        assert_eq!(leftover, 0, "after the frame");
    }

    actions!(native_view_tests, [Reserved, Ordinary]);

    struct TestView {
        native_view: NativeView,
        other_focus: FocusHandle,
        actions: Vec<&'static str>,
        /// The key presses dispatched to the window's content.
        keys: Vec<String>,
        presses: Vec<&'static str>,
        paints_native_view_twice: bool,
        rounded_view: Option<NativeView>,
        occludes_under_rounded_view: bool,
        /// How many times the input handler of the "cover" element was told to
        /// end its composition.
        unmark_count: usize,
    }

    impl Render for TestView {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            div()
                .size_full()
                .on_action(cx.listener(|this, _: &Reserved, _, _| this.actions.push("reserved")))
                .on_action(cx.listener(|this, _: &Ordinary, _, _| this.actions.push("ordinary")))
                .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, _| {
                    this.keys.push(event.keystroke.key.clone())
                }))
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .size(px(100.))
                        .bg(rgb(0xff0000))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, _, _| this.presses.push("behind view")),
                        )
                        .child(self.native_view.clone()),
                )
                .when(self.occludes_under_rounded_view, |this| {
                    this.child(
                        div()
                            .id("under rounded view")
                            .absolute()
                            .top(px(60.))
                            .left(px(60.))
                            .size(px(40.))
                            .occlude(),
                    )
                })
                .when_some(self.rounded_view.clone(), |this, rounded_view| {
                    this.child(
                        div()
                            .absolute()
                            .top(px(60.))
                            .left(px(60.))
                            .size(px(40.))
                            .child(rounded_view),
                    )
                })
                .when(self.paints_native_view_twice, |this| {
                    this.child(
                        div()
                            .absolute()
                            .top_0()
                            .left(px(200.))
                            .size(px(100.))
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(|this, _, _, _| {
                                    this.presses.push("behind second occurrence")
                                }),
                            )
                            .child(self.native_view.clone()),
                    )
                })
                .child(
                    div()
                        .id("cover")
                        .track_focus(&self.other_focus)
                        .absolute()
                        .top_0()
                        .left_0()
                        .size(px(50.))
                        .occlude()
                        .bg(rgb(0x0000ff))
                        .on_mouse_down_out(
                            cx.listener(|this, _, _, _| this.presses.push("outside cover")),
                        )
                        .child({
                            let focus = self.other_focus.clone();
                            let view = cx.entity();
                            canvas(
                                |_, _, _| {},
                                move |_, _, window, cx| {
                                    window.handle_input(&focus, TestInput { view }, cx);
                                },
                            )
                            .size_full()
                        }),
                )
        }
    }

    /// Reaches its view as an element's input handler does, by updating it.
    struct TestInput {
        view: Entity<TestView>,
    }

    impl InputHandler for TestInput {
        fn selected_text_range(
            &mut self,
            _: bool,
            _: &mut Window,
            _: &mut App,
        ) -> Option<UTF16Selection> {
            None
        }

        fn marked_text_range(&mut self, _: &mut Window, _: &mut App) -> Option<Range<usize>> {
            None
        }

        fn text_for_range(
            &mut self,
            _: Range<usize>,
            _: &mut Option<Range<usize>>,
            _: &mut Window,
            _: &mut App,
        ) -> Option<String> {
            None
        }

        fn replace_text_in_range(
            &mut self,
            _: Option<Range<usize>>,
            _: &str,
            _: &mut Window,
            _: &mut App,
        ) {
        }

        fn replace_and_mark_text_in_range(
            &mut self,
            _: Option<Range<usize>>,
            _: &str,
            _: Option<Range<usize>>,
            _: &mut Window,
            _: &mut App,
        ) {
        }

        fn unmark_text(&mut self, _: &mut Window, cx: &mut App) {
            self.view.update(cx, |view, _| view.unmark_count += 1);
        }

        fn bounds_for_range(
            &mut self,
            _: Range<usize>,
            _: &mut Window,
            _: &mut App,
        ) -> Option<Bounds<Pixels>> {
            None
        }

        fn character_index_for_point(
            &mut self,
            _: Point<Pixels>,
            _: &mut Window,
            _: &mut App,
        ) -> Option<usize> {
            None
        }
    }

    struct StretchedView {
        view: NativeView,
        scale_xy: (f32, f32),
        angle: f32,
    }

    impl Render for StretchedView {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let (x, y) = self.scale_xy;
            div().size_full().child(
                div()
                    .absolute()
                    .left(px(100.))
                    .top(px(100.))
                    .w(px(200.))
                    .h(px(100.))
                    .scale_xy(x, y)
                    .rotate(Radians(self.angle))
                    .child(self.view.clone()),
            )
        }
    }

    fn painted_stretched_view(
        window: WindowHandle<StretchedView>,
        cx: &mut TestAppContext,
    ) -> (PaintNativeView, f32) {
        window
            .update(cx, |_, window, _| {
                let native_views = &window.rendered_frame.scene.native_views;
                assert_eq!(native_views.len(), 1);
                (native_views[0], window.scale_factor())
            })
            .unwrap()
    }

    #[gpui::test]
    fn a_native_view_carries_the_scale_of_each_axis_it_is_painted_in(cx: &mut TestAppContext) {
        let window = cx.add_window(|window, cx| StretchedView {
            view: new_native_view(window, cx),
            scale_xy: (0.5, 2.),
            angle: 0.,
        });
        cx.run_until_parked();
        let (native_view, scale_factor) = painted_stretched_view(window, cx);
        assert_eq!(native_view.scale, 1.);
        assert_eq!(native_view.axis_scale, point(0.5, 2.));
        assert_eq!(native_view.scales(), point(0.5, 2.));
        assert!(native_view.is_transformed());
        let in_points = |length: ScaledPixels| length.0 / scale_factor;
        assert_eq!(
            (
                in_points(native_view.layout_size.width),
                in_points(native_view.layout_size.height)
            ),
            (200., 100.)
        );
        assert_eq!(
            (
                in_points(native_view.bounds.origin.x),
                in_points(native_view.bounds.origin.y),
                in_points(native_view.bounds.size.width),
                in_points(native_view.bounds.size.height),
            ),
            (150., 50., 100., 200.)
        );

        let platform_window = cx.test_window(window.into());
        let id = window.update(cx, |view, _, _| view.view.0.id).unwrap();
        assert_eq!(
            platform_window.hit_test_native_view(point(px(160.), px(60.))),
            Some(id),
            "the view is hit where it is drawn, above its layout"
        );
        assert_eq!(
            platform_window.hit_test_native_view(point(px(120.), px(150.))),
            None,
            "and not in its layout beside where it is drawn"
        );

        window
            .update(cx, |view, _, cx| {
                view.scale_xy = (0.5, 0.5);
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();
        let (native_view, _) = painted_stretched_view(window, cx);
        assert_eq!(native_view.scale, 0.5);
        assert_eq!(native_view.axis_scale, point(1., 1.));

        window
            .update(cx, |view, _, cx| {
                view.scale_xy = (0.5, 2.);
                view.angle = std::f32::consts::FRAC_PI_2;
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();
        let (native_view, scale_factor) = painted_stretched_view(window, cx);
        let scales = native_view.scales();
        assert!((scales.x - 0.5).abs() < 1e-6 && (scales.y - 2.).abs() < 1e-6);
        let shown = native_view
            .bounds
            .size
            .map(|length| length.0 / scale_factor);
        assert!((shown.width - 100.).abs() < 1e-3 && (shown.height - 200.).abs() < 1e-3);
        assert_eq!(
            platform_window.hit_test_native_view(point(px(200.), px(240.))),
            Some(id),
            "the turned view stays upright, stretched along its own axes"
        );
        assert_eq!(
            platform_window.hit_test_native_view(point(px(290.), px(150.))),
            None
        );
    }

    fn open_window(cx: &mut TestAppContext) -> WindowHandle<TestView> {
        cx.add_window(|window, cx| TestView {
            native_view: new_native_view(window, cx),
            other_focus: cx.focus_handle(),
            actions: Vec::new(),
            keys: Vec::new(),
            presses: Vec::new(),
            paints_native_view_twice: false,
            rounded_view: None,
            occludes_under_rounded_view: false,
            unmark_count: 0,
        })
    }

    fn new_native_view(window: &mut Window, cx: &mut App) -> NativeView {
        // SAFETY: The test platform never reads the view it is given.
        unsafe { NativeView::new(NonNull::dangling(), window, cx) }
            .expect("the test platform attaches native views")
    }
}
