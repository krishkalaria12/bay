//! Drawables for frames drawn outside a display link's update.
//!
//! `nextDrawable` blocks while every drawable is in flight, so it runs with
//! the window's lock released: AppKit hit testing and other callbacks only try
//! the lock and would otherwise fail for as long as it blocks.

use super::{MacWindowState, renderer::Renderer};
use objc2::{Message, class, msg_send, rc::Retained, runtime::ProtocolObject};
use objc2_quartz_core::CAMetalDrawable;
use parking_lot::Mutex;

pub(super) type Drawable = Retained<ProtocolObject<dyn CAMetalDrawable>>;

/// What a frame drawn outside a display link's update draws into.
pub(super) enum FrameDrawable {
    /// A display link supplies the drawable, or the renderer has no layer.
    Supplied,
    /// A drawable taken from the layer with the lock released.
    Acquired(Drawable),
    /// The layer had no drawable to give.
    Unavailable,
}

/// Runs `prepare` with `state` locked and then `acquire` with it unlocked.
/// Returns `None` when `prepare` does.
pub(super) fn with_unlocked<S, L, R>(
    state: &Mutex<S>,
    prepare: impl FnOnce(&mut S) -> Option<L>,
    acquire: impl FnOnce(L) -> R,
) -> Option<R> {
    let prepared = prepare(&mut state.lock())?;
    Some(acquire(prepared))
}

/// Takes the layer's next drawable unless a display link supplies one.
pub(super) fn next_drawable(window_state: &Mutex<MacWindowState>) -> FrameDrawable {
    let acquired = with_unlocked(
        window_state,
        |state| {
            if state.renderer.is_display_link_attached() {
                return None;
            }
            state.renderer.layer().map(|layer| layer.retain())
        },
        |layer| layer.nextDrawable(),
    );
    match acquired {
        None => FrameDrawable::Supplied,
        Some(Some(drawable)) => FrameDrawable::Acquired(drawable),
        Some(None) => FrameDrawable::Unavailable,
    }
}

/// Draws `scene` into `drawable` the way a display link's frame would, then
/// leaves the renderer detached again.
pub(super) fn draw_into(renderer: &mut Renderer, drawable: Drawable, scene: &gpui::Scene) {
    renderer.set_display_link_attached(true);
    renderer.set_frame_drawable(Some(drawable));
    renderer.draw(scene);
    renderer.set_frame_drawable(None);
    renderer.set_display_link_attached(false);
}

/// Runs `f` in an explicit Core Animation transaction, so that a drawable
/// presented with the transaction and the layer changes made after it reach
/// the display together.
pub(super) fn in_transaction<R>(f: impl FnOnce() -> R) -> R {
    unsafe {
        let _: () = msg_send![class!(CATransaction), begin];
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

    #[test]
    fn the_drawable_is_acquired_with_the_lock_released() {
        let state = Mutex::new(1);
        let acquired = with_unlocked(
            &state,
            |value| {
                *value += 1;
                Some(*value)
            },
            |prepared| {
                assert!(
                    state.try_lock().is_some(),
                    "acquiring must not hold the lock"
                );
                prepared * 10
            },
        );
        assert_eq!(acquired, Some(20));
    }

    #[test]
    fn nothing_is_acquired_when_preparation_declines() {
        let state = Mutex::new(());
        let acquired = with_unlocked(&state, |_| None::<()>, |_| unreachable!());
        assert_eq!(acquired, None);
    }
}
