//! Pairing a new device with one already syncing, by a code. The new device shows eight characters and waits under
//! them with a one-time X25519 key; you type them on the device that syncs, which finds the key, and both show four
//! digits worked out from the code and the key. Once you say they match, it seals the chain's key to the new device's
//! key and leaves the envelope in the box. A port of `packages/sync/src/relay/pairing.ts`.
//!
//! The relay never sees the code: it's stretched by PBKDF2, and HKDF of that names the box, tags the waiting key (so a
//! relay that swaps in a key of its own fails the tag) and salts the envelope's key.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use super::bytes::{base64, from_base64};
use super::http::{Relay, RelayError};
use super::keys::{NONCE, hkdf32, hmac_sha256, open_gcm, random_bytes, seal_gcm};

/// The code's letters: no 0, O, 1 or I, which read alike.
const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

pub const CODE_LENGTH: usize = 8;

/// Rounds of PBKDF2: enough that trying every code within a box's ten minutes is out of reach, quick on a phone.
const ROUNDS: u32 = 20_000;

const KEY: usize = 32;
const TAG: usize = 32;
const JOIN: &[u8] = b"bay sync join v1";

/// A code as typed: its letters and digits, uppercase, without the dash or spaces.
pub fn normalize_code(text: &str) -> String {
    text.to_uppercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect()
}

/// Whether a typed code has all its characters, from the code's own letters.
pub fn is_code(code: &str) -> bool {
    code.len() == CODE_LENGTH && code.bytes().all(|byte| ALPHABET.contains(&byte))
}

/// A code to show: ABCD-EFGH.
pub fn format_code(code: &str) -> String {
    if code.len() == CODE_LENGTH {
        format!("{}-{}", &code[..4], &code[4..])
    } else {
        code.to_owned()
    }
}

fn new_code() -> String {
    random_bytes::<CODE_LENGTH>()
        .iter()
        .map(|byte| ALPHABET[usize::from(*byte) % ALPHABET.len()] as char)
        .collect()
}

/// What a code stretches to: the box's name, the key that tags the waiting key, the envelope's salt.
struct Stretched {
    box_name: String,
    tag_key: Zeroizing<[u8; 32]>,
    join_salt: Zeroizing<[u8; 32]>,
}

fn stretch(code: &str) -> Stretched {
    let mut seed = Zeroizing::new([0u8; KEY]);
    pbkdf2::pbkdf2_hmac::<Sha256>(code.as_bytes(), b"bay sync pairing v1", ROUNDS, &mut *seed);
    Stretched {
        box_name: hex::encode(hkdf32(&*seed, None, b"box")),
        tag_key: Zeroizing::new(hkdf32(&*seed, None, b"pub-tag")),
        join_salt: Zeroizing::new(hkdf32(&*seed, None, b"join")),
    }
}

/// The four digits both screens show: from the code and the waiting key, so a swapped key shows others.
pub fn check_digits(code: &str, public: &[u8]) -> String {
    let digest = Sha256::digest([b"bay sync check v1", code.as_bytes(), public].concat());
    let number = u32::from_be_bytes(
        digest[..4]
            .try_into()
            .expect("a SHA-256 digest has four bytes"),
    ) % 10_000;
    format!("{number:04}")
}

fn pub_tag(tag_key: &[u8; 32], public: &[u8]) -> [u8; 32] {
    hmac_sha256(tag_key, &[b"bay sync pub v1", public].concat())
}

fn join_key(shared: &[u8], salt: &[u8; 32], sender: &[u8], receiver: &[u8]) -> Zeroizing<[u8; 32]> {
    Zeroizing::new(hkdf32(
        shared,
        Some(salt),
        &[JOIN, sender, receiver].concat(),
    ))
}

#[derive(Serialize)]
struct Wait<'a> {
    #[serde(rename = "box")]
    box_name: &'a str,
    #[serde(rename = "pub")]
    public: String,
}

#[derive(Deserialize)]
struct BoxBody {
    #[serde(rename = "pub")]
    public: String,
    envelope: Option<String>,
}

#[derive(Serialize)]
struct Envelope {
    envelope: String,
}

const JSON: (&str, &str) = ("content-type", "application/json");

/// What a waiting device finds when it looks in its box.
#[derive(Debug, PartialEq, Eq)]
pub enum Poll {
    /// The other device hasn't let this one in yet.
    Waiting,
    /// The box ran out (ten minutes) or was never there.
    Expired,
    /// The chain's key.
    Joined(Zeroizing<[u8; 32]>),
}

/// The new device's side: wait under a code for the chain's key.
pub struct Waiting {
    pub code: String,
    pub digits: String,
    secret: StaticSecret,
    public: PublicKey,
    stretched: Stretched,
    relay: Relay,
}

