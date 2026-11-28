//! NNCore on macOS, through `bridge.mm` (include/bay_engine_mac.h). Everything here runs on the main thread, inside
//! Chromium's run loop.

use std::cell::RefCell;
use std::ffi::{CString, c_char, c_int, c_void};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr::{self, NonNull};

// The host glue compiled into this crate calls these crates' C functions (bay_blocker_*, bay_lists_*, bay_plugins_*,
// bay_switches_*): naming them keeps them linked.
use bay_adblock as _;
use bay_lists as _;
use bay_plugins as _;
use bay_switches as _;

type Launched = unsafe extern "C" fn(context: *mut c_void);
type VoidSuper = unsafe extern "C" fn(thunk: *mut c_void);
type BoolSuper = unsafe extern "C" fn(thunk: *mut c_void) -> bool;

#[repr(C)]
struct HostedHooks {
    send_event: unsafe extern "C" fn(*mut c_void, *mut c_void, VoidSuper, *mut c_void),
    key_down: unsafe extern "C" fn(*mut c_void, *mut c_void, VoidSuper, *mut c_void),
    make_first_responder:
        unsafe extern "C" fn(*mut c_void, *mut c_void, BoolSuper, *mut c_void) -> bool,
    perform_key_equivalent:
        unsafe extern "C" fn(*mut c_void, *mut c_void, BoolSuper, *mut c_void) -> bool,
}

#[cfg(not(bay_engine_stub))]
unsafe extern "C" {
    fn bay_engine_run(
        argc: c_int,
        argv: *mut *mut c_char,
        launched: Launched,
        context: *mut c_void,
    ) -> c_int;
    fn bay_engine_window_open(x: f64, y: f64, width: f64, height: f64) -> *mut c_void;
    fn bay_engine_window_ns_window(window: *mut c_void) -> *mut c_void;
    fn bay_engine_window_host_view(window: *mut c_void) -> *mut c_void;
    fn bay_engine_window_show(window: *mut c_void);
    fn bay_engine_window_open_tab(
        window: *mut c_void,
        url: *const c_char,
        foreground: bool,
    ) -> *mut c_void;
    fn bay_engine_tab_view(tab: *mut c_void) -> *mut c_void;
    fn bay_engine_tab_navigate(tab: *mut c_void, url: *const c_char);
    fn bay_engine_release(object: *mut c_void);
    fn bay_engine_route_window(ns_window: *mut c_void, hooks: *const HostedHooks) -> bool;
}

#[cfg(bay_engine_stub)]
use stub::*;

/// A build without the engine framework (CI, a checkout that hasn't built or fetched one): everything compiles and
/// links, and running says what is missing. build.rs picks it.
#[cfg(bay_engine_stub)]
mod stub {
    use super::{HostedHooks, Launched};
    use std::ffi::{c_char, c_int, c_void};
    use std::ptr;

    pub(super) unsafe fn bay_engine_run(
        _: c_int,
        _: *mut *mut c_char,
        _: Launched,
        _: *mut c_void,
    ) -> c_int {
        eprintln!(
            "bay: built without the NNCore framework (packages/chromium/scripts/stage-framework.sh, then rebuild)"
        );
        1
    }
    pub(super) unsafe fn bay_engine_window_open(_: f64, _: f64, _: f64, _: f64) -> *mut c_void {
        ptr::null_mut()
    }
    pub(super) unsafe fn bay_engine_window_ns_window(_: *mut c_void) -> *mut c_void {
        ptr::null_mut()
    }
    pub(super) unsafe fn bay_engine_window_host_view(_: *mut c_void) -> *mut c_void {
        ptr::null_mut()
    }
    pub(super) unsafe fn bay_engine_window_show(_: *mut c_void) {}
    pub(super) unsafe fn bay_engine_window_open_tab(
        _: *mut c_void,
        _: *const c_char,
        _: bool,
    ) -> *mut c_void {
        ptr::null_mut()
    }
    pub(super) unsafe fn bay_engine_tab_view(_: *mut c_void) -> *mut c_void {
        ptr::null_mut()
    }
    pub(super) unsafe fn bay_engine_tab_navigate(_: *mut c_void, _: *const c_char) {}
    pub(super) unsafe fn bay_engine_release(_: *mut c_void) {}
    pub(super) unsafe fn bay_engine_route_window(_: *mut c_void, _: *const HostedHooks) -> bool {
        false
    }
}

