#[cfg(not(target_os = "macos"))]
fn main() {}

#[cfg(target_os = "macos")]
fn main() {
    macos::run();
}

#[cfg(target_os = "macos")]
mod macos {
    use gpui::{
        BackdropLayerSpec, Bounds, ContentMask, Context, DispatchEventResult, ExternalWindowHandle,
        HitboxId, Hsla, IntoElement, LiquidGlassRegion, LiquidGlassStyle, NativeViewId,
        PaintNativeView, Platform, PlatformInput, PlatformWindow, Render, ScaledPixels, Scene,
        Window, WindowBackgroundAppearance, WindowHandle, WindowId, WindowKind, WindowParams, div,
        point, px, size,
    };
    use gpui_macos::MacPlatform;
    use gpui_platform::macos_hosted_window;
    use objc2::{
        class, msg_send,
        rc::Retained,
        runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel},
        sel,
    };
    use raw_window_handle::RawWindowHandle;
    use std::{
        cell::{Cell, RefCell},
        ffi::{CStr, c_char, c_void},
        ptr::{self, NonNull},
        rc::Rc,
        sync::OnceLock,
    };

    #[repr(C)]
    #[derive(Clone, Copy, Debug, PartialEq)]
    struct Rect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }

    unsafe impl objc2::Encode for Rect {
        const ENCODING: objc2::Encoding = objc2::Encoding::Struct(
            "CGRect",
            &[
                objc2::Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]),
                objc2::Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]),
            ],
        );
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: f64,
        y: f64,
    }

    unsafe impl objc2::Encode for Point {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }

    struct Blank;

    impl Render for Blank {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
        }
    }

    thread_local! {
        static PAGE_KEYS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
        static DRAG_PASTEBOARD: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
        static PAGE_DROPS: Cell<usize> = const { Cell::new(0) };
        static PAGE_GESTURES: RefCell<Vec<&'static str>> = const { RefCell::new(Vec::new()) };
    }

    pub fn run() {
        let app: *mut AnyObject = unsafe { msg_send![class!(NSApplication), sharedApplication] };
        let host_delegate: Retained<AnyObject> = unsafe { msg_send![class!(NSObject), new] };
        unsafe {
            let _: () = msg_send![app, setDelegate: &*host_delegate];
        }
        attached_launch_leaves_the_host_application_alone(app, &host_delegate);
        attached_application_runs_embedded();
        windows_keep_key_appearance_while_the_app_is_inactive();
        hosted_window_composites_glass_in_paint_order();
        hosted_window_routes_input_through_its_host();
        hosted_window_forwards_drags_to_the_page_beneath();
        hosted_window_hears_pinches_over_the_page_beneath();
        hosted_window_keeps_gestures_it_handles_from_the_page_beneath();
        hosted_window_scales_and_fades_the_page_beneath();
        hosted_window_leaves_a_full_screen_page_to_its_window();
        hosted_window_can_be_replaced_at_once();
        own_window_tears_down_with_its_glass();
        own_window_renders_its_last_scene_to_an_image();
        unhandled_text_commands_come_back_as_their_key_once();
        html_only_clipboard_reads_as_plain_text_on_the_main_thread();
        println!("attached_macos: all checks passed");
    }

    fn class_name(object: *mut AnyObject) -> String {
        unsafe {
            let class: *const AnyClass = msg_send![object, class];
            (*class).name().to_string_lossy().into_owned()
        }
    }

    fn ns_string(text: &CStr) -> Retained<AnyObject> {
        unsafe { msg_send![class!(NSString), stringWithUTF8String: text.as_ptr()] }
    }

    fn post(name: &CStr) {
        unsafe {
            let name = ns_string(name);
            let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
            let _: () = msg_send![center, postNotificationName: &*name, object: ptr::null_mut::<AnyObject>()];
        }
    }

    fn run_main_queue(seconds: f64) {
        unsafe {
            let run_loop: *mut AnyObject = msg_send![class!(NSRunLoop), currentRunLoop];
            let until: *mut AnyObject =
                msg_send![class!(NSDate), dateWithTimeIntervalSinceNow: seconds];
            let _: () = msg_send![run_loop, runUntilDate: until];
        }
    }

    fn counter() -> (Rc<Cell<usize>>, Box<dyn FnMut()>) {
        let count = Rc::new(Cell::new(0));
        let callback = Box::new({
            let count = count.clone();
            move || count.set(count.get() + 1)
        });
        (count, callback)
    }

    fn attached_launch_leaves_the_host_application_alone(
        app: *mut AnyObject,
        host_delegate: &AnyObject,
    ) {
        let app_class = class_name(app);
        let platform = MacPlatform::new_attached();
        let launches = Rc::new(Cell::new(0));
        let (layout_changes, on_layout_change) = counter();
        let (display_changes, on_display_change) = counter();
        platform.on_keyboard_layout_change(on_layout_change);
        platform.on_displays_changed(on_display_change);
        platform.run(Box::new({
            let launches = launches.clone();
            let platform = platform.clone();
            move || {
                launches.set(launches.get() + 1);
                platform.run(Box::new(|| panic!("an attached platform launched twice")));
            }
        }));
        assert_eq!(launches.get(), 1);
        platform.run(Box::new(|| panic!("an attached platform launched twice")));
        assert_eq!(launches.get(), 1);

        let delegate: *mut AnyObject = unsafe { msg_send![app, delegate] };
        assert!(ptr::eq(delegate, host_delegate));
        assert_eq!(class_name(app), app_class);

        post(c"NSTextInputContextKeyboardSelectionDidChangeNotification");
        assert_eq!(layout_changes.get(), 1);
        post(c"NSApplicationDidChangeScreenParametersNotification");
        run_main_queue(0.05);
        assert_eq!(display_changes.get(), 1);

        post(c"NSApplicationDidChangeScreenParametersNotification");
        drop(platform);
        run_main_queue(0.05);
        assert_eq!(
            display_changes.get(),
            1,
            "a change queued before the platform went away is dropped with it"
        );
        post(c"NSTextInputContextKeyboardSelectionDidChangeNotification");
        assert_eq!(layout_changes.get(), 1);
    }

    fn attached_application_runs_embedded() {
        let launched = Rc::new(Cell::new(false));
        let handle = gpui_platform::attached_macos_application().run_embedded({
            let launched = launched.clone();
            move |cx| {
                launched.set(true);
                assert!(cx.windows().is_empty());
            }
        });
        assert!(launched.get());
        handle.update(|cx| assert!(cx.windows().is_empty()));
    }

    fn region(id: u64, bounds: Bounds<ScaledPixels>, group_id: Option<u64>) -> LiquidGlassRegion {
        LiquidGlassRegion {
            id,
            order: 0,
            bounds,
            content_mask: scaled(0., 0., 1600., 1200.),
            corner_radius: ScaledPixels(20.),
            tint: None,
            style: LiquidGlassStyle::Regular,
            group_id,
            alpha: 1.,
        }
    }

    fn scaled(x: f32, y: f32, width: f32, height: f32) -> Bounds<ScaledPixels> {
        Bounds {
            origin: point(ScaledPixels(x), ScaledPixels(y)),
            size: size(ScaledPixels(width), ScaledPixels(height)),
        }
    }

    fn subviews(view: *const AnyObject) -> Vec<*mut AnyObject> {
        unsafe {
            let subviews: *mut AnyObject = msg_send![view, subviews];
            let count: usize = msg_send![subviews, count];
            (0..count)
                .map(|index| msg_send![subviews, objectAtIndex: index])
                .collect()
        }
    }

    fn shown_classes(view: *const AnyObject) -> Vec<String> {
        subviews(view)
            .into_iter()
            .filter(|subview| {
                let hidden: Bool = unsafe { msg_send![*subview, isHidden] };
                !hidden.as_bool()
            })
            .map(class_name)
            .collect()
    }

    fn host_window(class: &AnyClass) -> Retained<AnyObject> {
        let frame = Rect {
            x: 0.,
            y: 0.,
            width: 800.,
            height: 600.,
        };
        unsafe {
            let window: *mut AnyObject = msg_send![class, alloc];
            let window: *mut AnyObject = msg_send![
                window,
                initWithContentRect: frame,
                styleMask: 15usize,
                backing: 2usize,
                defer: Bool::YES
            ];
            let window = Retained::from_raw(window).expect("an NSWindow");
            let _: () = msg_send![&*window, setReleasedWhenClosed: Bool::NO];
            window
        }
    }

    fn window_params(host_window: Option<ExternalWindowHandle>) -> WindowParams {
        WindowParams {
            bounds: Bounds::new(point(px(0.), px(0.)), size(px(800.), px(600.))),
            titlebar: None,
            kind: WindowKind::Normal,
            is_movable: true,
            app_owns_titlebar_drag: false,
            is_resizable: true,
            is_minimizable: true,
            focus: false,
            show: false,
            icon: None,
            display_id: None,
            app_id: None,
            window_min_size: None,
            tabbing_identifier: None,
            use_display_p3: false,
            host_window,
        }
    }

    fn hosted_params(window: &AnyObject, host_view: Option<&AnyObject>) -> WindowParams {
        window_params(Some(unsafe {
            ExternalWindowHandle::new(
                NonNull::from(window).cast::<c_void>(),
                host_view.map(|view| NonNull::from(view).cast::<c_void>()),
            )
        }))
    }

    fn open_hosted(
        platform: &Rc<dyn Platform>,
        id: u64,
        window: &AnyObject,
        host_view: Option<&AnyObject>,
    ) -> (Box<dyn PlatformWindow>, *mut AnyObject) {
        let handle = WindowHandle::<Blank>::new(WindowId::from(id)).into();
        let window = platform
            .open_window(handle, hosted_params(window, host_view))
            .expect("a GPUI window hosted in an existing NSWindow");
        let gpui_view = match window.window_handle().map(|handle| handle.as_raw()) {
            Ok(RawWindowHandle::AppKit(handle)) => handle.ns_view.as_ptr().cast::<AnyObject>(),
            _ => panic!("a hosted window has an AppKit view"),
        };
        (window, gpui_view)
    }

    fn page_view(id: u64, bounds: Bounds<ScaledPixels>) -> PaintNativeView {
        PaintNativeView::new(
            NativeViewId::for_test(id),
            HitboxId::placeholder(),
            bounds,
            ContentMask {
                bounds: scaled(0., 0., 1600., 1200.),
            },
            Hsla::default(),
        )
    }

    fn close_button_frame(window: &AnyObject) -> Rect {
        unsafe {
            let button: *mut AnyObject = msg_send![window, standardWindowButton: 0usize];
            msg_send![button, frame]
        }
    }

    fn hosted_window_composites_glass_in_paint_order() {
        let platform = MacPlatform::new_attached();
        let host_window = host_window(class!(NSWindow));
        let window_delegate: Retained<AnyObject> = unsafe { msg_send![class!(NSObject), new] };
        let red: Retained<AnyObject> = unsafe {
            msg_send![class!(NSColor), colorWithSRGBRed: 1f64, green: 0f64, blue: 0f64, alpha: 1f64]
        };
        let content_view: *mut AnyObject = unsafe {
            let _: () = msg_send![&*host_window, setDelegate: &*window_delegate];
            let _: () = msg_send![&*host_window, setOpaque: Bool::YES];
            let _: () = msg_send![&*host_window, setBackgroundColor: &*red];
            msg_send![&*host_window, contentView]
        };
        let close_button = close_button_frame(&host_window);
        let window_class = class_name(Retained::as_ptr(&host_window).cast_mut());
        let (window, gpui_view) = open_hosted(&platform, 41, &host_window, None);

        let superview: *mut AnyObject = unsafe { msg_send![gpui_view, superview] };
        assert_eq!(superview, content_view);
        let delegate: *mut AnyObject = unsafe { msg_send![&*host_window, delegate] };
        assert!(ptr::eq(delegate, &*window_delegate));
        assert_eq!(
            class_name(Retained::as_ptr(&host_window).cast_mut()),
            window_class
        );
        assert!(window.composites_liquid_glass());

        window.set_background_appearance(WindowBackgroundAppearance::LiquidGlass);
        window.set_backdrop_layer(Some(BackdropLayerSpec {
            grain_intensity: 0.3,
            ..BackdropLayerSpec::default()
        }));
        assert_eq!(
            shown_classes(content_view),
            ["GPUIBackdropBlurView", "GPUIBackdropHostView", "GPUIView"]
        );
        let opaque: Bool = unsafe { msg_send![&*host_window, isOpaque] };
        assert!(!opaque.as_bool());
        window.set_traffic_light_origin(point(px(30.), px(24.)));
        assert_ne!(close_button_frame(&host_window), close_button);

        let page: Retained<AnyObject> = unsafe { msg_send![class!(NSView), new] };
        let page_id = NativeViewId::for_test(0);
        let attachment =
            unsafe { window.attach_native_view(page_id, NonNull::from(&*page).cast::<c_void>()) }
                .expect("native views attach to hosted windows");
        window.set_native_view_corner_radius(page_id, px(40.).into());
        window.on_hit_test_native_view(Box::new(move |_| Some(page_id)));

        let groups = window.liquid_glass_available();
        let draw = |with_sidebar: bool| {
            let mut scene = Scene::default();
            if with_sidebar {
                scene.insert_liquid_glass(region(1, scaled(40., 40., 400., 200.), None));
            }
            scene.insert_primitive(page_view(0, scaled(0., 0., 1600., 1200.)));
            scene.insert_liquid_glass(region(2, scaled(600., 600., 400., 200.), None));
            scene.insert_liquid_glass(region(3, scaled(80., 900., 120., 120.), Some(5)));
            scene.insert_liquid_glass(region(4, scaled(240., 900., 120., 120.), Some(5)));
            scene.finish();
            window.draw(&scene);
        };

        draw(true);
        let expected = if groups {
            vec![
                "GPUIBackdropBlurView",
                "GPUIBackdropHostView",
                "GPUILiquidGlassView",
                "GPUINativeViewContainer",
                "GPUILiquidGlassView",
                "GPUILiquidGlassGroupView",
                "GPUIView",
            ]
        } else {
            vec![
                "GPUIBackdropBlurView",
                "GPUIBackdropHostView",
                "GPUILiquidGlassVibrancyView",
                "GPUINativeViewContainer",
                "GPUILiquidGlassVibrancyView",
                "GPUILiquidGlassVibrancyView",
                "GPUILiquidGlassVibrancyView",
                "GPUIView",
            ]
        };
        assert_eq!(shown_classes(content_view), expected);

        let glass_views = subviews(content_view)
            .into_iter()
            .filter(|view| class_name(*view).starts_with("GPUILiquidGlass"))
            .collect::<Vec<_>>();
        for view in &glass_views {
            let hit: *mut AnyObject =
                unsafe { msg_send![*view, hitTest: Point { x: 10., y: 10. }] };
            assert!(hit.is_null(), "glass views never take mouse input");
        }
        let sidebar = glass_views[0];
        let sidebar_frame: Rect = unsafe { msg_send![sidebar, frame] };
        let scale: f64 = unsafe { msg_send![&*host_window, backingScaleFactor] };
        assert_eq!(sidebar_frame.width, 400. / scale);

        let corner: *mut AnyObject =
            unsafe { msg_send![gpui_view, hitTest: Point { x: 2., y: 2. }] };
        assert_eq!(
            corner, gpui_view,
            "a rounded native view leaves its clipped corner to GPUI"
        );
        let middle: *mut AnyObject =
            unsafe { msg_send![gpui_view, hitTest: Point { x: 300., y: 300. }] };
        assert!(
            ptr::eq(middle, Retained::as_ptr(&page).cast_mut()),
            "the rest of the page takes mouse input"
        );

        draw(false);
        let hidden: Bool = unsafe { msg_send![sidebar, isHidden] };
        assert!(
            hidden.as_bool(),
            "a glass view without a region is pooled, hidden"
        );
        assert_eq!(
            subviews(content_view)
                .into_iter()
                .filter(|view| class_name(*view).starts_with("GPUILiquidGlass"))
                .count(),
            glass_views.len()
        );

        let empty = Scene::default();
        window.draw(&empty);
        window.draw(&empty);
        let pooled = subviews(content_view)
            .into_iter()
            .filter(|view| class_name(*view).starts_with("GPUILiquidGlass"))
            .collect::<Vec<_>>();
        assert_eq!(pooled, glass_views, "idle frames keep pooled glass views");
        assert!(pooled.iter().all(|view| {
            let hidden: Bool = unsafe { msg_send![*view, isHidden] };
            hidden.as_bool()
        }));
        draw(true);
        let reused = subviews(content_view)
            .into_iter()
            .filter(|view| class_name(*view).starts_with("GPUILiquidGlass"))
            .collect::<Vec<_>>();
        assert_eq!(reused.len(), glass_views.len());
        assert!(reused.iter().all(|view| glass_views.contains(view)));
        assert_eq!(shown_classes(content_view), expected);

        unsafe {
            let _: () = msg_send![gpui_view, removeFromSuperview];
        }
        run_main_queue(0.05);
        draw(true);
        unsafe {
            let _: () = msg_send![content_view, addSubview: gpui_view];
        }
        draw(true);
        assert_eq!(shown_classes(content_view), expected);

        let kept_view = unsafe { Retained::retain(gpui_view) }.expect("the GPUI view");
        drop(window);
        run_main_queue(0.2);
        drop(attachment);
        assert!(
            shown_classes(content_view).is_empty(),
            "closing a hosted GPUI window leaves the host's content view as it found it"
        );
        let delegate: *mut AnyObject = unsafe { msg_send![&*host_window, delegate] };
        assert!(ptr::eq(delegate, &*window_delegate));
        let opaque: Bool = unsafe { msg_send![&*host_window, isOpaque] };
        assert!(opaque.as_bool(), "the host window is opaque again");
        let background: *mut AnyObject = unsafe { msg_send![&*host_window, backgroundColor] };
        let restored: Bool = unsafe { msg_send![background, isEqual: &*red] };
        assert!(restored.as_bool(), "the host window keeps its own color");
        assert_eq!(close_button_frame(&host_window), close_button);
        drop(kept_view);
    }

    fn forwarding_window_class() -> &'static AnyClass {
        static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
        CLASS.get_or_init(|| {
            let mut builder = ClassBuilder::new(c"GPUITestHostWindow", class!(NSWindow))
                .expect("a fresh window class");
            unsafe {
                builder.add_method(
                    sel!(sendEvent:),
                    forward_send_event as extern "C" fn(_, Sel, *mut AnyObject),
                );
                builder.add_method(
                    sel!(makeFirstResponder:),
                    forward_make_first_responder as extern "C" fn(_, Sel, *mut AnyObject) -> Bool,
                );
                builder.add_method(
                    sel!(performKeyEquivalent:),
                    forward_perform_key_equivalent as extern "C" fn(_, Sel, *mut AnyObject) -> Bool,
                );
                builder.add_method(
                    sel!(keyDown:),
                    forward_key_down as extern "C" fn(_, Sel, *mut AnyObject),
                );
            }
            builder.register()
        })
    }

    fn window_pointer(window: &AnyObject) -> NonNull<c_void> {
        NonNull::from(window).cast()
    }

    extern "C" fn forward_send_event(this: &AnyObject, _: Sel, event: *mut AnyObject) {
        let event = NonNull::new(event).expect("an event");
        unsafe {
            macos_hosted_window::send_event(window_pointer(this), event.cast(), || {
                let _: () = msg_send![super(this, class!(NSWindow)), sendEvent: event.as_ptr()];
            })
        }
    }

    extern "C" fn forward_make_first_responder(
        this: &AnyObject,
        _: Sel,
        responder: *mut AnyObject,
    ) -> Bool {
        let accepted = unsafe {
            macos_hosted_window::make_first_responder(
                window_pointer(this),
                NonNull::new(responder.cast()),
                || {
                    let accepted: Bool =
                        msg_send![super(this, class!(NSWindow)), makeFirstResponder: responder];
                    accepted.as_bool()
                },
            )
        };
        Bool::new(accepted)
    }

    extern "C" fn forward_perform_key_equivalent(
        this: &AnyObject,
        _: Sel,
        event: *mut AnyObject,
    ) -> Bool {
        let event = NonNull::new(event).expect("an event");
        let performed = unsafe {
            macos_hosted_window::perform_key_equivalent(window_pointer(this), event.cast(), || {
                let performed: Bool = msg_send![
                    super(this, class!(NSWindow)),
                    performKeyEquivalent: event.as_ptr()
                ];
                performed.as_bool()
            })
        };
        Bool::new(performed)
    }

    extern "C" fn forward_key_down(this: &AnyObject, _: Sel, event: *mut AnyObject) {
        let event = NonNull::new(event).expect("an event");
        unsafe {
            macos_hosted_window::key_down(window_pointer(this), event.cast(), || {
                let _: () = msg_send![super(this, class!(NSWindow)), keyDown: event.as_ptr()];
            })
        }
    }

    fn page_class() -> &'static AnyClass {
        static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
        CLASS.get_or_init(|| {
            let mut builder =
                ClassBuilder::new(c"GPUITestPageView", class!(NSView)).expect("a fresh view class");
            unsafe {
                builder.add_method(
                    sel!(acceptsFirstResponder),
                    accepts_first_responder as extern "C" fn(_, Sel) -> Bool,
                );
                builder.add_method(
                    sel!(keyDown:),
                    page_key_down as extern "C" fn(_, Sel, *mut AnyObject),
                );
            }
            builder.register()
        })
    }

    extern "C" fn accepts_first_responder(_: &AnyObject, _: Sel) -> Bool {
        Bool::YES
    }

    extern "C" fn page_key_down(_: &AnyObject, _: Sel, event: *mut AnyObject) {
        let text = unsafe {
            let characters: *mut AnyObject = msg_send![event, characters];
            let text: *const c_char = msg_send![characters, UTF8String];
            CStr::from_ptr(text).to_string_lossy().into_owned()
        };
        PAGE_KEYS.with_borrow_mut(|keys| keys.push(text));
    }

    fn key_event(
        window: &AnyObject,
        key: &CStr,
        key_code: u16,
        command: bool,
    ) -> Retained<AnyObject> {
        let characters = ns_string(key);
        unsafe {
            let window_number: isize = msg_send![window, windowNumber];
            let modifiers: usize = if command { 1 << 20 } else { 0 };
            let event: *mut AnyObject = msg_send![
                class!(NSEvent),
                keyEventWithType: 10usize,
                location: Point { x: 0., y: 0. },
                modifierFlags: modifiers,
                timestamp: 0f64,
                windowNumber: window_number,
                context: ptr::null_mut::<AnyObject>(),
                characters: &*characters,
                charactersIgnoringModifiers: &*characters,
                isARepeat: Bool::NO,
                keyCode: key_code
            ];
            Retained::retain(event).expect("a key event")
        }
    }

    fn mouse_down(window: &AnyObject, x: f64, y: f64) -> Retained<AnyObject> {
        unsafe {
            let window_number: isize = msg_send![window, windowNumber];
            let event: *mut AnyObject = msg_send![
                class!(NSEvent),
                mouseEventWithType: 1usize,
                location: Point { x, y },
                modifierFlags: 0usize,
                timestamp: 0f64,
                windowNumber: window_number,
                context: ptr::null_mut::<AnyObject>(),
                eventNumber: 0isize,
                clickCount: 1isize,
                pressure: 1f32
            ];
            Retained::retain(event).expect("a mouse event")
        }
    }

    fn hosted_window_routes_input_through_its_host() {
        let platform = MacPlatform::new_attached();
        let host_window = host_window(forwarding_window_class());
        let content_view: *mut AnyObject = unsafe { msg_send![&*host_window, contentView] };
        let host_view: Retained<AnyObject> = unsafe {
            let view: *mut AnyObject = msg_send![class!(NSView), alloc];
            let frame = Rect {
                x: 100.,
                y: 50.,
                width: 600.,
                height: 500.,
            };
            let view: *mut AnyObject = msg_send![view, initWithFrame: frame];
            let view = Retained::from_raw(view).expect("a host view");
            let _: () = msg_send![content_view, addSubview: &*view];
            view
        };
        let (window, gpui_view) = open_hosted(&platform, 42, &host_window, Some(&host_view));
        let superview: *mut AnyObject = unsafe { msg_send![gpui_view, superview] };
        assert!(ptr::eq(superview, &*host_view));
        let second = WindowHandle::<Blank>::new(WindowId::from(43)).into();
        assert!(
            platform
                .open_window(second, hosted_params(&host_window, None))
                .is_err(),
            "a host window holds one GPUI window at a time"
        );

        let inputs = Rc::new(RefCell::new(Vec::new()));
        window.on_input(Box::new({
            let inputs = inputs.clone();
            move |input| {
                inputs.borrow_mut().push(input);
                DispatchEventResult {
                    propagate: true,
                    default_prevented: false,
                }
            }
        }));
        unsafe {
            let _: () = msg_send![gpui_view, mouseDown: &*mouse_down(&host_window, 110., 540.)];
        }
        let position = inputs.borrow().iter().find_map(|input| match input {
            PlatformInput::MouseDown(event) => Some(event.position),
            _ => None,
        });
        assert_eq!(
            position,
            Some(point(px(10.), px(10.))),
            "a press is measured from the GPUI view, wherever the host puts it"
        );

        let page: Retained<AnyObject> = unsafe { msg_send![page_class(), new] };
        let page_id = NativeViewId::for_test(7);
        let attachment =
            unsafe { window.attach_native_view(page_id, NonNull::from(&*page).cast::<c_void>()) }
                .expect("native views attach to hosted windows");
        let offered = Rc::new(RefCell::new(Vec::new()));
        window.on_key_down_before_native_view(Box::new({
            let offered = offered.clone();
            move |key_down| {
                offered.borrow_mut().push(key_down.keystroke.key.clone());
                key_down.keystroke.key == "k"
            }
        }));
        window.on_hit_test_native_view(Box::new(move |_| Some(page_id)));
        let mut scene = Scene::default();
        scene.insert_primitive(page_view(7, scaled(0., 0., 1200., 1000.)));
        scene.finish();
        window.draw(&scene);

        let first_responder =
            || -> *mut AnyObject { unsafe { msg_send![&*host_window, firstResponder] } };
        let accepted: Bool = unsafe { msg_send![&*host_window, makeFirstResponder: &*page] };
        assert!(
            !accepted.as_bool() && !ptr::eq(first_responder(), &*page),
            "a page can't take keyboard input on its own"
        );
        window.set_focused_native_view(Some(page_id));
        assert!(
            ptr::eq(first_responder(), &*page),
            "GPUI's focus gives the page keyboard input through the host window"
        );

        unsafe {
            let _: () =
                msg_send![&*host_window, sendEvent: &*key_event(&host_window, c"k", 40, false)];
            let _: () =
                msg_send![&*host_window, sendEvent: &*key_event(&host_window, c"a", 0, false)];
        }
        assert_eq!(*offered.borrow(), ["k", "a"]);
        assert_eq!(
            PAGE_KEYS.with_borrow(|keys| keys.clone()),
            ["a"],
            "GPUI takes a reserved key before the page sees it"
        );

        let performed: Bool = unsafe {
            msg_send![&*host_window, performKeyEquivalent: &*key_event(&host_window, c"k", 40, true)]
        };
        assert!(
            performed.as_bool(),
            "GPUI performs a reserved key equivalent first"
        );
        assert_eq!(offered.borrow().len(), 3);

        drop(attachment);
        drop(window);
        run_main_queue(0.2);
        assert!(subviews(&*host_view).is_empty());
    }

    const DRAG_OPERATION_COPY: usize = 1;

    fn drop_page_class() -> &'static AnyClass {
        static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
        CLASS.get_or_init(|| {
            let mut builder = ClassBuilder::new(c"GPUITestDropPageView", class!(NSView))
                .expect("a fresh view class");
            unsafe {
                builder.add_method(
                    sel!(draggingEntered:),
                    page_dragging_entered as extern "C" fn(_, Sel, *mut AnyObject) -> usize,
                );
                builder.add_method(
                    sel!(performDragOperation:),
                    page_perform_drag_operation as extern "C" fn(_, Sel, *mut AnyObject) -> Bool,
                );
            }
            builder.register()
        })
    }

    extern "C" fn page_dragging_entered(_: &AnyObject, _: Sel, _: *mut AnyObject) -> usize {
        DRAG_OPERATION_COPY
    }

    extern "C" fn page_perform_drag_operation(_: &AnyObject, _: Sel, _: *mut AnyObject) -> Bool {
        PAGE_DROPS.set(PAGE_DROPS.get() + 1);
        Bool::YES
    }

    fn dragging_info_class() -> &'static AnyClass {
        static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
        CLASS.get_or_init(|| {
            let mut builder = ClassBuilder::new(c"GPUITestDraggingInfo", class!(NSObject))
                .expect("a fresh class");
            unsafe {
                builder.add_method(
                    sel!(draggingLocation),
                    dragging_location as extern "C" fn(_, Sel) -> Point,
                );
                builder.add_method(
                    sel!(draggingPasteboard),
                    dragging_pasteboard as extern "C" fn(_, Sel) -> *mut AnyObject,
                );
                builder.add_method(
                    sel!(draggingSource),
                    dragging_source as extern "C" fn(_, Sel) -> *mut AnyObject,
                );
            }
            builder.register()
        })
    }

    extern "C" fn dragging_location(_: &AnyObject, _: Sel) -> Point {
        Point { x: 300., y: 300. }
    }

    extern "C" fn dragging_pasteboard(_: &AnyObject, _: Sel) -> *mut AnyObject {
        DRAG_PASTEBOARD.with_borrow(|pasteboard| {
            pasteboard.as_ref().map_or(ptr::null_mut(), |pasteboard| {
                Retained::as_ptr(pasteboard).cast_mut()
            })
        })
    }

    extern "C" fn dragging_source(_: &AnyObject, _: Sel) -> *mut AnyObject {
        ptr::null_mut()
    }

    fn hosted_window_forwards_drags_to_the_page_beneath() {
        let platform = MacPlatform::new_attached();
        let host_window = host_window(class!(NSWindow));
        let (window, gpui_view) = open_hosted(&platform, 45, &host_window, None);
        let plain_text = ns_string(c"public.utf8-plain-text");
        let pasteboard: Retained<AnyObject> = unsafe {
            let pasteboard: *mut AnyObject =
                msg_send![class!(NSPasteboard), pasteboardWithUniqueName];
            let pasteboard = Retained::retain(pasteboard).expect("a pasteboard");
            let _: isize = msg_send![&*pasteboard, clearContents];
            let text = ns_string(c"dragged text");
            let written: Bool = msg_send![&*pasteboard, setString: &*text, forType: &*plain_text];
            assert!(written.as_bool());
            pasteboard
        };
        DRAG_PASTEBOARD.with_borrow_mut(|slot| *slot = Some(pasteboard.clone()));

        let page: Retained<AnyObject> = unsafe { msg_send![drop_page_class(), new] };
        unsafe {
            let types: Retained<AnyObject> =
                msg_send![class!(NSArray), arrayWithObject: &*plain_text];
            let _: () = msg_send![&*page, registerForDraggedTypes: &*types];
        }
        let page_id = NativeViewId::for_test(11);
        let attachment =
            unsafe { window.attach_native_view(page_id, NonNull::from(&*page).cast::<c_void>()) }
                .expect("native views attach to hosted windows");
        window.on_hit_test_native_view(Box::new(move |_| Some(page_id)));
        let mut scene = Scene::default();
        scene.insert_primitive(page_view(11, scaled(0., 0., 1600., 1200.)));
        scene.finish();
        window.draw(&scene);

        let info: Retained<AnyObject> = unsafe { msg_send![dragging_info_class(), new] };
        let entered: usize = unsafe { msg_send![gpui_view, draggingEntered: &*info] };
        assert_eq!(entered, DRAG_OPERATION_COPY);
        let updated: usize = unsafe { msg_send![gpui_view, draggingUpdated: &*info] };
        assert_eq!(
            updated, DRAG_OPERATION_COPY,
            "a page without draggingUpdated: keeps what its draggingEntered: returned"
        );
        let prepared: Bool = unsafe { msg_send![gpui_view, prepareForDragOperation: &*info] };
        assert!(
            prepared.as_bool(),
            "a page without prepareForDragOperation: is ready"
        );
        let performed: Bool = unsafe { msg_send![gpui_view, performDragOperation: &*info] };
        assert!(performed.as_bool());
        assert_eq!(PAGE_DROPS.get(), 1, "the page takes the drop");
        unsafe {
            let _: () = msg_send![gpui_view, concludeDragOperation: &*info];
            let _: () = msg_send![gpui_view, draggingEnded: &*info];
        }

        DRAG_PASTEBOARD.with_borrow_mut(|slot| *slot = None);
        unsafe {
            let _: () = msg_send![&*pasteboard, releaseGlobally];
        }
        drop(attachment);
        drop(window);
        run_main_queue(0.1);
        unsafe {
            let _: () = msg_send![&*host_window, close];
        }
    }

    #[repr(C)]
    struct CGEvent {
        _private: [u8; 0],
    }

    unsafe impl objc2::RefEncode for CGEvent {
        const ENCODING_REF: objc2::Encoding =
            objc2::Encoding::Pointer(&objc2::Encoding::Struct("__CGEvent", &[]));
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventCreateCopy(event: *mut CGEvent) -> *mut CGEvent;
        fn CGEventSetType(event: *mut CGEvent, event_type: u32);
        fn CGEventSetIntegerValueField(event: *mut CGEvent, field: u32, value: i64);
        fn CGEventSetDoubleValueField(event: *mut CGEvent, field: u32, value: f64);
        fn CFRelease(object: *mut CGEvent);
    }

    const GESTURE_EVENT_TYPE: u32 = 29;
    const GESTURE_SUBTYPE_FIELD: u32 = 110;
    const GESTURE_MAGNIFY_SUBTYPE: i64 = 8;
    const GESTURE_MAGNIFICATION_FIELD: u32 = 113;
    const GESTURE_PHASE_FIELD: u32 = 132;
    const PHASE_BEGAN: i64 = 1;
    const PHASE_CHANGED: i64 = 2;
    const PHASE_ENDED: i64 = 4;
    const GESTURE_SWIPE_SUBTYPE: i64 = 16;
    const GESTURE_SWIPE_DIRECTION_FIELD: u32 = 115;
    const SWIPE_TOWARD_BACK: i64 = 4;

    fn magnify_event(window: &AnyObject, x: f64, y: f64, phase: i64) -> Retained<AnyObject> {
        let event = gesture_event(window, x, y, |gesture| unsafe {
            CGEventSetIntegerValueField(gesture, GESTURE_SUBTYPE_FIELD, GESTURE_MAGNIFY_SUBTYPE);
            CGEventSetDoubleValueField(gesture, GESTURE_MAGNIFICATION_FIELD, 0.25);
            CGEventSetIntegerValueField(gesture, GESTURE_PHASE_FIELD, phase);
        });
        let event_type: usize = unsafe { msg_send![&*event, type] };
        assert_eq!(event_type, 30, "a gesture event with the magnify subtype");
        event
    }

    fn swipe_back_event(window: &AnyObject, x: f64, y: f64) -> Retained<AnyObject> {
        let event = gesture_event(window, x, y, |gesture| unsafe {
            CGEventSetIntegerValueField(gesture, GESTURE_SUBTYPE_FIELD, GESTURE_SWIPE_SUBTYPE);
            CGEventSetIntegerValueField(gesture, GESTURE_SWIPE_DIRECTION_FIELD, SWIPE_TOWARD_BACK);
            CGEventSetIntegerValueField(gesture, GESTURE_PHASE_FIELD, PHASE_ENDED);
        });
        let event_type: usize = unsafe { msg_send![&*event, type] };
        assert_eq!(event_type, 31, "a gesture event with the swipe subtype");
        event
    }

    fn gesture_event(
        window: &AnyObject,
        x: f64,
        y: f64,
        set_fields: impl FnOnce(*mut CGEvent),
    ) -> Retained<AnyObject> {
        unsafe {
            let window_number: isize = msg_send![window, windowNumber];
            let moved: *mut AnyObject = msg_send![
                class!(NSEvent),
                mouseEventWithType: 5usize,
                location: Point { x, y },
                modifierFlags: 0usize,
                timestamp: 0f64,
                windowNumber: window_number,
                context: ptr::null_mut::<AnyObject>(),
                eventNumber: 0isize,
                clickCount: 0isize,
                pressure: 0f32
            ];
            let template: *mut CGEvent = msg_send![moved, CGEvent];
            let gesture = CGEventCreateCopy(template);
            CGEventSetType(gesture, GESTURE_EVENT_TYPE);
            set_fields(gesture);
            let event: *mut AnyObject = msg_send![class!(NSEvent), eventWithCGEvent: gesture];
            CFRelease(gesture);
            Retained::retain(event).expect("a gesture event")
        }
    }

    fn deliver_as_appkit(window: &AnyObject, event: &AnyObject) {
        unsafe {
            let event = gpui_macos::monitor_gesture(NonNull::from(event));
            if event.is_null() {
                return;
            }
            let location: Point = msg_send![event, locationInWindow];
            let content_view: *mut AnyObject = msg_send![window, contentView];
            let frame_view: *mut AnyObject = msg_send![content_view, superview];
            let target: *mut AnyObject = msg_send![frame_view, hitTest: location];
            assert!(!target.is_null());
            let event_type: usize = msg_send![event, type];
            if event_type == 31 {
                let _: () = msg_send![target, swipeWithEvent: event];
            } else {
                let _: () = msg_send![target, magnifyWithEvent: event];
            }
        }
    }

    fn hosted_window_hears_pinches_over_the_page_beneath() {
        let platform = MacPlatform::new_attached();
        let host_window: Retained<AnyObject> = unsafe {
            let window: *mut AnyObject = msg_send![class!(NSWindow), alloc];
            let window: *mut AnyObject = msg_send![
                window,
                initWithContentRect: Rect { x: 0., y: 0., width: 800., height: 600. },
                styleMask: 15usize,
                backing: 2usize,
                defer: Bool::NO
            ];
            let window = Retained::from_raw(window).expect("an NSWindow");
            let _: () = msg_send![&*window, setReleasedWhenClosed: Bool::NO];
            window
        };
        let (window, gpui_view) = open_hosted(&platform, 47, &host_window, None);
        let pinches = Rc::new(RefCell::new(Vec::new()));
        window.on_input(Box::new({
            let pinches = pinches.clone();
            move |input| {
                if let PlatformInput::Pinch(pinch) = input {
                    pinches.borrow_mut().push((pinch.position, pinch.phase));
                }
                DispatchEventResult {
                    propagate: true,
                    default_prevented: false,
                }
            }
        }));
        let page: Retained<AnyObject> = unsafe { msg_send![page_class(), new] };
        let page_id = NativeViewId::for_test(13);
        let attachment =
            unsafe { window.attach_native_view(page_id, NonNull::from(&*page).cast::<c_void>()) }
                .expect("native views attach to hosted windows");
        window.on_hit_test_native_view(Box::new(move |position| {
            (position.x < px(200.)).then_some(page_id)
        }));
        let mut scene = Scene::default();
        scene.insert_primitive(page_view(13, scaled(0., 0., 400., 1200.)));
        scene.finish();
        window.draw(&scene);

        let hit_at = |x: f64| -> *mut AnyObject {
            unsafe {
                let content_view: *mut AnyObject = msg_send![&*host_window, contentView];
                let frame_view: *mut AnyObject = msg_send![content_view, superview];
                msg_send![frame_view, hitTest: Point { x, y: 300. }]
            }
        };
        let is_in_page: bool = unsafe { msg_send![hit_at(50.), isDescendantOf: &*page] };
        assert!(is_in_page, "AppKit sends a pinch at the left to the page");
        assert!(ptr::eq(hit_at(600.), gpui_view));

        for phase in [PHASE_BEGAN, PHASE_CHANGED, PHASE_ENDED] {
            deliver_as_appkit(&host_window, &magnify_event(&host_window, 50., 300., phase));
        }
        assert_eq!(
            *pinches.borrow(),
            [
                gpui::TouchPhase::Started,
                gpui::TouchPhase::Moved,
                gpui::TouchPhase::Ended
            ]
            .map(|phase| (point(px(50.), px(300.)), phase)),
            "GPUI hears each event of a pinch over the page once"
        );

        pinches.borrow_mut().clear();
        for phase in [PHASE_BEGAN, PHASE_ENDED] {
            deliver_as_appkit(
                &host_window,
                &magnify_event(&host_window, 600., 300., phase),
            );
        }
        assert_eq!(
            *pinches.borrow(),
            [gpui::TouchPhase::Started, gpui::TouchPhase::Ended]
                .map(|phase| (point(px(600.), px(300.)), phase)),
            "a pinch over GPUI's own content reaches it once, from the GPUI view"
        );

        drop(attachment);
        drop(window);
        run_main_queue(0.1);
        unsafe {
            let _: () = msg_send![&*host_window, close];
        }
    }

    fn gesture_page_class() -> &'static AnyClass {
        static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
        CLASS.get_or_init(|| {
            let mut builder = ClassBuilder::new(c"GPUITestGesturePageView", class!(NSView))
                .expect("a fresh view class");
            unsafe {
                builder.add_method(
                    sel!(magnifyWithEvent:),
                    page_magnify as extern "C" fn(_, Sel, *mut AnyObject),
                );
                builder.add_method(
                    sel!(swipeWithEvent:),
                    page_swipe as extern "C" fn(_, Sel, *mut AnyObject),
                );
            }
            builder.register()
        })
    }

    extern "C" fn page_magnify(_: &AnyObject, _: Sel, _: *mut AnyObject) {
        PAGE_GESTURES.with_borrow_mut(|gestures| gestures.push("magnify"));
    }

    extern "C" fn page_swipe(_: &AnyObject, _: Sel, _: *mut AnyObject) {
        PAGE_GESTURES.with_borrow_mut(|gestures| gestures.push("swipe"));
    }

    fn hosted_window_keeps_gestures_it_handles_from_the_page_beneath() {
        let platform = MacPlatform::new_attached();
        let host_window: Retained<AnyObject> = unsafe {
            let window: *mut AnyObject = msg_send![class!(NSWindow), alloc];
            let window: *mut AnyObject = msg_send![
                window,
                initWithContentRect: Rect { x: 0., y: 0., width: 800., height: 600. },
                styleMask: 15usize,
                backing: 2usize,
                defer: Bool::NO
            ];
            let window = Retained::from_raw(window).expect("an NSWindow");
            let _: () = msg_send![&*window, setReleasedWhenClosed: Bool::NO];
            window
        };
        let (window, _) = open_hosted(&platform, 48, &host_window, None);
        let handles = Rc::new(Cell::new(false));
        let pinches = Rc::new(RefCell::new(Vec::new()));
        window.on_input(Box::new({
            let handles = handles.clone();
            let pinches = pinches.clone();
            move |input| {
                match input {
                    PlatformInput::Pinch(pinch) => pinches.borrow_mut().push(Some(pinch.phase)),
                    PlatformInput::MouseDown(gpui::MouseDownEvent {
                        button: gpui::MouseButton::Navigate(gpui::NavigationDirection::Back),
                        ..
                    }) => pinches.borrow_mut().push(None),
                    _ => {}
                }
                DispatchEventResult {
                    propagate: !handles.get(),
                    default_prevented: false,
                }
            }
        }));
        let page: Retained<AnyObject> = unsafe { msg_send![gesture_page_class(), new] };
        let page_id = NativeViewId::for_test(14);
        let attachment =
            unsafe { window.attach_native_view(page_id, NonNull::from(&*page).cast::<c_void>()) }
                .expect("native views attach to hosted windows");
        window.on_hit_test_native_view(Box::new(move |position| {
            (position.x < px(200.)).then_some(page_id)
        }));
        let mut scene = Scene::default();
        scene.insert_primitive(page_view(14, scaled(0., 0., 400., 1200.)));
        scene.finish();
        window.draw(&scene);

        let gesture = |handled: bool| {
            handles.set(handled);
            pinches.borrow_mut().clear();
            PAGE_GESTURES.take();
            let events = [PHASE_BEGAN, PHASE_CHANGED, PHASE_ENDED]
                .map(|phase| magnify_event(&host_window, 50., 300., phase));
            for event in events
                .iter()
                .chain([&swipe_back_event(&host_window, 50., 300.)])
            {
                deliver_as_appkit(&host_window, event);
            }
            (pinches.take(), PAGE_GESTURES.take())
        };
        let gpui_hears = vec![
            Some(gpui::TouchPhase::Started),
            Some(gpui::TouchPhase::Moved),
            Some(gpui::TouchPhase::Ended),
            None,
        ];
        assert_eq!(
            gesture(true),
            (gpui_hears.clone(), vec![]),
            "a pinch or swipe GPUI handles never reaches the page"
        );
        assert_eq!(
            gesture(false),
            (gpui_hears, vec!["magnify", "magnify", "magnify", "swipe"]),
            "a pinch or swipe GPUI leaves goes on to the page"
        );

        drop(attachment);
        drop(window);
        run_main_queue(0.1);
        unsafe {
            let _: () = msg_send![&*host_window, close];
        }
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, PartialEq)]
    struct Transform3D([f64; 16]);

    unsafe impl objc2::Encode for Transform3D {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CATransform3D", &[f64::ENCODING; 16]);
    }

    const IDENTITY: Transform3D = Transform3D([
        1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
    ]);

    fn hosted_window_scales_and_fades_the_page_beneath() {
        let platform = MacPlatform::new_attached();
        let host_window = host_window(class!(NSWindow));
        let (window, _) = open_hosted(&platform, 49, &host_window, None);
        let page: Retained<AnyObject> = unsafe { msg_send![page_class(), new] };
        let renderer: Retained<AnyObject> = unsafe {
            let view: *mut AnyObject = msg_send![class!(NSView), alloc];
            let frame = Rect {
                x: 200.,
                y: 0.,
                width: 200.,
                height: 300.,
            };
            let view: *mut AnyObject = msg_send![view, initWithFrame: frame];
            let view = Retained::from_raw(view).expect("a view");
            let _: () = msg_send![&*page, addSubview: &*view];
            view
        };
        let page_id = NativeViewId::for_test(15);
        let attachment =
            unsafe { window.attach_native_view(page_id, NonNull::from(&*page).cast::<c_void>()) }
                .expect("native views attach to hosted windows");
        window.on_hit_test_native_view(Box::new(move |_| Some(page_id)));
        let scale_factor = window.scale_factor();
        let device = |points: f32| ScaledPixels(points * scale_factor);
        let device_bounds = |x: f32, y: f32, width: f32, height: f32| {
            scaled(
                x * scale_factor,
                y * scale_factor,
                width * scale_factor,
                height * scale_factor,
            )
        };

        // A 400 by 300 point page centered on (400, 300), shown at half size
        // and half faded.
        let mut scaled_page = page_view(15, device_bounds(300., 225., 200., 150.));
        scaled_page.content_mask.bounds = device_bounds(0., 0., 800., 600.);
        scaled_page.layout_size = size(device(400.), device(300.));
        scaled_page.scale = 0.5;
        scaled_page.opacity = 0.5;
        let mut scene = Scene::default();
        scene.insert_primitive(scaled_page);
        scene.finish();
        window.draw(&scene);

        let container: *mut AnyObject = unsafe { msg_send![&*page, superview] };
        let layer = || -> *mut AnyObject { unsafe { msg_send![container, layer] } };
        let alpha: f64 = unsafe { msg_send![container, alphaValue] };
        assert_eq!(alpha, 0.5, "the page fades with its element");
        let page_frame: Rect = unsafe { msg_send![&*page, frame] };
        assert_eq!(
            (page_frame.width, page_frame.height),
            (400., 300.),
            "the page keeps its layout size"
        );
        let bounds: Rect = unsafe { msg_send![container, bounds] };
        let frame: Rect = unsafe { msg_send![container, frame] };
        assert_eq!(
            frame,
            Rect {
                x: 300.,
                y: 225.,
                width: 200.,
                height: 150.
            },
            "the container is where GPUI hit-tests the page and erases for it"
        );
        assert!((bounds.width - frame.width * 2.).abs() < 1e-6);
        assert!((bounds.height - frame.height * 2.).abs() < 1e-6);
        let untransformed_layer = || {
            let layer = layer();
            layer.is_null() || {
                let sublayer: Transform3D = unsafe { msg_send![layer, sublayerTransform] };
                let own: Transform3D = unsafe { msg_send![layer, transform] };
                (sublayer, own) == (IDENTITY, IDENTITY)
            }
        };
        assert!(untransformed_layer(), "the page is scaled, never turned");

        let hit_at = |x: f64, y: f64| -> *mut AnyObject {
            unsafe {
                let content_view: *mut AnyObject = msg_send![&*host_window, contentView];
                let frame_view: *mut AnyObject = msg_send![content_view, superview];
                msg_send![frame_view, hitTest: Point { x, y }]
            }
        };
        assert!(
            ptr::eq(hit_at(450., 300.), &*renderer),
            "a press reaches what shows of the page's right half"
        );
        assert!(ptr::eq(hit_at(350., 300.), &*page), "and of its left half");

        let mut scene = Scene::default();
        scene.insert_primitive(page_view(15, device_bounds(200., 150., 400., 300.)));
        scene.finish();
        window.draw(&scene);
        let alpha: f64 = unsafe { msg_send![container, alphaValue] };
        let bounds: Rect = unsafe { msg_send![container, bounds] };
        let frame: Rect = unsafe { msg_send![container, frame] };
        assert_eq!(alpha, 1.);
        assert_eq!((bounds.x, bounds.y), (0., 0.));
        assert_eq!(
            (bounds.width, bounds.height),
            (frame.width, frame.height),
            "the page is back to exactly unscaled"
        );
        assert!(untransformed_layer());
        assert!(ptr::eq(hit_at(500., 300.), &*renderer));

        drop(attachment);
        drop(window);
        run_main_queue(0.1);
        unsafe {
            let _: () = msg_send![&*host_window, close];
        }
    }

    fn hosted_window_leaves_a_full_screen_page_to_its_window() {
        let platform = MacPlatform::new_attached();
        let host_window = host_window(class!(NSWindow));
        let (window, gpui_view) = open_hosted(&platform, 53, &host_window, None);
        let page: Retained<AnyObject> = unsafe { msg_send![class!(NSView), new] };
        let page_id = NativeViewId::for_test(17);
        let attachment =
            unsafe { window.attach_native_view(page_id, NonNull::from(&*page).cast::<c_void>()) }
                .expect("native views attach to hosted windows");
        window.on_hit_test_native_view(Box::new(move |_| Some(page_id)));
        let scale_factor = window.scale_factor();
        let draw = |x: f32, y: f32, width: f32, height: f32| {
            let mut scene = Scene::default();
            scene.insert_primitive(page_view(
                17,
                scaled(
                    x * scale_factor,
                    y * scale_factor,
                    width * scale_factor,
                    height * scale_factor,
                ),
            ));
            scene.finish();
            window.draw(&scene);
        };
        let frame_of = |view: *const AnyObject| -> Rect { unsafe { msg_send![view, frame] } };
        let superview_of =
            |view: *const AnyObject| -> *mut AnyObject { unsafe { msg_send![view, superview] } };

        draw(200., 150., 400., 300.);
        let container = superview_of(&*page);
        assert_eq!(class_name(container), "GPUINativeViewContainer");

        // WebKit's element full screen moves the page into its own window.
        let full_screen: Retained<AnyObject> = unsafe { msg_send![class!(NSView), new] };
        let full_screen_frame = Rect {
            x: 0.,
            y: 0.,
            width: 1440.,
            height: 900.,
        };
        unsafe {
            let _: () = msg_send![&*page, removeFromSuperview];
            let _: () = msg_send![&*full_screen, addSubview: &*page];
            let _: () = msg_send![&*page, setFrame: full_screen_frame];
        }
        draw(100., 100., 600., 400.);
        assert_eq!(
            frame_of(&*page),
            full_screen_frame,
            "the page fills the screen"
        );
        assert!(ptr::eq(superview_of(&*page), &*full_screen));
        let container_frame = frame_of(container);
        assert_eq!(
            (container_frame.width, container_frame.height),
            (600., 400.),
            "the placeholder keeps the page's place"
        );
        let hit: *mut AnyObject =
            unsafe { msg_send![gpui_view, hitTest: Point { x: 400., y: 300. }] };
        assert!(
            !ptr::eq(hit, &*page),
            "presses don't go to a page that isn't there"
        );

        unsafe {
            let _: () = msg_send![&*page, removeFromSuperview];
            let _: () = msg_send![container, addSubview: &*page];
        }
        draw(100., 100., 600., 400.);
        let returned = frame_of(&*page);
        assert_eq!(
            (returned.x, returned.y, returned.width, returned.height),
            (0., 0., 600., 400.),
            "a page back from full screen is laid out again"
        );

        unsafe {
            let _: () = msg_send![&*page, removeFromSuperview];
            let _: () = msg_send![&*full_screen, addSubview: &*page];
        }
        drop(attachment);
        assert!(
            ptr::eq(superview_of(&*page), &*full_screen),
            "letting go of a page in full screen leaves it there"
        );
        drop(window);
        run_main_queue(0.1);
        unsafe {
            let _: () = msg_send![&*host_window, close];
        }
    }

    fn is_opaque(window: &AnyObject) -> bool {
        let opaque: Bool = unsafe { msg_send![window, isOpaque] };
        opaque.as_bool()
    }

    fn hosted_window_can_be_replaced_at_once() {
        let platform = MacPlatform::new_attached();
        let host_window = host_window(class!(NSWindow));
        let red: Retained<AnyObject> = unsafe {
            msg_send![class!(NSColor), colorWithSRGBRed: 1f64, green: 0f64, blue: 0f64, alpha: 1f64]
        };
        let content_view: *mut AnyObject = unsafe {
            let _: () = msg_send![&*host_window, setOpaque: Bool::YES];
            let _: () = msg_send![&*host_window, setBackgroundColor: &*red];
            msg_send![&*host_window, contentView]
        };
        let close_button = close_button_frame(&host_window);

        let (first, _) = open_hosted(&platform, 51, &host_window, None);
        first.set_background_appearance(WindowBackgroundAppearance::LiquidGlass);
        first.set_traffic_light_origin(point(px(30.), px(24.)));
        drop(first);
        assert!(
            is_opaque(&host_window),
            "closing a hosted window hands the host its chrome back at once"
        );
        assert_eq!(close_button_frame(&host_window), close_button);

        let (second, second_view) = open_hosted(&platform, 52, &host_window, None);
        second.set_background_appearance(WindowBackgroundAppearance::LiquidGlass);
        second.set_traffic_light_origin(point(px(40.), px(30.)));
        let moved = close_button_frame(&host_window);
        run_main_queue(0.2);
        assert!(
            !is_opaque(&host_window),
            "the first window's teardown leaves the second window's chrome alone"
        );
        assert_eq!(close_button_frame(&host_window), moved);
        assert_eq!(
            shown_classes(content_view),
            ["GPUIBackdropBlurView", "GPUIView"]
        );
        assert_eq!(subviews(content_view).last().copied(), Some(second_view));

        drop(second);
        run_main_queue(0.2);
        assert!(is_opaque(&host_window));
        let background: *mut AnyObject = unsafe { msg_send![&*host_window, backgroundColor] };
        let restored: Bool = unsafe { msg_send![background, isEqual: &*red] };
        assert!(restored.as_bool());
        assert_eq!(close_button_frame(&host_window), close_button);
        assert!(subviews(content_view).is_empty());

        let (third, _) = open_hosted(&platform, 53, &host_window, None);
        third.set_background_appearance(WindowBackgroundAppearance::LiquidGlass);
        unsafe {
            let _: () = msg_send![&*host_window, close];
        }
        drop(third);
        run_main_queue(0.2);
        assert!(
            subviews(content_view).is_empty(),
            "a closed host still gets its views back"
        );
    }

    fn unhandled_text_commands_come_back_as_their_key_once() {
        let platform = MacPlatform::new_attached();
        let host_window = host_window(class!(NSWindow));
        let (window, gpui_view) = open_hosted(&platform, 81, &host_window, None);
        let keys = Rc::new(RefCell::new(Vec::new()));
        window.on_input(Box::new({
            let keys = keys.clone();
            move |input| {
                if let PlatformInput::KeyDown(key_down) = input {
                    keys.borrow_mut().push(key_down.keystroke.key.clone());
                }
                DispatchEventResult {
                    propagate: false,
                    default_prevented: false,
                }
            }
        }));

        let left_arrow = unsafe {
            let characters = ns_string(c"\u{F702}");
            let window_number: isize = msg_send![&*host_window, windowNumber];
            let event: *mut AnyObject = msg_send![
                class!(NSEvent),
                keyEventWithType: 10usize,
                location: Point { x: 0., y: 0. },
                modifierFlags: (1usize << 23) | (1usize << 21),
                timestamp: 0f64,
                windowNumber: window_number,
                context: ptr::null_mut::<AnyObject>(),
                characters: &*characters,
                charactersIgnoringModifiers: &*characters,
                isARepeat: Bool::NO,
                keyCode: 123u16
            ];
            Retained::retain(event).expect("a key event")
        };
        unsafe {
            let _: () = msg_send![gpui_view, keyDown: &*left_arrow];
        }
        assert_eq!(
            *keys.borrow(),
            ["left"],
            "AppKit's moveLeft: reaches GPUI's bindings as the left key, once"
        );

        unsafe {
            let _: () = msg_send![gpui_view, doCommandBySelector: sel!(moveWordLeft:)];
        }
        assert_eq!(
            keys.borrow().len(),
            1,
            "a command outside a key press has no key to dispatch"
        );

        drop(window);
        run_main_queue(0.1);
    }

    fn html_only_clipboard_reads_as_plain_text_on_the_main_thread() {
        unsafe {
            let pasteboard: Retained<AnyObject> =
                msg_send![class!(NSPasteboard), pasteboardWithUniqueName];
            let html = ns_string(c"public.html");
            let types: Retained<AnyObject> = msg_send![class!(NSArray), arrayWithObject: &*html];
            let _: isize = msg_send![
                &*pasteboard,
                declareTypes: &*types,
                owner: ptr::null_mut::<AnyObject>()
            ];
            let markup = c"<p>Hello <b>rich</b> w&ouml;rld</p>";
            let data: Retained<AnyObject> = msg_send![
                class!(NSData),
                dataWithBytes: markup.as_ptr().cast::<c_void>(),
                length: markup.count_bytes()
            ];
            let written: Bool = msg_send![&*pasteboard, setData: &*data, forType: &*html];
            assert!(written.as_bool());
            let name: *mut AnyObject = msg_send![&*pasteboard, name];
            let name: *const c_char = msg_send![name, UTF8String];
            let name = CStr::from_ptr(name).to_string_lossy().into_owned();

            let item = gpui_macos::read_pasteboard_with_name(&name)
                .expect("HTML-only clipboard content reads as text");
            assert_eq!(
                item.text().as_deref().map(str::trim_end),
                Some("Hello rich w\u{f6}rld")
            );
            let _: () = msg_send![&*pasteboard, releaseGlobally];
        }
    }

    fn own_window_tears_down_with_its_glass() {
        let platform = MacPlatform::new_attached();
        let handle = WindowHandle::<Blank>::new(WindowId::from(61)).into();
        let window = platform
            .open_window(handle, window_params(None))
            .expect("a GPUI window of its own");
        window.set_background_appearance(WindowBackgroundAppearance::LiquidGlass);
        window.set_backdrop_layer(Some(BackdropLayerSpec::default()));
        let page: Retained<AnyObject> = unsafe { msg_send![class!(NSView), new] };
        let page_id = NativeViewId::for_test(9);
        let attachment =
            unsafe { window.attach_native_view(page_id, NonNull::from(&*page).cast::<c_void>()) }
                .expect("native views attach to a GPUI window");
        let mut scene = Scene::default();
        scene.insert_primitive(page_view(9, scaled(0., 0., 800., 600.)));
        scene.insert_liquid_glass(region(1, scaled(40., 40., 400., 200.), Some(3)));
        scene.insert_liquid_glass(region(2, scaled(500., 40., 200., 200.), Some(3)));
        scene.finish();
        window.draw(&scene);
        drop(window);
        drop(attachment);
        run_main_queue(0.2);
    }

    fn own_window_renders_its_last_scene_to_an_image() {
        let platform = MacPlatform::new_attached();
        let handle = WindowHandle::<Blank>::new(WindowId::from(62)).into();
        let window = platform
            .open_window(handle, window_params(None))
            .expect("a GPUI window of its own");
        let device_width = (800. * window.scale_factor()).floor() as u32;
        let device_height = (600. * window.scale_factor()).floor() as u32;
        let mut scene = Scene::default();
        scene.insert_primitive(solid_quad(
            scaled(0., 0., device_width as f32, device_height as f32),
            gpui::red(),
        ));
        scene.insert_primitive(solid_quad(scaled(0., 0., 100., 100.), gpui::blue()));
        scene.finish();
        window.draw(&scene);

        let started = std::time::Instant::now();
        let full = window
            .render_to_image(&scene, 1.)
            .expect("a window renders its scene at full size");
        let full_took = started.elapsed();
        assert_eq!(full.dimensions(), (device_width, device_height));
        assert_eq!(full.get_pixel(10, 10).0, [0, 0, 255, 255]);
        assert_eq!(full.get_pixel(400, 400).0, [255, 0, 0, 255]);

        let started = std::time::Instant::now();
        let half = window
            .render_to_image(&scene, 0.5)
            .expect("a window renders its scene at half size");
        let half_took = started.elapsed();
        assert_eq!(half.dimensions(), (device_width / 2, device_height / 2));
        assert_eq!(half.get_pixel(10, 10).0, [0, 0, 255, 255]);
        assert_eq!(half.get_pixel(200, 200).0, [255, 0, 0, 255]);

        let third = window
            .render_to_image(&scene, 0.3)
            .expect("a window renders its scene at any smaller scale");
        assert_eq!(
            third.dimensions(),
            (
                (device_width as f32 * 0.3).floor() as u32,
                (device_height as f32 * 0.3).floor() as u32
            )
        );
        assert!(window.render_to_image(&scene, 0.).is_err());
        assert!(window.render_to_image(&scene, 1.5).is_err());

        window.draw(&scene);
        println!(
            "attached_macos: render_to_image {device_width}x{device_height} took {full_took:?}, half took {half_took:?}"
        );
        drop(window);
        run_main_queue(0.1);
    }

    fn solid_quad(bounds: Bounds<ScaledPixels>, color: Hsla) -> gpui::Quad {
        gpui::Quad {
            bounds,
            content_mask: ContentMask { bounds },
            background: color.into(),
            ..Default::default()
        }
    }

    fn has_key_appearance(window: &AnyObject) -> bool {
        let answer: Bool = unsafe { msg_send![window, hasKeyAppearance] };
        answer.as_bool()
    }

    fn vibrancy_is_active(window: &AnyObject) -> bool {
        unsafe {
            let content: *mut AnyObject = msg_send![window, contentView];
            let frame: Rect = msg_send![content, bounds];
            let effect: *mut AnyObject = msg_send![class!(NSVisualEffectView), alloc];
            let effect: *mut AnyObject = msg_send![effect, initWithFrame: frame];
            let effect = Retained::from_raw(effect).expect("an NSVisualEffectView");
            let _: () = msg_send![&*effect, setState: 0isize];
            let _: () = msg_send![content, addSubview: &*effect];
            let active: Bool = msg_send![&*effect, _shouldUseActiveAppearance];
            let _: () = msg_send![&*effect, removeFromSuperview];
            active.as_bool()
        }
    }

    fn gpui_ns_window(window: &dyn PlatformWindow) -> *mut AnyObject {
        match window.window_handle().map(|handle| handle.as_raw()) {
            Ok(RawWindowHandle::AppKit(handle)) => unsafe {
                msg_send![handle.ns_view.as_ptr().cast::<AnyObject>(), window]
            },
            _ => panic!("a GPUI window has an AppKit view"),
        }
    }

    fn check_keeps_key_appearance(window: &dyn PlatformWindow, ns_window: &AnyObject) {
        let is_key: Bool = unsafe { msg_send![ns_window, isKeyWindow] };
        let is_main: Bool = unsafe { msg_send![ns_window, isMainWindow] };
        assert!(!is_key.as_bool() && !is_main.as_bool());
        assert!(
            !has_key_appearance(ns_window),
            "windows keep AppKit's appearance until they opt in"
        );
        window.set_keeps_key_appearance(true);
        assert!(
            has_key_appearance(ns_window),
            "an opted-in window looks key though it was never key or main"
        );
        assert!(vibrancy_is_active(ns_window));
        window.set_keeps_key_appearance(false);
        assert!(!has_key_appearance(ns_window));
        assert!(!vibrancy_is_active(ns_window));
    }

    extern "C" fn never_key(_: &AnyObject, _: Sel) -> Bool {
        Bool::NO
    }

    fn painted_as_inactive_class() -> &'static AnyClass {
        static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
        CLASS.get_or_init(|| {
            let mut owner = ClassBuilder::new(c"KeyAppearanceTestWidgetWindow", class!(NSWindow))
                .expect("a fresh window class");
            unsafe {
                owner.add_method(
                    sel!(hasKeyAppearance),
                    never_key as extern "C" fn(_, Sel) -> Bool,
                );
            }
            let owner = owner.register();
            ClassBuilder::new(c"KeyAppearanceTestBrowserWindow", owner)
                .expect("a fresh window class")
                .register()
        })
    }

    extern "C" fn asks_its_superclass(this: &AnyObject, _: Sel) -> Bool {
        let superclass = AnyClass::get(c"KeyAppearanceTestWidgetWindow").expect("registered");
        unsafe { msg_send![super(this, superclass), hasKeyAppearance] }
    }

    fn overriding_subclass() -> &'static AnyClass {
        static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
        CLASS.get_or_init(|| {
            let mut decl = ClassBuilder::new(
                c"KeyAppearanceTestOverridingWindow",
                AnyClass::get(c"KeyAppearanceTestWidgetWindow").expect("registered"),
            )
            .expect("a fresh window class");
            unsafe {
                decl.add_method(
                    sel!(hasKeyAppearance),
                    asks_its_superclass as extern "C" fn(_, Sel) -> Bool,
                );
            }
            decl.register()
        })
    }

    fn a_patched_subclass_calling_super_reaches_its_superclass_once(platform: &Rc<dyn Platform>) {
        let _ = painted_as_inactive_class();
        let base =
            host_window(AnyClass::get(c"KeyAppearanceTestWidgetWindow").expect("registered"));
        let sub = host_window(overriding_subclass());
        let (on_base, _) = open_hosted(platform, 73, &base, None);
        let (on_sub, _) = open_hosted(platform, 74, &sub, None);
        on_base.set_keeps_key_appearance(true);
        on_sub.set_keeps_key_appearance(true);
        on_sub.set_keeps_key_appearance(false);
        assert!(has_key_appearance(&base));
        assert!(
            !has_key_appearance(&sub),
            "a subclass asking its patched superclass gets the original answer"
        );
        on_sub.set_keeps_key_appearance(true);
        assert!(has_key_appearance(&sub));
        drop(on_sub);
        drop(on_base);
        run_main_queue(0.1);
        unsafe {
            let _: () = msg_send![&*sub, close];
            let _: () = msg_send![&*base, close];
        }
    }

    const CHAIN: [&str; 4] = ["Base", "Middle", "Leaf", "Tip"];

    fn class_named_ending_in(this: &AnyObject, suffix: &str) -> &'static AnyClass {
        let mut class: Option<&'static AnyClass> = Some(unsafe { msg_send![this, class] });
        while let Some(current) = class {
            if current.name().to_string_lossy().ends_with(suffix) {
                return current;
            }
            class = current.superclass();
        }
        panic!("no class ending in {suffix}")
    }

    fn negate_super_of(this: &AnyObject, suffix: &str) -> Bool {
        let superclass = class_named_ending_in(this, suffix)
            .superclass()
            .expect("a superclass");
        let answer: Bool = unsafe { msg_send![super(this, superclass), hasKeyAppearance] };
        Bool::new(!answer.as_bool())
    }

    extern "C" fn middle_negates_super(this: &AnyObject, _: Sel) -> Bool {
        negate_super_of(this, "Middle")
    }

    extern "C" fn tip_negates_super(this: &AnyObject, _: Sel) -> Bool {
        negate_super_of(this, "Tip")
    }

    fn key_appearance_chain(run: usize) -> Vec<&'static AnyClass> {
        let mut classes: Vec<&'static AnyClass> = Vec::new();
        for name in CHAIN {
            let superclass = classes.last().copied().unwrap_or(class!(NSWindow));
            let name = std::ffi::CString::new(format!("KeyAppearanceChain{run}{name}")).unwrap();
            let mut decl = ClassBuilder::new(&name, superclass).expect("a fresh window class");
            unsafe {
                match name.to_bytes() {
                    name if name.ends_with(b"Base") => decl.add_method(
                        sel!(hasKeyAppearance),
                        never_key as extern "C" fn(_, Sel) -> Bool,
                    ),
                    name if name.ends_with(b"Middle") => decl.add_method(
                        sel!(hasKeyAppearance),
                        middle_negates_super as extern "C" fn(_, Sel) -> Bool,
                    ),
                    name if name.ends_with(b"Tip") => decl.add_method(
                        sel!(hasKeyAppearance),
                        tip_negates_super as extern "C" fn(_, Sel) -> Bool,
                    ),
                    _ => {}
                }
            }
            classes.push(decl.register());
        }
        classes
    }

    fn patching_any_classes_in_any_order_keeps_appkit_dispatch(platform: &Rc<dyn Platform>) {
        let orders: [&[usize]; 7] = [
            &[0, 1, 2],
            &[2, 1, 0],
            &[1, 2, 0],
            &[2],
            &[3, 0],
            &[0, 2, 3],
            &[3, 2, 1, 0],
        ];
        for (run, order) in orders.iter().enumerate() {
            let classes = key_appearance_chain(run);
            let bystanders: Vec<_> = classes.iter().map(|class| host_window(class)).collect();
            let unpatched: Vec<bool> = bystanders
                .iter()
                .map(|window| has_key_appearance(window))
                .collect();
            assert_eq!(unpatched, [false, true, true, false]);
            let mut patched = Vec::new();
            for (step, &index) in order.iter().enumerate() {
                let host = host_window(classes[index]);
                let id = 1000 + (run * 10 + step) as u64;
                let (hosted, _) = open_hosted(platform, id, &host, None);
                hosted.set_keeps_key_appearance(true);
                assert!(
                    has_key_appearance(&host),
                    "run {run}: an opted-in window is forced key"
                );
                hosted.set_keeps_key_appearance(false);
                assert_eq!(
                    has_key_appearance(&host),
                    unpatched[index],
                    "run {run}: an opted-out window on a patched class answers as AppKit would"
                );
                patched.push((hosted, host, index));
                let answers: Vec<bool> = bystanders
                    .iter()
                    .map(|window| has_key_appearance(window))
                    .collect();
                assert_eq!(
                    answers,
                    unpatched,
                    "run {run}: patching {:?} changed what unopted windows answer",
                    &order[..=step]
                );
            }
            for (hosted, host, index) in &patched {
                hosted.set_keeps_key_appearance(true);
                assert!(
                    has_key_appearance(host),
                    "run {run}: a forced window is key"
                );
                for (other, window) in bystanders.iter().enumerate() {
                    assert_eq!(
                        has_key_appearance(window),
                        unpatched[other],
                        "run {run}: forcing a {} window changed a bystander",
                        CHAIN[*index]
                    );
                }
                hosted.set_keeps_key_appearance(false);
            }
            for (hosted, host, _) in patched {
                drop(hosted);
                run_main_queue(0.05);
                unsafe {
                    let _: () = msg_send![&*host, close];
                }
            }
            for window in bystanders {
                unsafe {
                    let _: () = msg_send![&*window, close];
                }
            }
        }
    }

    fn windows_keep_key_appearance_while_the_app_is_inactive() {
        let app: *mut AnyObject = unsafe { msg_send![class!(NSApplication), sharedApplication] };
        let active: Bool = unsafe { msg_send![app, isActive] };
        assert!(!active.as_bool(), "the test process never activates");
        let platform = MacPlatform::new_attached();

        let handle = WindowHandle::<Blank>::new(WindowId::from(71)).into();
        let own = platform
            .open_window(handle, window_params(None))
            .expect("a GPUI window of its own");
        let own_ns_window = gpui_ns_window(&*own);
        check_keeps_key_appearance(&*own, unsafe { &*own_ns_window });

        let host = host_window(painted_as_inactive_class());
        let bystander = host_window(painted_as_inactive_class());
        let (hosted, _) = open_hosted(&platform, 72, &host, None);
        check_keeps_key_appearance(&*hosted, &host);
        hosted.set_keeps_key_appearance(true);
        assert!(
            !has_key_appearance(&bystander),
            "only windows that opt in keep their key appearance"
        );
        assert!(has_key_appearance(&host));
        drop(hosted);
        run_main_queue(0.1);
        assert!(
            !has_key_appearance(&host),
            "a host forgets the option once its GPUI window goes"
        );
        a_patched_subclass_calling_super_reaches_its_superclass_once(&platform);
        patching_any_classes_in_any_order_keeps_appkit_dispatch(&platform);
        drop(own);
        run_main_queue(0.1);
        unsafe {
            let _: () = msg_send![&*host, close];
            let _: () = msg_send![&*bystander, close];
        }
    }
}
