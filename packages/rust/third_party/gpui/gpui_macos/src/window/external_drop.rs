use super::{
    conclude_drag_operation, dragging_entered, dragging_exited, dragging_updated,
    native_views::native_view_hit_at, perform_drag_operation, window_state_if_set,
};
use gpui::{ExternalItems, ExternalPaths};
use objc2::{
    class, msg_send,
    rc::Retained,
    runtime::{AnyObject, Bool, ClassBuilder, Sel},
    sel,
};
#[expect(
    deprecated,
    reason = "Finder and most drag sources still offer NSFilenamesPboardType, the one type that lists every dragged path at once"
)]
use objc2_app_kit::NSFilenamesPboardType;
use objc2_app_kit::{
    NSDragOperation, NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardTypeString,
    NSPasteboardTypeURL, NSView,
};
use objc2_foundation::{NSArray, NSPoint, NSString, NSURL};
use std::{cell::RefCell, path::PathBuf};

/// What a dragging pasteboard holds, read out of AppKit.
#[derive(Debug, Default)]
pub(crate) struct DraggedContents {
    pub filenames: Vec<PathBuf>,
    pub file_urls: Vec<PathBuf>,
    pub web_urls: Vec<String>,
    pub text: Option<String>,
}

/// What GPUI makes the active drag for a drag from outside the window.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DroppedPayload {
    Paths(ExternalPaths),
    Items(ExternalItems),
}

/// Files win and arrive as [`ExternalPaths`], as they always have; otherwise
/// web URLs and text arrive together as [`ExternalItems`].
pub(crate) fn decode_dragged_contents(contents: DraggedContents) -> Option<DroppedPayload> {
    let DraggedContents {
        filenames,
        file_urls,
        web_urls,
        text,
    } = contents;
    let paths = if filenames.is_empty() {
        file_urls
    } else {
        filenames
    };
    if !paths.is_empty() {
        return Some(DroppedPayload::Paths(ExternalPaths(
            paths.into_iter().collect(),
        )));
    }
    let items = ExternalItems {
        paths: Vec::new(),
        urls: web_urls
            .into_iter()
            .map(|url| url.trim().to_owned())
            .filter(|url| !url.is_empty())
            .collect(),
        text: text.filter(|text| !text.is_empty()),
    };
    (!items.is_empty()).then_some(DroppedPayload::Items(items))
}

/// The pasteboard types GPUI views and windows register to receive drags of.
pub(super) fn dragged_types() -> Retained<NSArray<NSString>> {
    #[expect(
        deprecated,
        reason = "Finder and most drag sources still offer NSFilenamesPboardType, the one type that lists every dragged path at once"
    )]
    let filenames = unsafe { NSFilenamesPboardType };
    unsafe {
        NSArray::from_slice(&[
            filenames,
            NSPasteboardTypeFileURL,
            NSPasteboardTypeURL,
            NSPasteboardTypeString,
        ])
    }
}

/// Reads and decodes what the drag behind an `NSDraggingInfo` carries.
pub(super) fn payload_from_dragging_info(dragging_info: *mut AnyObject) -> Option<DroppedPayload> {
    let pasteboard: *mut NSPasteboard = unsafe { msg_send![dragging_info, draggingPasteboard] };
    let pasteboard = unsafe { pasteboard.as_ref() }?;
    decode_dragged_contents(read_pasteboard(pasteboard))
}

