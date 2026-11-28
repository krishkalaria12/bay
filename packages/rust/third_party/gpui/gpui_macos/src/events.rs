use gpui::{
    Capslock, KeyDownEvent, KeyUpEvent, Keystroke, Modifiers, ModifiersChangedEvent, MouseButton,
    MouseDownEvent, MouseExitEvent, MouseMoveEvent, MousePressureEvent, MouseUpEvent,
    NavigationDirection, PinchEvent, PlatformInput, PressureStage, ScrollDelta, ScrollEvent,
    ScrollPhase, ScrollSource, TouchPhase, point, px,
};

use crate::{
    LMGetKbdType, NSStringExt, TISCopyCurrentKeyboardLayoutInputSource, TISGetInputSourceProperty,
    UCKeyTranslate, convert_mouse_position, kTISPropertyUnicodeKeyLayoutData,
};
use core_foundation::data::{CFDataGetBytePtr, CFDataRef};
use core_graphics::event::CGKeyCode;
use objc2::{msg_send, runtime::AnyObject};
use objc2_app_kit::{
    NSDeleteFunctionKey, NSDownArrowFunctionKey, NSEndFunctionKey, NSEvent, NSEventModifierFlags,
    NSEventPhase, NSEventType, NSF1FunctionKey, NSF2FunctionKey, NSF3FunctionKey, NSF4FunctionKey,
    NSF5FunctionKey, NSF6FunctionKey, NSF7FunctionKey, NSF8FunctionKey, NSF9FunctionKey,
    NSF10FunctionKey, NSF11FunctionKey, NSF12FunctionKey, NSF13FunctionKey, NSF14FunctionKey,
    NSF15FunctionKey, NSF16FunctionKey, NSF17FunctionKey, NSF18FunctionKey, NSF19FunctionKey,
    NSF20FunctionKey, NSF21FunctionKey, NSF22FunctionKey, NSF23FunctionKey, NSF24FunctionKey,
    NSF25FunctionKey, NSF26FunctionKey, NSF27FunctionKey, NSF28FunctionKey, NSF29FunctionKey,
    NSF30FunctionKey, NSF31FunctionKey, NSF32FunctionKey, NSF33FunctionKey, NSF34FunctionKey,
    NSF35FunctionKey, NSHelpFunctionKey, NSHomeFunctionKey, NSLeftArrowFunctionKey,
    NSModeSwitchFunctionKey, NSPageDownFunctionKey, NSPageUpFunctionKey, NSRightArrowFunctionKey,
    NSUpArrowFunctionKey,
};
use objc2_foundation::NSRect;
use std::{borrow::Cow, ffi::c_void, time::Duration};

pub(crate) const ESCAPE_KEY: u16 = 0x1b;

const BACKSPACE_KEY: u32 = 0x7f;
const SPACE_KEY: u32 = b' ' as u32;
const ENTER_KEY: u32 = 0x0d;
const NUMPAD_ENTER_KEY: u32 = 0x03;
const TAB_KEY: u32 = 0x09;
const SHIFT_TAB_KEY: u32 = 0x19;

// Menu key equivalents use different character values than the ones NSEvent
// reports for the same physical keys.
//
// See https://developer.apple.com/documentation/appkit/nsmenuitem/keyequivalent#Discussion
const BACKSPACE_KEY_EQUIVALENT: u32 = 0x08;
const DELETE_KEY_EQUIVALENT: u32 = 0x7f;

