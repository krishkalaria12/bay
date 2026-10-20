import { UNIT_CATEGORIES, convertUnit, lookupUnit } from "./vendor/supercalculator/units.ts";

type Token = { type: "num"; value: number } | { type: "op"; value: string } | { type: "id"; value: string };

const CONSTANTS: Record<string, number> = { pi: Math.PI, π: Math.PI, e: Math.E, tau: 2 * Math.PI, τ: 2 * Math.PI };

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  ln: Math.log,
  log: (x, base) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base)),
  log2: Math.log2,
  log10: Math.log10,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
};

const OPERATOR_ALIASES: Record<string, string> = { "×": "*", "·": "*", "÷": "/", "−": "-", "–": "-", "**": "^" };

function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const space = /^\s+/.exec(rest);
    if (space) {
      i += space[0].length;
      continue;
    }
    const num = /^(\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(rest);
    if (num) {
      tokens.push({ type: "num", value: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const op = /^(\*\*|[-+*/^%!(),×·÷−–°])/.exec(rest);
    if (op) {
      tokens.push({ type: "op", value: OPERATOR_ALIASES[op[0]] ?? op[0] });
      i += op[0].length;
      continue;
    }
    const id = /^([a-z][a-z0-9]*|π|τ)/i.exec(rest);
    if (id) {
      tokens.push({ type: "id", value: id[0].toLowerCase() });
      i += id[0].length;
      continue;
    }
    return null;
  }
  return tokens;
}

class Parser {
  private i = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): number | null {
    const value = this.expr();
    return this.i === this.tokens.length ? value : null;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.i + offset];
  }

  private isOp(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t?.type === "op" && t.value === value;
  }

  private isId(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t?.type === "id" && t.value === value;
  }

  private startsPrimary(offset = 0): boolean {
    const t = this.peek(offset);
    return !!t && (t.type === "num" || (t.type === "id" && (t.value in CONSTANTS || t.value in FUNCTIONS)) || (t.type === "op" && t.value === "("));
  }

  private expr(): number {
    let value = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.tokens[this.i++] as { value: string }).value;
      const rhs = this.term();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  private term(): number {
    let value = this.unary();
    for (;;) {
      if (this.isOp("*") || this.isOp("/") || this.isId("mod") || this.isId("of") || this.isId("x")) {
        const t = this.tokens[this.i++]!;
        const rhs = this.unary();
        if (t.value === "/") value /= rhs;
        else if (t.value === "mod") value %= rhs;
        else value *= rhs;
      } else if (this.isOp("%") && this.startsPrimary(1)) {
        this.i++;
        value %= this.unary();
      } else if (this.peek()?.type !== "num" && this.startsPrimary()) {
        value *= this.unary();
      } else {
        return value;
      }
    }
  }

  private unary(): number {
    if (this.isOp("-")) {
      this.i++;
      return -this.unary();
    }
    if (this.isOp("+")) {
      this.i++;
      return this.unary();
    }
    return this.power();
  }

  private power(): number {
    const base = this.postfix();
    if (this.isOp("^")) {
      this.i++;
      return Math.pow(base, this.unary());
    }
    return base;
  }

  private postfix(): number {
    let value = this.primary();
    for (;;) {
      if (this.isOp("!")) {
        this.i++;
        value = factorial(value);
      } else if (this.isOp("%") && !this.startsPrimary(1)) {
        this.i++;
        value /= 100;
      } else if (this.isOp("°") || this.isId("deg") || this.isId("degrees")) {
        this.i++;
        value *= Math.PI / 180;
      } else {
        return value;
      }
    }
  }

  private primary(): number {
    const t = this.tokens[this.i++];
    if (!t) throw new SyntaxError("unexpected end");
    if (t.type === "num") return t.value;
    if (t.type === "op" && t.value === "(") {
      const value = this.expr();
      this.expect(")");
      return value;
    }
    if (t.type === "id" && t.value in CONSTANTS) return CONSTANTS[t.value]!;
    if (t.type === "id" && t.value in FUNCTIONS) {
      this.expect("(");
      const args = [this.expr()];
      while (this.isOp(",")) {
        this.i++;
        args.push(this.expr());
      }
      this.expect(")");
      return FUNCTIONS[t.value]!(...args);
    }
    throw new SyntaxError(`unexpected ${t.value}`);
  }

  private expect(op: string) {
    if (!this.isOp(op)) throw new SyntaxError(`expected ${op}`);
    this.i++;
  }
}

