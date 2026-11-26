//! JSON with its object keys sorted, as `packages/sync/src/canon.ts` writes it: what a device compares to tell
//! whether a value changed since it last published it.

use serde_json::{Map, Value};

fn sort_keys(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sort_keys).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            // JavaScript sorts keys by UTF-16 code units.
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), sort_keys(&map[key])))
                    .collect::<Map<_, _>>(),
            )
        }
        other => other.clone(),
    }
}

pub fn canonical(value: &Value) -> String {
    serde_json::to_string(&sort_keys(value)).expect("a JSON value serializes")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_are_sorted_all_the_way_down() {
        assert_eq!(
            canonical(&json!({ "b": 1, "a": [{ "d": null, "c": "x" }] })),
            r#"{"a":[{"c":"x","d":null}],"b":1}"#
        );
    }
}