pub(crate) fn key_to_menu_equivalent(key: &str) -> Cow<'_, str> {
    let code = match key {
        "space" => SPACE_KEY,
        "backspace" => BACKSPACE_KEY_EQUIVALENT,
        "escape" => u32::from(ESCAPE_KEY),
        "up" => NSUpArrowFunctionKey,
        "down" => NSDownArrowFunctionKey,
        "left" => NSLeftArrowFunctionKey,
        "right" => NSRightArrowFunctionKey,
        "pageup" => NSPageUpFunctionKey,
        "pagedown" => NSPageDownFunctionKey,
        "home" => NSHomeFunctionKey,
        "end" => NSEndFunctionKey,
        "delete" => DELETE_KEY_EQUIVALENT,
        "insert" => NSHelpFunctionKey,
        "f1" => NSF1FunctionKey,
        "f2" => NSF2FunctionKey,
        "f3" => NSF3FunctionKey,
        "f4" => NSF4FunctionKey,
        "f5" => NSF5FunctionKey,
        "f6" => NSF6FunctionKey,
        "f7" => NSF7FunctionKey,
        "f8" => NSF8FunctionKey,
        "f9" => NSF9FunctionKey,
        "f10" => NSF10FunctionKey,
        "f11" => NSF11FunctionKey,
        "f12" => NSF12FunctionKey,
        "f13" => NSF13FunctionKey,
        "f14" => NSF14FunctionKey,
        "f15" => NSF15FunctionKey,
        "f16" => NSF16FunctionKey,
        "f17" => NSF17FunctionKey,
        "f18" => NSF18FunctionKey,
        "f19" => NSF19FunctionKey,
        "f20" => NSF20FunctionKey,
        "f21" => NSF21FunctionKey,
        "f22" => NSF22FunctionKey,
        "f23" => NSF23FunctionKey,
        "f24" => NSF24FunctionKey,
        "f25" => NSF25FunctionKey,
        "f26" => NSF26FunctionKey,
        "f27" => NSF27FunctionKey,
        "f28" => NSF28FunctionKey,
        "f29" => NSF29FunctionKey,
        "f30" => NSF30FunctionKey,
        "f31" => NSF31FunctionKey,
        "f32" => NSF32FunctionKey,
        "f33" => NSF33FunctionKey,
        "f34" => NSF34FunctionKey,
        "f35" => NSF35FunctionKey,
        _ => return Cow::Borrowed(key),
    };
    Cow::Owned(String::from_utf16(&[code as u16]).unwrap())
}

fn read_modifiers(native_event: &NSEvent) -> Modifiers {
    let modifiers = native_event.modifierFlags();
    let control = modifiers.contains(NSEventModifierFlags::Control);
    let alt = modifiers.contains(NSEventModifierFlags::Option);
    let shift = modifiers.contains(NSEventModifierFlags::Shift);
    let command = modifiers.contains(NSEventModifierFlags::Command);
    let function = modifiers.contains(NSEventModifierFlags::Function);

    Modifiers {
        control,
        alt,
        shift,
        platform: command,
        function,
    }
}

fn scroll_phase(phase: NSEventPhase) -> ScrollPhase {
    if phase.contains(NSEventPhase::Cancelled) {
        ScrollPhase::Cancelled
    } else if phase.contains(NSEventPhase::Ended) {
        ScrollPhase::Ended
    } else if phase.contains(NSEventPhase::Began) {
        ScrollPhase::Began
    } else if phase.contains(NSEventPhase::Changed) {
        ScrollPhase::Changed
    } else if phase.contains(NSEventPhase::Stationary) {
        ScrollPhase::Stationary
    } else if phase.contains(NSEventPhase::MayBegin) {
        ScrollPhase::MayBegin
    } else {
        ScrollPhase::None
    }
}

fn timestamp_from_secs(seconds: f64) -> Option<Duration> {
    Duration::try_from_secs_f64(seconds).ok()
}

