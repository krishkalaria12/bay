//! What went wrong (B8): a release build says nothing when it breaks, so Bay keeps its last few crashes on disk and
//! offers them from Settings › Report a problem, where they can be sent to whoever looks after the app. The apps record
//! a crash as it happens (Android's uncaught exceptions) or as the system reports it on the next launch (iOS's
//! MetricKit); this keeps them, newest first. The Expo app's `src/crashReports.ts`, which kept them in memory only.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

/// How many are kept.
const LIMIT: usize = 10;
const FILE: &str = "crash-reports.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct CrashReport {
    /// When it happened, in milliseconds since 1970.
    pub at: i64,
    /// What went wrong.
    pub message: String,
    /// Where it went wrong.
    pub stack: String,
}

/// The crashes kept in the app's documents directory.
#[derive(uniffi::Object)]
pub struct CrashLog {
    file: PathBuf,
    reports: Mutex<Vec<CrashReport>>,
}

#[uniffi::export]
impl CrashLog {
    #[uniffi::constructor]
    pub fn new(documents_dir: String) -> Arc<Self> {
        let file = Path::new(&documents_dir).join(FILE);
        let reports = fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Arc::new(Self {
            file,
            reports: Mutex::new(reports),
        })
    }

    /// Keeps a crash, written at once: the app may be about to end.
    pub fn record(&self, report: CrashReport) {
        let mut reports = self
            .reports
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reports.insert(0, report);
        reports.truncate(LIMIT);
        if let Ok(json) = serde_json::to_vec(&*reports) {
            let _ = fs::write(&self.file, json);
        }
    }

    /// The crashes kept, newest first.
    pub fn reports(&self) -> Vec<CrashReport> {
        self.reports
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Forgets them, once they've been sent.
    pub fn clear(&self) {
        self.reports
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        let _ = fs::remove_file(&self.file);
    }

    /// The crashes as text, ready to be sent, with the version that crashed; none when there are none.
    pub fn text(&self, version: String) -> Option<String> {
        let reports = self.reports();
        if reports.is_empty() {
            return None;
        }
        let body = reports
            .iter()
            .map(|report| {
                let at = chrono_free_iso(report.at);
                format!("--- {at}\n{}\n{}", report.message, report.stack)
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        Some(format!(
            "Bay {version} (core {})\n\n{body}",
            crate::version()
        ))
    }
}

/// An ISO 8601 UTC time from milliseconds since 1970, as JavaScript's `toISOString` writes it.
fn chrono_free_iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's days-from-civil, inverted.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_newest_ten_across_launches_and_writes_them_out() {
        let dir = std::env::temp_dir().join(format!("bay-crashes-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let log = CrashLog::new(dir.to_string_lossy().into());
        log.clear();
        assert_eq!(log.text("1.0".into()), None);
        for i in 0..12 {
            log.record(CrashReport {
                at: i,
                message: format!("m{i}"),
                stack: "s".into(),
            });
        }
        let again = CrashLog::new(dir.to_string_lossy().into());
        let reports = again.reports();
        assert_eq!(reports.len(), 10);
        assert_eq!(reports[0].message, "m11");
        let text = again.text("1.0".into()).unwrap();
        assert!(text.starts_with("Bay 1.0 (core "));
        assert!(text.contains("--- 1970-01-01T00:00:00.011Z\nm11\ns"));
        again.clear();
        assert!(
            CrashLog::new(dir.to_string_lossy().into())
                .reports()
                .is_empty()
        );
    }

    #[test]
    fn writes_times_as_iso() {
        assert_eq!(
            chrono_free_iso(1_795_000_000_123),
            "2026-11-18T11:06:40.123Z"
        );
    }
}
