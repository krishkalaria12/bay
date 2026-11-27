//! Where a link really goes: its redirects followed without opening it, for the link menu. Dropping the answer (the
//! menu closing) drops the request with it; the whole answer has ten seconds.

use std::sync::Arc;
use std::time::Instant;

use url::Url;

use crate::sync::http::{HttpClient, HttpRequest};

/// How long the whole answer may take, in milliseconds.
pub const RESOLVE_TIMEOUT_MS: u64 = 10_000;

/// Browsers give up after about 20; a link menu needs far fewer to say where a link goes.
pub const MAX_REDIRECTS: usize = 10;

/// The address a link's redirects end at, or none when the link can't be reached.
#[uniffi::export]
pub async fn resolve_link(http: Arc<dyn HttpClient>, url: String) -> Option<String> {
    let started = Instant::now();
    resolve_with(http.as_ref(), &url, &|| {
        started.elapsed().as_millis() as u64
    })
    .await
}

/// [`resolve_link`] with its own clock, in milliseconds since the start, so tests can move time.
pub async fn resolve_with(
    http: &dyn HttpClient,
    url: &str,
    elapsed: &(dyn Fn() -> u64 + Sync),
) -> Option<String> {
    let remaining = || RESOLVE_TIMEOUT_MS.saturating_sub(elapsed());
    let probe = |url: &str, method: &str, follow: bool| HttpRequest {
        follow_redirects: follow,
        timeout_ms: Some(remaining() as u32),
        ..HttpRequest::new(method, url)
    };
    let ended = |answer: String| {
        Some(if answer.is_empty() {
            url.to_owned()
        } else {
            answer
        })
    };

    // Follows the redirects in one request. A server that refuses HEAD is asked with GET.
    if let Ok(response) = http.send(probe(url, "HEAD", true)).await {
        if response.status != 405 && response.status != 501 {
            return ended(response.url);
        }
        if let Ok(retried) = http.send(probe(url, "GET", true)).await {
            return ended(retried.url);
        }
    }

    // iOS's App Transport Security refuses a plain-http hop, and the whole request fails with it. Walk the redirects
    // one at a time instead; a walk that runs out of time says how far it got.
    let mut current = url.to_owned();
    let mut reached: Option<String> = None;
    for hop in 0..MAX_REDIRECTS {
        if remaining() == 0 {
            return reached;
        }
        let Ok(answer) = http.send(probe(&current, "HEAD", false)).await else {
            // The hop that can't be loaded is where the link goes.
            return (hop > 0).then_some(current);
        };
        if remaining() == 0 {
            return reached;
        }
        let location = (300..400)
            .contains(&answer.status)
            .then(|| answer.headers.get("location"))
            .flatten();
        let Some(location) = location else {
            return Some(current);
        };
        // A relative Location resolves against the hop that sent it; one that isn't an address ends the walk here.
        let Some(next) = Url::parse(&current)
            .ok()
            .and_then(|base| base.join(location).ok())
        else {
            return Some(current);
        };
        current = next.into();
        reached = Some(current.clone());
    }
    Some(current)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::sync::http::{HttpError, HttpResponse};

    type Answer = Box<dyn Fn(&HttpRequest) -> Result<HttpResponse, HttpError> + Send + Sync>;

    /// A network that answers with `answer`, records what was asked, and moves the clock by `cost` per request.
    struct Scripted {
        answer: Answer,
        requests: Mutex<Vec<HttpRequest>>,
        clock: AtomicU64,
        cost: u64,
    }

    impl Scripted {
        fn new(
            answer: impl Fn(&HttpRequest) -> Result<HttpResponse, HttpError> + Send + Sync + 'static,
        ) -> Self {
            Self {
                answer: Box::new(answer),
                requests: Mutex::new(Vec::new()),
                clock: AtomicU64::new(0),
                cost: 0,
            }
        }

        fn resolve(&self, url: &str) -> Option<String> {
            pollster::block_on(resolve_with(self, url, &|| {
                self.clock.load(Ordering::SeqCst)
            }))
        }
    }

    #[async_trait::async_trait]
    impl HttpClient for Scripted {
        async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
            self.requests.lock().unwrap().push(request.clone());
            self.clock.fetch_add(self.cost, Ordering::SeqCst);
            (self.answer)(&request)
        }
    }

    fn answer(status: u16, url: &str, location: Option<&str>) -> Result<HttpResponse, HttpError> {
        Ok(HttpResponse {
            url: url.into(),
            headers: location
                .map(|location| HashMap::from([("location".to_owned(), location.to_owned())]))
                .unwrap_or_default(),
            ..HttpResponse::new(status, Vec::new())
        })
    }

    fn refused(reason: &str) -> Result<HttpResponse, HttpError> {
        Err(HttpError::Offline {
            reason: reason.into(),
        })
    }

    #[test]
    fn a_link_that_follows_in_one_request_answers_with_where_it_ended() {
        let http = Scripted::new(|request| {
            let url = if request.url == "https://short.example/abc" {
                "https://long.example/page"
            } else {
                &request.url
            };
            answer(200, url, None)
        });
        assert_eq!(
            http.resolve("https://short.example/abc").as_deref(),
            Some("https://long.example/page")
        );
        // An app that can't say where it ended answers with the link itself.
        let blind = Scripted::new(|_| answer(200, "", None));
        assert_eq!(
            blind.resolve("https://short.example/abc").as_deref(),
            Some("https://short.example/abc")
        );
    }

    #[test]
    fn a_server_that_refuses_head_is_asked_again_with_get() {
        let http = Scripted::new(|request| {
            if request.method == "HEAD" {
                answer(405, &request.url, None)
            } else {
                answer(200, "https://long.example/page", None)
            }
        });
        assert_eq!(
            http.resolve("https://short.example/abc").as_deref(),
            Some("https://long.example/page")
        );
        let methods: Vec<String> = http
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.method.clone())
            .collect();
        assert_eq!(methods, ["HEAD", "GET"]);
    }

    #[test]
    fn when_the_followed_request_fails_the_walk_goes_hop_by_hop_and_stops_at_ten() {
        // Every hop redirects to the next one, for ever; following them in one request fails as App Transport Security does.
        let http = Scripted::new(|request| {
            if request.follow_redirects {
                return refused("App Transport Security refused a plain-http hop");
            }
            let hop: u32 = Url::parse(&request.url)
                .unwrap()
                .query_pairs()
                .find(|(name, _)| name == "hop")
                .map_or(0, |(_, value)| value.parse().unwrap());
            answer(302, &request.url, Some(&format!("/next?hop={}", hop + 1)))
        });
        assert_eq!(
            http.resolve("https://loop.example/start"),
            Some(format!("https://loop.example/next?hop={MAX_REDIRECTS}"))
        );
        let walked = http
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| !r.follow_redirects)
            .count();
        assert_eq!(walked, MAX_REDIRECTS, "the walk asks ten times and no more");
    }

    #[test]
    fn the_hop_that_cant_be_loaded_is_where_the_link_goes_and_a_link_that_cant_be_reached_has_no_answer()
     {
        let http = Scripted::new(|request| {
            if !request.follow_redirects && request.url == "https://short.example/abc" {
                return answer(301, &request.url, Some("http://plain.example/page"));
            }
            refused("refused")
        });
        assert_eq!(
            http.resolve("https://short.example/abc").as_deref(),
            Some("http://plain.example/page")
        );
        assert_eq!(http.resolve("https://down.example/"), None);
    }

    #[test]
    fn a_link_that_doesnt_answer_in_ten_seconds_has_no_answer_or_says_how_far_it_got() {
        // Each request takes the whole budget and then fails.
        let slow = Scripted {
            cost: RESOLVE_TIMEOUT_MS,
            ..Scripted::new(|_| refused("timed out"))
        };
        assert_eq!(slow.resolve("https://slow.example/"), None);
        assert!(
            slow.requests
                .lock()
                .unwrap()
                .iter()
                .all(|r| r.timeout_ms.is_some())
        );

        // A walk that passes two hops before time runs out says the second.
        let walking = Scripted {
            cost: 3_000,
            ..Scripted::new(|request| {
                if request.follow_redirects {
                    return refused("refused");
                }
                let next = format!("{}x", request.url);
                answer(302, &request.url, Some(&next))
            })
        };
        assert_eq!(
            walking.resolve("https://walk.example/").as_deref(),
            Some("https://walk.example/xx")
        );
    }
}