impl Waiting {
    /// A waiting device with a known code and key, to read a vector the TypeScript side made.
    #[cfg(test)]
    pub(crate) fn from_parts(code: &str, secret: [u8; KEY], relay: Relay) -> Self {
        let secret = StaticSecret::from(secret);
        let public = PublicKey::from(&secret);
        Self {
            code: code.into(),
            digits: check_digits(code, public.as_bytes()),
            secret,
            public,
            stretched: stretch(code),
            relay,
        }
    }

    /// Posts a fresh code's waiting key; a code someone else holds already is tried again with another.
    pub async fn start(relay: Relay) -> Result<Self, RelayError> {
        let mut attempt = 0;
        loop {
            let code = new_code();
            let secret = StaticSecret::from(random_bytes::<KEY>());
            let public = PublicKey::from(&secret);
            let stretched = stretch(&code);
            let tag = pub_tag(&stretched.tag_key, public.as_bytes());
            let body = serde_json::to_vec(&Wait {
                box_name: &stretched.box_name,
                public: base64(&[public.as_bytes(), &tag[..]].concat()),
            })
            .expect("the wait request serializes");
            let response = relay.send("POST", "/v1/pair", &[JSON], Some(body)).await?;
            if (200..300).contains(&response.status) {
                let digits = check_digits(&code, public.as_bytes());
                return Ok(Self {
                    code,
                    digits,
                    secret,
                    public,
                    stretched,
                    relay,
                });
            }
            if response.status != 409 || attempt >= 2 {
                return Err(Relay::refusal(&response));
            }
            attempt += 1;
        }
    }

    /// The chain's key, once the other device has sealed it here.
    pub async fn poll(&self) -> Result<Poll, RelayError> {
        let response = self
            .relay
            .send(
                "GET",
                &format!("/v1/pair/{}", self.stretched.box_name),
                &[],
                None,
            )
            .await?;
        if response.status == 404 {
            return Ok(Poll::Expired);
        }
        if !(200..300).contains(&response.status) {
            return Err(Relay::refusal(&response));
        }
        let unreadable = || RelayError::Refused {
            status: response.status,
            code: "envelope".into(),
        };
        let body: BoxBody = serde_json::from_slice(&response.body).map_err(|_| unreadable())?;
        let Some(envelope) = body.envelope else {
            return Ok(Poll::Waiting);
        };
        let envelope = from_base64(&envelope)
            .filter(|bytes| bytes.len() > KEY + NONCE)
            .ok_or_else(unreadable)?;
        let theirs: [u8; KEY] = envelope[..KEY].try_into().map_err(|_| unreadable())?;
        let shared = self.secret.diffie_hellman(&PublicKey::from(theirs));
        let key = join_key(
            shared.as_bytes(),
            &self.stretched.join_salt,
            &theirs,
            self.public.as_bytes(),
        );
        let entropy = open_gcm(
            &key,
            &envelope[KEY..KEY + NONCE],
            JOIN,
            &envelope[KEY + NONCE..],
        )
        .ok_or_else(unreadable)?;
        let entropy: [u8; KEY] = entropy.try_into().map_err(|_| unreadable())?;
        Ok(Poll::Joined(Zeroizing::new(entropy)))
    }
}

/// Why a typed code found no device to let in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FindProblem {
    /// No one waits under it: mistyped, or it ran out.
    NotFound,
    /// The key there wasn't tagged with the code: posted by someone who doesn't know it.
    NotVerified,
    /// Another device let it in already.
    Taken,
}

/// The syncing device's side: a typed code's waiting device, its digits, and letting it in.
pub struct Joining {
    pub digits: String,
    public: PublicKey,
    stretched: Stretched,
    relay: Relay,
}

impl Joining {
    pub async fn find(code: &str, relay: Relay) -> Result<Result<Self, FindProblem>, RelayError> {
        let stretched = stretch(code);
        let response = relay
            .send(
                "GET",
                &format!("/v1/pair/{}", stretched.box_name),
                &[],
                None,
            )
            .await?;
        if response.status == 404 {
            return Ok(Err(FindProblem::NotFound));
        }
        if !(200..300).contains(&response.status) {
            return Err(Relay::refusal(&response));
        }
        let Ok(body) = serde_json::from_slice::<BoxBody>(&response.body) else {
            return Ok(Err(FindProblem::NotVerified));
        };
        if body.envelope.is_some() {
            return Ok(Err(FindProblem::Taken));
        }
        let Some(posted) = from_base64(&body.public).filter(|posted| posted.len() == KEY + TAG)
        else {
            return Ok(Err(FindProblem::NotVerified));
        };
        let (public, tag) = posted.split_at(KEY);
        if !bool::from(tag.ct_eq(&pub_tag(&stretched.tag_key, public))) {
            return Ok(Err(FindProblem::NotVerified));
        }
        let public: [u8; KEY] = public.try_into().expect("split at the key's length");
        Ok(Ok(Self {
            digits: check_digits(code, &public),
            public: PublicKey::from(public),
            stretched,
            relay,
        }))
    }

