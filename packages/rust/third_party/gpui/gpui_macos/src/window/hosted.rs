use super::{
    MacWindowState, WINDOW_STATE_IVAR, drop_window_state,
    native_views::{
        route_key_down, route_make_first_responder, route_perform_key_equivalent, route_send_event,
    },
    window_did_change_key_status, window_did_change_occlusion_state, window_did_change_screen,
    window_did_move, window_did_resize, window_state_if_set,
};
use crate::ns_string;
use objc2::{
    class, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel},
    sel,
};
use objc2_app_kit::{NSColor, NSView, NSWindow};
use parking_lot::Mutex;
use std::{
    cell::RefCell,
    ffi::c_void,
    ptr::{self, NonNull},
    rc::{Rc, Weak},
    sync::{OnceLock, atomic::Ordering},
};

fn notifications() -> [(&'static str, Sel); 7] {
    [
        ("NSWindowDidResizeNotification", sel!(windowDidResize:)),
        ("NSWindowDidMoveNotification", sel!(windowDidMove:)),
        (
            "NSWindowDidChangeScreenNotification",
            sel!(windowDidChangeScreen:),
        ),
        (
            "NSWindowDidBecomeKeyNotification",
            sel!(windowDidBecomeKey:),
        ),
        (
            "NSWindowDidResignKeyNotification",
            sel!(windowDidResignKey:),
        ),
        (
            "NSWindowDidChangeOcclusionStateNotification",
            sel!(windowDidChangeOcclusionState:),
        ),
        ("NSWindowWillCloseNotification", sel!(windowWillClose:)),
    ]
}

thread_local! {
    static HOSTED_WINDOWS: RefCell<Vec<(usize, Weak<Mutex<MacWindowState>>)>> = const { RefCell::new(Vec::new()) };
}

fn observer_class() -> &'static AnyClass {
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    CLASS.get_or_init(|| {
        let name = c"GPUIHostedWindowObserver";
        let Some(mut builder) = ClassBuilder::new(name, class!(NSObject)) else {
            return AnyClass::get(name).unwrap_or(class!(NSObject));
        };
        builder.add_ivar::<*mut c_void>(WINDOW_STATE_IVAR);
        unsafe {
            builder.add_method(
                sel!(windowDidResize:),
                window_did_resize as extern "C" fn(_, Sel, *mut AnyObject),
            );
            builder.add_method(
                sel!(windowDidMove:),
                window_did_move as extern "C" fn(_, Sel, *mut AnyObject),
            );
            builder.add_method(
                sel!(windowDidChangeScreen:),
                window_did_change_screen as extern "C" fn(_, Sel, *mut AnyObject),
            );
            builder.add_method(
                sel!(windowDidBecomeKey:),
                window_did_change_key_status as extern "C" fn(_, Sel, *mut AnyObject),
            );
            builder.add_method(
                sel!(windowDidResignKey:),
                window_did_change_key_status as extern "C" fn(_, Sel, *mut AnyObject),
            );
            builder.add_method(
                sel!(windowDidChangeOcclusionState:),
                window_did_change_occlusion_state as extern "C" fn(_, Sel, *mut AnyObject),
            );
            builder.add_method(
                sel!(windowWillClose:),
                window_will_close as extern "C" fn(_, Sel, *mut AnyObject),
            );
            builder.add_method(sel!(dealloc), dealloc_observer as extern "C" fn(_, Sel));
        }
        builder.register()
    })
}

pub(super) struct Host {
    window: Retained<NSWindow>,
    state: Weak<Mutex<MacWindowState>>,
    view: Option<Retained<NSView>>,
    observer: Option<Retained<AnyObject>>,
    chrome: Option<Chrome>,
}

struct Chrome {
    opaque: bool,
    background: Retained<NSColor>,
}

pub(super) struct Detached {
    window: Retained<NSWindow>,
    view: Option<Retained<NSView>>,
    chrome: Option<Chrome>,
}

impl Host {
    pub(super) unsafe fn attach(
        window_state: &Rc<Mutex<MacWindowState>>,
        window: *mut AnyObject,
        view: *mut AnyObject,
    ) -> Self {
        let window = unsafe { Retained::retain(window.cast::<NSWindow>()) }
            .expect("a hosted GPUI window needs its host NSWindow");
        let view = unsafe { Retained::retain(view.cast::<NSView>()) }
            .expect("a hosted GPUI window needs its GPUI view");
        let observer: Retained<AnyObject> = unsafe { msg_send![observer_class(), new] };
        unsafe {
            observer
                .class()
                .instance_variable(WINDOW_STATE_IVAR)
                .expect("hosted window observer state ivar")
                .load_ptr::<*mut c_void>(&observer)
                .write(Rc::into_raw(window_state.clone()).cast_mut().cast());
            let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
            for (name, selector) in notifications() {
                let _: () = msg_send![
                    center,
                    addObserver: &*observer,
                    selector: selector,
                    name: ns_string(name),
                    object: &*window
                ];
            }
        }
        let address = Retained::as_ptr(&window) as usize;
        HOSTED_WINDOWS.with_borrow_mut(|windows| {
            windows.retain(|(_, state)| state.strong_count() > 0);
            windows.push((address, Rc::downgrade(window_state)));
        });
        Self {
            window,
            state: Rc::downgrade(window_state),
            view: Some(view),
            observer: Some(observer),
            chrome: None,
        }
    }