function factorial(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > 170) return NaN;
  let out = 1;
  for (let k = 2; k <= n; k++) out *= k;
  return out;
}

export function evaluate(expression: string): number | null {
  const source = /[a-z]\s*\(/i.test(expression) ? expression : expression.replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  const tokens = tokenize(source);
  if (!tokens?.length) return null;
  try {
    const value = new Parser(tokens).parse();
    return value !== null && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function formatNumber(value: number, digits = 12): string {
  if (value === 0) return "0";
  const rounded = Number(value.toPrecision(digits));
  const abs = Math.abs(rounded);
  if (abs >= 1e21 || abs < 1e-9) return rounded.toExponential().replace(/\.?0+e/, "e");
  return String(rounded);
}

const legacyLabels: Record<string, string> = {
  meter: "m",
  kilometer: "km",
  centimeter: "cm",
  millimeter: "mm",
  mile: "mi",
  yard: "yd",
  foot: "ft",
  inch: "in",
  "nautical mile": "nmi",
  kilogram: "kg",
  gram: "g",
  milligram: "mg",
  pound: "lb",
  ounce: "oz",
  stone: "st",
  "metric ton": "t",
  liter: "l",
  milliliter: "ml",
  gallon: "gal",
  quart: "qt",
  pint: "pt",
  cup: "cup",
  "fluid ounce": "fl oz",
  tablespoon: "tbsp",
  teaspoon: "tsp",
  millisecond: "ms",
  second: "s",
  minute: "min",
  hour: "h",
  day: "days",
  week: "weeks",
  year: "years",
  bit: "bits",
  byte: "bytes",
  kilobyte: "KB",
  megabyte: "MB",
  gigabyte: "GB",
  terabyte: "TB",
  kibibyte: "KiB",
  mebibyte: "MiB",
  gibibyte: "GiB",
  tebibyte: "TiB",
  "meter per second": "m/s",
  "kilometer per hour": "km/h",
  "mile per hour": "mph",
  knot: "knots",
  celsius: "°C",
  fahrenheit: "°F",
  kelvin: "K",
};

const unitAliases = new Set(UNIT_CATEGORIES.flatMap((category) => Object.keys(category.units).map((key) => key.toLowerCase())));
const unitPattern = [...unitAliases]
  .sort((a, b) => b.length - a.length)
  .map((unit) => unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s/g, "\\s*"))
  .join("|");
const CONVERSION = new RegExp(`^(.+?)\\s*(${unitPattern})\\s*(?:to|in|into|as|=|->|→)\\s*(${unitPattern})$`, "i");

function convert(input: string): { value: number; unit: string } | null {
  const m = CONVERSION.exec(input.replace(/²/g, "2").replace(/³/g, "3"));
  if (!m) return null;
  const amount = evaluate(m[1]!);
  if (amount === null) return null;
  const from = lookupUnit(m[2]!);
  const to = lookupUnit(m[3]!);
  if (!from || !to || from.category !== to.category) return null;
  const value = convertUnit(amount, from, to);
  if (!Number.isFinite(value)) return null;
  return { value, unit: legacyLabels[to.def.name] ?? to.def.name };
}

export type Calculation = { expression: string; value: number; display: string };

export function calculate(raw: string): Calculation | null {
  const expression = raw
    .trim()
    .replace(/^=\s*/, "")
    .replace(/\s*=\s*\??$/, "");
  if (!expression || expression.length > 200 || !/[\dπτ]|\b(pi|e|tau)\b/i.test(expression)) return null;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(expression) || /^\d+(\.\d+){2,}$/.test(expression)) return null;

  const converted = convert(expression);
  if (converted) {
    const display = `${formatNumber(converted.value, 9)} ${converted.unit}`;
    return { expression, value: converted.value, display };
  }
  const hasOperator = /[\w).πτ]\s*(\*\*|[-+*/^%×·÷−–]|mod|of|x)\s*[\d(.a-zπτ]/i.test(expression) || /[!%°]\s*$/.test(expression);
  const hasFunction = new RegExp(`\\b(${Object.keys(FUNCTIONS).join("|")})\\s*\\(`, "i").test(expression);
  if (!hasOperator && !hasFunction) return null;
  const value = evaluate(expression);
  if (value === null) return null;
  return { expression, value, display: formatNumber(value) };
}
