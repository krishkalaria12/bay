//! Remote kill switches, one copy for every desktop: Bay's small signed feed (`https://baybrowser.in/switches.json`
//! and its `.sig`), which lets a release turn off a broken feature without shipping an update.
//!
//! The feed is JSON signed with Ed25519 over its exact bytes; the signature is base64. Only Bay's keys
//! ([`PUBLIC_KEYS`]) sign it, with the private key kept off the repository (`scripts/sign-switches.mjs`). A host fetches
//! the feed, keeps the last one it accepted, and asks [`check`] which switches apply to its platform and version. A
//! feed issued before the one it kept is refused, so an old copy can't turn a fixed feature back off or a switched one
//! back on.

pub mod ffi;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ed25519_dalek::{Signature, VerifyingKey};
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};

/// Bay's feed keys, raw Ed25519 public keys in base64. A new key goes in before the old one is retired.
pub const PUBLIC_KEYS: &[&str] = &["k5bcnQ1b2B1lf5w+HmTtIRJyYUJhZajsmDGEE0DnlOg="];

/// The platforms a switch can name: the desktop hosts' own names.
pub const PLATFORMS: &[&str] = &["macos", "windows", "linux"];

#[derive(Debug, Deserialize)]
struct Feed {
    /// Seconds since 1970 when the feed was signed; never lower than the last one's.
    issued: i64,
    #[serde(default)]
    switches: Vec<Switch>,
}

#[derive(Debug, Deserialize)]
struct Switch {
    id: String,
    /// The app's name for what turns off (apps/browser/src/lib/killSwitches.ts), like "webkit".
    feature: String,
    /// What Settings says, in a sentence.
    reason: String,
    /// The platforms it applies to; every platform when empty.
    #[serde(default)]
    platforms: Vec<String>,
    /// The releases it applies to, like ">=1.6.0, <1.6.4"; every release when absent. A nightly or other pre-release
    /// counts as its release (1.6.2-nightly.3 as 1.6.2), so it's switched off with it.
    #[serde(default)]
    versions: Option<String>,
    /// Seconds since 1970 after which it lapses, so a switch nobody retires doesn't stay on forever.
    #[serde(default)]
    until: Option<i64>,
}

/// A switch that applies here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Active {
    pub id: String,
    pub feature: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
}

/// What applies, from an accepted feed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Checked {
    pub issued: i64,
    pub switches: Vec<Active>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Not signed by one of Bay's keys, or the signature isn't base64 Ed25519.
    Signature,
    /// Signed, but not a feed.
    Format,
    /// Issued before the feed the host already has.
    Stale,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Refusal::Signature => "signature",
            Refusal::Format => "format",
            Refusal::Stale => "stale",
        }
    }
}

/// Whether `signature` (base64) is one of `keys` signing `feed`.
pub fn verify(feed: &[u8], signature: &str, keys: &[&str]) -> bool {
    let Ok(bytes) = STANDARD.decode(signature.trim()) else {
        return false;
    };

    let Ok(signature) = Signature::from_slice(&bytes) else {
        return false;
    };

    keys.iter().any(|key| {
        let Ok(raw) = STANDARD.decode(key) else {
            return false;
        };

        let Ok(raw) = <[u8; 32]>::try_from(raw.as_slice()) else {
            return false;
        };

        VerifyingKey::from_bytes(&raw).is_ok_and(|key| key.verify_strict(feed, &signature).is_ok())
    })
}

/// The release a version string names, without its pre-release or build: "1.6.2-nightly.3" is 1.6.2. A missing
/// part reads as 0 ("1.6" is 1.6.0).
fn release(version: &str) -> Option<Version> {
    let core = version
        .trim()
        .trim_start_matches('v')
        .split(['-', '+'])
        .next()?;
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    let major = parts.next()??;
    let minor = parts.next().unwrap_or(Some(0))?;
    let patch = parts.next().unwrap_or(Some(0))?;

    parts
        .next()
        .is_none()
        .then(|| Version::new(major, minor, patch))
}

fn applies(switch: &Switch, platform: &str, version: Option<&Version>, now: i64) -> bool {
    if switch.until.is_some_and(|until| until <= now) {
        return false;
    }

    if !switch.platforms.is_empty() && !switch.platforms.iter().any(|p| p == platform) {
        return false;
    }

    match &switch.versions {
        None => true,
        // A range this release can't be compared with, or a version that isn't one, applies: a switch is turned on to
        // stop harm, so a doubt leaves it on.
        Some(range) => match (VersionReq::parse(range), version) {
            (Ok(range), Some(version)) => range.matches(version),
            _ => true,
        },
    }
}

/// The switches in a signed feed that apply to `platform` and `version` at `now` (seconds since 1970), or why the
/// feed is refused. `last_issued` is the issue time of the feed the host kept, 0 for none.
pub fn check(
    feed: &[u8],
    signature: &str,
    platform: &str,
    version: &str,
    now: i64,
    last_issued: i64,
) -> Result<Checked, Refusal> {
    check_with(
        feed,
        signature,
        PUBLIC_KEYS,
        platform,
        version,
        now,
        last_issued,
    )
}

