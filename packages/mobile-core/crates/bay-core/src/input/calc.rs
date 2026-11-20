//! The calculator in the search field: arithmetic with functions and constants, percentages, factorials, degrees,
//! and unit conversions ("12 km to miles"), shown as JavaScript would print the answer.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use super::{Pattern, fancy, pattern};
use crate::js;

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Num(f64),
    Op(String),
    Id(String),
}

const FUNCTIONS: [&str; 23] = [
    "sqrt", "cbrt", "abs", "sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh",
    "ln", "log", "log2", "log10", "exp", "floor", "ceil", "round", "min", "max", "pow",
];

fn constant(name: &str) -> Option<f64> {
    match name {
        "pi" | "π" => Some(std::f64::consts::PI),
        "e" => Some(std::f64::consts::E),
        "tau" | "τ" => Some(2.0 * std::f64::consts::PI),
        _ => None,
    }
}

/// A missing argument is `undefined`, which JavaScript's math reads as NaN.
fn call(name: &str, args: &[f64]) -> f64 {
    let arg = |i: usize| args.get(i).copied().unwrap_or(f64::NAN);
    let x = arg(0);
    match name {
        "sqrt" => libm::sqrt(x),
        "cbrt" => libm::cbrt(x),
        "abs" => x.abs(),
        "sin" => libm::sin(x),
        "cos" => libm::cos(x),
        "tan" => libm::tan(x),
        "asin" => libm::asin(x),
        "acos" => libm::acos(x),
        "atan" => libm::atan(x),
        "sinh" => libm::sinh(x),
        "cosh" => libm::cosh(x),
        "tanh" => libm::tanh(x),
        "ln" => libm::log(x),
        "log" => match args.get(1) {
            None => libm::log10(x),
            Some(base) => libm::log(x) / libm::log(*base),
        },
        "log2" => libm::log2(x),
        "log10" => libm::log10(x),
        "exp" => libm::exp(x),
        "floor" => x.floor(),
        "ceil" => x.ceil(),
        "round" => js::math_round(x),
        "min" => args.iter().copied().fold(f64::INFINITY, |a, b| {
            if a.is_nan() || b.is_nan() {
                f64::NAN
            } else {
                a.min(b)
            }
        }),
        "max" => args.iter().copied().fold(f64::NEG_INFINITY, |a, b| {
            if a.is_nan() || b.is_nan() {
                f64::NAN
            } else {
                a.max(b)
            }
        }),
        "pow" => js_pow(x, arg(1)),
        _ => f64::NAN,
    }
}

/// `Math.pow`: like `pow`, except that 1 to the power of ±∞ or NaN is NaN.
fn js_pow(base: f64, exponent: f64) -> f64 {
    if exponent.is_nan() || (base.abs() == 1.0 && exponent.is_infinite()) {
        f64::NAN
    } else {
        libm::pow(base, exponent)
    }
}

static SPACE: Pattern = Pattern::new(|| pattern(r"^\s+"));
static NUM: Pattern =
    Pattern::new(|| pattern(r"(?i)^([0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?"));
static OP: Pattern = Pattern::new(|| pattern(r"^(\*\*|[-+*/^%!(),×·÷−–°])"));
static ID: Pattern = Pattern::new(|| pattern(r"(?i)^([a-z][a-z0-9]*|π|τ)"));

fn alias(op: &str) -> &str {
    match op {
        "×" | "·" => "*",
        "÷" => "/",
        "−" | "–" => "-",
        "**" => "^",
        other => other,
    }
}

fn tokenize(source: &str) -> Option<Vec<Token>> {
    let mut tokens = Vec::new();
    let mut rest = source;
    while !rest.is_empty() {
        if let Some(space) = SPACE.find(rest) {
            rest = &rest[space.end()..];
        } else if let Some(num) = NUM.find(rest) {
            tokens.push(Token::Num(num.as_str().parse().ok()?));
            rest = &rest[num.end()..];
        } else if let Some(op) = OP.find(rest) {
            tokens.push(Token::Op(alias(op.as_str()).to_owned()));
            rest = &rest[op.end()..];
        } else {
            let id = ID.find(rest)?;
            tokens.push(Token::Id(id.as_str().to_lowercase()));
            rest = &rest[id.end()..];
        }
    }
    Some(tokens)
}

struct Parser {
    tokens: Vec<Token>,
    i: usize,
}

