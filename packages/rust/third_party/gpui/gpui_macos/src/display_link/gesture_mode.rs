const PHASE_BEGAN: u64 = 1;
const PHASE_STATIONARY: u64 = 2;
const PHASE_CHANGED: u64 = 4;
const PHASE_ENDED: u64 = 8;
const PHASE_CANCELLED: u64 = 16;
const MOVING: u64 = PHASE_BEGAN | PHASE_STATIONARY | PHASE_CHANGED;
const FINISHED: u64 = PHASE_ENDED | PHASE_CANCELLED;

use super::vsync_clock::VsyncClock;

const IDLE_TIMEOUT: f64 = 0.1;
const ENDING_GRACE: f64 = 0.05;
const REFRESH_SLACK: f64 = 0.001;

/// Where a trackpad gesture is, from an `NSEvent`'s `phase` and `momentumPhase`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GesturePhase {
    /// The fingers or the momentum that follows them are moving.
    Moving,
    /// The gesture, and any momentum after it, has ended.
    Finished,
    /// The event isn't part of a phased gesture, like a mouse wheel tick.
    Unphased,
}

impl GesturePhase {
    /// Classifies the raw `NSEventPhase` bits of an event.
    pub fn from_bits(phase: u64, momentum: u64) -> Self {
        if phase & MOVING != 0 || momentum & MOVING != 0 {
            GesturePhase::Moving
        } else if momentum & FINISHED != 0 || (phase & FINISHED != 0 && momentum == 0) {
            GesturePhase::Finished
        } else {
            GesturePhase::Unphased
        }
    }
}

/// A change to how the window presents.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GestureTransition {
    /// Detach the display link and present with the Core Animation transaction.
    Enter,
    /// Present with the display link again.
    Exit,
    /// Keep presenting as before.
    Stay,
}

/// Decides when a window presents synchronously during a trackpad gesture.
///
/// A gesture that dirties the window enters gesture mode. While in it the
/// window draws right after the events that dirty it, at most once per
/// refresh, and keeps drawing on a timer while it stays dirty. It leaves a
/// short while after the gesture and its momentum end, or once events stop.
/// Once frames report when they reached the display, a frame presents only
/// if it reaches a later refresh than the last one. Times are host-time
/// seconds.
#[derive(Debug, Default)]
pub struct GesturePresenter {
    active: bool,
    last_event: f64,
    last_present: Option<f64>,
    last_commit: Option<f64>,
    finished_at: Option<f64>,
    clock: VsyncClock,
}

impl GesturePresenter {
    /// Whether the window is in gesture mode.
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Records an event after its dispatch, which `dirtied` the window or not.
    pub fn after_event(
        &mut self,
        now: f64,
        phase: GesturePhase,
        dirtied: bool,
    ) -> GestureTransition {
        match phase {
            GesturePhase::Moving => {
                self.finished_at = None;
                if self.active {
                    self.last_event = now;
                    GestureTransition::Stay
                } else if dirtied {
                    self.active = true;
                    self.last_event = now;
                    self.last_present = None;
                    self.last_commit = None;
                    GestureTransition::Enter
                } else {
                    GestureTransition::Stay
                }
            }
            GesturePhase::Finished if self.active => {
                self.last_event = now;
                self.finished_at.get_or_insert(now);
                GestureTransition::Stay
            }
            GesturePhase::Finished | GesturePhase::Unphased => GestureTransition::Stay,
        }
    }

    /// Whether a frame may present now without a second present in one
    /// refresh of `refresh_interval` seconds.
    pub fn may_present(&self, now: f64, refresh_interval: f64) -> bool {
        if !self.active {
            return false;
        }
        let shown = |at| self.clock.display_time(at, refresh_interval);
        match self.last_commit.map(shown) {
            Some(Some(last_shown)) => shown(now).is_some_and(|next| next > last_shown),
            _ => self
                .last_present
                .is_none_or(|last| now - last >= refresh_interval - REFRESH_SLACK),
        }
    }

    /// When the next frame may present.
    pub fn next_present_at(&self, now: f64, refresh_interval: f64) -> f64 {
        let next_refresh = self
            .last_commit
            .and_then(|commit| self.clock.next_refresh_commit(commit, refresh_interval));
        match (next_refresh, self.last_present) {
            (Some(at), _) => at.max(now),
            (None, Some(last)) => (last + refresh_interval).max(now),
            (None, None) => now,
        }
    }

    /// Records that a frame that started drawing at `started` committed at
    /// `committed`.
    pub fn presented(&mut self, started: f64, committed: f64) {
        self.last_present = Some(started);
        self.last_commit = Some(committed);
    }

    /// Records that a frame committed at `committed` reached the display at
    /// `presented`.
    pub fn observe_display(&mut self, committed: f64, presented: f64) {
        self.clock.observe(committed, presented);
    }

    /// Checks whether the gesture is over, leaving gesture mode if so.
    pub fn tick(&mut self, now: f64) -> GestureTransition {
        if !self.active {
            return GestureTransition::Stay;
        }
        let finished = self
            .finished_at
            .is_some_and(|finished_at| now - finished_at >= ENDING_GRACE);
        if finished || now - self.last_event >= IDLE_TIMEOUT {
            self.active = false;
            GestureTransition::Exit
        } else {
            GestureTransition::Stay
        }
    }

