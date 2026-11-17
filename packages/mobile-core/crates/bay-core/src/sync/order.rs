//! Positions that sort between two others, for ordered lists synced as records (bookmark folders' children). A port
//! of `packages/sync/src/order.ts`.

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE: usize = 62;

fn digit(c: Option<u8>) -> usize {
    c.and_then(|c| DIGITS.iter().position(|d| *d == c))
        .unwrap_or(0)
}

/// A position after `a` and before `b` (or anywhere after `a` when `b` is none).
pub fn position_between(a: &str, b: Option<&str>) -> String {
    let (a_bytes, b_bytes) = (a.as_bytes(), b.map(str::as_bytes));
    if let Some(b) = b_bytes {
        assert!(
            a_bytes < b,
            "position_between: {a} >= {}",
            String::from_utf8_lossy(b)
        );
        let mut n = 0;
        while a_bytes.get(n).copied().unwrap_or(b'0') == b.get(n).copied().unwrap_or(0)
            && n < b.len()
        {
            n += 1;
        }
        if n > 0 {
            let prefix = String::from_utf8_lossy(&b[..n]).into_owned();
            let rest_a = String::from_utf8_lossy(a_bytes.get(n..).unwrap_or(&[])).into_owned();
            let rest_b = String::from_utf8_lossy(&b[n..]).into_owned();
            return prefix + &position_between(&rest_a, Some(&rest_b));
        }
    }
    let da = digit(a_bytes.first().copied());
    let db = b_bytes.map_or(BASE, |b| digit(b.first().copied()));
    if db - da > 1 {
        return (DIGITS[(da + db).div_ceil(2).min(BASE - 1)] as char).to_string();
    }
    if let Some(b) = b_bytes
        && b.len() > 1
    {
        return (b[0] as char).to_string();
    }
    let rest = String::from_utf8_lossy(a_bytes.get(1..).unwrap_or(&[])).into_owned();
    format!("{}{}", DIGITS[da] as char, position_between(&rest, None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positions_sort_between_their_neighbours() {
        for (a, b) in [
            ("", None),
            ("1", Some("2")),
            ("A", Some("B")),
            ("Az", Some("B")),
            ("5", None),
            ("", Some("1")),
        ] {
            let p = position_between(a, b);
            assert!(p.as_str() > a, "{p} after {a}");
            if let Some(b) = b {
                assert!(p.as_str() < b, "{p} before {b}");
            }
        }
        assert_eq!(position_between("", None), "V");
    }
}
