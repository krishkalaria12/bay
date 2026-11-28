//! Presents a window synchronously while a trackpad gesture moves it.
//!
//! A `CAMetalDisplayLink` frame reaches the display several refreshes after
//! the link asks for it. While a scroll or pinch gesture is moving the window,
//! the window instead draws right after each event that dirties it and
//! presents with the Core Animation transaction, so its native views move in
//! the same transaction as its GPUI content. The display link comes back once
//! the gesture and its momentum end. `ARDIA_GPUI_GESTURE_PRESENT=0` turns this
//! off.

use super::{FrameSource, MacWindowState, frame_drawable, native_views};
use crate::{GesturePhase, GestureTransition, MetalFrames};
use gpui::{FrameRequestSource, PlatformFrameSignal, RequestFrameOptions};
use objc2::{Message, msg_send, runtime::AnyObject};
use objc2_app_kit::{NSEventPhase, NSEventType};
use parking_lot::Mutex;
use std::rc::Rc;

pub(super) fn gesture_phase(native_event: *mut AnyObject) -> Option<GesturePhase> {
    let event_type: NSEventType = unsafe { msg_send![native_event, type] };
    let momentum = match event_type {
        NSEventType::ScrollWheel => {
            let momentum: NSEventPhase = unsafe { msg_send![native_event, momentumPhase] };
            momentum
        }
        NSEventType::Magnify => NSEventPhase::None,
        _ => return None,
    };
    let phase: NSEventPhase = unsafe { msg_send![native_event, phase] };
    Some(GesturePhase::from_bits(phase.0 as u64, momentum.0 as u64))
}

fn metal_frames(state: &MacWindowState) -> Option<Rc<MetalFrames>> {
    match &state.frame_source {
        FrameSource::Metal(metal_frames) => Some(metal_frames.clone()),
        FrameSource::DisplayLink(_) => None,
    }
}

pub(super) fn before_dispatch(state: &MacWindowState) {
    if let Some(metal_frames) = metal_frames(state) {
        metal_frames.begin_gesture_dispatch();
    }
}

pub(super) fn after_dispatch(window_state: &Rc<Mutex<MacWindowState>>, phase: GesturePhase) {
    let Some(metal_frames) = metal_frames(&window_state.lock()) else {
        return;
    };
    if metal_frames.gesture_after_event(phase) == GestureTransition::Enter {
        let mut lock = window_state.lock();
        lock.stop_display_link();
        let refresh_interval = refresh_interval(&lock);
        metal_frames.enter_gesture_mode(&mut lock.renderer, refresh_interval);
    }
    present_if_due(window_state, &metal_frames);
}

fn present_if_due(window_state: &Rc<Mutex<MacWindowState>>, metal_frames: &Rc<MetalFrames>) {
    if !metal_frames.is_in_gesture_mode() {
        return;
    }
    if metal_frames.gesture_frame_due() {
        draw(window_state, metal_frames);
    }
    schedule_tick(window_state, metal_frames);
}

fn refresh_interval(state: &MacWindowState) -> f64 {
    let screen: *mut AnyObject = unsafe { msg_send![state.native_window, screen] };
    if screen.is_null() {
        return 0.0;
    }
    unsafe { msg_send![screen, minimumRefreshInterval] }
}

fn draw(window_state: &Rc<Mutex<MacWindowState>>, metal_frames: &MetalFrames) {
    let signal_at = PlatformFrameSignal::capture(scheduler::Instant::now);
    let drawable = frame_drawable::with_unlocked(
        window_state,
        |state| {
            state.request_frame_callback.as_ref()?;
            state.renderer.layer().map(|layer| layer.retain())
        },
        |layer| layer.nextDrawable(),
    );
    let Some(Some(drawable)) = drawable else {
        return;
    };
    let mut lock = window_state.lock();
    let Some(mut callback) = lock.request_frame_callback.take() else {
        return;
    };
    if metal_frames.is_attached() {
        lock.request_frame_callback = Some(callback);
        return;
    }
    metal_frames.begin_gesture_frame(&drawable);
    lock.renderer.set_display_link_attached(true);
    lock.renderer.set_frame_drawable(Some(drawable));
    drop(lock);
    frame_drawable::in_transaction(|| {
        callback(RequestFrameOptions {
            signal_at,
            signal_source: FrameRequestSource::NativeCallback,
            ..Default::default()
        })
    });
    let mut lock = window_state.lock();
    lock.request_frame_callback = Some(callback);
    let used_drawable = if metal_frames.is_attached() {
        true
    } else {
        let used_drawable = lock.renderer.set_frame_drawable(None).is_none();
        lock.renderer.set_display_link_attached(false);
        used_drawable
    };
    drop(lock);
    metal_frames.end_gesture_frame(used_drawable);
    native_views::check_pointer_after_frame(window_state);
}

fn schedule_tick(window_state: &Rc<Mutex<MacWindowState>>, metal_frames: &MetalFrames) {
    let Some(delay) = metal_frames.schedule_gesture_tick() else {
        return;
    };
    let lock = window_state.lock();
    let foreground_executor = lock.foreground_executor.clone();
    let background_executor = lock.background_executor.clone();
    drop(lock);
    let window_state = Rc::downgrade(window_state);
    foreground_executor
        .spawn(async move {
            background_executor.timer(delay).await;
            if let Some(window_state) = window_state.upgrade() {
                tick(&window_state);
            }
        })
        .detach();
}

fn tick(window_state: &Rc<Mutex<MacWindowState>>) {
    let Some(metal_frames) = metal_frames(&window_state.lock()) else {
        return;
    };
    metal_frames.gesture_tick_fired();
    if metal_frames.gesture_tick() == GestureTransition::Exit {
        let mut lock = window_state.lock();
        metal_frames.exit_gesture_mode(&mut lock.renderer);
        lock.start_display_link(window_state);
        return;
    }
    present_if_due(window_state, &metal_frames);
}
