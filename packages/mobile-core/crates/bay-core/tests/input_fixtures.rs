//! Replays what `@bay/core`'s address, IDN, calculator, emoji and suggestion code (and the phone's address helpers)
//! did in their tests (`fixtures/input.jsonl`, recorded before the Expo app was removed) and checks the Rust port gives
//! the same answers.

use bay_core::input::address::{engine_for, is_web_url, resolve_address, site_name};
use bay_core::input::app_urls::{app_url_origin, to_app_url};
use bay_core::input::calc::{calculate, evaluate, format_number};
use bay_core::input::clean::{clean_url, is_tracking_param};
use bay_core::input::emoji::find_emoji;
use bay_core::input::engines::{
    SearchEngine, engine_host, parse_suggestions, search_url, suggest_request_url,
};
use bay_core::input::idn::{
    display_host, host_spoof_reason, label_spoof_reason, punycode_decode, punycode_encode,
    similar_top_domain,
};
use bay_core::input::quick_create::match_quick_create;
use bay_core::input::suggest::{
    SuggestEngine, SuggestOptions, SuggestionSource, build_suggestions, display_url,
};
use bay_core::input::url::{
    SEARCH_URL, classify_paste, fixup_url, host_of, parse_url, resolve_input, search_url_for,
    url_for_display,
};
use serde_json::{Map, Value, json};

/// Absent and null are one, as are 5 and 5.0; numbers within a hair are one (V8's and libm's last bits may differ).
fn same(expected: &Value, actual: &Value) -> bool {
    match (expected, actual) {
        (Value::Object(a), Value::Object(b)) => {
            let keys: std::collections::BTreeSet<&String> = a.keys().chain(b.keys()).collect();
            keys.into_iter().all(|key| {
                same(
                    a.get(key).unwrap_or(&Value::Null),
                    b.get(key).unwrap_or(&Value::Null),
                )
            })
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same(x, y))
        }
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (
                a.as_f64().unwrap_or(f64::NAN),
                b.as_f64().unwrap_or(f64::NAN),
            );
            a == b || (a - b).abs() <= 1e-12 * a.abs().max(b.abs())
        }
        (Value::Null, Value::Bool(false)) | (Value::Bool(false), Value::Null) => true,
        (a, b) => a == b,
    }
}