pub(crate) fn read_pasteboard(pasteboard: &NSPasteboard) -> DraggedContents {
    let mut contents = DraggedContents::default();
    #[expect(
        deprecated,
        reason = "Finder and most drag sources still offer NSFilenamesPboardType, the one type that lists every dragged path at once"
    )]
    let filenames: *mut AnyObject =
        unsafe { msg_send![pasteboard, propertyListForType: NSFilenamesPboardType] };
    let is_array: bool = !filenames.is_null()
        && unsafe { msg_send![filenames, isKindOfClass: objc2::class!(NSArray)] };
    if is_array {
        let filenames = unsafe { &*filenames.cast::<NSArray<AnyObject>>() };
        for filename in filenames.iter() {
            if let Some(filename) = filename.downcast_ref::<NSString>() {
                contents.filenames.push(PathBuf::from(filename.to_string()));
            }
        }
    }
    let items: *mut NSArray<AnyObject> = unsafe { msg_send![pasteboard, pasteboardItems] };
    if let Some(items) = unsafe { items.as_ref() } {
        for item in items.iter() {
            let item: &AnyObject = &item;
            for kind in unsafe { [NSPasteboardTypeFileURL, NSPasteboardTypeURL] } {
                let string: *mut NSString = unsafe { msg_send![item, stringForType: kind] };
                let Some(string) = (unsafe { string.as_ref() }) else {
                    continue;
                };
                match file_path_of_url(string) {
                    Some(path) => contents.file_urls.push(path),
                    None if kind == unsafe { NSPasteboardTypeURL } => {
                        contents.web_urls.push(string.to_string())
                    }
                    None => {}
                }
                break;
            }
        }
    }
    contents.text =
        unsafe { pasteboard.stringForType(NSPasteboardTypeString) }.map(|text| text.to_string());
    contents
}

fn file_path_of_url(string: &NSString) -> Option<PathBuf> {
    let url = NSURL::URLWithString(string)?;
    if !url.isFileURL() {
        return None;
    }
    let url = url.filePathURL().unwrap_or(url);
    url.path().map(|path| PathBuf::from(path.to_string()))
}

enum DragTarget {
    Gpui,
    Native {
        view: Retained<NSView>,
        entered: NSDragOperation,
    },
}

thread_local! {
    static HOSTED_DRAG_TARGET: RefCell<Option<(usize, DragTarget)>> = const { RefCell::new(None) };
}

/// Adds the drag destination methods to the GPUI view.
///
/// A hosted GPUI view is registered for drags itself, since its host window
/// isn't a GPUI window. AppKit picks the frontmost registered view under the
/// pointer without asking `hitTest:`, so the GPUI view would take drags meant
/// for the native views beneath it. These methods hand a drag over such a view
/// to the view inside it that is registered for the drag, and give GPUI the rest.
pub(super) fn add_view_methods(decl: &mut ClassBuilder) {
    unsafe {
        decl.add_method(
            sel!(draggingEntered:),
            view_dragging_entered as extern "C" fn(_, Sel, *mut AnyObject) -> NSDragOperation,
        );
        decl.add_method(
            sel!(draggingUpdated:),
            view_dragging_updated as extern "C" fn(_, Sel, *mut AnyObject) -> NSDragOperation,
        );
        decl.add_method(
            sel!(draggingExited:),
            view_dragging_exited as extern "C" fn(_, Sel, *mut AnyObject),
        );
        decl.add_method(
            sel!(prepareForDragOperation:),
            view_prepare_for_drag_operation as extern "C" fn(_, Sel, *mut AnyObject) -> Bool,
        );
        decl.add_method(
            sel!(performDragOperation:),
            view_perform_drag_operation as extern "C" fn(_, Sel, *mut AnyObject) -> Bool,
        );
        decl.add_method(
            sel!(concludeDragOperation:),
            view_conclude_drag_operation as extern "C" fn(_, Sel, *mut AnyObject),
        );
        decl.add_method(
            sel!(draggingEnded:),
            view_dragging_ended as extern "C" fn(_, Sel, *mut AnyObject),
        );
    }
}

fn native_destination(this: &AnyObject, dragging_info: *mut AnyObject) -> Option<Retained<NSView>> {
    let window_state = unsafe { window_state_if_set(this) }?;
    let location: NSPoint = unsafe { msg_send![dragging_info, draggingLocation] };
    let pasteboard: *mut NSPasteboard = unsafe { msg_send![dragging_info, draggingPasteboard] };
    let types = unsafe { pasteboard.as_ref() }?.types()?;
    let (container, hit) = native_view_hit_at(&window_state, location)?;
    registered_destination(hit, &container, &types)
}

/// The innermost view from `hit` up to and including `container` that is
/// registered for one of `types`, which is the view AppKit would make the drag
/// destination were the GPUI view not registered above it.
fn registered_destination(
    hit: Retained<NSView>,
    container: &NSView,
    types: &NSArray<NSString>,
) -> Option<Retained<NSView>> {
    let mut candidate = Some(hit);
    while let Some(view) = candidate {
        let registered = view.registeredDraggedTypes();
        if types.iter().any(|kind| registered.containsObject(&kind)) {
            return Some(view);
        }
        if std::ptr::eq(&*view, container) {
            break;
        }
        candidate = unsafe { view.superview() };
    }
    None
}

