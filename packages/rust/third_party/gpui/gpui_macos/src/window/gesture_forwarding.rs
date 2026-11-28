//! Gives GPUI the trackpad gestures that AppKit sends to its native views.
//!
//! AppKit sends a pinch or swipe to the view under the pointer, so one over a
//! native view never reaches the GPUI view. While any native view is attached,
//! an event monitor passes GPUI each such gesture as the GPUI view would have
//! received it, and lets the event go on to the native view unless GPUI handled
//! it by stopping its propagation.

use super::{
    MacWindowState,
    native_views::{hit_test_native_view, native_view_under_press},
    window_state_of,
};
use crate::events::platform_input_from_native;
use block2::RcBlock;
use objc2::{msg_send, rc::Retained, runtime::AnyObject};
use objc2_app_kit::{NSEvent, NSEventMask, NSEventPhase, NSEventType};
use objc2_foundation::NSPoint;
use parking_lot::Mutex;
use std::{
    cell::{Cell, RefCell},
    ptr::{self, NonNull},
    rc::{Rc, Weak},
    sync::atomic::Ordering,
};

thread_local! {
    static MONITOR: RefCell<Weak<GestureMonitor>> = const { RefCell::new(Weak::new()) };
    static PINCH: Cell<Option<PinchRoute>> = const { Cell::new(None) };
}

/// The process's gesture monitor, installed while any window has a native view attached.
pub(super) struct GestureMonitor {
    monitor: Retained<AnyObject>,
}

impl GestureMonitor {
    /// Returns the installed monitor, installing it if no attached view holds it.
    pub(super) fn acquire() -> Option<Rc<Self>> {
        if let Some(monitor) = MONITOR.with_borrow(Weak::upgrade) {
            return Some(monitor);
        }
        let handler = RcBlock::new(handle_gesture);
        let monitor = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::Magnify | NSEventMask::Swipe,
                &handler,
            )
        }?;
        let monitor = Rc::new(Self { monitor });
        MONITOR.set(Rc::downgrade(&monitor));
        Some(monitor)
    }
}

impl Drop for GestureMonitor {
    fn drop(&mut self) {
        PINCH.set(None);
        unsafe { NSEvent::removeMonitor(&self.monitor) };
    }
}

fn handle_gesture(event: NonNull<NSEvent>) -> *mut NSEvent {
    if unsafe { forward_gesture(event.as_ref()) } {
        ptr::null_mut()
    } else {
        event.as_ptr()
    }
}

/// Runs a pinch or swipe through the gesture monitor as AppKit would, returning
/// the event AppKit goes on to send to the view under the pointer, or null when
/// GPUI kept it. With no native view attached there's no monitor, so the event
/// is returned untouched.
///
/// # Safety
///
/// `event` must be a valid `NSEvent`, and this must be called on the main thread.
#[doc(hidden)]
pub unsafe fn monitor_gesture(event: NonNull<AnyObject>) -> *mut AnyObject {
    let event = event.cast::<NSEvent>();
    if MONITOR.with_borrow(Weak::strong_count) == 0 {
        return event.as_ptr().cast();
    }
    handle_gesture(event).cast()
}

/// Where AppKit sends a gesture.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum GestureTarget {
    /// A view GPUI attached to its window, which the GPUI view never hears of.
    NativeView,
    /// The GPUI view, or anything else in a GPUI window that GPUI didn't attach.
    WindowContent,
    /// A window GPUI neither owns nor is hosted in.
    OtherWindow,
}

/// Whether GPUI is passed the pinch under way in a window, and how much of it GPUI
/// has claimed. AppKit keeps sending a pinch to the view it began over, so the
/// route is decided as the pinch begins.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct PinchRoute {
    window: usize,
    forwards: bool,
    claim: GestureClaim,
}

impl PinchRoute {
    /// Records whether GPUI handled an event of the pinch, returning whether the
    /// native view is kept from it and the route the rest of the pinch keeps.
    pub(super) fn after(self, phase: NSEventPhase, handled: bool) -> (bool, Option<Self>) {
        let (claim, consumes) = self.claim.after(phase, handled);
        (consumes, (!ends(phase)).then_some(Self { claim, ..self }))
    }
}

