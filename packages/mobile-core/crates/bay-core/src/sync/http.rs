//! The one thing the core asks the apps to do for sync and the link menu: send an HTTP request. iOS answers with URLSession and
//! Android with HttpURLConnection, so requests follow the phone's own certificates, proxies and VPN, and the core
//! carries no TLS stack of its own (plan D5).

use std::collections::HashMap;
use std::sync::Arc;

use serde::de::DeserializeOwned;

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub body: Option<Vec<u8>>,
    /// Follow redirects to the end (the phone's own rules); false answers with the first redirect itself.
    pub follow_redirects: bool,
    /// How long the request may take; none leaves the app's own limit.
    pub timeout_ms: Option<u32>,
}

impl HttpRequest {
    /// A request with no headers or body that follows redirects, within the app's own limit.
    pub fn new(method: &str, url: impl Into<String>) -> Self {
        Self {
            method: method.into(),
            url: url.into(),
            headers: HashMap::new(),
            body: None,
            follow_redirects: true,
            timeout_ms: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct HttpResponse {
    pub status: u16,
    /// Where the answer came from, after any redirects followed; empty when the app can't say.
    pub url: String,
    /// The answer's headers, names lowercased.
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    /// An answer with a status and body, from the address asked.
    pub fn new(status: u16, body: Vec<u8>) -> Self {
        Self {
            status,
            url: String::new(),
            headers: HashMap::new(),
            body,
        }
    }
}

/// The request got no answer: no network, a timeout, a refused connection.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum HttpError {
    #[error("No answer: {reason}")]
    Offline { reason: String },
}

impl From<uniffi::UnexpectedUniFFICallbackError> for HttpError {
    fn from(error: uniffi::UnexpectedUniFFICallbackError) -> Self {
        Self::Offline {
            reason: error.reason,
        }
    }
}

#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
pub trait HttpClient: Send + Sync {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError>;
}

/// Why a request to the relay failed: no answer (status 0), or an answer that says why.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum RelayError {
    #[error("The sync relay didn't answer")]
    Offline,
    #[error("The sync relay said {status} {code}")]
    Refused { status: u16, code: String },
}

impl RelayError {
    pub fn status(&self) -> u16 {
        match self {
            Self::Offline => 0,
            Self::Refused { status, .. } => *status,
        }
    }
}

/// The relay every Bay syncs through unless told otherwise.
pub const DEFAULT_RELAY: &str = "https://bay-sync.codewithkrish12.workers.dev";

/// A relay at an address, reached through the app's HTTP client.
#[derive(Clone)]
pub struct Relay {
    pub url: String,
    http: Arc<dyn HttpClient>,
}

#[derive(serde::Deserialize)]
struct ErrorBody {
    error: String,
}

impl Relay {
    pub fn new(url: impl Into<String>, http: Arc<dyn HttpClient>) -> Self {
        Self {
            url: url.into().trim_end_matches('/').to_owned(),
            http,
        }
    }

    /// A request's answer, whatever its status; `Offline` only when nothing answered.
    pub async fn send(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<Vec<u8>>,
    ) -> Result<HttpResponse, RelayError> {
        let request = HttpRequest {
            headers: headers
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                .collect(),
            body,
            ..HttpRequest::new(method, format!("{}{path}", self.url))
        };
        self.http
            .send(request)
            .await
            .map_err(|_| RelayError::Offline)
    }

    /// A refusal as the relay explains it.
    pub fn refusal(response: &HttpResponse) -> RelayError {
        let code = serde_json::from_slice::<ErrorBody>(&response.body)
            .map_or_else(|_| "unknown".into(), |body| body.error);
        RelayError::Refused {
            status: response.status,
            code,
        }
    }

    /// An answer read as `T`; a refusal as a `RelayError`.
    pub async fn json<T: DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<Vec<u8>>,
    ) -> Result<T, RelayError> {
        let response = self.send(method, path, headers, body).await?;
        if !(200..300).contains(&response.status) {
            return Err(Self::refusal(&response));
        }
        serde_json::from_slice(&response.body).map_err(|_| RelayError::Refused {
            status: response.status,
            code: "unreadable".into(),
        })
    }

    /// An answer that carries nothing back.
    pub async fn empty(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<Vec<u8>>,
    ) -> Result<(), RelayError> {
        let response = self.send(method, path, headers, body).await?;
        if (200..300).contains(&response.status) {
            Ok(())
        } else {
            Err(Self::refusal(&response))
        }
    }
}