fn take_target(this: &AnyObject) -> Option<DragTarget> {
    HOSTED_DRAG_TARGET.with_borrow_mut(|target| {
        if target
            .as_ref()
            .is_some_and(|(view, _)| *view == this as *const AnyObject as usize)
        {
            target.take().map(|(_, target)| target)
        } else {
            None
        }
    })
}

fn set_target(this: &AnyObject, target: DragTarget) {
    HOSTED_DRAG_TARGET
        .with_borrow_mut(|slot| *slot = Some((this as *const AnyObject as usize, target)));
}

fn implements(view: &NSView, selector: Sel) -> bool {
    let object: &AnyObject = view;
    let Some(method) = object.class().instance_method(selector) else {
        return unsafe { msg_send![view, respondsToSelector: selector] };
    };
    class!(NSView)
        .instance_method(selector)
        .is_none_or(|default| method.implementation() as usize != default.implementation() as usize)
}

fn enter(this: &AnyObject, selector: Sel, dragging_info: *mut AnyObject) -> NSDragOperation {
    match native_destination(this, dragging_info) {
        Some(view) => {
            let entered = if implements(&view, sel!(draggingEntered:)) {
                unsafe { msg_send![&*view, draggingEntered: dragging_info] }
            } else {
                NSDragOperation::None
            };
            set_target(this, DragTarget::Native { view, entered });
            entered
        }
        None => {
            set_target(this, DragTarget::Gpui);
            dragging_entered(this, selector, dragging_info)
        }
    }
}

fn leave(this: &AnyObject, target: DragTarget, selector: Sel, dragging_info: *mut AnyObject) {
    match target {
        DragTarget::Native { view, .. } => {
            if implements(&view, sel!(draggingExited:)) {
                let () = unsafe { msg_send![&*view, draggingExited: dragging_info] };
            }
        }
        DragTarget::Gpui => dragging_exited(this, selector, dragging_info),
    }
}

extern "C" fn view_dragging_entered(
    this: &AnyObject,
    selector: Sel,
    dragging_info: *mut AnyObject,
) -> NSDragOperation {
    if let Some(stale) = take_target(this) {
        leave(this, stale, selector, dragging_info);
    }
    enter(this, selector, dragging_info)
}

extern "C" fn view_dragging_updated(
    this: &AnyObject,
    selector: Sel,
    dragging_info: *mut AnyObject,
) -> NSDragOperation {
    let destination = native_destination(this, dragging_info);
    match (take_target(this), destination) {
        (Some(DragTarget::Native { view, entered }), Some(destination)) if view == destination => {
            let operation = if implements(&view, sel!(draggingUpdated:)) {
                unsafe { msg_send![&*view, draggingUpdated: dragging_info] }
            } else {
                entered
            };
            set_target(this, DragTarget::Native { view, entered });
            operation
        }
        (Some(DragTarget::Gpui), None) => {
            set_target(this, DragTarget::Gpui);
            dragging_updated(this, selector, dragging_info)
        }
        (current, _) => {
            if let Some(current) = current {
                leave(this, current, selector, dragging_info);
            }
            enter(this, selector, dragging_info)
        }
    }
}

extern "C" fn view_dragging_exited(this: &AnyObject, selector: Sel, dragging_info: *mut AnyObject) {
    if let Some(target) = take_target(this) {
        leave(this, target, selector, dragging_info);
    }
}

fn with_native_target<R>(this: &AnyObject, f: impl FnOnce(&NSView) -> R) -> Option<R> {
    let view = HOSTED_DRAG_TARGET.with_borrow(|target| match target {
        Some((owner, DragTarget::Native { view, .. }))
            if *owner == this as *const AnyObject as usize =>
        {
            Some(view.clone())
        }
        _ => None,
    })?;
    Some(f(&view))
}

extern "C" fn view_prepare_for_drag_operation(
    this: &AnyObject,
    _: Sel,
    dragging_info: *mut AnyObject,
) -> Bool {
    with_native_target(this, |view| {
        if implements(view, sel!(prepareForDragOperation:)) {
            unsafe { msg_send![view, prepareForDragOperation: dragging_info] }
        } else {
            Bool::YES
        }
    })
    .unwrap_or(Bool::YES)
}

