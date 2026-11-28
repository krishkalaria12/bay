use objc2::{
    AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
    rc::Retained,
    runtime::{AnyClass, ProtocolObject},
};
use objc2_foundation::{NSObject, NSObjectProtocol, NSRunLoop, NSRunLoopCommonModes};
use objc2_quartz_core::{
    CAMetalDisplayLink, CAMetalDisplayLinkDelegate, CAMetalDisplayLinkUpdate, CAMetalLayer,
};
use std::sync::OnceLock;

const FRAME_LATENCY_ENV: &str = "ARDIA_GPUI_FRAME_LATENCY";
const DEFAULT_FRAME_LATENCY: f32 = 2.0;

struct MetalDisplayLinkDelegateIvars {
    callback: Box<dyn Fn(&CAMetalDisplayLinkUpdate)>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = MetalDisplayLinkDelegateIvars]
    struct MetalDisplayLinkDelegate;

    unsafe impl NSObjectProtocol for MetalDisplayLinkDelegate {}

    unsafe impl CAMetalDisplayLinkDelegate for MetalDisplayLinkDelegate {
        #[unsafe(method(metalDisplayLink:needsUpdate:))]
        fn needs_update(&self, _link: &CAMetalDisplayLink, update: &CAMetalDisplayLinkUpdate) {
            let delegate = self.retain();
            (delegate.ivars().callback)(update);
        }
    }
);

impl MetalDisplayLinkDelegate {
    fn new(
        main_thread: MainThreadMarker,
        callback: impl Fn(&CAMetalDisplayLinkUpdate) + 'static,
    ) -> Retained<Self> {
        let this = Self::alloc(main_thread).set_ivars(MetalDisplayLinkDelegateIvars {
            callback: Box::new(callback),
        });
        unsafe { msg_send![super(this), init] }
    }
}

/// How many refreshes ahead each frame targets, read once per process.
///
/// Two frames by default, as upstream; `ARDIA_GPUI_FRAME_LATENCY` overrides it within the
/// one to three frames `CAMetalDisplayLink` accepts.
pub fn preferred_frame_latency() -> f32 {
    static LATENCY: OnceLock<f32> = OnceLock::new();
    *LATENCY.get_or_init(|| parse_frame_latency(std::env::var(FRAME_LATENCY_ENV).ok().as_deref()))
}

fn parse_frame_latency(value: Option<&str>) -> f32 {
    value
        .and_then(|value| value.trim().parse::<f32>().ok())
        .filter(|latency| latency.is_finite())
        .map_or(DEFAULT_FRAME_LATENCY, |latency| latency.clamp(1.0, 3.0))
}

fn display_link_for_layer(
    layer: &CAMetalLayer,
    frame_latency: f32,
) -> Retained<CAMetalDisplayLink> {
    let link = CAMetalDisplayLink::initWithMetalLayer(CAMetalDisplayLink::alloc(), layer);
    link.setPreferredFrameLatency(frame_latency);
    link
}

/// A main-run-loop source of Metal drawables on macOS 14+, targeting
/// [`preferred_frame_latency`] refreshes ahead.
pub struct MetalFrameSource {
    link: Retained<CAMetalDisplayLink>,
    _delegate: Retained<MetalDisplayLinkDelegate>,
    _main_thread: MainThreadMarker,
}

impl MetalFrameSource {
    /// Whether this system has `CAMetalDisplayLink` (macOS 14+).
    pub fn is_available() -> bool {
        AnyClass::get(c"CAMetalDisplayLink").is_some()
    }

    /// Starts delivering updates for `layer` on the main run loop, or returns
    /// `None` where `CAMetalDisplayLink` is unavailable.
    pub fn new(
        layer: &CAMetalLayer,
        main_thread: MainThreadMarker,
        callback: impl Fn(&CAMetalDisplayLinkUpdate) + 'static,
    ) -> Option<Self> {
        if !Self::is_available() {
            return None;
        }
        let delegate = MetalDisplayLinkDelegate::new(main_thread, callback);
        let link = display_link_for_layer(layer, preferred_frame_latency());
        link.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        unsafe { link.addToRunLoop_forMode(&NSRunLoop::mainRunLoop(), NSRunLoopCommonModes) };
        Some(Self {
            link,
            _delegate: delegate,
            _main_thread: main_thread,
        })
    }

    /// A paused link delivers no updates and acquires no drawables.
    pub fn set_paused(&self, paused: bool) {
        self.link.setPaused(paused);
    }

    /// Whether the link is paused.
    pub fn is_paused(&self) -> bool {
        self.link.isPaused()
    }

    /// The frame latency the link was created with.
    pub fn frame_latency(&self) -> f32 {
        self.link.preferredFrameLatency()
    }
}

impl Drop for MetalFrameSource {
    fn drop(&mut self) {
        self.link.invalidate();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_latency_defaults_to_two_frames_and_clamps_overrides() {
        assert_eq!(parse_frame_latency(None), 2.0);
        assert_eq!(parse_frame_latency(Some("1")), 1.0);
        assert_eq!(parse_frame_latency(Some(" 1.5 ")), 1.5);
        assert_eq!(parse_frame_latency(Some("0")), 1.0);
        assert_eq!(parse_frame_latency(Some("9")), 3.0);
        assert_eq!(parse_frame_latency(Some("NaN")), 2.0);
        assert_eq!(parse_frame_latency(Some("fast")), 2.0);
    }

    #[test]
    fn a_created_link_reports_its_preferred_frame_latency() {
        if !MetalFrameSource::is_available() {
            return;
        }
        let layer = CAMetalLayer::new();
        for latency in [1.0, DEFAULT_FRAME_LATENCY] {
            let link = display_link_for_layer(&layer, latency);
            assert_eq!(link.preferredFrameLatency(), latency);
            link.invalidate();
        }
    }
}
