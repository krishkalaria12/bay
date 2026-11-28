use block2::RcBlock;
use gpui::{InputLatencyKind, InputLatencySample};
use objc2::{
    msg_send,
    runtime::{AnyObject, ProtocolObject},
};
use objc2_quartz_core::CAMetalDrawable;
use scheduler::Instant;
use std::{
    cell::RefCell,
    fs::{File, OpenOptions},
    io::Write,
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const LATENCY_LOG_ENV: &str = "ARDIA_GPUI_LATENCY_LOG";
const LATE_TOLERANCE_SECONDS: f64 = 0.001;
const MAX_PENDING_SAMPLES: usize = 256;

/// The kind of input whose presentation latency is logged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputKind {
    /// A scroll event during a gesture, or a wheel tick.
    Scroll,
    /// A scroll event in a gesture's momentum phase.
    Momentum,
    /// A trackpad pinch.
    Magnify,
}

impl InputKind {
    fn label(self) -> &'static str {
        match self {
            InputKind::Scroll => "scroll",
            InputKind::Momentum => "momentum",
            InputKind::Magnify => "magnify",
        }
    }

    fn latency_kind(self) -> InputLatencyKind {
        match self {
            InputKind::Scroll => InputLatencyKind::Scroll,
            InputKind::Momentum => InputLatencyKind::Momentum,
            InputKind::Magnify => InputLatencyKind::Magnify,
        }
    }
}

/// An input waiting for the first frame drawn after it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PendingInput {
    /// What the input was.
    pub kind: InputKind,
    /// The event's timestamp, in host-time seconds.
    pub timestamp: f64,
    /// When the window received the event, in host-time seconds.
    pub received: f64,
}

/// When an update started and the presentation time it targets, in host-time
/// seconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameTimes {
    /// When the display link's update began.
    pub update_start: f64,
    /// The time the update's drawable is meant to reach the display, when a
    /// display link set one.
    pub target: Option<f64>,
}

/// Matches inputs to the frames that show them.
///
/// The oldest input not yet shown waits for the next frame that draws. An
/// update that neither draws nor asks for another frame means the input
/// changed nothing, so it stops waiting.
#[derive(Default, Debug)]
pub struct InputLatencyTracker {
    pending: Option<PendingInput>,
    in_flight: Option<PendingInput>,
}

impl InputLatencyTracker {
    /// Records an input unless an older one is still waiting.
    pub fn record_input(&mut self, input: PendingInput) {
        self.pending.get_or_insert(input);
    }

    /// Starts an update, returning the input its frame would show.
    pub fn begin_frame(&mut self) -> Option<PendingInput> {
        self.in_flight = self.pending;
        self.in_flight
    }

    /// Ends an update that `drew` a frame, or `went_idle` without one.
    pub fn end_frame(&mut self, drew: bool, went_idle: bool) {
        let in_flight = self.in_flight.take();
        if (drew && in_flight.is_some()) || (!drew && went_idle) {
            self.pending = None;
        }
    }
}

/// One presented frame's line in the latency log, in milliseconds except for
/// the flag and the last column: the input kind, input to presentation,
/// whether the frame missed its target, presentation after the target, input
/// to the window receiving it, receipt to the update that drew it, that update
/// to its target, and the presentation time in host-time seconds. Frames
/// without a target show `-` for the columns that need one.
///
/// Returns `None` when the drawable was never presented.
pub fn latency_line(input: PendingInput, presented_time: f64, frame: FrameTimes) -> Option<String> {
    if presented_time <= 0.0 || !presented_time.is_finite() {
        return None;
    }
    let ms = |seconds: f64| format!("{:.2}", seconds * 1000.0);
    let (late, past_target, lead) = match frame.target {
        Some(target) => (
            u8::from(presented_time > target + LATE_TOLERANCE_SECONDS).to_string(),
            ms(presented_time - target),
            ms(target - frame.update_start),
        ),
        None => ("-".into(), "-".into(), "-".into()),
    };
    Some(format!(
        "{} {} {late} {past_target} {} {} {lead} {presented_time:.4}\n",
        input.kind.label(),
        ms(presented_time - input.timestamp),
        ms(input.received - input.timestamp),
        ms(frame.update_start - input.received),
    ))
}

/// The host time `seconds` as an [`Instant`], given the host time and the
/// [`Instant`] of one moment. Both clocks count from the same machine
/// timebase, so the offset between them carries over.
pub fn instant_at(seconds: f64, now_seconds: f64, now: Instant) -> Option<Instant> {
    let offset = seconds - now_seconds;
    if !offset.is_finite() {
        return None;
    }
    if offset >= 0.0 {
        now.checked_add(Duration::from_secs_f64(offset))
    } else {
        now.checked_sub(Duration::from_secs_f64(-offset))
    }
}