fn str_arg(args: &[Value], i: usize) -> String {
    args.get(i)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn url_of(engine: &Value) -> String {
    engine["url"].as_str().unwrap_or_default().to_owned()
}

fn engine(value: &Value) -> SearchEngine {
    SearchEngine {
        id: value["id"].as_str().unwrap_or_default().into(),
        name: value["name"].as_str().unwrap_or_default().into(),
        keyword: value["keyword"].as_str().unwrap_or_default().into(),
        url: url_of(value),
        suggest_url: value["suggestUrl"].as_str().map(str::to_owned),
        custom: value["custom"].as_bool().unwrap_or(false),
    }
}

/// The Rust answer for a recorded call, or why the call can't be replayed.
fn replay(name: &str, args: &[Value]) -> Result<Value, String> {
    let to = |value: Option<String>| value.map_or(Value::Null, Value::String);
    Ok(match name {
        "parseUrl" => serde_json::to_value(parse_url(&str_arg(args, 0))).unwrap(),
        "hostOf" => json!(host_of(&str_arg(args, 0))),
        "fixupUrl" => to(fixup_url(&str_arg(args, 0))),
        "searchUrlFor" => json!(search_url_for(&str_arg(args, 0), &str_arg(args, 1))),
        "resolveInput" => json!(resolve_input(
            &str_arg(args, 0),
            args.get(1).and_then(Value::as_str).unwrap_or(SEARCH_URL)
        )),
        "classifyPaste" => serde_json::to_value(classify_paste(&str_arg(args, 0))).unwrap(),
        "urlForDisplay" => json!(url_for_display(&str_arg(args, 0))),
        "toAppUrl" => json!(to_app_url(&str_arg(args, 0))),
        "appUrlOrigin" => to(app_url_origin(&str_arg(args, 0))),
        "cleanUrl" => json!(clean_url(&str_arg(args, 0))),
        "isTrackingParam" => json!(is_tracking_param(&str_arg(args, 0), &str_arg(args, 1))),
        "displayHost" => json!(display_host(&str_arg(args, 0))),
        "hostSpoofReason" => serde_json::to_value(host_spoof_reason(&str_arg(args, 0))).unwrap(),
        "labelSpoofReason" => {
            serde_json::to_value(label_spoof_reason(&str_arg(args, 0), &str_arg(args, 1))).unwrap()
        }
        "punycodeDecode" => to(punycode_decode(&str_arg(args, 0))),
        "punycodeEncode" => json!(punycode_encode(&str_arg(args, 0))),
        "similarTopDomain" => to(similar_top_domain(&str_arg(args, 0))),
        "searchUrl" => json!(search_url(&url_of(&args[0]), &str_arg(args, 1))),
        "suggestRequestUrl" => to(suggest_request_url(&engine(&args[0]), &str_arg(args, 1))),
        "parseSuggestions" => json!(parse_suggestions(args.first().unwrap_or(&Value::Null))),
        "engineHost" => json!(engine_host(&url_of(&args[0]))),
        "calculate" => serde_json::to_value(calculate(&str_arg(args, 0))).unwrap(),
        "evaluate" => serde_json::to_value(evaluate(&str_arg(args, 0))).unwrap(),
        "formatNumber" => {
            let value = args[0].as_f64().ok_or("skip: a number JSON can't hold")?;
            json!(format_number(
                value,
                args.get(1).and_then(Value::as_u64).unwrap_or(12) as usize
            ))
        }
        "findEmoji" => {
            // An absent limit is 5; one that isn't a finite number (null included) finds nothing, as `Number.isFinite`.
            let limit = match args.get(1) {
                None => 5.0,
                Some(value) => value.as_f64().unwrap_or(f64::NAN),
            };
            if !limit.is_finite() {
                return Ok(json!([]));
            }
            serde_json::to_value(find_emoji(
                &str_arg(args, 0),
                limit.max(0.0).floor() as usize,
            ))
            .unwrap()
        }
        "matchQuickCreate" => serde_json::to_value(match_quick_create(
            &str_arg(args, 0),
            args.get(1).and_then(Value::as_u64).unwrap_or(3) as usize,
        ))
        .unwrap(),
        "displayUrl" => json!(display_url(&str_arg(args, 0))),
        "engineFor" => serde_json::to_value(engine_for(
            &str_arg(args, 0),
            args.get(1).and_then(Value::as_str),
        ))
        .unwrap(),
        "resolveAddress" => to(resolve_address(&str_arg(args, 0), &engine(&args[1]))),
        "isWebURL" => json!(is_web_url(&str_arg(args, 0))),
        "siteName" => json!(site_name(&str_arg(args, 0))),
        "buildSuggestions" => {
            let options = args
                .get(2)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for desktop_only in ["bangs", "scope", "currency"] {
                if options
                    .get(desktop_only)
                    .is_some_and(|value| !value.is_null())
                {
                    return Err(format!("skip: {desktop_only} is the desktop's"));
                }
            }
            if options
                .get("actions")
                .and_then(Value::as_array)
                .is_some_and(|actions| !actions.is_empty())
            {
                return Err("skip: commands are the desktop's".into());
            }
            let source: SuggestionSource = serde_json::from_value(args[1].clone())
                .map_err(|error| format!("skip: source: {error}"))?;
            let number = |key: &str, default: f64| {
                options.get(key).and_then(Value::as_f64).unwrap_or(default)
            };
            let engine = options.get("engine").map_or(
                SuggestEngine {
                    name: "Google".into(),
                    url: "https://www.google.com/search?q=%s".into(),
                },
                |engine| SuggestEngine {
                    name: engine["name"].as_str().unwrap_or_default().into(),
                    url: url_of(engine),
                },
            );
            let suggest = SuggestOptions {
                limit: number("limit", 8.0) as u32,
                remote_limit: number("remoteLimit", 4.0) as u32,
                pages_ahead: number("pagesAhead", 3.0) as u32,
                now: number("now", 0.0),
                engine,
                website_first: options.get("preference").and_then(Value::as_str) != Some("search"),
                remote: options
                    .get("remote")
                    .and_then(|remote| serde_json::from_value(remote.clone()).ok())
                    .unwrap_or_default(),
                current_tab_id: options
                    .get("currentTabId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                current_url: options
                    .get("currentUrl")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                calculator_enabled: options
                    .get("calculatorEnabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            };
            serde_json::to_value(build_suggestions(&str_arg(args, 0), &source, &suggest)).unwrap()
        }
        other => return Err(format!("skip: {other} isn't ported")),
    })
}

/// What the TypeScript answered, without the fields the port leaves out by design.
fn expected(name: &str, result: &Value) -> Value {
    let mut result = result.clone();
    if name == "matchQuickCreate"
        && let Some(rows) = result.as_array_mut()
    {
        for row in rows {
            row.as_object_mut()
                .map(|row: &mut Map<String, Value>| row.remove("aliases"));
        }
    }
    if name == "engineFor" {
        result
            .as_object_mut()
            .map(|engine| engine.remove("extension"));
    }
    result
}

#[test]
fn the_rust_input_code_matches_the_typescript() {
    let mut failures = Vec::new();
    let (mut checked, mut skipped) = (0, std::collections::BTreeMap::<String, usize>::new());
    for (number, line) in include_str!("../../../fixtures/input.jsonl")
        .lines()
        .enumerate()
    {
        let line: Value = serde_json::from_str(line).unwrap();
        let name = line["fn"].as_str().unwrap_or_default();
        let args = line["args"].as_array().cloned().unwrap_or_default();
        if line.get("error").is_some() {
            continue;
        }
        match replay(name, &args) {
            Ok(actual) => {
                let want = expected(name, &line["result"]);
                if same(&want, &actual) {
                    checked += 1;
                } else {
                    failures.push(format!(
                        "line {} {name}({}):\n    expected {want}\n    got      {actual}",
                        number + 1,
                        Value::Array(args)
                            .to_string()
                            .chars()
                            .take(160)
                            .collect::<String>()
                    ));
                }
            }
            Err(reason) if reason.starts_with("skip:") => {
                *skipped.entry(format!("{name}: {reason}")).or_default() += 1
            }
            Err(reason) => failures.push(reason),
        }
    }
    println!("checked {checked}, skipped {skipped:?}");
    assert!(
        failures.is_empty(),
        "{} calls differ:\n{}",
        failures.len(),
        failures
            .iter()
            .take(25)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
