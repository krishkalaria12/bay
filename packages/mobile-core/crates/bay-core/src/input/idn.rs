//! Internationalized hosts: Punycode, and Chromium's rules for when a host shows in Unicode (`bücher.de`) and when it
//! stays `xn--…` because its letters could pass for another site's.

use std::collections::{BTreeSet, HashMap};
use std::sync::LazyLock;

use regex::Regex;
use unicode_normalization::UnicodeNormalization;

use super::{Pattern, pattern};

// MARK: Punycode (RFC 3492)

const BASE: u32 = 36;
const T_MIN: u32 = 1;
const T_MAX: u32 = 26;
const SKEW: u32 = 38;
const DAMP: u32 = 700;
const INITIAL_BIAS: u32 = 72;
const INITIAL_N: u32 = 128;
const MAX_CODE_POINT: u32 = 0x10ffff;

fn adapt(delta: u32, points: u32, first: bool) -> u32 {
    let mut delta = if first { delta / DAMP } else { delta >> 1 };
    delta += delta / points;
    let mut k = 0;
    while delta > ((BASE - T_MIN) * T_MAX) >> 1 {
        delta /= BASE - T_MIN;
        k += BASE;
    }
    k + ((BASE - T_MIN + 1) * delta) / (delta + SKEW)
}

fn digit_value(c: u16) -> u32 {
    match c {
        0x30..=0x39 => u32::from(c) - 22,
        0x41..=0x5a => u32::from(c) - 0x41,
        0x61..=0x7a => u32::from(c) - 0x61,
        _ => BASE,
    }
}

fn digit_char(d: u32) -> char {
    char::from_u32(if d < 26 { d + 0x61 } else { d + 22 }).unwrap_or('?')
}

pub fn punycode_decode(input: &str) -> Option<String> {
    let units: Vec<u16> = input.encode_utf16().collect();
    let delimiter = units.iter().rposition(|&c| c == u16::from(b'-'));
    let mut output: Vec<u32> = Vec::new();
    for &c in &units[..delimiter.unwrap_or(0)] {
        if c >= 0x80 {
            return None;
        }
        output.push(u32::from(c));
    }
    let (mut n, mut bias, mut i) = (INITIAL_N, INITIAL_BIAS, 0u32);
    let mut index = match delimiter {
        Some(at) if at > 0 => at + 1,
        _ => 0,
    };
    while index < units.len() {
        let old_i = i;
        let mut w = 1u32;
        let mut k = BASE;
        loop {
            let digit = digit_value(*units.get(index)?);
            index += 1;
            if digit >= BASE || digit > (MAX_CODE_POINT - i) / w {
                return None;
            }
            i += digit * w;
            let t = if k <= bias {
                T_MIN
            } else if k >= bias + T_MAX {
                T_MAX
            } else {
                k - bias
            };
            if digit < t {
                break;
            }
            w = w.checked_mul(BASE - t)?;
            k += BASE;
        }
        let points = output.len() as u32 + 1;
        bias = adapt(i - old_i, points, old_i == 0);
        n = n.checked_add(i / points)?;
        i %= points;
        if n > MAX_CODE_POINT || (0xd800..=0xdfff).contains(&n) {
            return None;
        }
        output.insert(i as usize, n);
        i += 1;
    }
    output.into_iter().map(char::from_u32).collect()
}

pub fn punycode_encode(input: &str) -> String {
    let points: Vec<u32> = input.chars().map(u32::from).collect();
    let mut output: String = points
        .iter()
        .filter(|&&c| c < 0x80)
        .filter_map(|&c| char::from_u32(c))
        .collect();
    let basic = output.chars().count() as u32;
    let mut handled = basic;
    if basic > 0 {
        output.push('-');
    }
    let (mut n, mut delta, mut bias) = (INITIAL_N, 0u32, INITIAL_BIAS);
    while (handled as usize) < points.len() {
        let m = points
            .iter()
            .copied()
            .filter(|&c| c >= n)
            .min()
            .unwrap_or(n);
        delta += (m - n) * (handled + 1);
        n = m;
        for &c in &points {
            if c < n {
                delta += 1;
            }
            if c != n {
                continue;
            }
            let mut q = delta;
            let mut k = BASE;
            loop {
                let t = if k <= bias {
                    T_MIN
                } else if k >= bias + T_MAX {
                    T_MAX
                } else {
                    k - bias
                };
                if q < t {
                    break;
                }
                output.push(digit_char(t + (q - t) % (BASE - t)));
                q = (q - t) / (BASE - t);
                k += BASE;
            }
            output.push(digit_char(q));
            bias = adapt(delta, handled + 1, handled == basic);
            delta = 0;
            handled += 1;
        }
        delta += 1;
        n += 1;
    }
    output
}