/// An input whose frame reached the display, as a presented handler saw it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PresentedInput {
    /// The input the frame showed.
    pub input: PendingInput,
    /// When the frame reached the display, in host-time seconds.
    pub presented_time: f64,
    /// The update that drew the frame.
    pub frame: FrameTimes,
}

impl PresentedInput {
    /// The sample for this presentation, converting host times with the host
    /// time and [`Instant`] of one recent moment.
    pub fn sample(&self, now_seconds: f64, now: Instant) -> Option<InputLatencySample> {
        let at = |seconds: f64| instant_at(seconds, now_seconds, now);
        Some(InputLatencySample {
            kind: self.input.kind.latency_kind(),
            event_time: at(self.input.timestamp)?,
            received_time: at(self.input.received)?,
            frame_start: at(self.frame.update_start)?,
            target_presented_time: match self.frame.target {
                Some(target) => Some(at(target)?),
                None => None,
            },
            presented_time: at(self.presented_time)?,
            late: self
                .frame
                .target
                .map(|target| self.presented_time > target + LATE_TOLERANCE_SECONDS),
        })
    }
}

/// Presentations waiting for the main thread. Presented handlers run on a
/// system thread, push here and call `notify`, which should arrange for the
/// main thread to [`take`](Self::take) them.
pub struct LatencySink {
    pending: Mutex<Vec<PresentedInput>>,
    notify: Box<dyn Fn() + Send + Sync>,
}

