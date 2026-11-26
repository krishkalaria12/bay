//! Engines report navigation state dozens of times per load (progress, title, history), for hidden tabs too. These
//! decide which reports run page scripts (only a new document needs them) and which are worth a render.

/// What the last reports said, to judge the next one by.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ScriptTiming {
    /// The last event was loading. Starts true so the first settled event counts as a finished load.
    pub loading: bool,
    /// The address the media watcher was installed for during this load.
    pub watched_url: Option<String>,
    /// The progress last seen.
    pub progress: f64,
    /// The last hide-elements run applied rules, so the page has some to clear.
    pub hidden: bool,
}

/// One navigation report, as the scripts are judged by it.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct NavigationReport {
    pub url: String,
    pub progress: f64,
    pub is_loading: bool,
}

/// The scripts to run on the page, and the timing to judge the next report by.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ScriptPlan {
    pub timing: ScriptTiming,
    pub watch_media: bool,
    pub hide_elements: bool,
}

/// What a tab's navigation state shows on screen.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct Navigation {
    pub url: String,
    pub title: String,
    pub progress: f64,
    pub is_loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

#[uniffi::export]
pub fn initial_timing() -> ScriptTiming {
    ScriptTiming {
        loading: true,
        watched_url: None,
        progress: 0.0,
        hidden: false,
    }
}

/// Judges one navigation report: which scripts to run on the page, and the timing for the next.
#[uniffi::export]
pub fn scripts_for(timing: ScriptTiming, state: NavigationReport, has_rules: bool) -> ScriptPlan {
    let mut timing = timing;
    let mut watch_media = false;
    let mut hide_elements = false;

    if state.is_loading {
        // A new load, or progress starting over, is a new document; so is an address change once it commits.
        if !timing.loading || state.progress < timing.progress {
            timing.watched_url = None;
        }
        // Media can play before a page finishes loading (a media file streams for as long as it plays).
        if state.progress > 0.1 && timing.watched_url.as_deref() != Some(state.url.as_str()) {
            timing.watched_url = Some(state.url.clone());
            watch_media = true;
        }
        timing.progress = state.progress;
    } else if timing.loading {
        watch_media = true;
        hide_elements = should_hide(&mut timing, has_rules);
    }

    timing.loading = state.is_loading;
    ScriptPlan {
        timing,
        watch_media,
        hide_elements,
    }
}

/// Whether to run hide-elements now; skipped when there's nothing to apply or clear.
pub fn should_hide(timing: &mut ScriptTiming, has_rules: bool) -> bool {
    let run = has_rules || timing.hidden;
    if run {
        timing.hidden = has_rules;
    }
    run
}