pub(crate) unsafe fn platform_input_from_native(
    native_event: *mut AnyObject,
    view_frame: Option<NSRect>,
) -> Option<PlatformInput> {
    unsafe {
        let native_event = native_event.cast::<NSEvent>().as_ref()?;
        let event_type = native_event.r#type();

        // Filter out event types that aren't in the NSEventType enum.
        // See https://github.com/servo/cocoa-rs/issues/155#issuecomment-323482792 for details.
        match event_type.0 {
            0 | 21 | 32 | 33 | 35 | 36 | 37 => {
                return None;
            }
            _ => {}
        }

        match event_type {
            NSEventType::FlagsChanged => {
                Some(PlatformInput::ModifiersChanged(ModifiersChangedEvent {
                    modifiers: read_modifiers(native_event),
                    capslock: Capslock {
                        on: native_event
                            .modifierFlags()
                            .contains(NSEventModifierFlags::CapsLock),
                    },
                }))
            }
            NSEventType::KeyDown => Some(PlatformInput::KeyDown(KeyDownEvent {
                keystroke: parse_keystroke(native_event),
                is_held: native_event.isARepeat(),
                prefer_character_input: false,
            })),
            NSEventType::KeyUp => Some(PlatformInput::KeyUp(KeyUpEvent {
                keystroke: parse_keystroke(native_event),
            })),
            NSEventType::LeftMouseDown
            | NSEventType::RightMouseDown
            | NSEventType::OtherMouseDown => {
                let button = match native_event.buttonNumber() {
                    0 => MouseButton::Left,
                    1 => MouseButton::Right,
                    2 => MouseButton::Middle,
                    3 => MouseButton::Navigate(NavigationDirection::Back),
                    4 => MouseButton::Navigate(NavigationDirection::Forward),
                    // Other mouse buttons aren't tracked currently
                    _ => return None,
                };
                view_frame.map(|view_frame| {
                    PlatformInput::MouseDown(MouseDownEvent {
                        button,
                        position: convert_mouse_position(
                            native_event.locationInWindow(),
                            view_frame,
                        ),
                        modifiers: read_modifiers(native_event),
                        click_count: native_event.clickCount() as usize,
                        first_mouse: false,
                    })
                })
            }
            NSEventType::LeftMouseUp | NSEventType::RightMouseUp | NSEventType::OtherMouseUp => {
                let button = match native_event.buttonNumber() {
                    0 => MouseButton::Left,
                    1 => MouseButton::Right,
                    2 => MouseButton::Middle,
                    3 => MouseButton::Navigate(NavigationDirection::Back),
                    4 => MouseButton::Navigate(NavigationDirection::Forward),
                    // Other mouse buttons aren't tracked currently
                    _ => return None,
                };

                view_frame.map(|view_frame| {
                    PlatformInput::MouseUp(MouseUpEvent {
                        button,
                        position: convert_mouse_position(
                            native_event.locationInWindow(),
                            view_frame,
                        ),
                        modifiers: read_modifiers(native_event),
                        click_count: native_event.clickCount() as usize,
                    })
                })
            }
            NSEventType::Pressure => {
                let stage = native_event.stage();
                let pressure = native_event.pressure();

                view_frame.map(|view_frame| {
                    PlatformInput::MousePressure(MousePressureEvent {
                        stage: match stage {
                            1 => PressureStage::Normal,
                            2 => PressureStage::Force,
                            _ => PressureStage::Zero,
                        },
                        pressure,
                        modifiers: read_modifiers(native_event),
                        position: convert_mouse_position(
                            native_event.locationInWindow(),
                            view_frame,
                        ),
                    })
                })
            }
            // Some mice (like Logitech MX Master) send navigation buttons as swipe events
            NSEventType::Swipe => {
                let navigation_direction = match native_event.phase() {
                    NSEventPhase::Ended => match native_event.deltaX() {
                        x if x > 0.0 => Some(NavigationDirection::Back),
                        x if x < 0.0 => Some(NavigationDirection::Forward),
                        _ => return None,
                    },
                    _ => return None,
                };

                match navigation_direction {
                    Some(direction) => view_frame.map(|view_frame| {
                        PlatformInput::MouseDown(MouseDownEvent {
                            button: MouseButton::Navigate(direction),
                            position: convert_mouse_position(
                                native_event.locationInWindow(),
                                view_frame,
                            ),
                            modifiers: read_modifiers(native_event),
                            click_count: 1,
                            first_mouse: false,
                        })
                    }),
                    _ => None,
                }
            }
            NSEventType::Magnify => view_frame.map(|view_frame| {
                let phase = match native_event.phase() {
                    NSEventPhase::MayBegin | NSEventPhase::Began => TouchPhase::Started,
                    NSEventPhase::Ended => TouchPhase::Ended,
                    _ => TouchPhase::Moved,
                };

                let magnification = native_event.magnification() as f32;

                PlatformInput::Pinch(PinchEvent {
                    position: convert_mouse_position(native_event.locationInWindow(), view_frame),
                    delta: magnification,
                    modifiers: read_modifiers(native_event),
                    phase,
                    timestamp: timestamp_from_secs(native_event.timestamp()),
                })
            }),
            NSEventType::ScrollWheel => view_frame.map(|view_frame| {
                let phase = match native_event.phase() {
                    NSEventPhase::MayBegin | NSEventPhase::Began => TouchPhase::Started,
                    NSEventPhase::Ended => TouchPhase::Ended,
                    _ => TouchPhase::Moved,
                };

                let raw_data = point(
                    native_event.scrollingDeltaX() as f32,
                    native_event.scrollingDeltaY() as f32,
                );

                let delta = if native_event.hasPreciseScrollingDeltas() {
                    ScrollDelta::Pixels(raw_data.map(px))
                } else {
                    ScrollDelta::Lines(raw_data)
                };

                PlatformInput::Scroll(ScrollEvent {
                    position: convert_mouse_position(native_event.locationInWindow(), view_frame),
                    delta,
                    touch_phase: phase,
                    modifiers: read_modifiers(native_event),
                    source: ScrollSource::Pointer,
                    gesture_phase: scroll_phase(native_event.phase()),
                    momentum_phase: scroll_phase(native_event.momentumPhase()),
                    direction_inverted_from_device: native_event.isDirectionInvertedFromDevice(),
                    timestamp: timestamp_from_secs(native_event.timestamp()),
                })
            }),
            NSEventType::LeftMouseDragged
            | NSEventType::RightMouseDragged
            | NSEventType::OtherMouseDragged => {
                let pressed_button = match native_event.buttonNumber() {
                    0 => MouseButton::Left,
                    1 => MouseButton::Right,
                    2 => MouseButton::Middle,
                    3 => MouseButton::Navigate(NavigationDirection::Back),
                    4 => MouseButton::Navigate(NavigationDirection::Forward),
                    // Other mouse buttons aren't tracked currently
                    _ => return None,
                };

                view_frame.map(|view_frame| {
                    PlatformInput::MouseMove(MouseMoveEvent {
                        pressed_button: Some(pressed_button),
                        position: convert_mouse_position(
                            native_event.locationInWindow(),
                            view_frame,
                        ),
                        modifiers: read_modifiers(native_event),
                    })
                })
            }
            NSEventType::MouseMoved => view_frame.map(|view_frame| {
                PlatformInput::MouseMove(MouseMoveEvent {
                    position: convert_mouse_position(native_event.locationInWindow(), view_frame),
                    pressed_button: None,
                    modifiers: read_modifiers(native_event),
                })
            }),
            NSEventType::MouseExited => view_frame.map(|view_frame| {
                PlatformInput::MouseExited(MouseExitEvent {
                    position: convert_mouse_position(native_event.locationInWindow(), view_frame),

                    pressed_button: None,
                    modifiers: read_modifiers(native_event),
                })
            }),
            _ => None,
        }
    }
}

