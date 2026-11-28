use std::collections::VecDeque;

const SAMPLES: usize = 32;
const EPSILON: f64 = 1e-4;

/// Predicts which display refresh a Core Animation commit reaches, from when
/// earlier frames were committed and when they reached the display.
///
/// Refreshes fall on a grid anchored at the last presentation time. The
/// shortest commit-to-presentation time seen recently is taken as the
/// display's latency, so a commit at `t` shows at the first refresh at or
/// after `t` plus that latency. Times are host-time seconds.
#[derive(Debug, Default)]
pub struct VsyncClock {
    anchor: Option<f64>,
    latencies: VecDeque<f64>,
}

impl VsyncClock {
    /// Records that a frame committed at `committed` reached the display at
    /// `presented`.
    pub fn observe(&mut self, committed: f64, presented: f64) {
        let latency = presented - committed;
        if !latency.is_finite() || latency <= 0.0 {
            return;
        }
        self.anchor = Some(presented);
        if self.latencies.len() == SAMPLES {
            self.latencies.pop_front();
        }
        self.latencies.push_back(latency);
    }

    fn latency(&self) -> Option<f64> {
        self.latencies.iter().copied().reduce(f64::min)
    }

    /// The refresh a commit at `committed` reaches, once any frame has been
    /// observed.
    pub fn display_time(&self, committed: f64, refresh_interval: f64) -> Option<f64> {
        let anchor = self.anchor?;
        let earliest = committed + self.latency()?;
        let refreshes = ((earliest - anchor) / refresh_interval - EPSILON).ceil();
        Some(anchor + refreshes * refresh_interval)
    }

    /// The earliest commit time that reaches a later refresh than `committed`.
    pub fn next_refresh_commit(&self, committed: f64, refresh_interval: f64) -> Option<f64> {
        let shown = self.display_time(committed, refresh_interval)?;
        Some(shown + refresh_interval * EPSILON * 2.0 - self.latency()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REFRESH: f64 = 0.01;

    #[test]
    fn nothing_is_predicted_before_a_frame_is_seen() {
        let clock = VsyncClock::default();
        assert_eq!(clock.display_time(1.0, REFRESH), None);
        assert_eq!(clock.next_refresh_commit(1.0, REFRESH), None);
    }

    #[test]
    fn commits_in_one_refresh_slot_reach_the_same_refresh() {
        let mut clock = VsyncClock::default();
        clock.observe(1.003, 1.03);
        clock.observe(1.012, 1.04);
        let first = clock.display_time(1.05, REFRESH).unwrap();
        let second = clock.display_time(1.0525, REFRESH).unwrap();
        assert!((first - 1.08).abs() < 1e-9, "{first}");
        assert_eq!(first, second, "both commits beat the same deadline");
        let third = clock.display_time(1.056, REFRESH).unwrap();
        assert!((third - 1.09).abs() < 1e-9, "{third}");
    }

    #[test]
    fn the_next_refresh_opens_just_after_the_deadline() {
        let mut clock = VsyncClock::default();
        clock.observe(1.003, 1.03);
        clock.observe(1.012, 1.04);
        let opens = clock.next_refresh_commit(1.05, REFRESH).unwrap();
        let shown = clock.display_time(1.05, REFRESH).unwrap();
        assert!(clock.display_time(opens, REFRESH).unwrap() > shown);
        assert_eq!(
            clock.display_time(opens - 0.0005, REFRESH).unwrap(),
            shown,
            "a commit just before the deadline still reaches the earlier refresh"
        );
    }

    #[test]
    fn the_latency_follows_the_recent_minimum() {
        let mut clock = VsyncClock::default();
        clock.observe(1.0, 1.001);
        for frame in 0..SAMPLES {
            let committed = 2.0 + frame as f64 * REFRESH;
            clock.observe(committed, committed + 0.025);
        }
        assert!((clock.latency().unwrap() - 0.025).abs() < 1e-9);
        clock.observe(3.0, 2.0);
        assert!(
            (clock.latency().unwrap() - 0.025).abs() < 1e-9,
            "a presentation before its commit is ignored"
        );
    }
}