/// Whether a report changes nothing the screen shows. Only the active tab's progress is drawn.
#[uniffi::export]
pub fn same_navigation(before: &Navigation, after: &Navigation, ignore_progress: bool) -> bool {
    before.url == after.url
        && before.title == after.title
        && before.is_loading == after.is_loading
        && before.can_go_back == after.can_go_back
        && before.can_go_forward == after.can_go_forward
        && (ignore_progress || before.progress == after.progress)
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "https://a.example/";
    const B: &str = "https://b.example/";

    fn ev(url: &str, progress: f64, is_loading: bool) -> NavigationReport {
        NavigationReport {
            url: url.into(),
            progress,
            is_loading,
        }
    }

    /// Feeds events and says which scripts each one ran: "m" media watcher, "h" hide elements.
    fn run(events: &[NavigationReport], has_rules: bool, timing: &mut ScriptTiming) -> Vec<String> {
        events
            .iter()
            .map(|event| {
                let plan = scripts_for(timing.clone(), event.clone(), has_rules);
                *timing = plan.timing;
                format!(
                    "{}{}",
                    if plan.watch_media { "m" } else { "" },
                    if plan.hide_elements { "h" } else { "" }
                )
            })
            .collect()
    }

    fn fresh(events: &[NavigationReport], has_rules: bool) -> Vec<String> {
        run(events, has_rules, &mut initial_timing())
    }

    #[test]
    fn a_load_runs_the_media_watcher_once_mid_load_and_once_when_it_finishes() {
        let events = [
            ev(A, 0.0, true),
            ev(A, 0.05, true),
            ev(A, 0.3, true),
            ev(A, 0.6, true),
            ev(A, 0.9, true),
            ev(A, 1.0, false),
            ev(A, 1.0, false),
        ];
        assert_eq!(fresh(&events, false), ["", "", "m", "", "", "m", ""]);
    }

    #[test]
    fn hide_rules_run_only_when_a_load_finishes_and_never_with_nothing_to_apply_or_clear() {
        let events = [ev(A, 0.5, true), ev(A, 1.0, false), ev(A, 1.0, false)];
        assert_eq!(fresh(&events, true), ["m", "mh", ""]);
        assert_eq!(fresh(&events[..2], false), ["m", "m"]);
    }

    #[test]
    fn the_first_settled_event_counts_as_a_finished_load() {
        assert_eq!(
            fresh(&[ev(A, 1.0, false), ev(A, 1.0, false)], true),
            ["mh", ""]
        );
    }

    #[test]
    fn the_watcher_reinstalls_when_the_new_document_commits_or_progress_starts_over() {
        // Android reports the old page's progress until the new one commits, then the new address.
        let navigation = [
            ev(A, 1.0, false),
            ev(B, 0.0, true),
            ev(A, 1.0, true),
            ev(B, 0.1, true),
            ev(B, 0.4, true),
            ev(B, 0.5, true),
            ev(B, 1.0, false),
        ];
        assert_eq!(fresh(&navigation, false), ["m", "", "m", "", "m", "", "m"]);
        // A reload keeps the address; its progress starting over marks the new document.
        let reload = [
            ev(A, 1.0, false),
            ev(A, 1.0, true),
            ev(A, 0.1, true),
            ev(A, 0.3, true),
            ev(A, 1.0, false),
        ];
        assert_eq!(fresh(&reload, false), ["m", "m", "", "m", "m"]);
    }

    #[test]
    fn a_history_change_without_a_load_runs_nothing() {
        let next = format!("{A}#next");
        assert_eq!(
            fresh(&[ev(A, 1.0, false), ev(&next, 1.0, false)], true),
            ["mh", ""]
        );
    }

    #[test]
    fn removing_every_rule_clears_them_once() {
        let mut timing = initial_timing();
        assert!(!should_hide(&mut timing, false));
        assert!(should_hide(&mut timing, true));
        assert!(should_hide(&mut timing, false));
        assert!(!should_hide(&mut timing, false));
        // A finished load after rules went away clears what an earlier document may still show.
        should_hide(&mut timing, true);
        let events = [
            ev(B, 0.5, true),
            ev(B, 1.0, false),
            ev(B, 0.5, true),
            ev(B, 1.0, false),
        ];
        assert_eq!(run(&events, false, &mut timing), ["m", "mh", "m", "m"]);
    }

    #[test]
    fn only_changes_the_screen_shows_count_as_a_new_navigation_state() {
        let before = Navigation {
            url: A.into(),
            title: "A".into(),
            progress: 0.3,
            is_loading: true,
            can_go_back: false,
            can_go_forward: false,
        };
        assert!(same_navigation(&before, &before.clone(), false));
        let progressed = Navigation {
            progress: 0.6,
            ..before.clone()
        };
        assert!(!same_navigation(&before, &progressed, false));
        assert!(same_navigation(&before, &progressed, true));
        for change in [
            Navigation {
                url: B.into(),
                ..before.clone()
            },
            Navigation {
                title: "B".into(),
                ..before.clone()
            },
            Navigation {
                is_loading: false,
                ..before.clone()
            },
            Navigation {
                can_go_back: true,
                ..before.clone()
            },
            Navigation {
                can_go_forward: true,
                ..before.clone()
            },
        ] {
            assert!(!same_navigation(&before, &change, true));
        }
    }
}