fn parse_keystroke(native_event: &NSEvent) -> Keystroke {
    let characters = unsafe {
        let characters: *mut AnyObject = msg_send![native_event, charactersIgnoringModifiers];
        characters.to_str().to_string()
    };
    let mut key_char = None;
    let first_char = characters.chars().next().map(|ch| u32::from(ch as u16));
    let modifiers = native_event.modifierFlags();

    let control = modifiers.contains(NSEventModifierFlags::Control);
    let alt = modifiers.contains(NSEventModifierFlags::Option);
    let mut shift = modifiers.contains(NSEventModifierFlags::Shift);
    let command = modifiers.contains(NSEventModifierFlags::Command);
    let function = modifiers.contains(NSEventModifierFlags::Function)
        && first_char
            .is_none_or(|ch| !(NSUpArrowFunctionKey..=NSModeSwitchFunctionKey).contains(&ch));

    #[allow(non_upper_case_globals)]
    let key = match first_char {
        Some(SPACE_KEY) => {
            key_char = Some(" ".to_string());
            "space".to_string()
        }
        Some(TAB_KEY) => {
            key_char = Some("\t".to_string());
            "tab".to_string()
        }
        Some(ENTER_KEY) | Some(NUMPAD_ENTER_KEY) => {
            key_char = Some("\n".to_string());
            "enter".to_string()
        }
        Some(BACKSPACE_KEY) => "backspace".to_string(),
        Some(key) if key == u32::from(ESCAPE_KEY) => "escape".to_string(),
        Some(SHIFT_TAB_KEY) => "tab".to_string(),
        Some(NSUpArrowFunctionKey) => "up".to_string(),
        Some(NSDownArrowFunctionKey) => "down".to_string(),
        Some(NSLeftArrowFunctionKey) => "left".to_string(),
        Some(NSRightArrowFunctionKey) => "right".to_string(),
        Some(NSPageUpFunctionKey) => "pageup".to_string(),
        Some(NSPageDownFunctionKey) => "pagedown".to_string(),
        Some(NSHomeFunctionKey) => "home".to_string(),
        Some(NSEndFunctionKey) => "end".to_string(),
        Some(NSDeleteFunctionKey) => "delete".to_string(),
        // Observed Insert==NSHelpFunctionKey not NSInsertFunctionKey.
        Some(NSHelpFunctionKey) => "insert".to_string(),
        Some(NSF1FunctionKey) => "f1".to_string(),
        Some(NSF2FunctionKey) => "f2".to_string(),
        Some(NSF3FunctionKey) => "f3".to_string(),
        Some(NSF4FunctionKey) => "f4".to_string(),
        Some(NSF5FunctionKey) => "f5".to_string(),
        Some(NSF6FunctionKey) => "f6".to_string(),
        Some(NSF7FunctionKey) => "f7".to_string(),
        Some(NSF8FunctionKey) => "f8".to_string(),
        Some(NSF9FunctionKey) => "f9".to_string(),
        Some(NSF10FunctionKey) => "f10".to_string(),
        Some(NSF11FunctionKey) => "f11".to_string(),
        Some(NSF12FunctionKey) => "f12".to_string(),
        Some(NSF13FunctionKey) => "f13".to_string(),
        Some(NSF14FunctionKey) => "f14".to_string(),
        Some(NSF15FunctionKey) => "f15".to_string(),
        Some(NSF16FunctionKey) => "f16".to_string(),
        Some(NSF17FunctionKey) => "f17".to_string(),
        Some(NSF18FunctionKey) => "f18".to_string(),
        Some(NSF19FunctionKey) => "f19".to_string(),
        Some(NSF20FunctionKey) => "f20".to_string(),
        Some(NSF21FunctionKey) => "f21".to_string(),
        Some(NSF22FunctionKey) => "f22".to_string(),
        Some(NSF23FunctionKey) => "f23".to_string(),
        Some(NSF24FunctionKey) => "f24".to_string(),
        Some(NSF25FunctionKey) => "f25".to_string(),
        Some(NSF26FunctionKey) => "f26".to_string(),
        Some(NSF27FunctionKey) => "f27".to_string(),
        Some(NSF28FunctionKey) => "f28".to_string(),
        Some(NSF29FunctionKey) => "f29".to_string(),
        Some(NSF30FunctionKey) => "f30".to_string(),
        Some(NSF31FunctionKey) => "f31".to_string(),
        Some(NSF32FunctionKey) => "f32".to_string(),
        Some(NSF33FunctionKey) => "f33".to_string(),
        Some(NSF34FunctionKey) => "f34".to_string(),
        Some(NSF35FunctionKey) => "f35".to_string(),
        _ => {
            // Cases to test when modifying this:
            //
            //           qwerty key | none | cmd   | cmd-shift
            // * Armenian         s | ս    | cmd-s | cmd-shift-s  (layout is non-ASCII, so we use cmd layout)
            // * Dvorak+QWERTY    s | o    | cmd-s | cmd-shift-s  (layout switches on cmd)
            // * Ukrainian+QWERTY s | с    | cmd-s | cmd-shift-s  (macOS reports cmd-s instead of cmd-S)
            // * Czech            7 | ý    | cmd-ý | cmd-7        (layout has shifted numbers)
            // * Norwegian        7 | 7    | cmd-7 | cmd-/        (macOS reports cmd-shift-7 instead of cmd-/)
            // * Russian          7 | 7    | cmd-7 | cmd-&        (shift-7 is . but when cmd is down, should use cmd layout)
            // * German QWERTZ    ; | ö    | cmd-ö | cmd-Ö        (Zed's shift special case only applies to a-z)
            //
            let mut chars_ignoring_modifiers =
                chars_for_modified_key(native_event.keyCode(), NO_MOD);
            let mut chars_with_shift = chars_for_modified_key(native_event.keyCode(), SHIFT_MOD);
            let always_use_cmd_layout = always_use_command_layout();

            // Handle Dvorak+QWERTY / Russian / Armenian
            if command || always_use_cmd_layout {
                let chars_with_cmd = chars_for_modified_key(native_event.keyCode(), CMD_MOD);
                let chars_with_both =
                    chars_for_modified_key(native_event.keyCode(), CMD_MOD | SHIFT_MOD);

                // We don't do this in the case that the shifted command key generates
                // the same character as the unshifted command key (Norwegian, e.g.)
                if chars_with_both != chars_with_cmd {
                    chars_with_shift = chars_with_both;

                // Handle edge-case where cmd-shift-s reports cmd-s instead of
                // cmd-shift-s (Ukrainian, etc.)
                } else if chars_with_cmd.to_ascii_uppercase() != chars_with_cmd {
                    chars_with_shift = chars_with_cmd.to_ascii_uppercase();
                }
                chars_ignoring_modifiers = chars_with_cmd;
            }

            if !control && !command && !function {
                let mut mods = NO_MOD;
                if shift {
                    mods |= SHIFT_MOD;
                }
                if alt {
                    mods |= OPTION_MOD;
                }

                key_char = Some(chars_for_modified_key(native_event.keyCode(), mods));
            }

            if shift
                && chars_ignoring_modifiers
                    .chars()
                    .all(|c| c.is_ascii_lowercase())
            {
                chars_ignoring_modifiers
            } else if shift {
                shift = false;
                chars_with_shift
            } else {
                chars_ignoring_modifiers
            }
        }
    };

    Keystroke {
        modifiers: Modifiers {
            control,
            alt,
            shift,
            platform: command,
            function,
        },
        key,
        key_char,
    }
}