    pub(super) fn save_chrome(&mut self) {
        if self.chrome.is_none() && self.observer.is_some() {
            self.chrome = Some(Chrome {
                opaque: self.window.isOpaque(),
                background: self.window.backgroundColor(),
            });
        }
    }

    pub(super) fn detach(&mut self) -> Option<Detached> {
        let observer = self.observer.take()?;
        unsafe {
            let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
            let _: () = msg_send![center, removeObserver: &*observer];
            drop_window_state(&observer);
        }
        let _ = HOSTED_WINDOWS.try_with(|windows| {
            windows
                .borrow_mut()
                .retain(|(_, state)| !state.ptr_eq(&self.state) && state.strong_count() > 0)
        });
        Some(Detached {
            window: self.window.clone(),
            view: self.view.take(),
            chrome: self.chrome.take(),
        })
    }
}

impl Detached {
    pub(super) fn restore_chrome(&mut self) {
        if let Some(chrome) = self.chrome.take() {
            self.window.setOpaque(chrome.opaque);
            self.window.setBackgroundColor(Some(&chrome.background));
        }
    }

    pub(super) fn finish(
        self,
        views: impl IntoIterator<Item = Retained<NSView>>,
        host_closed: bool,
    ) {
        let views = self.view.into_iter().chain(views).collect::<Vec<_>>();
        if !host_closed {
            unsafe {
                let responder: *mut AnyObject = msg_send![&*self.window, firstResponder];
                let is_view: bool =
                    !responder.is_null() && msg_send![responder, isKindOfClass: class!(NSView)];
                if is_view
                    && views
                        .iter()
                        .any(|view| msg_send![responder, isDescendantOf: &**view])
                {
                    let _: Bool = msg_send![
                        &*self.window,
                        makeFirstResponder: ptr::null_mut::<AnyObject>()
                    ];
                }
            }
        }
        for view in views.iter().rev() {
            view.removeFromSuperview();
        }
    }
}

pub(super) fn window_state(native_window: *mut AnyObject) -> Option<Rc<Mutex<MacWindowState>>> {
    HOSTED_WINDOWS.with_borrow(|windows| {
        windows
            .iter()
            .find(|(window, _)| *window == native_window as usize)
            .and_then(|(_, state)| state.upgrade())
    })
}

extern "C" fn window_will_close(this: &AnyObject, _: Sel, _: *mut AnyObject) {
    let Some(window_state) = (unsafe { window_state_if_set(this) }) else {
        return;
    };
    let close_callback = {
        let mut lock = window_state.lock();
        lock.closed.store(true, Ordering::Release);
        lock.close_callback.take()
    };
    if let Some(callback) = close_callback {
        callback();
    }
}

extern "C" fn dealloc_observer(this: &AnyObject, _: Sel) {
    unsafe {
        drop_window_state(this);
        let _: () = msg_send![super(this, class!(NSObject)), dealloc];
    }
}

#[allow(clippy::missing_safety_doc)]
pub unsafe fn send_event(
    window: NonNull<c_void>,
    event: NonNull<c_void>,
    call_super: impl FnOnce(),
) {
    let window = window.cast::<AnyObject>();
    unsafe {
        route_send_event(
            window.as_ref(),
            window_state(window.as_ptr()),
            event.as_ptr().cast(),
            call_super,
        )
    }
}

#[allow(clippy::missing_safety_doc)]
pub unsafe fn make_first_responder(
    window: NonNull<c_void>,
    responder: Option<NonNull<c_void>>,
    call_super: impl FnOnce() -> bool,
) -> bool {
    let window = window.cast::<AnyObject>();
    let responder = responder.map_or(ptr::null_mut(), |responder| responder.as_ptr().cast());
    unsafe {
        route_make_first_responder(
            window.as_ref(),
            window_state(window.as_ptr()),
            responder,
            || Bool::new(call_super()),
        )
    }
    .as_bool()
}

#[allow(clippy::missing_safety_doc)]
pub unsafe fn perform_key_equivalent(
    window: NonNull<c_void>,
    event: NonNull<c_void>,
    call_super: impl FnOnce() -> bool,
) -> bool {
    let window = window.cast::<AnyObject>();
    unsafe {
        route_perform_key_equivalent(
            window.as_ref(),
            window_state(window.as_ptr()),
            event.as_ptr().cast(),
            || Bool::new(call_super()),
        )
    }
    .as_bool()
}

#[allow(clippy::missing_safety_doc)]
pub unsafe fn key_down(window: NonNull<c_void>, event: NonNull<c_void>, call_super: impl FnOnce()) {
    let window = window.cast::<AnyObject>();
    unsafe {
        route_key_down(
            window.as_ref(),
            window_state(window.as_ptr()),
            event.as_ptr().cast(),
            call_super,
        )
    }
}
