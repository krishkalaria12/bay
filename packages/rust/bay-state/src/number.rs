//! A number as the React Native app writes it: JavaScript has one number type, and `JSON.stringify` writes a whole
//! number without a fraction (`1`, not `1.0`). Every number in the saved documents is one of these, so a document
//! read and written again holds the same values in the same form.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Clone, Copy, Debug, Default, PartialEq, PartialOrd)]
pub struct JsNumber(pub f64);

/// The largest whole number a double holds exactly (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

impl JsNumber {
    pub const fn get(self) -> f64 {
        self.0
    }
}

impl From<f64> for JsNumber {
    fn from(value: f64) -> Self {
        Self(value)
    }
}

impl Serialize for JsNumber {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let value = self.0;
        if value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER {
            // A whole number within ±2^53 converts to i64 exactly.
            serializer.serialize_i64(value as i64)
        } else if value.is_finite() {
            serializer.serialize_f64(value)
        } else {
            // JSON.stringify writes NaN and the infinities as null.
            serializer.serialize_none()
        }
    }
}

impl<'de> Deserialize<'de> for JsNumber {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        f64::deserialize(deserializer).map(Self)
    }
}

#[cfg(test)]
mod tests {
    use super::JsNumber;

    fn written(value: f64) -> String {
        serde_json::to_string(&JsNumber(value)).unwrap()
    }

    #[test]
    fn whole_numbers_are_written_without_a_fraction() {
        assert_eq!(written(1.0), "1");
        assert_eq!(written(-3.0), "-3");
        assert_eq!(written(1_795_800_000_000.0), "1795800000000");
    }

    #[test]
    fn fractions_and_non_finite_numbers_are_written_as_javascript_does() {
        assert_eq!(written(1.25), "1.25");
        assert_eq!(written(0.1), "0.1");
        assert_eq!(written(f64::NAN), "null");
        assert_eq!(written(f64::INFINITY), "null");
    }

    #[test]
    fn integers_and_fractions_read_back() {
        let numbers: Vec<JsNumber> = serde_json::from_str("[1, 1.5, 1795800000000]").unwrap();
        assert_eq!(
            numbers,
            [JsNumber(1.0), JsNumber(1.5), JsNumber(1_795_800_000_000.0)]
        );
    }
}