impl LatencySink {
    /// A sink that calls `notify` after each presentation it receives.
    pub fn new(notify: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            pending: Mutex::default(),
            notify: Box::new(notify),
        }
    }

    /// Queues a presentation, dropping it when the main thread has fallen
    /// [`MAX_PENDING_SAMPLES`] behind.
    pub fn push(&self, presented: PresentedInput) {
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        if pending.len() >= MAX_PENDING_SAMPLES {
            return;
        }
        pending.push(presented);
        drop(pending);
        (self.notify)();
    }

    /// Takes the queued presentations, oldest first.
    pub fn take(&self) -> Vec<PresentedInput> {
        std::mem::take(&mut *self.pending.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

/// Reports that `input`'s frame reached the display at `presented_time`: a
/// line in the latency log file and a presentation for the sink, for
/// whichever are open. Called from the drawable's presented handler.
pub fn report_presentation(
    presented: PresentedInput,
    file: Option<&Mutex<File>>,
    sink: Option<&LatencySink>,
) {
    let Some(line) = latency_line(presented.input, presented.presented_time, presented.frame)
    else {
        return;
    };
    if let Some(file) = file {
        let mut file = file.lock().unwrap_or_else(PoisonError::into_inner);
        file.write_all(line.as_bytes()).ok();
    }
    if let Some(sink) = sink {
        sink.push(presented);
    }
}

/// A window's input-to-presentation latency tracking, writing the log named
/// by `ARDIA_GPUI_LATENCY_LOG=<path>` and feeding a [`LatencySink`], for
/// whichever are open.
pub struct InputLatencyLog {
    file: Option<Arc<Mutex<File>>>,
    sink: Option<Arc<LatencySink>>,
    tracker: RefCell<InputLatencyTracker>,
    watching: RefCell<Option<Arc<AtomicBool>>>,
}

impl InputLatencyLog {
    /// Opens the log named by the environment, or returns `None` when unset.
    pub fn from_env() -> Option<Self> {
        let path = std::env::var_os(LATENCY_LOG_ENV)?;
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .inspect_err(|error| log::error!("opening the latency log {path:?}: {error}"))
            .ok()?;
        Some(Self::new(Some(Arc::new(Mutex::new(file))), None))
    }

    fn new(file: Option<Arc<Mutex<File>>>, sink: Option<Arc<LatencySink>>) -> Self {
        Self {
            file,
            sink,
            tracker: RefCell::default(),
            watching: RefCell::default(),
        }
    }

    /// Replaces where presentations go besides the log file, returning `None`
    /// when neither remains.
    pub fn with_sink(log: Option<Self>, sink: Option<Arc<LatencySink>>) -> Option<Self> {
        match log {
            Some(mut log) => {
                log.sink = sink;
                (log.file.is_some() || log.sink.is_some()).then_some(log)
            }
            None => sink.map(|sink| Self::new(None, Some(sink))),
        }
    }

    /// Whether presentations are written to the log file.
    pub fn writes_file(&self) -> bool {
        self.file.is_some()
    }

    /// Records an input that may dirty the window.
    pub fn record_input(&self, input: PendingInput) {
        self.tracker.borrow_mut().record_input(input);
    }

    /// Starts an update, logging when `drawable` presents if its frame would
    /// show a waiting input. A drawable the update leaves unused logs nothing,
    /// even when it is presented by a later update.
    pub fn begin_frame(&self, drawable: &ProtocolObject<dyn CAMetalDrawable>, frame: FrameTimes) {
        let Some(input) = self.tracker.borrow_mut().begin_frame() else {
            return;
        };
        let file = self.file.clone();
        let sink = self.sink.clone();
        let armed = Arc::new(AtomicBool::new(true));
        self.watching.replace(Some(armed.clone()));
        let handler = RcBlock::new(move |presented: *mut AnyObject| {
            if presented.is_null() || !armed.swap(false, Ordering::Relaxed) {
                return;
            }
            let presented_time: f64 = unsafe { msg_send![presented, presentedTime] };
            report_presentation(
                PresentedInput {
                    input,
                    presented_time,
                    frame,
                },
                file.as_deref(),
                sink.as_deref(),
            );
        });
        let _: () = unsafe { msg_send![drawable, addPresentedHandler: &*handler] };
    }

    /// Ends an update. See [`InputLatencyTracker::end_frame`].
    pub fn end_frame(&self, drew: bool, went_idle: bool) {
        if let Some(armed) = self.watching.take()
            && !drew
        {
            armed.store(false, Ordering::Relaxed);
        }
        self.tracker.borrow_mut().end_frame(drew, went_idle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(kind: InputKind, timestamp: f64) -> PendingInput {
        PendingInput {
            kind,
            timestamp,
            received: timestamp + 0.002,
        }
    }

    fn frame(update_start: f64, target: Option<f64>) -> FrameTimes {
        FrameTimes {
            update_start,
            target,
        }
    }

    #[test]
    fn the_oldest_waiting_input_is_matched_to_the_next_drawn_frame() {
        let mut tracker = InputLatencyTracker::default();
        assert_eq!(tracker.begin_frame(), None);
        tracker.end_frame(false, false);

        tracker.record_input(input(InputKind::Scroll, 1.0));
        tracker.record_input(input(InputKind::Scroll, 1.004));
        assert_eq!(tracker.begin_frame(), Some(input(InputKind::Scroll, 1.0)));
        tracker.end_frame(false, false);
        assert_eq!(
            tracker.begin_frame(),
            Some(input(InputKind::Scroll, 1.0)),
            "an update that did not draw but stays awake keeps the input waiting"
        );
        tracker.end_frame(true, false);
        assert_eq!(tracker.begin_frame(), None, "a drawn frame shows the input");
        tracker.end_frame(false, false);
    }

    #[test]
    fn an_input_that_changes_nothing_stops_waiting_when_the_link_idles() {
        let mut tracker = InputLatencyTracker::default();
        tracker.record_input(input(InputKind::Momentum, 2.0));
        tracker.begin_frame();
        tracker.end_frame(false, true);
        assert_eq!(tracker.begin_frame(), None);
    }

    #[test]
    fn an_input_during_a_drawn_update_waits_for_the_next_frame() {
        let mut tracker = InputLatencyTracker::default();
        assert_eq!(tracker.begin_frame(), None);
        tracker.record_input(input(InputKind::Magnify, 3.0));
        tracker.end_frame(true, false);
        assert_eq!(tracker.begin_frame(), Some(input(InputKind::Magnify, 3.0)));
    }

    #[test]
    fn presentations_reach_the_sink_as_samples_on_the_main_thread_side() {
        let notified = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let sink = LatencySink::new({
            let notified = notified.clone();
            move || {
                notified.fetch_add(1, Ordering::Relaxed);
            }
        });
        let mut tracker = InputLatencyTracker::default();
        tracker.record_input(input(InputKind::Scroll, 10.0));
        let shown = tracker.begin_frame().expect("an input waits");
        tracker.end_frame(true, false);
        let on_time = PresentedInput {
            input: shown,
            presented_time: 10.0125,
            frame: frame(10.004, Some(10.0125)),
        };
        let late = PresentedInput {
            input: input(InputKind::Momentum, 10.0),
            presented_time: 10.0210,
            frame: frame(10.004, Some(10.0125)),
        };
        let untargeted = PresentedInput {
            input: input(InputKind::Magnify, 10.0),
            presented_time: 10.03,
            frame: frame(10.004, None),
        };
        let never_presented = PresentedInput {
            presented_time: 0.0,
            ..on_time
        };
        std::thread::scope(|scope| {
            scope.spawn(|| {
                for presented in [on_time, late, untargeted, never_presented] {
                    report_presentation(presented, None, Some(&sink));
                }
            });
        });
        assert_eq!(notified.load(Ordering::Relaxed), 3);
        let taken = sink.take();
        assert_eq!(taken, [on_time, late, untargeted]);
        assert!(sink.take().is_empty());

        let now = Instant::now();
        let samples: Vec<_> = taken
            .iter()
            .map(|presented| presented.sample(10.05, now).expect("a sample"))
            .collect();
        let at = |seconds: f64| now - Duration::from_secs_f64(10.05 - seconds);
        let close =
            |a: Instant, b: Instant| a.max(b).duration_since(a.min(b)) < Duration::from_micros(1);
        assert_eq!(samples[0].kind, InputLatencyKind::Scroll);
        assert!(close(samples[0].event_time, at(10.0)));
        assert!(close(samples[0].received_time, at(10.002)));
        assert!(close(samples[0].frame_start, at(10.004)));
        assert!(close(samples[0].presented_time, at(10.0125)));
        assert!(close(
            samples[0].target_presented_time.expect("a target"),
            at(10.0125)
        ));
        assert_eq!(samples[0].late, Some(false));
        let latency = samples[0].latency().as_secs_f64();
        assert!((latency - 0.0125).abs() < 1e-6, "{latency}");
        assert_eq!(samples[1].kind, InputLatencyKind::Momentum);
        assert_eq!(samples[1].late, Some(true));
        assert_eq!(samples[2].kind, InputLatencyKind::Magnify);
        assert_eq!(samples[2].late, None);
        assert_eq!(samples[2].target_presented_time, None);
        let future = PresentedInput {
            presented_time: 10.07,
            ..untargeted
        };
        assert!(future.sample(10.05, now).expect("a sample").presented_time > now);
    }

    #[test]
    fn a_full_sink_drops_presentations_instead_of_growing() {
        let sink = LatencySink::new(|| {});
        let presented = PresentedInput {
            input: input(InputKind::Scroll, 1.0),
            presented_time: 1.01,
            frame: frame(1.004, None),
        };
        for _ in 0..MAX_PENDING_SAMPLES + 10 {
            report_presentation(presented, None, Some(&sink));
        }
        assert_eq!(sink.take().len(), MAX_PENDING_SAMPLES);
    }

    #[test]
    fn the_log_file_and_the_sink_both_receive_a_presentation() {
        let path = std::env::temp_dir().join(format!(
            "gpui-latency-log-test-{}-{:?}.log",
            std::process::id(),
            std::thread::current().id()
        ));
        let file = Mutex::new(File::create(&path).expect("create the log"));
        let sink = LatencySink::new(|| {});
        let presented = PresentedInput {
            input: input(InputKind::Scroll, 10.0),
            presented_time: 10.0125,
            frame: frame(10.004, Some(10.0125)),
        };
        report_presentation(presented, Some(&file), Some(&sink));
        drop(file);
        let written = std::fs::read_to_string(&path).expect("read the log");
        std::fs::remove_file(&path).ok();
        assert_eq!(written, "scroll 12.50 0 0.00 2.00 2.00 8.50 10.0125\n");
        assert_eq!(sink.take(), [presented]);

        let sink = Arc::new(LatencySink::new(|| {}));
        let log = InputLatencyLog::with_sink(None, Some(sink.clone())).expect("a sink opens a log");
        assert!(!log.writes_file());
        assert!(InputLatencyLog::with_sink(Some(log), None).is_none());
    }

    #[test]
    fn latency_lines_report_milliseconds_and_late_frames() {
        let scroll = input(InputKind::Scroll, 10.0);
        let on_time = frame(10.004, Some(10.0125));
        assert_eq!(
            latency_line(scroll, 10.0125, on_time).as_deref(),
            Some("scroll 12.50 0 0.00 2.00 2.00 8.50 10.0125\n")
        );
        assert_eq!(
            latency_line(scroll, 10.0130, on_time).as_deref(),
            Some("scroll 13.00 0 0.50 2.00 2.00 8.50 10.0130\n"),
            "within a millisecond of the target is on time"
        );
        assert_eq!(
            latency_line(input(InputKind::Momentum, 10.0), 10.0210, on_time).as_deref(),
            Some("momentum 21.00 1 8.50 2.00 2.00 8.50 10.0210\n")
        );
        assert_eq!(
            latency_line(scroll, 10.03, frame(10.004, None)).as_deref(),
            Some("scroll 30.00 - - 2.00 2.00 - 10.0300\n"),
            "a frame presented outside a display link has no target"
        );
        assert_eq!(latency_line(scroll, 0.0, on_time), None, "never presented");
    }
}
