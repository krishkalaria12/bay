//! The Phase 0 window. NNCore makes the window and its tab; GPUI draws in it (a hosted window) and places the tab's
//! page under its own drawing (a native view), so the command bar paints over the page in the same window.

use std::cell::RefCell;
use std::ffi::c_void;
use std::ops::Range;
use std::ptr::NonNull;

use bay_engine::macos::{self as engine, HostedRoutes};
use gpui::{
    App, ApplicationHandle, Context, Div, Entity, ExternalWindowHandle, FocusHandle, Focusable,
    KeyBinding, NativeView, Role, SharedString, Stateful, Window, WindowOptions, actions, deferred,
    div, prelude::*, px, rgb, rgba,
};
use gpui_platform::macos_hosted_window;

use crate::text_input::{self, TextInput};

actions!(
    bay_spike,
    [ToggleCommandBar, CloseCommandBar, SubmitCommandBar]
);

const HOME: &str = "https://en.wikipedia.org/wiki/Bay";
const ROWS: usize = 500;
const SIDEBAR_WIDTH: f32 = 260.;
const BAR_WIDTH: f32 = 620.;

thread_local! {
    /// GPUI lives inside Chromium's loop: its handle and the engine windows stay for the app's life.
    static APP: RefCell<Option<ApplicationHandle>> = const { RefCell::new(None) };
    static WINDOWS: RefCell<Vec<engine::Window>> = const { RefCell::new(Vec::new()) };
}

pub fn run() -> i32 {
    use_spike_data_dir();
    engine::run(std::env::args(), launch)
}

/// The host glue refuses a development build without a scratch data folder (BAY_DATA_DIR), so the installed Bay's data
/// is never opened by an unsigned build. A spike started from Finder or a test tool gets its own folder under
/// Application Support, apart from the installed app's.
fn use_spike_data_dir() {
    if std::env::var_os("BAY_DATA_DIR").is_some_and(|dir| !dir.is_empty()) {
        return;
    }
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let dir = std::path::Path::new(&home)
        .join("Library/Application Support/in.krishkalaria.bay.gpui/Spike");
    if std::fs::create_dir_all(&dir).is_ok() {
        // SAFETY: the process is still single-threaded; Chromium hasn't started.
        unsafe { std::env::set_var("BAY_DATA_DIR", &dir) };
    }
}

fn launch() {
    let app = gpui_platform::attached_macos_application().run_embedded(|cx| {
        text_input::bind_keys(cx);
        cx.bind_keys([
            KeyBinding::new("cmd-l", ToggleCommandBar, None),
            KeyBinding::new("escape", CloseCommandBar, Some("CommandBar")),
            KeyBinding::new("enter", SubmitCommandBar, Some("CommandBar")),
        ]);
        open_window(cx);
    });
    APP.with_borrow_mut(|slot| *slot = Some(app));
}

fn open_window(cx: &mut App) {
    let Some(core) = engine::Window::open((160., 120.), (1280., 820.)) else {
        eprintln!("bay: the engine made no window");
        return;
    };
    let Some(tab) = core.open_tab(HOME, true) else {
        eprintln!("bay: the engine opened no tab");
        return;
    };
    // SAFETY: both are the live NNCoreWindow's own window and root view, used on the main thread.
    let host = unsafe { ExternalWindowHandle::new(core.ns_window(), core.host_view()) };
    let options = WindowOptions {
        host_window: Some(host),
        ..WindowOptions::default()
    };
    if let Err(error) = cx.open_window(options, |window, cx| {
        cx.new(|cx| Spike::new(tab, window, cx))
    }) {
        eprintln!("bay: GPUI couldn't draw in the engine's window: {error:#}");
        return;
    }
    if !engine::route_window(&core, GpuiRoutes) {
        eprintln!("bay: the window's input couldn't be routed to GPUI");
    }
    core.show();
    WINDOWS.with_borrow_mut(|windows| windows.push(core));
}