// MARK: Characters and scripts

const SCRIPTS: [&str; 29] = [
    "Latin",
    "Greek",
    "Cyrillic",
    "Armenian",
    "Hebrew",
    "Arabic",
    "Thaana",
    "Devanagari",
    "Bengali",
    "Gurmukhi",
    "Gujarati",
    "Oriya",
    "Tamil",
    "Telugu",
    "Kannada",
    "Malayalam",
    "Sinhala",
    "Thai",
    "Lao",
    "Tibetan",
    "Myanmar",
    "Georgian",
    "Hangul",
    "Ethiopic",
    "Khmer",
    "Hiragana",
    "Katakana",
    "Bopomofo",
    "Han",
];

fn scx(name: &str) -> String {
    format!(r"\p{{Script_Extensions={name}}}")
}

static SCRIPT_TESTS: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    SCRIPTS
        .iter()
        .map(|name| (*name, pattern(&scx(name))))
        .collect()
});
static COMMON: Pattern = Pattern::new(|| pattern(r"[\p{Script=Common}\p{Script=Inherited}]"));
static IDENTIFIER: Pattern = Pattern::new(|| pattern(r"^[\p{Ll}\p{Lo}\p{Lm}\p{Mn}\p{Mc}\p{Nd}-]$"));
static EXCLUDED: Pattern = Pattern::new(|| {
    pattern(concat!(
        r"[\x{0138}\x{0149}\x{017f}\x{01c4}-\x{01cc}\x{01dd}\x{0180}-\x{019f}\x{01a2}-\x{01ae}\x{01b1}-\x{01cc}\x{01f1}-\x{01f3}\x{01f6}\x{01f7}",
        r"\x{021c}\x{021d}\x{0220}-\x{0225}\x{0234}-\x{024f}",
        r"\x{0250}-\x{0258}\x{025a}-\x{02ff}",
        r"\x{0305}\x{030d}\x{030e}\x{0310}\x{0312}\x{0315}-\x{031a}\x{031c}-\x{0322}\x{0329}-\x{032c}\x{032f}\x{0332}-\x{0334}\x{0336}\x{0337}\x{033a}-\x{036f}",
        r"\x{0370}-\x{038f}\x{03cf}-\x{03ff}\x{1f00}-\x{1fff}",
        r"\x{0482}-\x{0489}",
        r"\x{1d00}-\x{1dbf}\x{1dc0}-\x{1dff}\x{2c60}-\x{2c7f}\x{a720}-\x{a7ff}\x{ab30}-\x{ab6f}",
        r"\x{10a0}-\x{10cf}\x{1c90}-\x{1cbf}",
        r"\x{0964}\x{0965}\x{0970}\x{0e2f}\x{0e46}\x{0eaf}\x{0ec6}\x{0f01}-\x{0f1f}\x{0f2a}-\x{0f3f}\x{104a}-\x{104f}\x{17d4}-\x{17d6}\x{17d8}-\x{17db}",
        r"\x{3031}-\x{3035}\x{303b}\x{303c}\x{3099}\x{309a}\x{309b}\x{309c}\x{309f}\x{30a0}\x{30ff}\x{3131}-\x{318e}",
        r"]",
    ))
});
// The combining marks come first: after a base character they would read as one glyph with it.
static ALLOWED_COMMON: Pattern = Pattern::new(|| {
    pattern(
        r"^[\x{0300}-\x{0304}\x{0306}-\x{030c}\x{030f}\x{0311}\x{0313}\x{0314}\x{031b}\x{0323}-\x{0328}\x{032d}\x{032e}\x{0330}\x{0331}\x{0335}\x{0338}\x{0339}\x{00b7}\x{30fb}\x{30fc}\x{3005}-\x{3007}-]$",
    )
});
static NUMBER: Pattern = Pattern::new(|| pattern(r"^\p{Nd}$"));
static MARK: Pattern = Pattern::new(|| pattern(r"^\p{M}$"));
static MARKS: Pattern = Pattern::new(|| pattern(r"\p{M}"));