/// Runs Chromium on this thread (the process's main thread) and returns its exit code when the app quits.
/// `launched` runs once, inside Chromium's loop, when the engine is up and windows can be made.
pub fn run(args: impl IntoIterator<Item = String>, launched: impl FnOnce() + 'static) -> i32 {
    // Chromium reads argv for the process's life (its helpers relaunch with it): the strings are never freed.
    let mut argv: Vec<*mut c_char> = args
        .into_iter()
        .filter_map(|arg| CString::new(arg).ok())
        .map(CString::into_raw)
        .collect();
    let argc = argv.len() as c_int;
    argv.push(ptr::null_mut());
    let argv = Box::leak(argv.into_boxed_slice()).as_mut_ptr();
    let launched: Box<Box<dyn FnOnce()>> = Box::new(Box::new(launched));
    unsafe extern "C" fn trampoline(context: *mut c_void) {
        // SAFETY: `context` is the box `run` leaked, and the bridge calls this once.
        let launched = unsafe { Box::from_raw(context.cast::<Box<dyn FnOnce()>>()) };
        if catch_unwind(AssertUnwindSafe(launched)).is_err() {
            eprintln!("[bay-engine] the app's launch panicked");
        }
    }
    // SAFETY: argv is a null-terminated array of C strings that lives for the process; the context is a leaked box
    // the trampoline takes back.
    unsafe { bay_engine_run(argc, argv, trampoline, Box::into_raw(launched).cast()) }
}

/// An engine window (NNCoreWindow): its AppKit window, and the host's root view the UI draws in.
pub struct Window(NonNull<c_void>);

impl Window {
    /// A new window with its content at `origin` and `size`, in screen points (origin bottom-left, as AppKit's).
    pub fn open(origin: (f64, f64), size: (f64, f64)) -> Option<Self> {
        // SAFETY: main thread; the bridge returns a retained window or null.
        NonNull::new(unsafe { bay_engine_window_open(origin.0, origin.1, size.0, size.1) })
            .map(Self)
    }

    /// The NSWindow.
    pub fn ns_window(&self) -> NonNull<c_void> {
        // SAFETY: a live NNCoreWindow always has its window.
        NonNull::new(unsafe { bay_engine_window_ns_window(self.0.as_ptr()) })
            .expect("an engine window has a window")
    }

    /// The host's root view: it fills the window, above Chrome's own views.
    pub fn host_view(&self) -> Option<NonNull<c_void>> {
        // SAFETY: a live NNCoreWindow.
        NonNull::new(unsafe { bay_engine_window_host_view(self.0.as_ptr()) })
    }

    pub fn show(&self) {
        // SAFETY: a live NNCoreWindow, main thread.
        unsafe { bay_engine_window_show(self.0.as_ptr()) }
    }

    /// A tab of the default profile at `url`.
    pub fn open_tab(&self, url: &str, foreground: bool) -> Option<Tab> {
        let url = CString::new(url).ok()?;
        // SAFETY: a live NNCoreWindow; the bridge returns a retained tab or null.
        NonNull::new(unsafe {
            bay_engine_window_open_tab(self.0.as_ptr(), url.as_ptr(), foreground)
        })
        .map(Tab)
    }
}

impl Drop for Window {
    fn drop(&mut self) {
        // SAFETY: the retain bay_engine_window_open gave.
        unsafe { bay_engine_release(self.0.as_ptr()) }
    }
}

/// An engine tab (NNCoreTab).
pub struct Tab(NonNull<c_void>);

impl Tab {
    /// The page's view. The app places it; the tab keeps it alive.
    pub fn view(&self) -> Option<NonNull<c_void>> {
        // SAFETY: a live NNCoreTab.
        NonNull::new(unsafe { bay_engine_tab_view(self.0.as_ptr()) })
    }

    pub fn navigate(&self, url: &str) {
        if let Ok(url) = CString::new(url) {
            // SAFETY: a live NNCoreTab, main thread.
            unsafe { bay_engine_tab_navigate(self.0.as_ptr(), url.as_ptr()) }
        }
    }
}

impl Drop for Tab {
    fn drop(&mut self) {
        // SAFETY: the retain bay_engine_window_open_tab gave.
        unsafe { bay_engine_release(self.0.as_ptr()) }
    }
}