type Parsed = Result<f64, ()>;

impl Parser {
    fn peek(&self, offset: usize) -> Option<&Token> {
        self.tokens.get(self.i + offset)
    }

    fn is_op(&self, value: &str, offset: usize) -> bool {
        matches!(self.peek(offset), Some(Token::Op(op)) if op == value)
    }

    fn is_id(&self, value: &str) -> bool {
        matches!(self.peek(0), Some(Token::Id(id)) if id == value)
    }

    fn starts_primary(&self, offset: usize) -> bool {
        match self.peek(offset) {
            Some(Token::Num(_)) => true,
            Some(Token::Id(id)) => constant(id).is_some() || FUNCTIONS.contains(&id.as_str()),
            Some(Token::Op(op)) => op == "(",
            None => false,
        }
    }

    fn parse(&mut self) -> Option<f64> {
        let value = self.expr().ok()?;
        (self.i == self.tokens.len()).then_some(value)
    }

    fn expr(&mut self) -> Parsed {
        let mut value = self.term()?;
        while self.is_op("+", 0) || self.is_op("-", 0) {
            let plus = self.is_op("+", 0);
            self.i += 1;
            let rhs = self.term()?;
            value = if plus { value + rhs } else { value - rhs };
        }
        Ok(value)
    }

    fn term(&mut self) -> Parsed {
        let mut value = self.unary()?;
        loop {
            if self.is_op("*", 0)
                || self.is_op("/", 0)
                || self.is_id("mod")
                || self.is_id("of")
                || self.is_id("x")
            {
                let divide = self.is_op("/", 0);
                let modulo = self.is_id("mod");
                self.i += 1;
                let rhs = self.unary()?;
                if divide {
                    value /= rhs;
                } else if modulo {
                    value %= rhs;
                } else {
                    value *= rhs;
                }
            } else if self.is_op("%", 0) && self.starts_primary(1) {
                self.i += 1;
                value %= self.unary()?;
            } else if !matches!(self.peek(0), Some(Token::Num(_))) && self.starts_primary(0) {
                value *= self.unary()?;
            } else {
                return Ok(value);
            }
        }
    }

    fn unary(&mut self) -> Parsed {
        if self.is_op("-", 0) {
            self.i += 1;
            return Ok(-self.unary()?);
        }
        if self.is_op("+", 0) {
            self.i += 1;
            return self.unary();
        }
        self.power()
    }

    fn power(&mut self) -> Parsed {
        let base = self.postfix()?;
        if self.is_op("^", 0) {
            self.i += 1;
            return Ok(js_pow(base, self.unary()?));
        }
        Ok(base)
    }

    fn postfix(&mut self) -> Parsed {
        let mut value = self.primary()?;
        loop {
            if self.is_op("!", 0) {
                self.i += 1;
                value = factorial(value);
            } else if self.is_op("%", 0) && !self.starts_primary(1) {
                self.i += 1;
                value /= 100.0;
            } else if self.is_op("°", 0) || self.is_id("deg") || self.is_id("degrees") {
                self.i += 1;
                value *= std::f64::consts::PI / 180.0;
            } else {
                return Ok(value);
            }
        }
    }

    fn primary(&mut self) -> Parsed {
        let token = self.peek(0).cloned().ok_or(())?;
        self.i += 1;
        match token {
            Token::Num(value) => Ok(value),
            Token::Op(op) if op == "(" => {
                let value = self.expr()?;
                self.expect(")")?;
                Ok(value)
            }
            Token::Id(id) if constant(&id).is_some() => constant(&id).ok_or(()),
            Token::Id(id) if FUNCTIONS.contains(&id.as_str()) => {
                self.expect("(")?;
                let mut args = vec![self.expr()?];
                while self.is_op(",", 0) {
                    self.i += 1;
                    args.push(self.expr()?);
                }
                self.expect(")")?;
                Ok(call(&id, &args))
            }
            _ => Err(()),
        }
    }

    fn expect(&mut self, op: &str) -> Result<(), ()> {
        if !self.is_op(op, 0) {
            return Err(());
        }
        self.i += 1;
        Ok(())
    }
}

fn factorial(n: f64) -> f64 {
    if n.fract() != 0.0 || !n.is_finite() || !(0.0..=170.0).contains(&n) {
        return f64::NAN;
    }
    (2..=n as u32).fold(1.0, |out, k| out * f64::from(k))
}