fn is_allowed(c: &str) -> bool {
    if ALLOWED_COMMON.is_match(c) {
        return true;
    }
    if !IDENTIFIER.is_match(c) || EXCLUDED.is_match(c) {
        return false;
    }
    if c.nfkc().collect::<String>() != c || c.to_lowercase() != c {
        return false;
    }
    scripts_of(c).is_some()
}

fn scripts_of(c: &str) -> Option<Vec<&'static str>> {
    let scripts: Vec<&'static str> = SCRIPT_TESTS
        .iter()
        .filter(|(_, re)| re.is_match(c))
        .map(|(name, _)| *name)
        .collect();
    if !scripts.is_empty() {
        return Some(scripts);
    }
    COMMON.is_match(c).then(Vec::new)
}

fn augmented(scripts: &[&'static str]) -> BTreeSet<&'static str> {
    let mut set: BTreeSet<&'static str> = scripts.iter().copied().collect();
    if set.contains("Han") {
        set.extend(["Hanb", "Jpan", "Kore"]);
    }
    if set.contains("Hiragana") || set.contains("Katakana") {
        set.insert("Jpan");
    }
    if set.contains("Hangul") {
        set.insert("Kore");
    }
    if set.contains("Bopomofo") {
        set.insert("Hanb");
    }
    set
}

#[derive(PartialEq, Eq)]
enum Restriction {
    Ascii,
    Single,
    Highly,
    Moderately,
    Minimal,
}

fn intersect(sets: &[BTreeSet<&'static str>]) -> Option<BTreeSet<&'static str>> {
    let (first, rest) = sets.split_first()?;
    Some(rest.iter().fold(first.clone(), |acc, set| {
        acc.intersection(set).copied().collect()
    }))
}

fn restriction_level(chars: &[String]) -> Restriction {
    if chars.iter().all(|c| c.chars().all(|c| (c as u32) < 0x80)) {
        return Restriction::Ascii;
    }
    let sets: Vec<BTreeSet<&'static str>> = chars
        .iter()
        .map(|c| augmented(&scripts_of(c).unwrap_or_default()))
        .filter(|set| !set.is_empty())
        .collect();
    match intersect(&sets) {
        None => return Restriction::Single,
        Some(all) if !all.is_empty() => return Restriction::Single,
        _ => {}
    }
    let non_latin: Vec<BTreeSet<&'static str>> = sets
        .into_iter()
        .filter(|set| !set.contains("Latin"))
        .collect();
    let Some(non_latin) = intersect(&non_latin).filter(|set| !set.is_empty()) else {
        return Restriction::Minimal;
    };
    if ["Hanb", "Jpan", "Kore"]
        .iter()
        .any(|s| non_latin.contains(s))
    {
        return Restriction::Highly;
    }
    if !non_latin.contains("Cyrillic") && !non_latin.contains("Greek") {
        return Restriction::Moderately;
    }
    Restriction::Minimal
}

fn digit_systems(chars: &[String]) -> BTreeSet<u32> {
    let is_digit =
        |cp: u32| char::from_u32(cp).is_some_and(|c| NUMBER.is_match(c.encode_utf8(&mut [0; 4])));
    chars
        .iter()
        .filter(|c| NUMBER.is_match(c))
        .filter_map(|c| c.chars().next().map(u32::from))
        .map(|cp| {
            let mut zero = cp;
            while zero > 0 && is_digit(zero - 1) && cp - zero < 9 {
                zero -= 1;
            }
            zero
        })
        .collect()
}

// MARK: Chrome's extra checks

static DEVIATIONS: Pattern = Pattern::new(|| pattern(r"[\x{00df}\x{03c2}\x{200c}\x{200d}]"));
static DIGIT_LOOKALIKES: Pattern = Pattern::new(|| pattern(r"[θ२২੨૨೩೭Շзҙӡउওਤ੩૩౩ဒვპ੫丩ㄐճ৪੪୫૭୨౨]"));
static KANA_EXCEPTIONS: Pattern =
    Pattern::new(|| pattern(r"[\x{3078}-\x{307a}\x{30d8}-\x{30da}\x{30fb}-\x{30fe}]"));
static COMBINING_DIACRITICS: Pattern = Pattern::new(|| pattern(r"[\x{0300}-\x{0339}]"));
static NON_ASCII_LATIN: Pattern = Pattern::new(|| pattern(r"[\p{Script=Latin}--a-z]"));
static LGC_OR_ASCII: Pattern = Pattern::new(|| {
    pattern(r"^[\x{0300}-\x{0339}\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}0-9._-]*$")
});
static THORN_ETH: Pattern = Pattern::new(|| pattern(r"[þð]"));
static UNSAFE_DOT: Pattern = Pattern::new(|| pattern(r"[^l]·|·[^l]|^·|·$"));
static ASCII_DIGIT: Pattern = Pattern::new(|| pattern(r"^[0-9]$"));

struct WholeScript {
    script: Regex,
    lookalikes: Regex,
    tlds: &'static [&'static str],
}

static WHOLE_SCRIPT_CONFUSABLES: LazyLock<Vec<WholeScript>> = LazyLock::new(|| {
    [
        ("Armenian", "ագզէլհյնոսւօՙ", &["am"][..]),
        (
            "Cyrillic",
            "асԁеһіјӏорԗԛѕԝхуъЬҽпгѵѡ",
            &["bg", "by", "kz", "pyc", "ru", "su", "ua", "uz"][..],
        ),
        ("Ethiopic", "ሀሁሃሠሡሰሱሲቀቁበቡነኑኒከኮዐዑዕዖፀፁፐ", &["er", "et"][..]),
        ("Georgian", "იოყჽ", &["ge"][..]),
        ("Greek", "αικνρυωϲοτχ", &["gr"][..]),
        ("Hebrew", "דוחיןסם", &["il"][..]),
        ("Khmer", "ឧ", &["kh"][..]),
        ("Lao", "ບປຍຮຣຨຫອພຟຝ໐", &["la"][..]),
        ("Sinhala", "ථ", &["lk"][..]),
        ("Thai", "ทนบพรหเแ๐ดลปฟม", &["th"][..]),
    ]
    .into_iter()
    .map(|(script, lookalikes, tlds)| WholeScript {
        script: pattern(&format!(r"\p{{Script={script}}}")),
        lookalikes: pattern(&format!("[{lookalikes}]")),
        tlds,
    })
    .collect()
});

static DANGEROUS: LazyLock<Regex> = LazyLock::new(|| {
    let (katakana, hiragana, han) = (scx("Katakana"), scx("Hiragana"), scx("Han"));
    pattern(
        &[
            format!(r"[^{katakana}{hiragana}{han}][\x{{30ce}}\x{{30f3}}\x{{30bd}}\x{{30be}}\x{{4e36}}\x{{4e40}}\x{{4e41}}\x{{4e3f}}]"),
            format!(r"[\x{{30ce}}\x{{30f3}}\x{{30bd}}\x{{30be}}\x{{4e36}}\x{{4e40}}\x{{4e41}}\x{{4e3f}}][^{katakana}{hiragana}{han}]"),
            format!(r"^[{katakana}]+[\x{{3078}}-\x{{307a}}][{katakana}]+$"),
            format!(r"^[{hiragana}]+[\x{{30d8}}-\x{{30da}}][{hiragana}]+$"),
            format!(r"[^{katakana}{hiragana}]\x{{30fc}}|^\x{{30fc}}"),
            format!(r"[^{katakana}][\x{{30fd}}\x{{30fe}}]|^[\x{{30fd}}\x{{30fe}}]"),
            r"[a-z]\x{30fb}|\x{30fb}[a-z]".to_owned(),
            format!(r"[^{han}]\x{{4e00}}|\x{{4e00}}[^{han}]"),
            format!(r"[^{}]\x{{3127}}|\x{{3127}}[^{}]", scx("Bopomofo"), scx("Bopomofo")),
            format!(r"[^{}{}{}][\x{{0300}}-\x{{0339}}]", scx("Latin"), scx("Greek"), scx("Cyrillic")),
            r"\x{0131}[\x{0300}-\x{0339}]".to_owned(),
            r"[ijl\x{0131}]\x{0307}".to_owned(),
            r"[a-z][\x{0585}\x{0581}]|[\x{0585}\x{0581}][a-z]".to_owned(),
            format!(r"[{}][og]|[og][{}]", scx("Armenian"), scx("Armenian")),
            format!(r"[^{}][\x{{064b}}-\x{{0652}}\x{{0670}}]", scx("Arabic")),
            format!(r"[^{}]\x{{05b4}}", scx("Hebrew")),
        ]
        .join("|"),
    )
});

/// Why a host's label could pass for another's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SpoofReason {
    Invalid,
    DisallowedCharacter,
    Invisible,
    MixedNumbers,
    MixedScripts,
    DeviationCharacter,
    TldSpecificCharacter,
    UnsafeMiddleDot,
    DigitLookalikes,
    WholeScriptConfusable,
    NonAsciiLatinMixed,
    DangerousPattern,
    TopDomainLookalike,
}

/// The label's characters, each as a string (JavaScript's `Array.from`, by code point).
fn characters(label: &str) -> Vec<String> {
    label.chars().map(String::from).collect()
}

pub fn label_spoof_reason(label: &str, tld: &str) -> Option<SpoofReason> {
    let chars = characters(label);
    if chars.is_empty() {
        return Some(SpoofReason::Invalid);
    }
    if !chars.iter().all(|c| is_allowed(c)) {
        return Some(SpoofReason::DisallowedCharacter);
    }
    if chars
        .windows(2)
        .any(|pair| pair[0] == pair[1] && MARK.is_match(&pair[1]))
    {
        return Some(SpoofReason::Invisible);
    }
    if digit_systems(&chars).len() > 1 {
        return Some(SpoofReason::MixedNumbers);
    }
    let level = restriction_level(&chars);
    if level == Restriction::Minimal {
        return Some(SpoofReason::MixedScripts);
    }
    if DEVIATIONS.is_match(label) {
        return Some(SpoofReason::DeviationCharacter);
    }
    if chars.len() > 1 && tld != "is" && THORN_ETH.is_match(label) {
        return Some(SpoofReason::TldSpecificCharacter);
    }
    if chars.len() > 1 && tld != "az" && label.contains('ə') {
        return Some(SpoofReason::TldSpecificCharacter);
    }
    if label.contains('·') && (tld != "cat" || UNSAFE_DOT.is_match(label)) {
        return Some(SpoofReason::UnsafeMiddleDot);
    }
    if level == Restriction::Ascii {
        return None;
    }
    if DIGIT_LOOKALIKES.is_match(label)
        && chars
            .iter()
            .all(|c| ASCII_DIGIT.is_match(c) || DIGIT_LOOKALIKES.is_match(c))
    {
        return Some(SpoofReason::DigitLookalikes);
    }
    if level == Restriction::Single
        && !KANA_EXCEPTIONS.is_match(label)
        && !COMBINING_DIACRITICS.is_match(label)
    {
        let unicode_tld = decode_label(tld).unwrap_or_else(|| tld.to_owned());
        for whole in WHOLE_SCRIPT_CONFUSABLES.iter() {
            let letters: Vec<&String> = chars.iter().filter(|c| whole.script.is_match(c)).collect();
            if letters.is_empty() || !letters.iter().all(|c| whole.lookalikes.is_match(c)) {
                continue;
            }
            let tld_uses_script = characters(&unicode_tld)
                .iter()
                .all(|c| whole.script.is_match(c));
            if !whole.tlds.contains(&tld) && !tld_uses_script {
                return Some(SpoofReason::WholeScriptConfusable);
            }
        }
        return None;
    }
    if NON_ASCII_LATIN.is_match(label) && !LGC_OR_ASCII.is_match(label) {
        return Some(SpoofReason::NonAsciiLatinMixed);
    }
    if DANGEROUS.is_match(label) {
        return Some(SpoofReason::DangerousPattern);
    }
    None
}

fn decode_label(label: &str) -> Option<String> {
    if !label
        .get(..4)
        .is_some_and(|start| start.eq_ignore_ascii_case("xn--"))
    {
        return None;
    }
    let ascii = label[4..].to_lowercase();
    let unicode = punycode_decode(&ascii).filter(|unicode| !unicode.is_ascii())?;
    if unicode.nfc().collect::<String>() != unicode
        || unicode.to_lowercase() != unicode
        || punycode_encode(&unicode) != ascii
    {
        return None;
    }
    Some(unicode)
}

// MARK: Top domains

const TOP_DOMAINS: &str = "google.com youtube.com facebook.com instagram.com twitter.com x.com whatsapp.com wikipedia.org amazon.com \
apple.com icloud.com microsoft.com live.com outlook.com office.com bing.com linkedin.com netflix.com yahoo.com \
reddit.com tiktok.com github.com gitlab.com paypal.com ebay.com dropbox.com adobe.com spotify.com twitch.tv \
discord.com slack.com zoom.us notion.so figma.com openai.com chatgpt.com anthropic.com claude.ai stripe.com \
shopify.com coinbase.com binance.com kraken.com blockchain.com metamask.io chase.com bankofamerica.com \
wellsfargo.com citi.com americanexpress.com capitalone.com hsbc.com barclays.co.uk santander.com revolut.com \
wise.com venmo.com cash.app booking.com airbnb.com expedia.com uber.com lyft.com doordash.com walmart.com \
target.com bestbuy.com costco.com etsy.com aliexpress.com alibaba.com temu.com shein.com baidu.com qq.com \
weibo.com yandex.ru vk.com mail.ru ok.ru naver.com kakao.com line.me rakuten.co.jp yahoo.co.jp amazon.co.jp \
amazon.co.uk amazon.de amazon.fr amazon.in bbc.co.uk bbc.com cnn.com nytimes.com theguardian.com \
washingtonpost.com wsj.com bloomberg.com reuters.com forbes.com medium.com substack.com wordpress.com \
blogger.com tumblr.com pinterest.com quora.com stackoverflow.com imdb.com steampowered.com steamcommunity.com \
epicgames.com roblox.com playstation.com xbox.com nintendo.com ea.com battle.net salesforce.com atlassian.com \
trello.com asana.com canva.com docusign.com okta.com cloudflare.com godaddy.com squarespace.com wix.com \
mozilla.org duckduckgo.com proton.me protonmail.com gmail.com googledrive.com fedex.com ups.com usps.com dhl.com \
irs.gov gov.uk";

const CONFUSABLES: &[(&str, &str)] = &[
    ("ø", "o"),
    ("đ", "d"),
    ("ħ", "h"),
    ("ı", "i"),
    ("ł", "l"),
    ("ŧ", "t"),
    ("ð", "d"),
    ("þ", "p"),
    ("ə", "e"),
    ("ß", "ss"),
    ("œ", "oe"),
    ("æ", "ae"),
    ("а", "a"),
    ("в", "b"),
    ("е", "e"),
    ("з", "3"),
    ("и", "u"),
    ("к", "k"),
    ("м", "m"),
    ("н", "h"),
    ("о", "o"),
    ("п", "n"),
    ("р", "p"),
    ("с", "c"),
    ("т", "t"),
    ("у", "y"),
    ("х", "x"),
    ("ь", "b"),
    ("ѕ", "s"),
    ("і", "i"),
    ("ј", "j"),
    ("ԁ", "d"),
    ("һ", "h"),
    ("ӏ", "l"),
    ("ԛ", "q"),
    ("ԝ", "w"),
    ("ҽ", "e"),
    ("ѵ", "v"),
    ("ѡ", "w"),
    ("г", "r"),
    ("α", "a"),
    ("ι", "i"),
    ("κ", "k"),
    ("ν", "v"),
    ("ο", "o"),
    ("ρ", "p"),
    ("τ", "t"),
    ("υ", "u"),
    ("χ", "x"),
    ("ω", "w"),
    ("ϲ", "c"),
    ("օ", "o"),
    ("ս", "u"),
    ("հ", "h"),
    ("ց", "g"),
    ("ք", "p"),
    ("զ", "q"),
    ("ո", "n"),
    ("0", "o"),
    ("1", "l"),
    ("m", "rn"),
    ("w", "vv"),
];

fn skeleton(text: &str) -> String {
    let stripped = MARKS
        .replace_all(&text.nfd().collect::<String>(), "")
        .to_lowercase();
    let map: HashMap<char, &str> = CONFUSABLES
        .iter()
        .filter_map(|(from, to)| from.chars().next().map(|c| (c, *to)))
        .collect();
    stripped
        .chars()
        .map(|c| {
            map.get(&c)
                .map_or_else(|| c.to_string(), |to| (*to).to_owned())
        })
        .collect()
}

static TOP_SKELETONS: LazyLock<HashMap<String, &'static str>> = LazyLock::new(|| {
    TOP_DOMAINS
        .split(' ')
        .map(|domain| (skeleton(domain), domain))
        .collect()
});