fn always_use_command_layout() -> bool {
    if chars_for_modified_key(0, NO_MOD).is_ascii() {
        return false;
    }

    chars_for_modified_key(0, CMD_MOD).is_ascii()
}

const NO_MOD: u32 = 0;
const CMD_MOD: u32 = 1;
const SHIFT_MOD: u32 = 2;
const OPTION_MOD: u32 = 8;

fn chars_for_modified_key(code: CGKeyCode, modifiers: u32) -> String {
    // Values from: https://github.com/phracker/MacOSX-SDKs/blob/master/MacOSX10.6.sdk/System/Library/Frameworks/Carbon.framework/Versions/A/Frameworks/HIToolbox.framework/Versions/A/Headers/Events.h#L126
    // shifted >> 8 for UCKeyTranslate
    const CG_SPACE_KEY: u16 = 49;
    // https://github.com/phracker/MacOSX-SDKs/blob/master/MacOSX10.6.sdk/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/CarbonCore.framework/Versions/A/Headers/UnicodeUtilities.h#L278
    #[allow(non_upper_case_globals)]
    const kUCKeyActionDown: u16 = 0;
    #[allow(non_upper_case_globals)]
    const kUCKeyTranslateNoDeadKeysMask: u32 = 0;

    let keyboard_type = unsafe { LMGetKbdType() as u32 };
    const BUFFER_SIZE: usize = 4;
    let mut dead_key_state = 0;
    let mut buffer: [u16; BUFFER_SIZE] = [0; BUFFER_SIZE];
    let mut buffer_size: usize = 0;

    let keyboard = unsafe { TISCopyCurrentKeyboardLayoutInputSource() };
    if keyboard.is_null() {
        return "".to_string();
    }
    let layout_data = unsafe {
        TISGetInputSourceProperty(keyboard, kTISPropertyUnicodeKeyLayoutData as *const c_void)
            as CFDataRef
    };
    if layout_data.is_null() {
        unsafe {
            let _: () = msg_send![keyboard, release];
        }
        return "".to_string();
    }
    let keyboard_layout = unsafe { CFDataGetBytePtr(layout_data) };

    unsafe {
        UCKeyTranslate(
            keyboard_layout as *const c_void,
            code,
            kUCKeyActionDown,
            modifiers,
            keyboard_type,
            kUCKeyTranslateNoDeadKeysMask,
            &mut dead_key_state,
            BUFFER_SIZE,
            &mut buffer_size as *mut usize,
            &mut buffer as *mut u16,
        );
        if dead_key_state != 0 {
            UCKeyTranslate(
                keyboard_layout as *const c_void,
                CG_SPACE_KEY,
                kUCKeyActionDown,
                modifiers,
                keyboard_type,
                kUCKeyTranslateNoDeadKeysMask,
                &mut dead_key_state,
                BUFFER_SIZE,
                &mut buffer_size as *mut usize,
                &mut buffer as *mut u16,
            );
        }
        let _: () = msg_send![keyboard, release];
    }
    String::from_utf16(&buffer[..buffer_size]).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::{class, rc::autoreleasepool};
    use objc2_foundation::{NSPoint, NSSize};

    const SCROLL_EVENT_UNIT_PIXEL: u32 = 0;

    #[repr(C)]
    struct CGEvent {
        _private: [u8; 0],
    }

    unsafe impl objc2::encode::RefEncode for CGEvent {
        const ENCODING_REF: objc2::encode::Encoding =
            objc2::encode::Encoding::Pointer(&objc2::encode::Encoding::Struct("__CGEvent", &[]));
    }
    const SCROLL_WHEEL_EVENT_SCROLL_PHASE: u32 = 99;
    const SCROLL_WHEEL_EVENT_MOMENTUM_PHASE: u32 = 123;
    const SCROLL_WHEEL_EVENT_DIRECTION_INVERTED: u32 = 137;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventCreateScrollWheelEvent2(
            source: *const c_void,
            units: u32,
            wheel_count: u32,
            wheel1: i32,
            wheel2: i32,
            wheel3: i32,
        ) -> *mut CGEvent;
        fn CGEventSetIntegerValueField(event: *mut CGEvent, field: u32, value: i64);
        fn CGEventCreate(source: *const c_void) -> *mut CGEvent;
        fn CGEventSetType(event: *mut CGEvent, event_type: u32);
        fn CGEventSetTimestamp(event: *mut CGEvent, timestamp: u64);
        fn CFRelease(object: *const c_void);
    }

    const MAGNIFY_EVENT_TYPE: u32 = 30;

    unsafe fn native_input(event: *mut CGEvent, timestamp: u64) -> (f64, Option<PlatformInput>) {
        unsafe {
            CGEventSetTimestamp(event, timestamp);
            let native: *mut AnyObject = msg_send![class!(NSEvent), eventWithCGEvent: event];
            CFRelease(event.cast());
            assert!(!native.is_null());
            let native_timestamp: f64 = msg_send![native, timestamp];
            let view_frame = NSRect::new(NSPoint::new(0., 0.), NSSize::new(800., 600.));
            (
                native_timestamp,
                platform_input_from_native(native, Some(view_frame)),
            )
        }
    }

    fn assert_matches_native(timestamp: Option<Duration>, native_timestamp: f64) {
        let timestamp = timestamp.expect("event has a timestamp");
        assert!(native_timestamp > 0.);
        assert!(
            (timestamp.as_secs_f64() - native_timestamp).abs() < 1e-6,
            "{timestamp:?} != {native_timestamp}"
        );
    }

    #[test]
    fn scroll_carries_the_native_timestamp() {
        let read = |timestamp| {
            autoreleasepool(|_| unsafe {
                let event = CGEventCreateScrollWheelEvent2(
                    std::ptr::null(),
                    SCROLL_EVENT_UNIT_PIXEL,
                    1,
                    -3,
                    0,
                    0,
                );
                assert!(!event.is_null());
                match native_input(event, timestamp) {
                    (native, Some(PlatformInput::Scroll(event))) => (event.timestamp, native),
                    (_, other) => panic!("expected a scroll, got {other:?}"),
                }
            })
        };
        let (first, first_native) = read(7_000_000_000);
        let (second, second_native) = read(7_008_333_333);
        assert_matches_native(first, first_native);
        assert_matches_native(second, second_native);
        assert!(second > first);
        let interval = second.unwrap() - first.unwrap();
        assert!(interval.abs_diff(Duration::from_nanos(8_333_333)) < Duration::from_micros(1));
    }

    #[test]
    fn magnify_carries_the_native_timestamp() {
        let read = |timestamp| {
            autoreleasepool(|_| unsafe {
                let event = CGEventCreate(std::ptr::null());
                assert!(!event.is_null());
                CGEventSetType(event, MAGNIFY_EVENT_TYPE);
                match native_input(event, timestamp) {
                    (native, Some(PlatformInput::Pinch(event))) => (event.timestamp, native),
                    (_, other) => panic!("expected a pinch, got {other:?}"),
                }
            })
        };
        let (first, first_native) = read(9_000_000_000);
        let (second, second_native) = read(9_016_000_000);
        assert_matches_native(first, first_native);
        assert_matches_native(second, second_native);
        assert!(second > first);
    }

    #[test]
    fn invalid_native_timestamps_become_none() {
        assert_eq!(timestamp_from_secs(-1.), None);
        assert_eq!(timestamp_from_secs(f64::NAN), None);
        assert_eq!(timestamp_from_secs(f64::INFINITY), None);
        assert_eq!(timestamp_from_secs(1.5), Some(Duration::from_millis(1500)));
    }

    fn scroll(scroll_phase: i64, momentum_phase: i64, inverted: bool) -> ScrollEvent {
        autoreleasepool(|_| unsafe {
            let event = CGEventCreateScrollWheelEvent2(
                std::ptr::null(),
                SCROLL_EVENT_UNIT_PIXEL,
                2,
                -3,
                4,
                0,
            );
            assert!(!event.is_null());
            CGEventSetIntegerValueField(event, SCROLL_WHEEL_EVENT_SCROLL_PHASE, scroll_phase);
            CGEventSetIntegerValueField(event, SCROLL_WHEEL_EVENT_MOMENTUM_PHASE, momentum_phase);
            CGEventSetIntegerValueField(
                event,
                SCROLL_WHEEL_EVENT_DIRECTION_INVERTED,
                inverted as i64,
            );
            let native: *mut AnyObject = msg_send![class!(NSEvent), eventWithCGEvent: event];
            CFRelease(event.cast());
            let view_frame = NSRect::new(NSPoint::new(0., 0.), NSSize::new(800., 600.));
            match platform_input_from_native(native, Some(view_frame)) {
                Some(PlatformInput::Scroll(event)) => event,
                other => panic!("expected a scroll, got {other:?}"),
            }
        })
    }

    #[test]
    fn maps_gesture_and_momentum_phases() {
        let event = scroll(1, 0, false);
        assert_eq!(event.gesture_phase, ScrollPhase::Began);
        assert_eq!(event.momentum_phase, ScrollPhase::None);
        assert_eq!(event.touch_phase, TouchPhase::Started);
        assert!(!event.direction_inverted_from_device);

        assert_eq!(scroll(128, 0, false).gesture_phase, ScrollPhase::MayBegin);
        assert_eq!(scroll(2, 0, false).gesture_phase, ScrollPhase::Changed);
        assert_eq!(scroll(4, 0, false).gesture_phase, ScrollPhase::Ended);
        assert_eq!(scroll(8, 0, false).gesture_phase, ScrollPhase::Cancelled);

        for (momentum, expected) in [
            (1, ScrollPhase::Began),
            (2, ScrollPhase::Changed),
            (3, ScrollPhase::Ended),
        ] {
            let event = scroll(0, momentum, false);
            assert_eq!(event.gesture_phase, ScrollPhase::None);
            assert_eq!(event.momentum_phase, expected);
        }
    }

    #[test]
    fn maps_direction_inversion() {
        let event = scroll(2, 0, true);
        assert!(event.direction_inverted_from_device);
        assert!(matches!(event.delta, ScrollDelta::Pixels(_)));
    }

    #[test]
    fn phase_flags_map_to_one_phase() {
        assert_eq!(scroll_phase(NSEventPhase::empty()), ScrollPhase::None);
        assert_eq!(
            scroll_phase(NSEventPhase::Stationary),
            ScrollPhase::Stationary
        );
        assert_eq!(
            scroll_phase(NSEventPhase::Began | NSEventPhase::Changed),
            ScrollPhase::Began
        );
    }
}