/// A routed window's input goes to GPUI first, which hands what it leaves to the window (and so to the page).
struct GpuiRoutes;

impl HostedRoutes for GpuiRoutes {
    fn send_event(
        &self,
        window: NonNull<c_void>,
        event: NonNull<c_void>,
        call_super: &mut dyn FnMut(),
    ) {
        // SAFETY: the bridge passes the routed NSWindow and its event, on the main thread.
        unsafe { macos_hosted_window::send_event(window, event, call_super) }
    }

    fn key_down(
        &self,
        window: NonNull<c_void>,
        event: NonNull<c_void>,
        call_super: &mut dyn FnMut(),
    ) {
        // SAFETY: as send_event.
        unsafe { macos_hosted_window::key_down(window, event, call_super) }
    }

    fn make_first_responder(
        &self,
        window: NonNull<c_void>,
        responder: Option<NonNull<c_void>>,
        call_super: &mut dyn FnMut() -> bool,
    ) -> bool {
        // SAFETY: as send_event.
        unsafe { macos_hosted_window::make_first_responder(window, responder, call_super) }
    }

    fn perform_key_equivalent(
        &self,
        window: NonNull<c_void>,
        event: NonNull<c_void>,
        call_super: &mut dyn FnMut() -> bool,
    ) -> bool {
        // SAFETY: as send_event.
        unsafe { macos_hosted_window::perform_key_equivalent(window, event, call_super) }
    }
}

struct Spike {
    tab: engine::Tab,
    page: Option<NativeView>,
    rows: Vec<SharedString>,
    selected: usize,
    bar: Entity<TextInput>,
    bar_open: bool,
    focus: FocusHandle,
}

impl Spike {
    fn new(tab: engine::Tab, window: &mut Window, cx: &mut Context<Self>) -> Self {
        // SAFETY: the tab's page view, on the main thread; GPUI owns its frame and order from here on.
        let page = tab
            .view()
            .and_then(|view| match unsafe { NativeView::new(view, window, cx) } {
                Ok(page) => Some(page),
                Err(error) => {
                    eprintln!("bay: the page view can't be shown: {error:#}");
                    None
                }
            });
        if let Some(page) = &page {
            // ⌘L opens the bar whatever the page does with it.
            page.reserve_action::<ToggleCommandBar>();
            page.set_background(rgb(0xffffff), cx);
        }
        let rows = (0..ROWS)
            .map(|index| SharedString::from(format!("Tab {} · a page in the sidebar", index + 1)))
            .collect();
        Self {
            tab,
            page,
            rows,
            selected: 0,
            bar: cx.new(|cx| TextInput::new("Search or enter address", cx)),
            // BAY_SPIKE_BAR=1 starts with the bar open, for screenshots taken without sending keys.
            bar_open: std::env::var_os("BAY_SPIKE_BAR").is_some_and(|value| value == "1"),
            focus: cx.focus_handle(),
        }
    }

    fn toggle_bar(&mut self, _: &ToggleCommandBar, window: &mut Window, cx: &mut Context<Self>) {
        if self.bar_open {
            self.close_bar(&CloseCommandBar, window, cx);
            return;
        }
        self.bar_open = true;
        window.focus(&self.bar.focus_handle(cx), cx);
        cx.notify();
    }

    fn close_bar(&mut self, _: &CloseCommandBar, window: &mut Window, cx: &mut Context<Self>) {
        self.bar_open = false;
        match &self.page {
            Some(page) => window.focus(&page.focus_handle(cx), cx),
            None => window.focus(&self.focus, cx),
        }
        cx.notify();
    }

    fn submit_bar(&mut self, _: &SubmitCommandBar, window: &mut Window, cx: &mut Context<Self>) {
        let typed = self.bar.read(cx).text().trim().to_owned();
        if !typed.is_empty() {
            self.tab.navigate(&address(&typed));
        }
        self.bar.update(cx, |bar, cx| bar.reset(window, cx));
        self.close_bar(&CloseCommandBar, window, cx);
    }

