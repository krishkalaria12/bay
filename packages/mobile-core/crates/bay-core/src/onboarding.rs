//! The first run's way through, without the screen: which page comes after which, what the dots count, and the
//! demonstrations' numbers. The Expo app's `src/onboarding/flow.ts` (ported from Yab's first run, Apache-2.0), with
//! `tests/firstRun.test.ts` below.

use serde::{Deserialize, Serialize};

use crate::settings::DefaultBrowser;

/// A page of the first run. `End` is the moment the glass becomes the real field and the welcome goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum WelcomeStep {
    Welcome,
    Desktop,
    Field,
    Private,
    Links,
    End,
}

pub const STEPS: [WelcomeStep; 6] = [
    WelcomeStep::Welcome,
    WelcomeStep::Desktop,
    WelcomeStep::Field,
    WelcomeStep::Private,
    WelcomeStep::Links,
    WelcomeStep::End,
];

/// Where the main button goes from a page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum WelcomeForward {
    To {
        step: WelcomeStep,
    },
    /// It ends the welcome.
    Finish,
}

/// The pages the dots count: the welcome, the desktop, the field, private and, while Bay may ask to be it, links.
#[uniffi::export]
pub fn welcome_page_count(asks_links: bool) -> u32 {
    if asks_links { 5 } else { 4 }
}

/// The dot of the page on screen.
#[uniffi::export]
pub fn welcome_page_of(step: WelcomeStep, asks_links: bool) -> u32 {
    match step {
        WelcomeStep::Welcome => 0,
        WelcomeStep::Desktop => 1,
        WelcomeStep::Field => 2,
        WelcomeStep::Private => 3,
        WelcomeStep::Links | WelcomeStep::End => 4.min(welcome_page_count(asks_links) - 1),
    }
}

/// The page the main button goes on to. Links ends the welcome with its own question.
#[uniffi::export]
pub fn welcome_forward(step: WelcomeStep, asks_links: bool) -> WelcomeForward {
    let to = |step| WelcomeForward::To { step };
    match step {
        WelcomeStep::Welcome => to(WelcomeStep::Desktop),
        WelcomeStep::Desktop => to(WelcomeStep::Field),
        WelcomeStep::Field => to(WelcomeStep::Private),
        WelcomeStep::Private if asks_links => to(WelcomeStep::Links),
        WelcomeStep::Private | WelcomeStep::Links | WelcomeStep::End => WelcomeForward::Finish,
    }
}

/// The page ‹ goes back to, or none where there's no going back.
#[uniffi::export]
pub fn welcome_back(step: WelcomeStep) -> Option<WelcomeStep> {
    match step {
        WelcomeStep::Welcome | WelcomeStep::End => None,
        WelcomeStep::Desktop => Some(WelcomeStep::Welcome),
        WelcomeStep::Field => Some(WelcomeStep::Desktop),
        WelcomeStep::Private => Some(WelcomeStep::Field),
        WelcomeStep::Links => Some(WelcomeStep::Private),
    }
}

/// Skip opens the real field, unless the person is already past it: from the private page or the links page, it just
/// shows the browser underneath.
#[uniffi::export]
pub fn skip_opens_field(step: WelcomeStep) -> bool {
    !matches!(step, WelcomeStep::Private | WelcomeStep::Links)
}

/// Whether Bay asks to be the default browser: only where it can be, and isn't yet.
#[uniffi::export]
pub fn asks_about_links(status: DefaultBrowser) -> bool {
    matches!(status, DefaultBrowser::Not | DefaultBrowser::Unknown)
}

/// One of the field page's three ways.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum WelcomeWay {
    Search,
    GoToSite,
    YourTabs,
}

/// What the field types and the way it lands in, as string keys: the typed words, and for Your tabs the open tab it
/// finds. The words are the reader's language, so they live with the other strings.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct WelcomePhrase {
    pub typed: String,
    pub way: WelcomeWay,
    pub landed: String,
}

/// A link from another app on the links page: where it goes, the tab it becomes, and its page's colours.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct WelcomeLink {
    pub host: String,
    pub title: String,
    /// The app it comes from: "messages" or "mail".
    pub from: String,
    pub colors: Vec<String>,
}

/// A spring as SwiftUI writes it: how long it takes to settle and how much it bounces.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct WelcomeSpring {
    pub response: f64,
    pub damping_ratio: f64,
}

/// A spring as a physical system (Compose and Reanimated take it this way).
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct SpringPhysics {
    pub stiffness: f64,
    pub damping: f64,
    pub mass: f64,
}

/// A rect on the stage.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct StageRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub radius: f64,
}

/// The welcome's motion: the prototype's numbers.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct WelcomeMotion {
    /// The glass from one page's shape into the next.
    pub morph: WelcomeSpring,
    /// A typed phrase into its way.
    pub land: WelcomeSpring,
    /// The dots, and the keyboard lifting the words.
    pub dots: WelcomeSpring,
    /// A link growing into the tab in front.
    pub link: WelcomeSpring,
    /// Private's chips springing in.
    pub chips: WelcomeSpring,
}