static FUNCTION_CALL: Pattern = Pattern::new(|| pattern(r"(?i)[a-z]\s*\("));
static THOUSANDS: LazyLock<fancy_regex::Regex> =
    LazyLock::new(|| fancy(r"([0-9]),(?=[0-9]{3}(?![0-9]))"));

/// The expression's value, when it is one and finite.
pub fn evaluate(expression: &str) -> Option<f64> {
    let source = if FUNCTION_CALL.is_match(expression) {
        expression.to_owned()
    } else {
        THOUSANDS.replace_all(expression, "$1").into_owned()
    };
    let tokens = tokenize(&source).filter(|tokens| !tokens.is_empty())?;
    Parser { tokens, i: 0 }
        .parse()
        .filter(|value| value.is_finite())
}

static TRAILING_ZEROS: Pattern = Pattern::new(|| pattern(r"\.?0+e"));

/// A number as the calculator shows it: `digits` significant digits, exponents for the very large and small.
pub fn format_number(value: f64, digits: usize) -> String {
    if value == 0.0 {
        return "0".into();
    }
    let rounded = js::to_precision(value, digits);
    if rounded.abs() >= 1e21 || rounded.abs() < 1e-9 {
        return TRAILING_ZEROS
            .replace(&js::to_exponential(rounded), "e")
            .into_owned();
    }
    js::number_string(rounded)
}

// MARK: Units

#[derive(Deserialize)]
struct UnitDef {
    alias: String,
    factor: f64,
    name: String,
    #[serde(default)]
    offset: Option<f64>,
}

#[derive(Deserialize)]
struct Category {
    name: String,
    units: Vec<UnitDef>,
}

struct Units {
    categories: Vec<Category>,
    /// Alias → (category, unit), a later alias replacing an earlier one, as the table's map does.
    index: HashMap<String, (usize, usize)>,
    conversion: regex::Regex,
}

static UNITS: LazyLock<Units> = LazyLock::new(|| {
    let categories: Vec<Category> =
        serde_json::from_str(include_str!("../../../../data/units.json"))
            .expect("data/units.json reads");
    let mut index = HashMap::new();
    let mut aliases: Vec<String> = Vec::new();
    for (c, category) in categories.iter().enumerate() {
        for (u, unit) in category.units.iter().enumerate() {
            index.insert(unit.alias.clone(), (c, u));
            let lower = unit.alias.to_lowercase();
            if !aliases.contains(&lower) {
                aliases.push(lower);
            }
        }
    }
    aliases.sort_by_key(|alias| std::cmp::Reverse(js::utf16_len(alias)));
    let units = aliases
        .iter()
        .map(|alias| regex::escape(alias).replace(' ', r"\s*"))
        .collect::<Vec<_>>()
        .join("|");
    let conversion = pattern(&format!(
        r"(?i)^(.+?)\s*({units})\s*(?:to|in|into|as|=|->|→)\s*({units})$"
    ));
    Units {
        categories,
        index,
        conversion,
    }
});

fn lookup_unit(token: &str) -> Option<(usize, usize)> {
    let units = &*UNITS;
    let normalized = token
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace('²', "2")
        .replace('³', "3");
    units
        .index
        .get(js::trim(token))
        .or_else(|| units.index.get(js::trim(&normalized)))
        .copied()
}

fn legacy_label(name: &str) -> &str {
    match name {
        "meter" => "m",
        "kilometer" => "km",
        "centimeter" => "cm",
        "millimeter" => "mm",
        "mile" => "mi",
        "yard" => "yd",
        "foot" => "ft",
        "inch" => "in",
        "nautical mile" => "nmi",
        "kilogram" => "kg",
        "gram" => "g",
        "milligram" => "mg",
        "pound" => "lb",
        "ounce" => "oz",
        "stone" => "st",
        "metric ton" => "t",
        "liter" => "l",
        "milliliter" => "ml",
        "gallon" => "gal",
        "quart" => "qt",
        "pint" => "pt",
        "cup" => "cup",
        "fluid ounce" => "fl oz",
        "tablespoon" => "tbsp",
        "teaspoon" => "tsp",
        "millisecond" => "ms",
        "second" => "s",
        "minute" => "min",
        "hour" => "h",
        "day" => "days",
        "week" => "weeks",
        "year" => "years",
        "bit" => "bits",
        "byte" => "bytes",
        "kilobyte" => "KB",
        "megabyte" => "MB",
        "gigabyte" => "GB",
        "terabyte" => "TB",
        "kibibyte" => "KiB",
        "mebibyte" => "MiB",
        "gibibyte" => "GiB",
        "tebibyte" => "TiB",
        "meter per second" => "m/s",
        "kilometer per hour" => "km/h",
        "mile per hour" => "mph",
        "knot" => "knots",
        "celsius" => "°C",
        "fahrenheit" => "°F",
        "kelvin" => "K",
        other => other,
    }
}