/// How much of a gesture GPUI keeps from the native view it was sent to. AppKit
/// and the native view only ever hear a gesture that begins and ends.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum GestureClaim {
    /// GPUI hasn't handled the gesture, so the native view hears all of it.
    Unclaimed,
    /// GPUI handled the gesture as it began, so the native view hears none of it.
    FromStart,
    /// GPUI handled the gesture after the native view heard it begin. The native
    /// view hears no more of it but its end, which closes the gesture it began.
    Midway,
}

impl GestureClaim {
    /// The claim after GPUI did or didn't handle an event of the gesture, and
    /// whether the native view is kept from that event.
    pub(super) fn after(self, phase: NSEventPhase, handled: bool) -> (Self, bool) {
        let claim = match self {
            _ if begins(phase) => {
                if handled {
                    Self::FromStart
                } else {
                    Self::Unclaimed
                }
            }
            Self::Unclaimed if handled => Self::Midway,
            claim => claim,
        };
        let consumes = match claim {
            Self::Unclaimed => false,
            Self::FromStart => true,
            Self::Midway => !ends(phase),
        };
        (claim, consumes)
    }
}

fn begins(phase: NSEventPhase) -> bool {
    phase.intersects(NSEventPhase::Began | NSEventPhase::MayBegin)
}

fn ends(phase: NSEventPhase) -> bool {
    phase.intersects(NSEventPhase::Ended | NSEventPhase::Cancelled)
}

/// Whether GPUI should be passed a gesture AppKit sends to `target`.
pub(super) fn forwards_gesture(target: GestureTarget) -> bool {
    target == GestureTarget::NativeView
}

/// The route of a pinch event in `window`: the pinch's own, or a new one as a pinch begins.
pub(super) fn route_pinch(
    route: Option<PinchRoute>,
    window: usize,
    phase: NSEventPhase,
    target: impl FnOnce() -> GestureTarget,
) -> PinchRoute {
    match route {
        Some(route) if route.window == window && !begins(phase) => route,
        _ => PinchRoute {
            window,
            forwards: forwards_gesture(target()),
            claim: GestureClaim::Unclaimed,
        },
    }
}

unsafe fn forward_gesture(event: &NSEvent) -> bool {
    let window: *mut AnyObject = unsafe { msg_send![event, window] };
    let window_state = unsafe { window_state_of(window) };
    let position = event.locationInWindow();
    let target = || match &window_state {
        Some(window_state) => unsafe { target_at(window_state, &*window, position) },
        None => GestureTarget::OtherWindow,
    };
    let handled_by_gpui = |forwards: bool| {
        forwards
            && window_state
                .as_ref()
                .is_some_and(|window_state| pass_gesture_to_gpui(window_state, event))
    };
    if event.r#type() == NSEventType::Magnify {
        let phase = event.phase();
        let route = route_pinch(PINCH.get(), window as usize, phase, target);
        let (consumes, route) = route.after(phase, handled_by_gpui(route.forwards));
        PINCH.set(route);
        consumes
    } else {
        handled_by_gpui(forwards_gesture(target()))
    }
}

unsafe fn target_at(
    window_state: &Rc<Mutex<MacWindowState>>,
    window: &AnyObject,
    position_in_window: NSPoint,
) -> GestureTarget {
    let under_view = hit_test_native_view(window_state, position_in_window)
        .and_then(|_| unsafe { native_view_under_press(window_state, window, position_in_window) });
    if under_view.is_some() {
        GestureTarget::NativeView
    } else {
        GestureTarget::WindowContent
    }
}