/// Everything the welcome draws that isn't words: the phrases, links, drifting sites, motion and the stage.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct WelcomeContent {
    pub phrases: Vec<WelcomePhrase>,
    pub links: Vec<WelcomeLink>,
    pub drift_sites: Vec<String>,
    pub motion: WelcomeMotion,
    /// The drawing above the words, in its own units: 402 wide, as the prototype draws it, scaled to the screen.
    pub stage_width: f64,
    pub stage_height: f64,
    /// Where the name's letters sit: the next page's glass grows out of them.
    pub letters: StageRect,
}

pub const STAGE_WIDTH: f64 = 402.0;
pub const STAGE_HEIGHT: f64 = 560.0;

const LETTERS: StageRect = StageRect {
    x: 34.0,
    y: 122.0,
    width: 334.0,
    height: 137.0,
    radius: 40.0,
};

const fn spring(response: f64, damping_ratio: f64) -> WelcomeSpring {
    WelcomeSpring {
        response,
        damping_ratio,
    }
}

#[uniffi::export]
pub fn welcome_content() -> WelcomeContent {
    let phrase = |typed: &str, way, landed: &str| WelcomePhrase {
        typed: format!("welcome.phrase.{typed}"),
        way,
        landed: format!("welcome.phrase.{landed}"),
    };
    let link = |host: &str, title: &str, from: &str, colors: &[&str]| WelcomeLink {
        host: host.into(),
        title: format!("welcome.link.{title}"),
        from: from.into(),
        colors: colors.iter().map(|color| (*color).to_owned()).collect(),
    };
    WelcomeContent {
        phrases: vec![
            phrase("weather", WelcomeWay::Search, "weather"),
            phrase("site", WelcomeWay::GoToSite, "site"),
            phrase("flights", WelcomeWay::YourTabs, "flightsTab"),
            phrase("recipe", WelcomeWay::Search, "recipe"),
            phrase("news", WelcomeWay::GoToSite, "news"),
            phrase("soup", WelcomeWay::YourTabs, "soupTab"),
        ],
        links: vec![
            link(
                "timeout.com",
                "things",
                "messages",
                &["#F7C873", "#EE7B5B", "#B5527A"],
            ),
            link("airbnb.com", "stay", "mail", &["#FF9A8B", "#E0565B"]),
            link("flytap.com", "flight", "messages", &["#86D9A4", "#2E9E6B"]),
        ],
        drift_sites: [
            "news.ycombinator.com",
            "wikipedia.org",
            "airbnb.com",
            "github.com",
            "are.na",
            "nytimes.com",
            "theverge.com",
            "youtube.com",
            "notion.so",
            "figma.com",
            "flytap.com",
        ]
        .map(str::to_owned)
        .to_vec(),
        motion: WelcomeMotion {
            morph: spring(0.5, 0.86),
            land: spring(0.42, 0.82),
            dots: spring(0.36, 0.86),
            link: spring(0.42, 0.8),
            chips: spring(0.45, 0.7),
        },
        stage_width: STAGE_WIDTH,
        stage_height: STAGE_HEIGHT,
        letters: LETTERS,
    }
}

/// The spring as a physical configuration: unit mass, the stiffness and damping that settle in `response`.
#[uniffi::export]
pub fn spring_physics(spring: WelcomeSpring) -> SpringPhysics {
    let omega = 2.0 * std::f64::consts::PI / spring.response;
    SpringPhysics {
        stiffness: omega * omega,
        damping: (4.0 * std::f64::consts::PI * spring.damping_ratio) / spring.response,
        mass: 1.0,
    }
}

/// How tall each page's drawing is, for scaling it into the room above the words.
#[uniffi::export]
pub fn stage_needs(step: WelcomeStep) -> f64 {
    match step {
        WelcomeStep::Welcome => 348.0,
        WelcomeStep::Desktop => 392.0,
        WelcomeStep::Field => 356.0,
        WelcomeStep::Private => 320.0,
        WelcomeStep::Links => 352.0,
        WelcomeStep::End => 220.0,
    }
}

/// The glass object's place and corner on each page.
#[uniffi::export]
pub fn hero(step: WelcomeStep) -> StageRect {
    let rect = |x, y, width, height, radius| StageRect {
        x,
        y,
        width,
        height,
        radius,
    };
    match step {
        WelcomeStep::Welcome => LETTERS,
        WelcomeStep::Desktop => rect(36.0, 322.0, 330.0, 68.0, 34.0),
        WelcomeStep::Field => rect(20.0, 84.0, 362.0, 60.0, 30.0),
        WelcomeStep::Private => rect(20.0, 160.0, 362.0, 56.0, 28.0),
        WelcomeStep::Links => rect(86.0, 48.0, 230.0, 300.0, 30.0),
        WelcomeStep::End => rect(16.0, 120.0, 370.0, 48.0, 24.0),
    }
}