fn convert(input: &str) -> Option<(f64, String)> {
    let units = &*UNITS;
    let input = input.replace('²', "2").replace('³', "3");
    let m = units.conversion.captures(&input)?;
    let amount = evaluate(&m[1])?;
    let (from_category, from) = lookup_unit(&m[2])?;
    let (to_category, to) = lookup_unit(&m[3])?;
    if from_category != to_category {
        return None;
    }
    let category = &units.categories[from_category];
    let (from, to) = (&category.units[from], &category.units[to]);
    let value = if category.name == "temperature" {
        // Celsius directly, so freezing points don't gather error through Kelvin (32 F is exactly 0 C).
        if from.name == to.name {
            amount
        } else {
            let celsius = match from.name.as_str() {
                "fahrenheit" => ((amount - 32.0) * 5.0) / 9.0,
                "kelvin" => amount - 273.15,
                _ => amount,
            };
            match to.name.as_str() {
                "fahrenheit" => (celsius * 9.0) / 5.0 + 32.0,
                "kelvin" => celsius + 273.15,
                _ => celsius,
            }
        }
    } else {
        let _ = from.offset;
        (amount * from.factor) / to.factor
    };
    value
        .is_finite()
        .then(|| (value, legacy_label(&to.name).to_owned()))
}

/// A calculation's expression, value and how the field shows it.
#[derive(Debug, Clone, PartialEq, Serialize, uniffi::Record)]
pub struct Calculation {
    pub expression: String,
    pub value: f64,
    pub display: String,
}

static LEADING_EQUALS: Pattern = Pattern::new(|| pattern(r"^=\s*"));
static TRAILING_EQUALS: Pattern = Pattern::new(|| pattern(r"\s*=\s*\??$"));
static HAS_NUMBER: Pattern = Pattern::new(|| pattern(r"(?i)[0-9πτ]|(?-u:\b)(pi|e|tau)(?-u:\b)"));
static DATE: Pattern = Pattern::new(|| pattern(r"^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}$"));
static VERSION: Pattern = Pattern::new(|| pattern(r"^[0-9]+(\.[0-9]+){2,}$"));
static HAS_OPERATOR: Pattern = Pattern::new(|| {
    pattern(r"(?i)[A-Za-z0-9_).πτ]\s*(\*\*|[-+*/^%×·÷−–]|mod|of|x)\s*[0-9(.a-zπτ]")
});
static ENDS_POSTFIX: Pattern = Pattern::new(|| pattern(r"[!%°]\s*$"));
static HAS_FUNCTION: Pattern =
    Pattern::new(|| pattern(&format!(r"(?i)(?-u:\b)({})\s*\(", FUNCTIONS.join("|"))));

/// What the search field shows for typed math or a unit conversion, if it is one.
pub fn calculate(raw: &str) -> Option<Calculation> {
    let expression = TRAILING_EQUALS
        .replace(&LEADING_EQUALS.replace(js::trim(raw), ""), "")
        .into_owned();
    if expression.is_empty()
        || js::utf16_len(&expression) > 200
        || !HAS_NUMBER.is_match(&expression)
    {
        return None;
    }
    if DATE.is_match(&expression) || VERSION.is_match(&expression) {
        return None;
    }
    if let Some((value, unit)) = convert(&expression) {
        let display = format!("{} {unit}", format_number(value, 9));
        return Some(Calculation {
            expression,
            value,
            display,
        });
    }
    if !HAS_OPERATOR.is_match(&expression)
        && !ENDS_POSTFIX.is_match(&expression)
        && !HAS_FUNCTION.is_match(&expression)
    {
        return None;
    }
    let value = evaluate(&expression)?;
    Some(Calculation {
        display: format_number(value, 12),
        expression,
        value,
    })
}