/// A popular domain the host could pass for, when it isn't that domain.
pub fn similar_top_domain(host: &str) -> Option<String> {
    let bare = host.strip_prefix("www.").unwrap_or(host);
    let bare = bare.strip_suffix('.').unwrap_or(bare);
    let labels: Vec<&str> = bare.split('.').collect();
    let tail = |n: usize| labels[labels.len().saturating_sub(n)..].join(".");
    for candidate in [bare.to_owned(), tail(2), tail(3)] {
        if let Some(found) = TOP_SKELETONS
            .get(&skeleton(&candidate))
            .filter(|found| **found != candidate)
        {
            return Some((*found).to_owned());
        }
    }
    None
}

// MARK: Display

static PUNY_LABEL: Pattern = Pattern::new(|| pattern(r"(?i)(^|\.)xn--"));

/// A host as Bay shows it: Unicode labels where they can't pass for another site, `xn--…` where they could.
pub fn display_host(host: &str) -> String {
    if !PUNY_LABEL.is_match(host) {
        return host.to_owned();
    }
    let lower = host.to_lowercase();
    let labels: Vec<&str> = lower.split('.').collect();
    // `labels[length - 1] || labels[length - 2]`: a trailing dot leaves an empty label to step over.
    let last = labels.last().copied().unwrap_or_default();
    let tld = if last.is_empty() {
        labels.len().checked_sub(2).map_or("", |at| labels[at])
    } else {
        last
    };
    let tld_owned = tld.to_owned();
    let mut changed = false;
    let shown: Vec<String> = labels
        .iter()
        .map(|label| match decode_label(label) {
            Some(unicode) if label_spoof_reason(&unicode, &tld_owned).is_none() => {
                changed = true;
                unicode
            }
            _ => (*label).to_owned(),
        })
        .collect();
    let result = if changed {
        shown.join(".")
    } else {
        host.to_owned()
    };
    if changed && similar_top_domain(&result).is_some() {
        host.to_owned()
    } else {
        result
    }
}

pub fn host_spoof_reason(host: &str) -> Option<SpoofReason> {
    let lower = host.to_lowercase();
    let labels: Vec<&str> = lower.split('.').collect();
    let tld = labels.last().copied().unwrap_or_default();
    for label in &labels {
        if !label.starts_with("xn--") {
            continue;
        }
        let Some(unicode) = decode_label(label) else {
            return Some(SpoofReason::Invalid);
        };
        if let Some(reason) = label_spoof_reason(&unicode, tld) {
            return Some(reason);
        }
    }
    (display_host(host) == host && lower.split('.').any(|label| label.starts_with("xn--")))
        .then_some(SpoofReason::TopDomainLookalike)
}
