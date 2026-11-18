//! Messages pages send the app through `post(message)`, as JSON text. They come from the page, so each is checked
//! before anything acts on it. The Expo app's `parseMediaMessage` (src/pagescripts/media.ts).

use serde_json::Value;

use crate::js::slice;

/// A page's media playing, pausing or ending, as `watch-media` reports it (`{ type: "media", playing, title, video }`).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct MediaReport {
    pub playing: bool,
    /// The page's title, else the media's own, else its file name; at most 200 UTF-16 units.
    pub title: String,
    /// Video (shown) rather than audio only.
    pub video: bool,
}

/// Reads a page message as a media report; None for anything else.
#[uniffi::export]
pub fn parse_media_message(message: &str) -> Option<MediaReport> {
    let value: Value = serde_json::from_str(message).ok()?;
    let object = value.as_object()?;
    if object.get("type")?.as_str()? != "media" {
        return None;
    }
    Some(MediaReport {
        playing: object.get("playing")?.as_bool()?,
        title: slice(object.get("title")?.as_str()?, 200),
        video: object.get("video")?.as_bool()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_media_reports() {
        assert_eq!(
            parse_media_message(
                r#"{"type":"media","playing":true,"title":"Song","video":false,"extra":1}"#
            ),
            Some(MediaReport {
                playing: true,
                title: "Song".into(),
                video: false
            })
        );
        let long = format!(
            r#"{{"type":"media","playing":false,"title":"{}","video":true}}"#,
            "a".repeat(300)
        );
        assert_eq!(parse_media_message(&long).unwrap().title.len(), 200);
    }

    #[test]
    fn turns_down_anything_else() {
        for message in [
            "not json",
            "null",
            "[]",
            r#"{"type":"picked","selector":"div"}"#,
            r#"{"type":"media","playing":"yes","title":"","video":false}"#,
            r#"{"type":"media","playing":true,"video":false}"#,
            r#"{"type":"media","playing":true,"title":3,"video":false}"#,
        ] {
            assert_eq!(parse_media_message(message), None, "{message}");
        }
    }
}