    fn render_row(&self, index: usize, cx: &mut Context<Self>) -> Stateful<Div> {
        let selected = index == self.selected;
        div()
            .id(index)
            .role(Role::Tab)
            .aria_label(self.rows[index].clone())
            .w_full()
            .h(px(32.))
            .px(px(10.))
            .flex()
            .items_center()
            .rounded(px(7.))
            .text_size(px(13.))
            .when(selected, |row| row.bg(rgba(0xffffff26)))
            .hover(|row| row.bg(rgba(0xffffff14)))
            .child(self.rows[index].clone())
            .on_click(cx.listener(move |this, _, _, cx| {
                this.selected = index;
                cx.notify();
            }))
    }

    fn render_bar(&self, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let width = window.viewport_size().width;
        let left = (width - px(BAR_WIDTH) + px(SIDEBAR_WIDTH)) / 2.;
        let bar = self.bar.read(cx);
        let status = if bar.is_composing() {
            SharedString::from("Composing…")
        } else {
            SharedString::from(format!("Enter opens {}", address(bar.text())))
        };
        deferred(
            div()
                .id("command-bar")
                .absolute()
                .top(px(96.))
                .left(left)
                .w(px(BAR_WIDTH))
                .key_context("CommandBar")
                .on_action(cx.listener(Self::close_bar))
                .on_action(cx.listener(Self::submit_bar))
                .occlude()
                .p(px(12.))
                .rounded(px(14.))
                .bg(rgba(0x1d262cf2))
                .border_1()
                .border_color(rgba(0xffffff22))
                .shadow_lg()
                .flex()
                .flex_col()
                .gap(px(6.))
                .text_color(rgb(0xf2f2f2))
                .role(Role::Dialog)
                .aria_label("Command bar")
                .child(self.bar.clone())
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(rgba(0xffffff99))
                        .child(status),
                ),
        )
        .with_priority(1)
    }
}

impl Focusable for Spike {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Spike {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let sidebar = div()
            .id("sidebar")
            .w(px(SIDEBAR_WIDTH))
            .h_full()
            .flex()
            .flex_col()
            .pt(px(44.))
            .px(px(8.))
            .role(Role::List)
            .aria_label("Tabs")
            .child(
                gpui::uniform_list(
                    "tabs",
                    ROWS,
                    cx.processor(|this, range: Range<usize>, _window, cx| {
                        range
                            .map(|index| this.render_row(index, cx))
                            .collect::<Vec<_>>()
                    }),
                )
                .flex_1(),
            );
        let content = div().flex_1().h_full().py(px(8.)).pr(px(8.)).child(
            div()
                .size_full()
                .rounded(px(10.))
                .overflow_hidden()
                .bg(rgb(0xffffff))
                .when_some(self.page.clone(), |frame, page| frame.child(page)),
        );
        div()
            .relative()
            .size_full()
            .flex()
            .flex_row()
            .bg(rgb(0x2b3a42))
            .text_color(rgb(0xf2f2f2))
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::toggle_bar))
            .child(sidebar)
            .child(content)
            .when(self.bar_open, |root| {
                root.child(self.render_bar(window, cx))
            })
    }
}

/// What the bar opens for what was typed: an address as is (https:// added), anything else as a search.
fn address(typed: &str) -> String {
    let typed = typed.trim();
    if typed.contains("://") {
        return typed.to_owned();
    }
    if !typed.contains(' ') && typed.contains('.') {
        return format!("https://{typed}");
    }
    let query: String = typed
        .bytes()
        .map(|byte| match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            b' ' => "+".to_owned(),
            _ => format!("%{byte:02X}"),
        })
        .collect();
    format!("https://www.google.com/search?q={query}")
}
