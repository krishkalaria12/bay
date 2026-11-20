//! Replays what the Expo app's import code (src/import, src/browser/importTabs.ts) did in its tests and the scenarios in
//! `scripts/import-scenarios.test.ts` (`fixtures/import.jsonl`, written by `scripts/record-fixtures.mjs import`) and
//! checks the Rust port gives the same answers.

use bay_core::imports::{
    ExportFile, ImportedBookmark, InstalledBrowser, android_browsers, android_method,
    bookmark_drafts, bookmark_links, decode_entities, draft_link_count, export_notes,
    imported_tabs, ios_browsers, is_bookmarks_html, link_count, parse_bookmarks_html,
    parse_history_json, read_export, web_address,
};
use bay_core::store::Bookmarks;
use bay_core::store::bookmarks::BookmarkDraft;
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

fn arg<T: serde::de::DeserializeOwned>(args: &Value, index: usize) -> T {
    serde_json::from_value(args[index].clone()).unwrap()
}

/// A draft as the TypeScript writes it: no `url` on a folder, no `children` on a link, no `addedAt` when unknown.
fn draft_json(draft: &BookmarkDraft) -> Value {
    let mut out = json!({ "title": draft.title });
    if let Some(url) = &draft.url {
        out["url"] = json!(url);
    } else {
        out["children"] = json!(draft.children.iter().map(draft_json).collect::<Vec<_>>());
    }
    if let Some(at) = draft.added_at {
        out["addedAt"] = json!(at);
    }
    out
}

fn draft_from(value: &Value) -> BookmarkDraft {
    BookmarkDraft {
        title: value["title"].as_str().unwrap_or_default().into(),
        url: value["url"].as_str().map(Into::into),
        added_at: value["addedAt"].as_i64(),
        children: value["children"]
            .as_array()
            .map(|children| children.iter().map(draft_from).collect())
            .unwrap_or_default(),
    }
}

fn run(fun: &str, args: &Value) -> Result<Value, String> {
    let text = || args[0].as_str().unwrap();
    let node = || arg::<ImportedBookmark>(args, 0);
    Ok(match fun {
        "webAddress" => json!(web_address(text())),
        "bookmarkLinks" => json!(bookmark_links(&node())),
        "linkCount" => json!(link_count(&node())),
        "decodeEntities" => json!(decode_entities(text())),
        "isBookmarksHTML" => json!(is_bookmarks_html(text())),
        "parseBookmarksHTML" => json!(parse_bookmarks_html(text())),
        "parseHistoryJSON" => json!(parse_history_json(text())),
        "readExport" => {
            let files: Vec<ExportFile> = arg(args, 0);
            json!(read_export(&files).map_err(|error| error.to_string())?)
        }
        "exportNotes" => {
            let skipped: Vec<String> = serde_json::from_value(args[0]["skipped"].clone()).unwrap();
            let too_large: Vec<String> =
                serde_json::from_value(args[0]["tooLarge"].clone()).unwrap();
            json!(export_notes(&skipped, &too_large))
        }
        "bookmarkDrafts" => {
            let existing: Bookmarks = arg(args, 1);
            json!(
                bookmark_drafts(&node(), &existing)
                    .iter()
                    .map(draft_json)
                    .collect::<Vec<_>>()
            )
        }
        "draftLinkCount" => {
            let drafts: Vec<BookmarkDraft> =
                args[0].as_array().unwrap().iter().map(draft_from).collect();
            json!(draft_link_count(&drafts))
        }
        "androidMethod" => json!(android_method(text())),
        "androidBrowsers" => {
            let installed: Vec<InstalledBrowser> = arg(args, 0);
            json!(android_browsers(&installed))
        }
        "iosBrowsers" => {
            let answered: Vec<bool> = arg(args, 0);
            json!(ios_browsers(&answered))
        }
        "importedTabs" => json!(imported_tabs(text())),
        other => panic!("unknown fn {other}"),
    })
}

#[test]
fn the_rust_import_reads_exports_as_the_typescript_one_does() {
    let mut checked = 0;
    let mut failures = Vec::new();
    for (number, line) in include_str!("../../../fixtures/import.jsonl")
        .lines()
        .enumerate()
    {
        let line: Value = serde_json::from_str(line).unwrap();
        let fun = line["fn"].as_str().unwrap();
        let got = run(fun, &line["args"]);
        checked += 1;
        let ok = match (&got, line.get("error")) {
            (Err(error), Some(expected)) => expected == error,
            (Ok(value), None) => same(&line["result"], value),
            _ => false,
        };
        if !ok {
            failures.push(format!(
                "line {} {fun} {}:\n  want {}\n  got  {:?}",
                number + 1,
                line["args"]
                    .to_string()
                    .chars()
                    .take(300)
                    .collect::<String>(),
                line.get("error").unwrap_or(&line["result"]),
                got
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {checked} differ:\n{}",
        failures.len(),
        failures
            .iter()
            .take(6)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
    println!("{checked} checked");
}
