//! Replays what the Expo app's TypeScript store did in its own tests (`fixtures/store.jsonl`, written by
//! `scripts/record-fixtures.mjs store`) and checks the Rust port gives the same answers: the same next state, the same
//! "nothing changed", the same repairs of saved state.

use bay_core::store::model::{merge_history, persisted_browser_data};
use bay_core::store::parse::{parse_browser_data, parse_preferences, parse_site_setting};
use bay_core::store::{Action, BrowserData, HistoryEntry, reduce};
use serde_json::{Map, Value};

/// Absent and null mean the same in the saved document, as does a `private` flag that is false, and 5 and 5.0 are
/// one number.
fn normalize(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, value)| {
                    !value.is_null()
                        && !(key.as_str() == "private" && **value == Value::Bool(false))
                })
                .map(|(key, value)| (key.clone(), normalize(value)))
                .collect::<Map<_, _>>(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(normalize).collect()),
        Value::Number(number) => number
            .as_f64()
            .and_then(serde_json::Number::from_f64)
            .map_or(value.clone(), Value::Number),
        other => other.clone(),
    }
}

fn favicon_order(value: &Value) -> Vec<String> {
    value
        .get("favicons")
        .and_then(Value::as_object)
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default()
}

fn same(expected: &Value, actual: &Value) -> Result<(), String> {
    if normalize(expected) != normalize(actual) {
        return Err(first_difference(
            &normalize(expected),
            &normalize(actual),
            String::new(),
        ));
    }
    if favicon_order(expected) != favicon_order(actual) {
        return Err("favicons in another order".into());
    }
    Ok(())
}

fn first_difference(expected: &Value, actual: &Value, path: String) -> String {
    match (expected, actual) {
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys()) {
                let (x, y) = (
                    a.get(key).unwrap_or(&Value::Null),
                    b.get(key).unwrap_or(&Value::Null),
                );
                if x != y {
                    return first_difference(x, y, format!("{path}.{key}"));
                }
            }
            path
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (index, (x, y)) in a.iter().zip(b).enumerate() {
                if x != y {
                    return first_difference(x, y, format!("{path}[{index}]"));
                }
            }
            path
        }
        _ => format!("{path}: expected {expected}, got {actual}"),
    }
}

fn check(line: &Value) -> Result<(), String> {
    let args = line["args"].as_array().ok_or("no args")?;
    let parse_data = |value: &Value| {
        serde_json::from_value::<BrowserData>(value.clone())
            .map_err(|error| format!("skip: data: {error}"))
    };
    match line["fn"].as_str().unwrap_or_default() {
        "reduceBrowserData" => {
            let data = parse_data(&args[0])?;
            let action: Action = serde_json::from_value(args[1].clone())
                .map_err(|error| format!("skip: action: {error}"))?;
            let next = reduce(&data, &action);
            let unchanged = line["same"].as_bool().unwrap_or(false);
            if unchanged != next.is_none() {
                return Err(format!(
                    "{}: TypeScript {} it, Rust {}",
                    args[1]["type"],
                    if unchanged { "kept" } else { "changed" },
                    if next.is_none() { "kept" } else { "changed" }
                ));
            }
            let actual = serde_json::to_value(next.as_ref().unwrap_or(&data)).unwrap();
            same(&line["result"], &actual)
                .map_err(|difference| format!("{}: {difference}", args[1]["type"]))
        }
        "parseBrowserData" => {
            let fallback = parse_data(&args[1])?;
            match (parse_browser_data(&args[0], &fallback), line.get("error")) {
                (Ok(data), None) => same(&line["result"], &serde_json::to_value(data).unwrap()),
                (Err(_), Some(_)) => Ok(()),
                (Ok(_), Some(error)) => Err(format!("TypeScript refused ({error}), Rust read it")),
                (Err(error), None) => Err(format!("Rust refused: {error}")),
            }
        }
        "persistedBrowserData" => same(
            &line["result"],
            &serde_json::to_value(persisted_browser_data(&parse_data(&args[0])?)).unwrap(),
        ),
        "mergeHistory" => {
            let history: Vec<HistoryEntry> = serde_json::from_value(args[0].clone())
                .map_err(|error| format!("skip: {error}"))?;
            let entries: Vec<HistoryEntry> = serde_json::from_value(args[1].clone())
                .map_err(|error| format!("skip: {error}"))?;
            let merged = merge_history(&history, &entries).unwrap_or(history);
            same(&line["result"], &serde_json::to_value(merged).unwrap())
        }
        "parsePreferences" => {
            let saved = args[0].as_object().cloned().unwrap_or_default();
            same(
                &line["result"],
                &serde_json::to_value(parse_preferences(&saved)).unwrap(),
            )
        }
        "parseSiteSetting" => same(
            &line["result"],
            &serde_json::to_value(parse_site_setting(&args[0])).unwrap(),
        ),
        other => Err(format!("skip: unknown function {other}")),
    }
}

#[test]
fn the_rust_store_matches_the_typescript_one() {
    let fixtures = include_str!("../../../fixtures/store.jsonl");
    let mut failures = Vec::new();
    let mut skipped = Vec::new();
    let mut checked = 0;
    for (number, line) in fixtures.lines().enumerate() {
        let line: Value = serde_json::from_str(line).expect("a fixture line is JSON");
        match check(&line) {
            Ok(()) => checked += 1,
            Err(message) if message.starts_with("skip:") => {
                skipped.push(format!("line {}: {message}", number + 1))
            }
            Err(message) => {
                failures.push(format!("line {} ({}): {message}", number + 1, line["fn"]))
            }
        }
    }
    println!("checked {checked}, skipped {}", skipped.len());
    for skip in &skipped {
        println!("  {skip}");
    }
    assert!(
        failures.is_empty(),
        "{} of {} calls differ:\n{}",
        failures.len(),
        checked + failures.len(),
        failures.join("\n")
    );
    assert!(
        skipped.len() * 20 < checked,
        "too many calls couldn't be read: {}",
        skipped.len()
    );
}
