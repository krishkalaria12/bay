//! Hybrid logical clocks, as every device of a chain stamps its changes: base-36 wall time (9 digits), a counter (4
//! digits) and the device, so stamps sort as strings. A port of `packages/sync/src/hlc.ts`.

pub type Hlc = String;

const WALL_DIGITS: usize = 9;
const COUNTER_DIGITS: usize = 4;

fn base36(mut value: u64, width: usize) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
        if value == 0 {
            break;
        }
    }
    while out.len() < width {
        out.push(b'0');
    }
    out.reverse();
    String::from_utf8(out).expect("base-36 digits are ASCII")
}

/// JavaScript's `parseInt(text, 36)` for well-formed digits: the leading run of base-36 digits, 0 when there's none.
fn parse36(text: &str) -> u64 {
    text.chars()
        .map_while(|c| c.to_digit(36))
        .fold(0u64, |value, digit| {
            value.saturating_mul(36).saturating_add(u64::from(digit))
        })
}

pub fn format_hlc(wall: i64, counter: u64, device: &str) -> Hlc {
    format!(
        "{}.{}.{device}",
        base36(wall.max(0) as u64, WALL_DIGITS),
        base36(counter, COUNTER_DIGITS)
    )
}

pub struct HlcParts {
    pub wall: i64,
    pub counter: u64,
    pub device: String,
}

pub fn parse_hlc(h: &str) -> HlcParts {
    let mut parts = h.split('.');
    let wall = parse36(parts.next().unwrap_or("0")) as i64;
    let counter = parse36(parts.next().unwrap_or("0"));
    HlcParts {
        wall,
        counter,
        device: parts.collect::<Vec<_>>().join("."),
    }
}

/// The wall time a stamp was made at, in milliseconds.
pub fn hlc_wall(h: &str) -> i64 {
    parse36(&h[..h.len().min(WALL_DIGITS)]) as i64
}

pub struct Clock {
    wall: i64,
    counter: u64,
    pub device: String,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
}

impl Clock {
    pub fn new(device: &str, last: Option<&str>, now: Box<dyn Fn() -> i64 + Send + Sync>) -> Self {
        let mut clock = Self {
            wall: 0,
            counter: 0,
            device: device.into(),
            now,
        };
        if let Some(last) = last.filter(|last| !last.is_empty()) {
            clock.observe(last);
        }
        clock
    }

    pub fn now(&self) -> i64 {
        (self.now)()
    }

    pub fn tick(&mut self) -> Hlc {
        let t = self.now();
        if t > self.wall {
            self.wall = t;
            self.counter = 0;
        } else {
            self.counter += 1;
        }
        format_hlc(self.wall, self.counter, &self.device)
    }

    /// A stamp at a past time: an edit the device knows it made then.
    pub fn at(&self, time: i64) -> Hlc {
        format_hlc(time.min(self.now()), 0, &self.device)
    }

    pub fn observe(&mut self, h: &str) {
        let HlcParts { wall, counter, .. } = parse_hlc(h);
        if wall > self.wall || (wall == self.wall && counter > self.counter) {
            self.wall = wall;
            self.counter = counter;
        }
    }

    pub fn last(&self) -> Hlc {
        format_hlc(self.wall, self.counter, &self.device)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_sort_as_strings() {
        assert_eq!(
            format_hlc(1_700_000_000_000, 3, "dev"),
            "0loyw3v28.0003.dev"
        );
        let parts = parse_hlc("0loyw3v28.0003.my.device");
        assert_eq!(
            (parts.wall, parts.counter, parts.device.as_str()),
            (1_700_000_000_000, 3, "my.device")
        );
        assert_eq!(hlc_wall("0loyw3v28.0003.dev"), 1_700_000_000_000);
        assert!(format_hlc(9, 0, "a") < format_hlc(10, 0, "a"));
    }

    #[test]
    fn a_clock_moves_past_what_it_sees() {
        let mut clock = Clock::new("me", None, Box::new(|| 100));
        assert_eq!(parse_hlc(&clock.tick()).wall, 100);
        assert_eq!(parse_hlc(&clock.tick()).counter, 1);
        clock.observe(&format_hlc(500, 7, "other"));
        let next = parse_hlc(&clock.tick());
        assert_eq!((next.wall, next.counter), (500, 8));
        assert_eq!(parse_hlc(&clock.at(50)).wall, 50);
        assert_eq!(parse_hlc(&clock.at(5000)).wall, 100);
    }
}