/// [`check`] with the keys given, for tests.
pub fn check_with(
    feed: &[u8],
    signature: &str,
    keys: &[&str],
    platform: &str,
    version: &str,
    now: i64,
    last_issued: i64,
) -> Result<Checked, Refusal> {
    if !verify(feed, signature, keys) {
        return Err(Refusal::Signature);
    }

    let parsed: Feed = serde_json::from_slice(feed).map_err(|_| Refusal::Format)?;

    if parsed.issued < last_issued {
        return Err(Refusal::Stale);
    }

    let version = release(version);
    let switches = parsed
        .switches
        .into_iter()
        .filter(|switch| applies(switch, platform, version.as_ref(), now))
        .map(|switch| Active {
            id: switch.id,
            feature: switch.feature,
            reason: switch.reason,
            until: switch.until,
        })
        .collect();

    Ok(Checked {
        issued: parsed.issued,
        switches,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[7; 32])
    }

    fn public(key: &SigningKey) -> String {
        STANDARD.encode(key.verifying_key().to_bytes())
    }

    fn sign(key: &SigningKey, feed: &str) -> String {
        STANDARD.encode(key.sign(feed.as_bytes()).to_bytes())
    }

    const FEED: &str = r#"{"issued": 1000, "switches": [
        {"id": "a", "feature": "webkit", "reason": "WebKit pages crash.", "platforms": ["macos"], "versions": ">=1.6.0, <1.6.4"},
        {"id": "b", "feature": "askPage", "reason": "Answers are wrong.", "until": 5000},
        {"id": "c", "feature": "sync", "reason": "Sync loses tabs.", "platforms": ["windows", "linux"]}
    ]}"#;

    fn run(platform: &str, version: &str, now: i64) -> Vec<String> {
        let key = key();
        let public = public(&key);
        let checked = check_with(
            FEED.as_bytes(),
            &sign(&key, FEED),
            &[&public],
            platform,
            version,
            now,
            0,
        )
        .unwrap();

        checked.switches.into_iter().map(|s| s.id).collect()
    }

    #[test]
    fn matches_platform_version_and_time() {
        assert_eq!(run("macos", "1.6.2", 100), ["a", "b"]);
        assert_eq!(run("macos", "1.6.4", 100), ["b"]);
        assert_eq!(run("macos", "1.5.9", 6000), Vec::<String>::new());
        assert_eq!(run("linux", "1.0.0", 100), ["b", "c"]);
    }

    #[test]
    fn a_nightly_counts_as_its_release() {
        assert_eq!(run("macos", "1.6.3-nightly.20261126", 100), ["a", "b"]);
        assert_eq!(run("macos", "v1.6", 100), ["a", "b"]);
    }

    #[test]
    fn an_unreadable_version_leaves_the_switch_on() {
        assert_eq!(run("macos", "dev", 100), ["a", "b"]);
    }

    #[test]
    fn refuses_other_keys_and_edits() {
        let key = key();
        let other = SigningKey::from_bytes(&[9; 32]);
        let public = public(&key);
        let edited = FEED.replace("1000", "1001");

        assert_eq!(
            check_with(
                FEED.as_bytes(),
                &sign(&other, FEED),
                &[&public],
                "macos",
                "1.6.2",
                0,
                0
            ),
            Err(Refusal::Signature)
        );
        assert_eq!(
            check_with(
                edited.as_bytes(),
                &sign(&key, FEED),
                &[&public],
                "macos",
                "1.6.2",
                0,
                0
            ),
            Err(Refusal::Signature)
        );
        assert_eq!(
            check_with(
                FEED.as_bytes(),
                "not base64!",
                &[&public],
                "macos",
                "1.6.2",
                0,
                0
            ),
            Err(Refusal::Signature)
        );
    }

    #[test]
    fn refuses_an_older_feed_and_a_signed_non_feed() {
        let key = key();
        let public = public(&key);

        assert_eq!(
            check_with(
                FEED.as_bytes(),
                &sign(&key, FEED),
                &[&public],
                "macos",
                "1.6.2",
                0,
                1001
            ),
            Err(Refusal::Stale)
        );
        assert_eq!(
            check_with(
                FEED.as_bytes(),
                &sign(&key, FEED),
                &[&public],
                "macos",
                "1.6.2",
                0,
                1000
            )
            .map(|c| c.issued),
            Ok(1000)
        );
        assert_eq!(
            check_with(b"[]", &sign(&key, "[]"), &[&public], "macos", "1.6.2", 0, 0),
            Err(Refusal::Format)
        );
    }

    #[test]
    fn the_shipped_feed_is_signed_by_bays_key() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../apps/web/public/");
        let feed = std::fs::read(format!("{root}switches.json")).unwrap();
        let signature = std::fs::read_to_string(format!("{root}switches.json.sig")).unwrap();

        assert!(check(&feed, &signature, "macos", "1.6.2", 0, 0).is_ok());
    }
}
