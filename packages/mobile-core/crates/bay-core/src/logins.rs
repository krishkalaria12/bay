//! Saved logins (B20): what a server's HTTP sign-in asks for, kept per site in the device's keychain or keystore so the
//! next challenge from that site is answered without asking. One JSON document under one secret; credentials never join
//! the browser's data, history or anything written to disk in the clear. Private tabs never read or write here.

use std::sync::{Arc, Mutex};

use crate::browser::{SavedLogin, format_saved_logins, origin_of, parse_saved_logins};
use crate::settings::LoginSummary;
use crate::sync::service::SecretStore;

const KEY: &str = "bay-saved-logins";

/// The saved logins, in the secret store the apps give.
#[derive(uniffi::Object)]
pub struct SavedLogins {
    secrets: Arc<dyn SecretStore>,
    /// One change at a time: each reads the whole document, edits it and writes it back.
    writing: Mutex<()>,
}

impl SavedLogins {
    fn read(&self) -> Vec<SavedLogin> {
        parse_saved_logins(self.secrets.read(KEY.into()))
    }

    fn change(&self, edit: impl FnOnce(&mut Vec<SavedLogin>)) {
        let _turn = self
            .writing
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut logins = self.read();
        edit(&mut logins);
        if logins.is_empty() {
            self.secrets.delete(KEY.into());
        } else {
            self.secrets.write(KEY.into(), format_saved_logins(logins));
        }
    }
}

#[uniffi::export]
impl SavedLogins {
    #[uniffi::constructor]
    pub fn new(secrets: Arc<dyn SecretStore>) -> Arc<Self> {
        Arc::new(Self {
            secrets,
            writing: Mutex::new(()),
        })
    }

    /// Every saved login, oldest first.
    pub fn list(&self) -> Vec<SavedLogin> {
        self.read()
    }

    /// What Settings › Passwords lists: each login's site and username, never its password.
    pub fn summaries(&self) -> Vec<LoginSummary> {
        self.read()
            .into_iter()
            .map(|login| LoginSummary {
                origin: login.origin,
                username: login.username,
            })
            .collect()
    }

    /// The login to answer `url`'s sign-in with: the newest saved for its origin.
    pub fn find(&self, url: String) -> Option<SavedLogin> {
        let origin = origin_of(url.trim())?;
        self.read()
            .into_iter()
            .rev()
            .find(|login| login.origin == origin)
    }

    /// Saves the login typed into `url`'s sign-in, replacing one with the same site and username. False for an address
    /// that isn't a web page, or an empty username or password.
    pub fn save(&self, url: String, username: String, password: String, now: i64) -> bool {
        let Some(origin) = origin_of(url.trim()) else {
            return false;
        };
        if username.is_empty() || password.is_empty() {
            return false;
        }
        self.change(|logins| {
            logins.retain(|login| !(login.origin == origin && login.username == username));
            logins.push(SavedLogin {
                origin,
                username,
                password,
                saved_at: now as f64,
            });
        });
        true
    }

    /// Forgets one saved login.
    pub fn forget(&self, origin: String, username: String) {
        self.change(|logins| {
            logins.retain(|login| !(login.origin == origin && login.username == username));
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Secrets(Mutex<HashMap<String, String>>);

    impl SecretStore for Secrets {
        fn read(&self, key: String) -> Option<String> {
            self.0.lock().unwrap().get(&key).cloned()
        }
        fn write(&self, key: String, value: String) {
            self.0.lock().unwrap().insert(key, value);
        }
        fn delete(&self, key: String) {
            self.0.lock().unwrap().remove(&key);
        }
    }

    #[test]
    fn a_save_replaces_the_same_user_and_the_newest_answers() {
        let secrets = Arc::new(Secrets::default());
        let logins = SavedLogins::new(secrets.clone());
        assert!(logins.find("https://a.example/".into()).is_none());
        assert!(logins.save("https://a.example/one".into(), "ann".into(), "1".into(), 1));
        assert!(logins.save("https://a.example/two".into(), "bob".into(), "2".into(), 2));
        assert!(logins.save("https://a.example/".into(), "ann".into(), "3".into(), 3));
        assert!(!logins.save("about:blank".into(), "ann".into(), "x".into(), 4));
        assert!(!logins.save("https://b.example/".into(), "ann".into(), String::new(), 4));
        let found = logins.find("https://a.example/deep".into()).unwrap();
        assert_eq!(
            (found.username.as_str(), found.password.as_str()),
            ("ann", "3")
        );
        assert_eq!(logins.list().len(), 2);
        assert!(logins.find("http://a.example/".into()).is_none());

        logins.forget("https://a.example".into(), "ann".into());
        logins.forget("https://a.example".into(), "bob".into());
        assert!(logins.summaries().is_empty());
        assert!(secrets.read(KEY.into()).is_none());
    }
}