    /// Leaves gesture mode without a transition, because another path took
    /// the presentation back.
    pub fn abandon(&mut self) {
        self.active = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REFRESH: f64 = 1.0 / 120.0;

    #[test]
    fn phases_come_from_the_gesture_and_its_momentum() {
        assert_eq!(
            GesturePhase::from_bits(PHASE_BEGAN, 0),
            GesturePhase::Moving
        );
        assert_eq!(
            GesturePhase::from_bits(PHASE_CHANGED, 0),
            GesturePhase::Moving
        );
        assert_eq!(
            GesturePhase::from_bits(0, PHASE_CHANGED),
            GesturePhase::Moving
        );
        assert_eq!(
            GesturePhase::from_bits(PHASE_ENDED, 0),
            GesturePhase::Finished
        );
        assert_eq!(
            GesturePhase::from_bits(0, PHASE_ENDED),
            GesturePhase::Finished
        );
        assert_eq!(
            GesturePhase::from_bits(0, PHASE_CANCELLED),
            GesturePhase::Finished
        );
        assert_eq!(GesturePhase::from_bits(0, 0), GesturePhase::Unphased);
        assert_eq!(GesturePhase::from_bits(32, 0), GesturePhase::Unphased);
    }

    #[test]
    fn a_moving_gesture_enters_only_once_it_dirties_the_window() {
        let mut presenter = GesturePresenter::default();
        assert_eq!(
            presenter.after_event(1.0, GesturePhase::Moving, false),
            GestureTransition::Stay
        );
        assert!(!presenter.is_active());
        assert_eq!(
            presenter.after_event(1.0, GesturePhase::Unphased, true),
            GestureTransition::Stay,
            "a wheel tick never enters"
        );
        assert_eq!(
            presenter.after_event(1.0, GesturePhase::Finished, true),
            GestureTransition::Stay
        );
        assert_eq!(
            presenter.after_event(1.01, GesturePhase::Moving, true),
            GestureTransition::Enter
        );
        assert!(presenter.is_active());
        assert_eq!(
            presenter.after_event(1.02, GesturePhase::Moving, true),
            GestureTransition::Stay
        );
    }

    #[test]
    fn gesture_mode_ends_after_the_gesture_and_momentum_finish() {
        let mut presenter = GesturePresenter::default();
        presenter.after_event(1.0, GesturePhase::Moving, true);
        presenter.after_event(1.01, GesturePhase::Finished, false);
        assert_eq!(presenter.tick(1.03), GestureTransition::Stay);
        presenter.after_event(1.04, GesturePhase::Moving, true);
        assert_eq!(
            presenter.tick(1.07),
            GestureTransition::Stay,
            "momentum after the fingers lift keeps gesture mode"
        );
        presenter.after_event(1.08, GesturePhase::Finished, false);
        assert_eq!(presenter.tick(1.12), GestureTransition::Stay);
        assert_eq!(presenter.tick(1.131), GestureTransition::Exit);
        assert!(!presenter.is_active());
        assert_eq!(presenter.tick(1.2), GestureTransition::Stay);
    }

    #[test]
    fn gesture_mode_ends_when_events_stop() {
        let mut presenter = GesturePresenter::default();
        presenter.after_event(1.0, GesturePhase::Moving, true);
        presenter.after_event(1.05, GesturePhase::Moving, false);
        assert_eq!(presenter.tick(1.14), GestureTransition::Stay);
        assert_eq!(presenter.tick(1.151), GestureTransition::Exit);
    }

    #[test]
    fn frames_present_at_most_once_per_refresh() {
        let mut presenter = GesturePresenter::default();
        assert!(!presenter.may_present(1.0, REFRESH), "only in gesture mode");
        presenter.after_event(1.0, GesturePhase::Moving, true);
        assert!(presenter.may_present(1.0, REFRESH));
        presenter.presented(1.0, 1.001);
        assert!(
            !presenter.may_present(1.004, REFRESH),
            "a second event in the same refresh doesn't present again"
        );
        assert_eq!(presenter.next_present_at(1.004, REFRESH), 1.0 + REFRESH);
        assert!(presenter.may_present(1.0 + REFRESH - 0.0005, REFRESH));
        assert_eq!(presenter.next_present_at(1.02, REFRESH), 1.02);
    }

    #[test]
    fn with_display_feedback_one_frame_presents_per_refresh_slot() {
        let refresh = 0.01;
        let mut presenter = GesturePresenter::default();
        presenter.observe_display(1.003, 1.03);
        presenter.observe_display(1.012, 1.04);
        presenter.after_event(1.05, GesturePhase::Moving, true);
        presenter.presented(1.049, 1.0505);
        assert!(
            !presenter.may_present(1.0525, refresh),
            "a commit before the same deadline would replace the last frame unseen"
        );
        let opens = presenter.next_present_at(1.0525, refresh);
        assert!(opens > 1.053 && opens < 1.0531, "{opens}");
        assert!(
            presenter.may_present(1.0535, refresh),
            "the next refresh may present sooner than a full interval after the last start"
        );
    }

    #[test]
    fn abandoning_leaves_without_a_transition() {
        let mut presenter = GesturePresenter::default();
        presenter.after_event(1.0, GesturePhase::Moving, true);
        presenter.abandon();
        assert!(!presenter.is_active());
        assert_eq!(presenter.tick(2.0), GestureTransition::Stay);
        assert!(!presenter.may_present(2.0, REFRESH));
    }
}
