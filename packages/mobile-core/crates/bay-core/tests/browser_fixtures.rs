//! Replays what the Expo app's browser helpers did in its tests and scenarios (`fixtures/browser.jsonl`, recorded
//! before the app was removed) and checks the Rust port gives the same answers.

use bay_core::browser::{
    KNOWN_LIMIT, bay_command, describe_page_error, downloads_from, format_saved_logins, icon_width,
    incoming_link, is_image, known_sites_without_icons, opens_when_finished, origin_of,
    page_error_id, parse_saved_logins, share_link,
};
use bay_core::store::{BrowserData, DownloadItem};
use serde_json::{Value, json};

/// Absent and null are one, as are 5 and 5.0.
fn same(expected: &Value, actual: &Value) -> bool {
    match (expected, actual) {
        (Value::Object(a), Value::Object(b)) => a.keys().chain(b.keys()).all(|key| {
            same(
                a.get(key).unwrap_or(&Value::Null),
                b.get(key).unwrap_or(&Value::Null),
            )
        }),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same(x, y))
        }
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        _ => expected == actual,
    }
}

/// A file head as JavaScript held it, one character per byte; none when a character isn't one.
fn head(value: &Value) -> Option<Vec<u8>> {
    value
        .as_str()?
        .chars()
        .map(|c| u8::try_from(u32::from(c)).ok())
        .collect()
}

fn run(fun: &str, args: &Value) -> Option<Value> {
    let text = || args[0].as_str().map(str::to_owned);
    Some(match fun {
        "incomingLink" => json!(incoming_link(text())),
        "shareLink" => json!(share_link(&text()?)),
        "bayCommand" => json!(bay_command(text())),
        "describePageError" => json!(describe_page_error(&text()?)),
        "pageErrorId" => json!(page_error_id(&text()?)),
        "parseSavedLogins" => json!(parse_saved_logins(text())),
        "formatSavedLogins" => {
            let logins = serde_json::from_value(args[0].clone()).unwrap();
            json!(format_saved_logins(logins))
        }
        "originOf" => json!(origin_of(&text()?)),
        "opensWhenFinished" => json!(opens_when_finished(&text()?)),
        "downloadsFrom" => {
            let downloads: Vec<DownloadItem> = serde_json::from_value(args[0].clone()).unwrap();
            json!(downloads_from(&downloads, &text_at(args, 1)))
        }
        "isImage" => json!(is_image(&head(&args[0])?)),
        "iconWidth" => json!(icon_width(&head(&args[0])?)),
        "knownSitesWithoutIcons" => {
            let data: BrowserData = serde_json::from_value(args[0].clone()).unwrap();
            let limit = args[1].as_u64().map_or(KNOWN_LIMIT, |limit| limit as usize);
            json!(known_sites_without_icons(&data, limit))
        }
        other => panic!("unknown fn {other}"),
    })
}

fn text_at(args: &Value, index: usize) -> String {
    args[index].as_str().unwrap_or_default().to_owned()
}

#[test]
fn the_rust_helpers_answer_as_the_typescript_ones_do() {
    let mut checked = 0;
    let mut skipped = 0;
    let mut failures = Vec::new();
    for (number, line) in include_str!("../../../fixtures/browser.jsonl")
        .lines()
        .enumerate()
    {
        let line: Value = serde_json::from_str(line).unwrap();
        let fun = line["fn"].as_str().unwrap();
        let Some(got) = run(fun, &line["args"]) else {
            // A head with a character past a byte, or a call without a string: nothing the apps can pass.
            skipped += 1;
            continue;
        };
        checked += 1;
        if !same(&line["result"], &got) {
            failures.push(format!(
                "line {} {fun} {}:\n  want {}\n  got  {got}",
                number + 1,
                line["args"]
                    .to_string()
                    .chars()
                    .take(200)
                    .collect::<String>(),
                line["result"],
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {checked} differ:\n{}",
        failures.len(),
        failures
            .iter()
            .take(8)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
    println!("{checked} checked, {skipped} skipped");
}
