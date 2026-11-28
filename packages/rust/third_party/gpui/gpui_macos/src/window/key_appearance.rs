use block2::RcBlock;
use objc2::{
    MainThreadMarker, class, ffi, msg_send,
    runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Imp, Sel},
    sel,
};
use objc2_app_kit::{NSView, NSWindow, NSWindowButton};
use parking_lot::Mutex;
use std::{collections::HashSet, mem};

static KEEPERS: Mutex<Option<HashSet<usize>>> = Mutex::new(None);
static HOSTED_CLASSES: Mutex<Option<HashSet<usize>>> = Mutex::new(None);

type HasKeyAppearance = unsafe extern "C-unwind" fn(&AnyObject, Sel) -> Bool;

fn address(window: &AnyObject) -> usize {
    window as *const AnyObject as usize
}

fn keeps(window: usize) -> bool {
    KEEPERS
        .lock()
        .as_ref()
        .is_some_and(|keepers| keepers.contains(&window))
}

pub(super) fn forces(window: &NSWindow) -> bool {
    let object: &AnyObject = window.as_ref();
    MainThreadMarker::new().is_some() && keeps(address(object))
}

pub(super) fn set_keeps(window: &NSWindow, keeps: bool) {
    let object: &AnyObject = window.as_ref();
    let window_address = address(object);
    {
        let mut keepers = KEEPERS.lock();
        let keepers = keepers.get_or_insert_with(HashSet::new);
        if keeps {
            keepers.insert(window_address);
        } else {
            keepers.remove(&window_address);
        }
    }
    refresh(window);
}

pub(super) fn forget(window: &NSWindow) {
    let object: &AnyObject = window.as_ref();
    let window_address = address(object);
    if let Some(keepers) = KEEPERS.lock().as_mut() {
        keepers.remove(&window_address);
    }
}

fn refresh(window: &NSWindow) {
    for button in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        if let Some(button) = window.standardWindowButton(button) {
            let view: &NSView = &button;
            view.setNeedsDisplay(true);
        }
    }
    if let Some(frame) = window
        .contentView()
        .and_then(|view| unsafe { view.superview() })
    {
        frame.setNeedsDisplay(true);
    }
}

pub(super) unsafe fn add_window_methods(decl: &mut ClassBuilder, superclass: &AnyClass) {
    unsafe {
        if superclass == class!(NSPanel) {
            decl.add_method(
                sel!(hasKeyAppearance),
                panel_has_key_appearance as extern "C" fn(_, Sel) -> Bool,
            );
        } else {
            decl.add_method(
                sel!(hasKeyAppearance),
                window_has_key_appearance as extern "C" fn(_, Sel) -> Bool,
            );
        }
    }
}

fn as_window(object: &AnyObject) -> &NSWindow {
    unsafe { &*(object as *const AnyObject).cast::<NSWindow>() }
}

extern "C" fn window_has_key_appearance(this: &AnyObject, _: Sel) -> Bool {
    if forces(as_window(this)) {
        return Bool::YES;
    }
    unsafe { msg_send![super(this, class!(NSWindow)), hasKeyAppearance] }
}

extern "C" fn panel_has_key_appearance(this: &AnyObject, _: Sel) -> Bool {
    if forces(as_window(this)) {
        return Bool::YES;
    }
    unsafe { msg_send![super(this, class!(NSPanel)), hasKeyAppearance] }
}

pub(super) fn patch_hosted_class(window: &NSWindow) -> bool {
    let selector = sel!(hasKeyAppearance);
    let class: &'static AnyClass = unsafe { msg_send![window, class] };
    let mut patched = HOSTED_CLASSES.lock();
    let patched = patched.get_or_insert_with(HashSet::new);
    if patched.contains(&class_key(class)) {
        return true;
    }
    let Some(method) = class.instance_method(selector) else {
        return false;
    };
    let superclass = class.superclass();
    let inherited = superclass
        .and_then(|superclass| superclass.instance_method(selector))
        .is_some_and(|above| std::ptr::eq(above, method));
    let next = if inherited {
        let Some(superclass) = superclass else {
            return false;
        };
        NextAppearance::Superclass(superclass)
    } else {
        NextAppearance::Own(method.implementation())
    };
    let ours = hosted_imp(next);
    if inherited {
        let types = unsafe { ffi::method_getTypeEncoding(method) };
        let class = class as *const AnyClass as *mut AnyClass;
        if !unsafe { ffi::class_addMethod(class, selector, ours, types) }.as_bool() {
            return false;
        }
    } else {
        unsafe { method.set_implementation(ours) };
    }
    patched.insert(class_key(class));
    true
}

fn class_key(class: &AnyClass) -> usize {
    class as *const AnyClass as usize
}

#[derive(Clone, Copy)]
enum NextAppearance {
    Own(Imp),
    Superclass(&'static AnyClass),
}

fn hosted_imp(next: NextAppearance) -> Imp {
    let block = RcBlock::new(move |this: *mut AnyObject| -> Bool {
        let Some(this) = (unsafe { this.as_ref() }) else {
            return Bool::NO;
        };
        hosted_has_key_appearance(this, next)
    });
    unsafe { ffi::imp_implementationWithBlock(RcBlock::as_ptr(&block).cast()) }
}

fn hosted_has_key_appearance(this: &AnyObject, next: NextAppearance) -> Bool {
    if forces(as_window(this)) {
        return Bool::YES;
    }
    match next {
        NextAppearance::Own(original) => unsafe {
            mem::transmute::<Imp, HasKeyAppearance>(original)(this, sel!(hasKeyAppearance))
        },
        NextAppearance::Superclass(superclass) => unsafe {
            msg_send![super(this, superclass), hasKeyAppearance]
        },
    }
}