fn pass_gesture_to_gpui(window_state: &Rc<Mutex<MacWindowState>>, event: &NSEvent) -> bool {
    let (input, mut callback) = {
        let Some(mut lock) = window_state.try_lock() else {
            return false;
        };
        let native_event = event as *const NSEvent as *mut AnyObject;
        let Some(input) =
            (unsafe { platform_input_from_native(native_event, Some(lock.view_frame())) })
        else {
            return false;
        };
        let Some(callback) = lock.event_callback.take() else {
            return false;
        };
        lock.cursor_visible.store(true, Ordering::Relaxed);
        (input, callback)
    };
    let handled = !callback(input).propagate;
    window_state.lock().event_callback = Some(callback);
    handled
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_gestures_sent_to_a_native_view_are_forwarded() {
        assert!(forwards_gesture(GestureTarget::NativeView));
        assert!(!forwards_gesture(GestureTarget::WindowContent));
        assert!(!forwards_gesture(GestureTarget::OtherWindow));
    }

    #[test]
    fn a_pinch_keeps_the_route_it_began_with() {
        let unreachable = || -> GestureTarget { panic!("a pinch under way isn't hit-tested") };
        let route = route_pinch(None, 1, NSEventPhase::Began, || GestureTarget::NativeView);
        assert!(route.forwards);
        let (_, route) = route.after(NSEventPhase::Began, false);
        let route = route_pinch(route, 1, NSEventPhase::Changed, unreachable);
        assert!(
            route.forwards,
            "a pinch begun over a page goes on reaching GPUI"
        );
        let (_, route) = route.after(NSEventPhase::Changed, false);
        let route = route_pinch(route, 1, NSEventPhase::Ended, unreachable);
        assert!(route.forwards);
        let (_, route) = route.after(NSEventPhase::Ended, false);
        assert_eq!(route, None, "the route ends with the pinch");

        let route = route_pinch(None, 1, NSEventPhase::Began, || {
            GestureTarget::WindowContent
        });
        assert!(!route.forwards);
        let (_, route) = route.after(NSEventPhase::Began, false);
        let route = route_pinch(route, 1, NSEventPhase::Changed, unreachable);
        assert!(
            !route.forwards,
            "a pinch begun over the GPUI view stays its own"
        );
    }

    #[test]
    fn a_pinch_in_another_window_or_a_new_pinch_is_routed_again() {
        let over_page = Some(PinchRoute {
            window: 1,
            forwards: true,
            claim: GestureClaim::FromStart,
        });
        let route = route_pinch(over_page, 2, NSEventPhase::Changed, || {
            GestureTarget::OtherWindow
        });
        assert_eq!(
            route,
            PinchRoute {
                window: 2,
                forwards: false,
                claim: GestureClaim::Unclaimed,
            }
        );
        let route = route_pinch(over_page, 1, NSEventPhase::Began, || {
            GestureTarget::WindowContent
        });
        assert!(!route.forwards);
        assert_eq!(route.claim, GestureClaim::Unclaimed);
    }

    const PINCH: [NSEventPhase; 4] = [
        NSEventPhase::Began,
        NSEventPhase::Changed,
        NSEventPhase::Changed,
        NSEventPhase::Ended,
    ];

    fn consumed(handled: [bool; 4]) -> Vec<bool> {
        let mut route = None;
        let consumed = PINCH
            .iter()
            .zip(handled)
            .map(|(&phase, handled)| {
                let (consumes, next) = route_pinch(route, 1, phase, || {
                    assert!(route.is_none(), "a pinch under way isn't hit-tested");
                    GestureTarget::NativeView
                })
                .after(phase, handled);
                route = next;
                consumes
            })
            .collect();
        assert_eq!(route, None);
        consumed
    }

    #[test]
    fn a_pinch_gpui_handles_as_it_begins_is_kept_from_the_native_view() {
        assert_eq!(consumed([true, true, true, true]), [true; 4]);
        assert_eq!(
            consumed([true, false, false, false]),
            [true; 4],
            "the native view never hears the rest of a pinch it never heard begin"
        );
    }

    #[test]
    fn a_pinch_gpui_leaves_reaches_the_native_view() {
        assert_eq!(consumed([false; 4]), [false; 4]);
    }

    #[test]
    fn a_pinch_gpui_handles_midway_is_kept_from_the_native_view_until_it_ends() {
        assert_eq!(
            consumed([false, true, false, false]),
            [false, true, true, false],
            "the native view hears the pinch begin and end, and none of it in between"
        );
        assert_eq!(consumed([false, false, false, true]), [false; 4]);
    }

    #[test]
    fn a_cancelled_or_new_gesture_settles_its_claim() {
        assert_eq!(
            GestureClaim::Midway.after(NSEventPhase::Cancelled, false),
            (GestureClaim::Midway, false)
        );
        assert_eq!(
            GestureClaim::FromStart.after(NSEventPhase::Cancelled, false),
            (GestureClaim::FromStart, true)
        );
        assert_eq!(
            GestureClaim::FromStart.after(NSEventPhase::MayBegin, false),
            (GestureClaim::Unclaimed, false)
        );
    }
}
