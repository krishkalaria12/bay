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

/// Positions for a list in its order, keeping as many of the known ones as stay in order (the longest increasing run)
/// and placing the rest between their neighbours. A known position ending in 0 isn't kept: nothing sorts before it.
pub fn assign_positions(existing: &[Option<String>]) -> Vec<String> {
    let mut tails: Vec<usize> = Vec::new();
    let mut previous: Vec<Option<usize>> = vec![None; existing.len()];
    for (i, position) in existing.iter().enumerate() {
        let Some(position) = position
            .as_deref()
            .filter(|p| !p.is_empty() && !p.ends_with('0'))
        else {
            continue;
        };
        let (mut lo, mut hi) = (0, tails.len());
        while lo < hi {
            let mid = (lo + hi) / 2;
            if existing[tails[mid]]
                .as_deref()
                .is_some_and(|tail| tail < position)
            {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo > 0 {
            previous[i] = Some(tails[lo - 1]);
        }
        if lo == tails.len() {
            tails.push(i);
        } else {
            tails[lo] = i;
        }
    }
    let mut keep = std::collections::HashSet::new();
    let mut at = tails.last().copied();
    while let Some(i) = at {
        keep.insert(i);
        at = previous[i];
    }
    let mut out = vec![String::new(); existing.len()];
    for &i in &keep {
        out[i] = existing[i].clone().unwrap_or_default();
    }
    let mut before = String::new();
    for i in 0..existing.len() {
        if keep.contains(&i) {
            before = out[i].clone();
            continue;
        }
        let next = (i + 1..existing.len())
            .find(|j| keep.contains(j))
            .map(|j| out[j].clone());
        out[i] = position_between(&before, next.as_deref());
        before = out[i].clone();
    }
    out
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

    #[test]
    fn assigned_positions_are_the_typescript_ones() {
        let known = |list: &[Option<&str>]| {
            list.iter()
                .map(|p| p.map(str::to_owned))
                .collect::<Vec<_>>()
        };
        // What packages/sync/src/order.ts answers for the same lists.
        assert_eq!(
            assign_positions(&known(&[None, None, None])),
            ["V", "l", "t"]
        );
        assert_eq!(
            assign_positions(&known(&[Some("V"), None, Some("X")])),
            ["V", "W", "X"]
        );
        assert_eq!(
            assign_positions(&known(&[Some("X"), Some("V"), Some("Y")])),
            ["G", "V", "Y"]
        );
    }
}
