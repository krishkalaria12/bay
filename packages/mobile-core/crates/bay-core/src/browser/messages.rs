//! Messages pages send the app through `post(message)`, as JSON text. They come from the page, so each is checked
//! before anything acts on it. The Expo app's `parseMediaMessage` (src/pagescripts/media.ts) and `parseImagePress`
//! (src/pagescripts/images.ts).

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

/// A long press on a bare image (outside any link), as `watch-images` reports it on iOS
/// (`{ type: "image", src, title }`): the app's link menu opens for it, answering as an image.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ImagePress {
    /// The image's own web address.
    pub url: String,
    /// Its alt text, else the address.
    pub title: String,
}

/// Reads a page message as an image press; None for anything else, the watcher's `ready` ping included.
#[uniffi::export]
pub fn parse_image_press(message: &str) -> Option<ImagePress> {
    let value: Value = serde_json::from_str(message).ok()?;
    let object = value.as_object()?;
    if object.get("type")?.as_str()? != "image" {
        return None;
    }
    let src = object.get("src")?.as_str()?;
    let title = object.get("title")?.as_str()?;
    let address = url::Url::parse(src).ok()?;
    if !matches!(address.scheme(), "http" | "https") || address.host_str().is_none_or(str::is_empty)
    {
        return None;
    }
    let url = address.to_string();
    let title = title.trim();
    Some(ImagePress {
        title: if title.is_empty() {
            url.clone()
        } else {
            title.to_owned()
        },
        url,
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
    fn reads_image_presses() {
        assert_eq!(
            parse_image_press(
                r#"{"type":"image","src":"https://example.com/a b.png","title":" Cat "}"#
            ),
            Some(ImagePress {
                url: "https://example.com/a%20b.png".into(),
                title: "Cat".into()
            })
        );
        let untitled =
            parse_image_press(r#"{"type":"image","src":"https://example.com/a.png","title":""}"#)
                .unwrap();
        assert_eq!(untitled.title, "https://example.com/a.png");
        for message in [
            r#"{"type":"image","ready":true}"#,
            r#"{"type":"image","src":"data:image/png;base64,AA","title":""}"#,
            r#"{"type":"media","src":"https://example.com/a.png","title":""}"#,
            "not json",
        ] {
            assert_eq!(parse_image_press(message), None, "{message}");
        }
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