    /// Seals the chain's key to the waiting device. Only once the person has said the digits match.
    pub async fn let_in(&self, entropy: &[u8; 32]) -> Result<(), RelayError> {
        let secret = StaticSecret::from(random_bytes::<KEY>());
        let mine = PublicKey::from(&secret);
        let nonce = random_bytes::<NONCE>();
        let key = join_key(
            secret.diffie_hellman(&self.public).as_bytes(),
            &self.stretched.join_salt,
            mine.as_bytes(),
            self.public.as_bytes(),
        );
        let sealed = seal_gcm(&key, &nonce, JOIN, entropy);
        let body = serde_json::to_vec(&Envelope {
            envelope: base64(&[mine.as_bytes(), &nonce[..], &sealed].concat()),
        })
        .expect("the envelope serializes");
        self.relay
            .empty(
                "PUT",
                &format!("/v1/pair/{}", self.stretched.box_name),
                &[JSON],
                Some(body),
            )
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::stand_in::StandInRelay;
    use std::sync::Arc;

    fn vector() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../../fixtures/pairing.json")).unwrap()
    }

    #[test]
    fn codes_read_as_typed() {
        assert_eq!(normalize_code("abcd-2345 "), "ABCD2345");
        assert!(is_code("ABCD2345"));
        assert!(!is_code("ABCD2340"), "0 isn't one of the code's characters");
        assert_eq!(format_code("ABCD2345"), "ABCD-2345");
        assert!(is_code(&new_code()));
    }

    #[test]
    fn a_typescript_pairing_reads_the_same_here() {
        let vector = vector();
        let code = vector["code"].as_str().unwrap();
        assert_eq!(stretch(code).box_name, vector["box"]);

        // The TypeScript side's posted key verifies here and shows the same digits.
        let relay = Arc::new(StandInRelay::default());
        relay.boxes.lock().unwrap().insert(
            vector["box"].as_str().unwrap().into(),
            (vector["posted"].as_str().unwrap().into(), None),
        );
        let joining = pollster::block_on(Joining::find(code, relay.relay()))
            .unwrap()
            .unwrap();
        assert_eq!(joining.digits, vector["digits"]);

        // Its envelope opens with the waiting key to the chain key it sealed.
        let secret: [u8; KEY] = hex::decode(vector["waitingSecret"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let waiting = Waiting::from_parts(code, secret, relay.relay());
        assert_eq!(waiting.digits, vector["digits"]);
        relay
            .boxes
            .lock()
            .unwrap()
            .get_mut(vector["box"].as_str().unwrap())
            .unwrap()
            .1 = Some(vector["envelope"].as_str().unwrap().into());
        let Poll::Joined(entropy) = pollster::block_on(waiting.poll()).unwrap() else {
            panic!("the envelope didn't open")
        };
        assert_eq!(hex::encode(*entropy), vector["entropy"]);
    }

    #[test]
    fn two_devices_pair_through_the_relay() {
        let relay = Arc::new(StandInRelay::default());
        let waiting = pollster::block_on(Waiting::start(relay.relay())).unwrap();
        assert_eq!(pollster::block_on(waiting.poll()).unwrap(), Poll::Waiting);
        let joining = pollster::block_on(Joining::find(&waiting.code, relay.relay()))
            .unwrap()
            .unwrap();
        assert_eq!(joining.digits, waiting.digits);
        let entropy = [9u8; 32];
        pollster::block_on(joining.let_in(&entropy)).unwrap();
        assert_eq!(
            pollster::block_on(waiting.poll()).unwrap(),
            Poll::Joined(Zeroizing::new(entropy))
        );
        assert_eq!(
            pollster::block_on(Joining::find(&waiting.code, relay.relay()))
                .unwrap()
                .err(),
            Some(FindProblem::Taken)
        );
        assert_eq!(
            pollster::block_on(Joining::find("ZZZZ2222", relay.relay()))
                .unwrap()
                .err(),
            Some(FindProblem::NotFound)
        );
    }

    #[test]
    fn a_key_posted_without_the_code_is_refused() {
        let relay = Arc::new(StandInRelay::default());
        let stretched = stretch("ABCD2345");
        let forged = base64(&[[1u8; 32], [2u8; 32]].concat());
        relay
            .boxes
            .lock()
            .unwrap()
            .insert(stretched.box_name, (forged, None));
        assert_eq!(
            pollster::block_on(Joining::find("ABCD2345", relay.relay()))
                .unwrap()
                .err(),
            Some(FindProblem::NotVerified)
        );
    }
}