/// Where a routed window's input goes first. `call_super` runs the window's own handling (at most once); not calling
/// it consumes the event.
pub trait HostedRoutes {
    fn send_event(
        &self,
        window: NonNull<c_void>,
        event: NonNull<c_void>,
        call_super: &mut dyn FnMut(),
    );
    fn key_down(
        &self,
        window: NonNull<c_void>,
        event: NonNull<c_void>,
        call_super: &mut dyn FnMut(),
    );
    fn make_first_responder(
        &self,
        window: NonNull<c_void>,
        responder: Option<NonNull<c_void>>,
        call_super: &mut dyn FnMut() -> bool,
    ) -> bool;
    fn perform_key_equivalent(
        &self,
        window: NonNull<c_void>,
        event: NonNull<c_void>,
        call_super: &mut dyn FnMut() -> bool,
    ) -> bool;
}

thread_local! {
    static ROUTES: RefCell<Option<Box<dyn HostedRoutes>>> = const { RefCell::new(None) };
}

/// Routes `window`'s input through `routes` (the last routes given win; there is one UI).
pub fn route_window(window: &Window, routes: impl HostedRoutes + 'static) -> bool {
    ROUTES.with_borrow_mut(|slot| *slot = Some(Box::new(routes)));
    let hooks = HostedHooks {
        send_event: send_event_hook,
        key_down: key_down_hook,
        make_first_responder: make_first_responder_hook,
        perform_key_equivalent: perform_key_equivalent_hook,
    };
    // SAFETY: main thread; the bridge copies the table.
    unsafe { bay_engine_route_window(window.ns_window().as_ptr(), &hooks) }
}

/// Runs `route` with the routes, or `fallback` when there are none, a route is already running (a nested event), or
/// the route panics.
fn with_routes<T>(route: impl FnOnce(&dyn HostedRoutes) -> T, fallback: impl FnOnce() -> T) -> T {
    let answer = ROUTES.with(|slot| {
        let routes = slot.try_borrow().ok()?;
        let routes = routes.as_deref()?;
        catch_unwind(AssertUnwindSafe(|| route(routes))).ok()
    });
    match answer {
        Some(answer) => answer,
        None => fallback(),
    }
}

unsafe extern "C" fn send_event_hook(
    window: *mut c_void,
    event: *mut c_void,
    call_super: VoidSuper,
    thunk: *mut c_void,
) {
    // SAFETY: the bridge passes its own thunk, valid for this call.
    let mut call = || unsafe { call_super(thunk) };
    match (NonNull::new(window), NonNull::new(event)) {
        (Some(window), Some(event)) => with_routes(
            |routes| routes.send_event(window, event, &mut call),
            || unsafe { call_super(thunk) },
        ),
        _ => call(),
    }
}

unsafe extern "C" fn key_down_hook(
    window: *mut c_void,
    event: *mut c_void,
    call_super: VoidSuper,
    thunk: *mut c_void,
) {
    // SAFETY: as send_event_hook.
    let mut call = || unsafe { call_super(thunk) };
    match (NonNull::new(window), NonNull::new(event)) {
        (Some(window), Some(event)) => with_routes(
            |routes| routes.key_down(window, event, &mut call),
            || unsafe { call_super(thunk) },
        ),
        _ => call(),
    }
}

unsafe extern "C" fn make_first_responder_hook(
    window: *mut c_void,
    responder: *mut c_void,
    call_super: BoolSuper,
    thunk: *mut c_void,
) -> bool {
    // SAFETY: as send_event_hook.
    let mut call = || unsafe { call_super(thunk) };
    match NonNull::new(window) {
        Some(window) => with_routes(
            |routes| routes.make_first_responder(window, NonNull::new(responder), &mut call),
            || unsafe { call_super(thunk) },
        ),
        None => call(),
    }
}

unsafe extern "C" fn perform_key_equivalent_hook(
    window: *mut c_void,
    event: *mut c_void,
    call_super: BoolSuper,
    thunk: *mut c_void,
) -> bool {
    // SAFETY: as send_event_hook.
    let mut call = || unsafe { call_super(thunk) };
    match (NonNull::new(window), NonNull::new(event)) {
        (Some(window), Some(event)) => with_routes(
            |routes| routes.perform_key_equivalent(window, event, &mut call),
            || unsafe { call_super(thunk) },
        ),
        _ => call(),
    }
}