/// The stage's scale: as wide as the screen allows, and small enough to leave the words their room.
#[uniffi::export]
pub fn stage_scale(width: f64, available: f64, step: WelcomeStep) -> f64 {
    (width / STAGE_WIDTH)
        .min(1.1)
        .min(available / stage_needs(step))
        .max(0.45)
}

/// Ease-out cubic, for counts and drawings that settle.
#[uniffi::export]
pub fn ease_out(progress: f64) -> f64 {
    let p = progress.clamp(0.0, 1.0);
    1.0 - (1.0 - p).powi(3)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_button_walks_every_page_and_links_only_while_bay_can_ask() {
        let walk = |asks| {
            let mut seen = Vec::new();
            let mut step = WelcomeForward::To {
                step: WelcomeStep::Welcome,
            };
            while let WelcomeForward::To { step: at } = step {
                seen.push(at);
                step = welcome_forward(at, asks);
            }
            seen
        };
        assert_eq!(
            walk(true),
            [
                WelcomeStep::Welcome,
                WelcomeStep::Desktop,
                WelcomeStep::Field,
                WelcomeStep::Private,
                WelcomeStep::Links
            ]
        );
        assert_eq!(
            walk(false),
            [
                WelcomeStep::Welcome,
                WelcomeStep::Desktop,
                WelcomeStep::Field,
                WelcomeStep::Private
            ]
        );
    }

    #[test]
    fn back_retraces_the_pages_and_theres_no_going_back_from_the_first_or_the_end() {
        assert_eq!(welcome_back(WelcomeStep::Welcome), None);
        assert_eq!(welcome_back(WelcomeStep::End), None);
        assert_eq!(
            welcome_back(WelcomeStep::Desktop),
            Some(WelcomeStep::Welcome)
        );
        assert_eq!(welcome_back(WelcomeStep::Links), Some(WelcomeStep::Private));
    }

    #[test]
    fn the_dots_count_the_pages_there_are_and_the_last_dot_stays_lit_at_the_end() {
        assert_eq!(welcome_page_count(true), 5);
        assert_eq!(welcome_page_count(false), 4);
        assert_eq!(
            STEPS.map(|step| welcome_page_of(step, true)),
            [0, 1, 2, 3, 4, 4]
        );
        assert_eq!(welcome_page_of(WelcomeStep::End, false), 3);
    }

    #[test]
    fn skip_opens_the_real_field_except_once_past_the_fields_page() {
        assert!(skip_opens_field(WelcomeStep::Welcome));
        assert!(skip_opens_field(WelcomeStep::Field));
        assert!(!skip_opens_field(WelcomeStep::Private));
        assert!(!skip_opens_field(WelcomeStep::Links));
    }

    #[test]
    fn bay_asks_to_be_the_default_browser_only_where_it_can_be_and_isnt() {
        assert!(asks_about_links(DefaultBrowser::Not));
        assert!(asks_about_links(DefaultBrowser::Unknown));
        assert!(!asks_about_links(DefaultBrowser::Default));
        assert!(!asks_about_links(DefaultBrowser::Unavailable));
    }

    #[test]
    fn the_glass_stays_on_the_stage_on_every_page() {
        for step in STEPS {
            let rect = hero(step);
            assert!(
                rect.x >= 0.0 && rect.x + rect.width <= STAGE_WIDTH,
                "{step:?}"
            );
            assert!(
                rect.y >= 0.0 && rect.y + rect.height <= STAGE_HEIGHT,
                "{step:?}"
            );
        }
    }

    #[test]
    fn the_drawing_scales_to_the_screens_width_and_down_to_leave_the_words_their_room() {
        assert_eq!(stage_scale(402.0, 1000.0, WelcomeStep::Field), 1.0);
        assert_eq!(stage_scale(1000.0, 1000.0, WelcomeStep::Field), 1.1);
        assert!(
            (stage_scale(402.0, 200.0, WelcomeStep::Field)
                - 200.0 / stage_needs(WelcomeStep::Field))
            .abs()
                < 1e-9
        );
        assert_eq!(stage_scale(402.0, 10.0, WelcomeStep::Field), 0.45);
    }

    #[test]
    fn springs_and_easing_are_the_typescript_numbers() {
        // springConfig({ response: 0.5, dampingRatio: 0.86 }) and easeOut(0.5) in the Expo app.
        let morph = spring_physics(welcome_content().motion.morph);
        assert!((morph.stiffness - 157.91367041742973).abs() < 1e-9);
        assert!((morph.damping - 21.614157456697775).abs() < 1e-9);
        assert_eq!(ease_out(0.5), 0.875);
        assert_eq!(ease_out(-1.0), 0.0);
        assert_eq!(ease_out(2.0), 1.0);
    }

    #[test]
    fn every_phrase_and_link_names_a_string_bay_ships() {
        let strings = crate::i18n::catalog("en".into());
        let content = welcome_content();
        for phrase in &content.phrases {
            assert!(strings.contains_key(&phrase.typed), "{}", phrase.typed);
            assert!(strings.contains_key(&phrase.landed), "{}", phrase.landed);
        }
        for link in &content.links {
            assert!(strings.contains_key(&link.title), "{}", link.title);
        }
    }
}