extern "C" fn view_perform_drag_operation(
    this: &AnyObject,
    selector: Sel,
    dragging_info: *mut AnyObject,
) -> Bool {
    with_native_target(this, |view| {
        if implements(view, sel!(performDragOperation:)) {
            unsafe { msg_send![view, performDragOperation: dragging_info] }
        } else {
            Bool::NO
        }
    })
    .unwrap_or_else(|| perform_drag_operation(this, selector, dragging_info))
}

extern "C" fn view_conclude_drag_operation(
    this: &AnyObject,
    selector: Sel,
    dragging_info: *mut AnyObject,
) {
    match take_target(this) {
        Some(DragTarget::Native { view, entered }) => {
            if implements(&view, sel!(concludeDragOperation:)) {
                let () = unsafe { msg_send![&*view, concludeDragOperation: dragging_info] };
            }
            set_target(this, DragTarget::Native { view, entered });
        }
        Some(DragTarget::Gpui) => conclude_drag_operation(this, selector, dragging_info),
        None => {}
    }
}

extern "C" fn view_dragging_ended(this: &AnyObject, _: Sel, dragging_info: *mut AnyObject) {
    if let Some(DragTarget::Native { view, .. }) = take_target(this)
        && implements(&view, sel!(draggingEnded:))
    {
        let () = unsafe { msg_send![&*view, draggingEnded: dragging_info] };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::NSPasteboardWriting;

    fn decode(contents: DraggedContents) -> Option<DroppedPayload> {
        decode_dragged_contents(contents)
    }

    fn paths(paths: &[&str]) -> Option<DroppedPayload> {
        Some(DroppedPayload::Paths(ExternalPaths(
            paths.iter().map(PathBuf::from).collect(),
        )))
    }

    fn items(urls: &[&str], text: Option<&str>) -> Option<DroppedPayload> {
        Some(DroppedPayload::Items(ExternalItems {
            paths: Vec::new(),
            urls: urls.iter().map(|url| url.to_string()).collect(),
            text: text.map(str::to_owned),
        }))
    }

    #[test]
    fn files_win_over_urls_and_text() {
        let payload = decode(DraggedContents {
            filenames: vec!["/tmp/a.txt".into(), "/tmp/b".into()],
            file_urls: vec!["/tmp/a.txt".into()],
            web_urls: vec!["https://example.com/".into()],
            text: Some("hello".into()),
        });
        assert_eq!(payload, paths(&["/tmp/a.txt", "/tmp/b"]));
    }

    #[test]
    fn file_urls_become_paths_without_filenames() {
        let payload = decode(DraggedContents {
            file_urls: vec!["/tmp/a b.txt".into()],
            web_urls: vec!["https://example.com/".into()],
            ..Default::default()
        });
        assert_eq!(payload, paths(&["/tmp/a b.txt"]));
    }

    #[test]
    fn urls_arrive_with_their_text() {
        let payload = decode(DraggedContents {
            web_urls: vec![
                " https://a.example/ ".into(),
                "".into(),
                "https://b.example/".into(),
            ],
            text: Some("Example".into()),
            ..Default::default()
        });
        assert_eq!(
            payload,
            items(
                &["https://a.example/", "https://b.example/"],
                Some("Example")
            )
        );
    }

    #[test]
    fn text_alone_is_text_and_empty_is_nothing() {
        assert_eq!(
            decode(DraggedContents {
                text: Some("https://not-a-url-type.example".into()),
                ..Default::default()
            }),
            items(&[], Some("https://not-a-url-type.example"))
        );
        assert_eq!(
            decode(DraggedContents {
                text: Some(String::new()),
                ..Default::default()
            }),
            None
        );
        assert_eq!(decode(DraggedContents::default()), None);
    }

    fn pasteboard_with(objects: &[Retained<AnyObject>]) -> Retained<NSPasteboard> {
        let pasteboard = NSPasteboard::pasteboardWithUniqueName();
        pasteboard.clearContents();
        let writers = objects
            .iter()
            .map(|object| unsafe {
                Retained::cast_unchecked::<ProtocolObject<dyn NSPasteboardWriting>>(object.clone())
            })
            .collect::<Vec<_>>();
        assert!(pasteboard.writeObjects(&NSArray::from_retained_slice(&writers)));
        pasteboard
    }

    fn url(string: &str) -> Retained<AnyObject> {
        let url = NSURL::URLWithString(&NSString::from_str(string)).unwrap();
        unsafe { Retained::cast_unchecked(url) }
    }

    fn file_url(path: &str) -> Retained<AnyObject> {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        unsafe { Retained::cast_unchecked(url) }
    }

    fn string(text: &str) -> Retained<AnyObject> {
        unsafe { Retained::cast_unchecked(NSString::from_str(text)) }
    }

    fn read(objects: &[Retained<AnyObject>]) -> Option<DroppedPayload> {
        let pasteboard = pasteboard_with(objects);
        let payload = decode_dragged_contents(read_pasteboard(&pasteboard));
        let () = unsafe { msg_send![&*pasteboard, releaseGlobally] };
        payload
    }

    #[test]
    fn forwards_to_the_innermost_registered_view_inside_the_container() {
        let new_view = || -> Retained<NSView> { unsafe { msg_send![objc2::class!(NSView), new] } };
        let outside = new_view();
        let container = new_view();
        let page = new_view();
        let renderer = new_view();
        outside.addSubview(&container);
        container.addSubview(&page);
        page.addSubview(&renderer);
        let strings = unsafe { NSArray::from_slice(&[NSPasteboardTypeString]) };
        let files = unsafe { NSArray::from_slice(&[NSPasteboardTypeFileURL]) };
        outside.registerForDraggedTypes(&strings);
        page.registerForDraggedTypes(&strings);

        assert_eq!(
            registered_destination(renderer.clone(), &container, &strings).as_deref(),
            Some(&*page)
        );
        assert_eq!(
            registered_destination(renderer.clone(), &container, &files),
            None
        );
        page.unregisterDraggedTypes();
        assert_eq!(
            registered_destination(renderer, &container, &strings),
            None,
            "views outside the native view are never forwarded to"
        );
    }

    extern "C" fn copies(_: &AnyObject, _: Sel, _: *mut AnyObject) -> NSDragOperation {
        NSDragOperation::Copy
    }

    #[test]
    fn appkit_defaults_are_not_implementations() {
        let plain: Retained<NSView> = unsafe { msg_send![objc2::class!(NSView), new] };
        let mut builder = ClassBuilder::new(c"GPUIExternalDropTestEnteringView", class!(NSView))
            .expect("a fresh view class");
        unsafe {
            builder.add_method(
                sel!(draggingEntered:),
                copies as extern "C" fn(_, Sel, *mut AnyObject) -> NSDragOperation,
            );
        }
        let entering: Retained<NSView> = unsafe { msg_send![builder.register(), new] };
        for selector in [
            sel!(draggingEntered:),
            sel!(draggingUpdated:),
            sel!(draggingExited:),
            sel!(prepareForDragOperation:),
            sel!(performDragOperation:),
            sel!(concludeDragOperation:),
            sel!(draggingEnded:),
        ] {
            assert!(!implements(&plain, selector), "{selector:?}");
        }
        assert!(implements(&entering, sel!(draggingEntered:)));
        assert!(!implements(&entering, sel!(draggingUpdated:)));
    }

    #[test]
    fn reads_a_real_pasteboard() {
        assert_eq!(
            read(&[file_url("/tmp/gpui drop/a.txt"), file_url("/tmp/b.txt")]),
            paths(&["/tmp/gpui drop/a.txt", "/tmp/b.txt"])
        );
        assert_eq!(
            read(&[
                url("https://example.com/a?b=c"),
                url("https://example.org/")
            ]),
            items(&["https://example.com/a?b=c", "https://example.org/"], None)
        );
        assert_eq!(
            read(&[url("https://example.com/"), string("Example")]),
            items(&["https://example.com/"], Some("Example"))
        );
        assert_eq!(
            read(&[string("plain text")]),
            items(&[], Some("plain text"))
        );
        assert_eq!(
            read(&[url("https://example.com/"), file_url("/tmp/c.txt")]),
            paths(&["/tmp/c.txt"])
        );
    }
}
