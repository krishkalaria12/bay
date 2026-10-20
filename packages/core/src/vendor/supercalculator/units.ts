// ─── Unit Conversion Data ───────────────────────────────────
// Each category maps unit aliases → { factor, offset? }
// Conversion: (value - fromOffset) * (toFactor / fromFactor) + toOffset
// For most units offset=0; temperature is the exception.

export interface UnitDef {
  /** Multiplier to convert 1 of this unit to the base unit */
  factor: number;
  /** Additive offset (for temperature) — applied before factor */
  offset?: number;
  /** Display name */
  name: string;
}

export interface UnitCategory {
  name: string;
  base: string;
  units: Record<string, UnitDef>;
}

function u(factor: number, name: string, offset?: number): UnitDef {
  return offset !== undefined ? { factor, name, offset } : { factor, name };
}

// ─── LENGTH (base: meter) ───────────────────────────────────
const length: UnitCategory = {
  name: "length",
  base: "meter",
  units: {
    // Metric
    nm: u(1e-9, "nanometer"),
    nanometer: u(1e-9, "nanometer"),
    nanometers: u(1e-9, "nanometer"),
    um: u(1e-6, "micrometer"),
    micrometer: u(1e-6, "micrometer"),
    micrometers: u(1e-6, "micrometer"),
    micron: u(1e-6, "micrometer"),
    microns: u(1e-6, "micrometer"),
    mm: u(0.001, "millimeter"),
    millimeter: u(0.001, "millimeter"),
    millimeters: u(0.001, "millimeter"),
    millimetre: u(0.001, "millimeter"),
    millimetres: u(0.001, "millimeter"),
    cm: u(0.01, "centimeter"),
    centimeter: u(0.01, "centimeter"),
    centimeters: u(0.01, "centimeter"),
    centimetre: u(0.01, "centimeter"),
    centimetres: u(0.01, "centimeter"),
    dm: u(0.1, "decimeter"),
    decimeter: u(0.1, "decimeter"),
    decimeters: u(0.1, "decimeter"),
    m: u(1, "meter"),
    meter: u(1, "meter"),
    meters: u(1, "meter"),
    metre: u(1, "meter"),
    metres: u(1, "meter"),
    km: u(1000, "kilometer"),
    kilometer: u(1000, "kilometer"),
    kilometers: u(1000, "kilometer"),
    kilometre: u(1000, "kilometer"),
    kilometres: u(1000, "kilometer"),
    // Imperial
    in: u(0.0254, "inch"),
    inch: u(0.0254, "inch"),
    inches: u(0.0254, "inch"),
    '"': u(0.0254, "inch"),
    ft: u(0.3048, "foot"),
    foot: u(0.3048, "foot"),
    feet: u(0.3048, "foot"),
    "'": u(0.3048, "foot"),
    yd: u(0.9144, "yard"),
    yard: u(0.9144, "yard"),
    yards: u(0.9144, "yard"),
    mi: u(1609.344, "mile"),
    mile: u(1609.344, "mile"),
    miles: u(1609.344, "mile"),
    nmi: u(1852, "nautical mile"),
    "nautical mile": u(1852, "nautical mile"),
    "nautical miles": u(1852, "nautical mile"),
    // Astronomical
    au: u(1.495978707e11, "astronomical unit"),
    "astronomical unit": u(1.495978707e11, "astronomical unit"),
    ly: u(9.4607e15, "light year"),
    "light year": u(9.4607e15, "light year"),
    "light years": u(9.4607e15, "light year"),
    lightyear: u(9.4607e15, "light year"),
    lightyears: u(9.4607e15, "light year"),
    pc: u(3.0857e16, "parsec"),
    parsec: u(3.0857e16, "parsec"),
    parsecs: u(3.0857e16, "parsec"),
  },
};

// ─── MASS (base: kilogram) ──────────────────────────────────
const mass: UnitCategory = {
  name: "mass",
  base: "kilogram",
  units: {
    ug: u(1e-9, "microgram"),
    microgram: u(1e-9, "microgram"),
    micrograms: u(1e-9, "microgram"),
    mcg: u(1e-9, "microgram"),
    mg: u(1e-6, "milligram"),
    milligram: u(1e-6, "milligram"),
    milligrams: u(1e-6, "milligram"),
    g: u(0.001, "gram"),
    gram: u(0.001, "gram"),
    grams: u(0.001, "gram"),
    kg: u(1, "kilogram"),
    kilogram: u(1, "kilogram"),
    kilograms: u(1, "kilogram"),
    kilo: u(1, "kilogram"),
    kilos: u(1, "kilogram"),
    tonne: u(1000, "metric ton"),
    tonnes: u(1000, "metric ton"),
    "metric ton": u(1000, "metric ton"),
    "metric tons": u(1000, "metric ton"),
    t: u(1000, "metric ton"),
    oz: u(0.028349523125, "ounce"),
    ounce: u(0.028349523125, "ounce"),
    ounces: u(0.028349523125, "ounce"),
    lb: u(0.45359237, "pound"),
    lbs: u(0.45359237, "pound"),
    pound: u(0.45359237, "pound"),
    pounds: u(0.45359237, "pound"),
    st: u(6.35029318, "stone"),
    stone: u(6.35029318, "stone"),
    stones: u(6.35029318, "stone"),
    "short ton": u(907.18474, "short ton"),
    "short tons": u(907.18474, "short ton"),
    "long ton": u(1016.0469088, "long ton"),
    "long tons": u(1016.0469088, "long ton"),
    grain: u(6.479891e-5, "grain"),
    grains: u(6.479891e-5, "grain"),
    gr: u(6.479891e-5, "grain"),
    carat: u(0.0002, "carat"),
    carats: u(0.0002, "carat"),
    ct: u(0.0002, "carat"),
  },
};

// ─── VOLUME (base: liter) ───────────────────────────────────
const volume: UnitCategory = {
  name: "volume",
  base: "liter",
  units: {
    ml: u(0.001, "milliliter"),
    milliliter: u(0.001, "milliliter"),
    milliliters: u(0.001, "milliliter"),
    millilitre: u(0.001, "milliliter"),
    millilitres: u(0.001, "milliliter"),
    cl: u(0.01, "centiliter"),
    centiliter: u(0.01, "centiliter"),
    centiliters: u(0.01, "centiliter"),
    dl: u(0.1, "deciliter"),
    deciliter: u(0.1, "deciliter"),
    deciliters: u(0.1, "deciliter"),
    l: u(1, "liter"),
    liter: u(1, "liter"),
    liters: u(1, "liter"),
    litre: u(1, "liter"),
    litres: u(1, "liter"),
    kl: u(1000, "kiloliter"),
    kiloliter: u(1000, "kiloliter"),
    kiloliters: u(1000, "kiloliter"),
    m3: u(1000, "cubic meter"),
    "cubic meter": u(1000, "cubic meter"),
    "cubic meters": u(1000, "cubic meter"),
    "cubic metre": u(1000, "cubic meter"),
    cm3: u(0.001, "cubic centimeter"),
    "cubic centimeter": u(0.001, "cubic centimeter"),
    "cubic centimeters": u(0.001, "cubic centimeter"),
    cc: u(0.001, "cubic centimeter"),
    tsp: u(0.00492892159375, "teaspoon"),
    teaspoon: u(0.00492892159375, "teaspoon"),
    teaspoons: u(0.00492892159375, "teaspoon"),
    tbsp: u(0.01478676478125, "tablespoon"),
    tablespoon: u(0.01478676478125, "tablespoon"),
    tablespoons: u(0.01478676478125, "tablespoon"),
    "fl oz": u(0.0295735295625, "fluid ounce"),
    "fluid ounce": u(0.0295735295625, "fluid ounce"),
    "fluid ounces": u(0.0295735295625, "fluid ounce"),
    floz: u(0.0295735295625, "fluid ounce"),
    cup: u(0.2365882365, "cup"),
    cups: u(0.2365882365, "cup"),
    pt: u(0.473176473, "pint"),
    pint: u(0.473176473, "pint"),
    pints: u(0.473176473, "pint"),
    qt: u(0.946352946, "quart"),
    quart: u(0.946352946, "quart"),
    quarts: u(0.946352946, "quart"),
    gal: u(3.785411784, "gallon"),
    gallon: u(3.785411784, "gallon"),
    gallons: u(3.785411784, "gallon"),
    "imp gal": u(4.54609, "imperial gallon"),
    "imperial gallon": u(4.54609, "imperial gallon"),
    "imperial gallons": u(4.54609, "imperial gallon"),
    "imp pt": u(0.568261, "imperial pint"),
    "imperial pint": u(0.568261, "imperial pint"),
    bbl: u(158.987, "barrel"),
    barrel: u(158.987, "barrel"),
    barrels: u(158.987, "barrel"),
  },
};

// ─── AREA (base: square meter) ──────────────────────────────
const area: UnitCategory = {
  name: "area",
  base: "square meter",
  units: {
    mm2: u(1e-6, "square millimeter"),
    "sq mm": u(1e-6, "square millimeter"),
    "square millimeter": u(1e-6, "square millimeter"),
    "square millimeters": u(1e-6, "square millimeter"),
    cm2: u(1e-4, "square centimeter"),
    "sq cm": u(1e-4, "square centimeter"),
    "square centimeter": u(1e-4, "square centimeter"),
    "square centimeters": u(1e-4, "square centimeter"),
    m2: u(1, "square meter"),
    "sq m": u(1, "square meter"),
    "square meter": u(1, "square meter"),
    "square meters": u(1, "square meter"),
    "square metre": u(1, "square meter"),
    km2: u(1e6, "square kilometer"),
    "sq km": u(1e6, "square kilometer"),
    "square kilometer": u(1e6, "square kilometer"),
    "square kilometers": u(1e6, "square kilometer"),
    in2: u(0.00064516, "square inch"),
    "sq in": u(0.00064516, "square inch"),
    "square inch": u(0.00064516, "square inch"),
    "square inches": u(0.00064516, "square inch"),
    ft2: u(0.092903, "square foot"),
    "sq ft": u(0.092903, "square foot"),
    "square foot": u(0.092903, "square foot"),
    "square feet": u(0.092903, "square foot"),
    sqft: u(0.092903, "square foot"),
    yd2: u(0.836127, "square yard"),
    "sq yd": u(0.836127, "square yard"),
    "square yard": u(0.836127, "square yard"),
    "square yards": u(0.836127, "square yard"),
    mi2: u(2589988.11, "square mile"),
    "sq mi": u(2589988.11, "square mile"),
    "square mile": u(2589988.11, "square mile"),
    "square miles": u(2589988.11, "square mile"),
    acre: u(4046.8564224, "acre"),
    acres: u(4046.8564224, "acre"),
    ac: u(4046.8564224, "acre"),
    hectare: u(10000, "hectare"),
    hectares: u(10000, "hectare"),
    ha: u(10000, "hectare"),
  },
};

// ─── TEMPERATURE (special: uses offset) ─────────────────────
// We use a custom conversion function for temperature
const temperature: UnitCategory = {
  name: "temperature",
  base: "kelvin",
  units: {
    // factor=1 offset=0 for kelvin (base)
    k: u(1, "kelvin", 0),
    kelvin: u(1, "kelvin", 0),
    // Celsius: K = C + 273.15
    c: u(1, "celsius", 273.15),
    celsius: u(1, "celsius", 273.15),
    "°c": u(1, "celsius", 273.15),
    centigrade: u(1, "celsius", 273.15),
    // Fahrenheit: K = (F + 459.67) * 5/9
    f: u(5 / 9, "fahrenheit", 459.67),
    fahrenheit: u(5 / 9, "fahrenheit", 459.67),
    "°f": u(5 / 9, "fahrenheit", 459.67),
  },
};

// ─── SPEED (base: meter/second) ─────────────────────────────
const speed: UnitCategory = {
  name: "speed",
  base: "meter per second",
  units: {
    mps: u(1, "meter per second"),
    "m/s": u(1, "meter per second"),
    "meter per second": u(1, "meter per second"),
    "meters per second": u(1, "meter per second"),
    "km/h": u(1 / 3.6, "kilometer per hour"),
    kmh: u(1 / 3.6, "kilometer per hour"),
    kph: u(1 / 3.6, "kilometer per hour"),
    kmph: u(1 / 3.6, "kilometer per hour"),
    "kilometer per hour": u(1 / 3.6, "kilometer per hour"),
    "kilometers per hour": u(1 / 3.6, "kilometer per hour"),
    mph: u(0.44704, "mile per hour"),
    "mile per hour": u(0.44704, "mile per hour"),
    "miles per hour": u(0.44704, "mile per hour"),
    fps: u(0.3048, "foot per second"),
    "ft/s": u(0.3048, "foot per second"),
    "feet per second": u(0.3048, "foot per second"),
    knot: u(1852 / 3600, "knot"),
    knots: u(1852 / 3600, "knot"),
    kn: u(1852 / 3600, "knot"),
    kt: u(1852 / 3600, "knot"),
    mach: u(343, "mach"),
  },
};

// ─── TIME DURATION (base: second) ───────────────────────────
const timeDuration: UnitCategory = {
  name: "time",
  base: "second",
  units: {
    ns: u(1e-9, "nanosecond"),
    nanosecond: u(1e-9, "nanosecond"),
    nanoseconds: u(1e-9, "nanosecond"),
    us: u(1e-6, "microsecond"),
    microsecond: u(1e-6, "microsecond"),
    microseconds: u(1e-6, "microsecond"),
    μs: u(1e-6, "microsecond"),
    ms: u(0.001, "millisecond"),
    millisecond: u(0.001, "millisecond"),
    milliseconds: u(0.001, "millisecond"),
    s: u(1, "second"),
    sec: u(1, "second"),
    secs: u(1, "second"),
    second: u(1, "second"),
    seconds: u(1, "second"),
    min: u(60, "minute"),
    minute: u(60, "minute"),
    minutes: u(60, "minute"),
    mins: u(60, "minute"),
    h: u(3600, "hour"),
    hr: u(3600, "hour"),
    hrs: u(3600, "hour"),
    hour: u(3600, "hour"),
    hours: u(3600, "hour"),
    d: u(86400, "day"),
    day: u(86400, "day"),
    days: u(86400, "day"),
    wk: u(604800, "week"),
    week: u(604800, "week"),
    weeks: u(604800, "week"),
    mo: u(2629746, "month"),
    month: u(2629746, "month"),
    months: u(2629746, "month"),
    yr: u(31556952, "year"),
    year: u(31556952, "year"),
    years: u(31556952, "year"),
    decade: u(315569520, "decade"),
    decades: u(315569520, "decade"),
    century: u(3155695200, "century"),
    centuries: u(3155695200, "century"),
  },
};

// ─── DATA SIZE (base: byte) ─────────────────────────────────
const dataSize: UnitCategory = {
  name: "data",
  base: "byte",
  units: {
    b: u(1, "byte"),
    byte: u(1, "byte"),
    bytes: u(1, "byte"),
    kb: u(1000, "kilobyte"),
    kilobyte: u(1000, "kilobyte"),
    kilobytes: u(1000, "kilobyte"),
    mb: u(1e6, "megabyte"),
    megabyte: u(1e6, "megabyte"),
    megabytes: u(1e6, "megabyte"),
    gb: u(1e9, "gigabyte"),
    gigabyte: u(1e9, "gigabyte"),
    gigabytes: u(1e9, "gigabyte"),
    tb: u(1e12, "terabyte"),
    terabyte: u(1e12, "terabyte"),
    terabytes: u(1e12, "terabyte"),
    pb: u(1e15, "petabyte"),
    petabyte: u(1e15, "petabyte"),
    petabytes: u(1e15, "petabyte"),
    eb: u(1e18, "exabyte"),
    exabyte: u(1e18, "exabyte"),
    exabytes: u(1e18, "exabyte"),
    kib: u(1024, "kibibyte"),
    kibibyte: u(1024, "kibibyte"),
    kibibytes: u(1024, "kibibyte"),
    mib: u(1048576, "mebibyte"),
    mebibyte: u(1048576, "mebibyte"),
    mebibytes: u(1048576, "mebibyte"),
    gib: u(1073741824, "gibibyte"),
    gibibyte: u(1073741824, "gibibyte"),
    gibibytes: u(1073741824, "gibibyte"),
    tib: u(1099511627776, "tebibyte"),
    tebibyte: u(1099511627776, "tebibyte"),
    tebibytes: u(1099511627776, "tebibyte"),
    bit: u(0.125, "bit"),
    bits: u(0.125, "bit"),
    kbit: u(125, "kilobit"),
    kilobit: u(125, "kilobit"),
    kilobits: u(125, "kilobit"),
    mbit: u(125000, "megabit"),
    megabit: u(125000, "megabit"),
    megabits: u(125000, "megabit"),
    gbit: u(125000000, "gigabit"),
    gigabit: u(125000000, "gigabit"),
    gigabits: u(125000000, "gigabit"),
  },
};

// ─── PRESSURE (base: pascal) ────────────────────────────────
const pressure: UnitCategory = {
  name: "pressure",
  base: "pascal",
  units: {
    pa: u(1, "pascal"),
    pascal: u(1, "pascal"),
    pascals: u(1, "pascal"),
    hpa: u(100, "hectopascal"),
    hectopascal: u(100, "hectopascal"),
    kpa: u(1000, "kilopascal"),
    kilopascal: u(1000, "kilopascal"),
    mpa: u(1e6, "megapascal"),
    megapascal: u(1e6, "megapascal"),
    bar: u(100000, "bar"),
    bars: u(100000, "bar"),
    mbar: u(100, "millibar"),
    millibar: u(100, "millibar"),
    atm: u(101325, "atmosphere"),
    atmosphere: u(101325, "atmosphere"),
    atmospheres: u(101325, "atmosphere"),
    psi: u(6894.757, "psi"),
    torr: u(133.322, "torr"),
    mmhg: u(133.322, "mmHg"),
    inhg: u(3386.39, "inHg"),
  },
};

// ─── ENERGY (base: joule) ───────────────────────────────────
const energy: UnitCategory = {
  name: "energy",
  base: "joule",
  units: {
    j: u(1, "joule"),
    joule: u(1, "joule"),
    joules: u(1, "joule"),
    kj: u(1000, "kilojoule"),
    kilojoule: u(1000, "kilojoule"),
    kilojoules: u(1000, "kilojoule"),
    mj: u(1e6, "megajoule"),
    megajoule: u(1e6, "megajoule"),
    cal: u(4.184, "calorie"),
    calorie: u(4.184, "calorie"),
    calories: u(4.184, "calorie"),
    kcal: u(4184, "kilocalorie"),
    kilocalorie: u(4184, "kilocalorie"),
    kilocalories: u(4184, "kilocalorie"),
    wh: u(3600, "watt-hour"),
    "watt-hour": u(3600, "watt-hour"),
    "watt hour": u(3600, "watt-hour"),
    kwh: u(3600000, "kilowatt-hour"),
    "kilowatt-hour": u(3600000, "kilowatt-hour"),
    "kilowatt hour": u(3600000, "kilowatt-hour"),
    btu: u(1055.06, "BTU"),
    "british thermal unit": u(1055.06, "BTU"),
    ev: u(1.602176634e-19, "electronvolt"),
    electronvolt: u(1.602176634e-19, "electronvolt"),
    erg: u(1e-7, "erg"),
    ergs: u(1e-7, "erg"),
    therm: u(1.055e8, "therm"),
    therms: u(1.055e8, "therm"),
  },
};

// ─── POWER (base: watt) ─────────────────────────────────────
const power: UnitCategory = {
  name: "power",
  base: "watt",
  units: {
    w: u(1, "watt"),
    watt: u(1, "watt"),
    watts: u(1, "watt"),
    mw: u(0.001, "milliwatt"),
    milliwatt: u(0.001, "milliwatt"),
    kw: u(1000, "kilowatt"),
    kilowatt: u(1000, "kilowatt"),
    kilowatts: u(1000, "kilowatt"),
    megawatt: u(1e6, "megawatt"),
    MW: u(1e6, "megawatt"),
    megawatts: u(1e6, "megawatt"),
    gw: u(1e9, "gigawatt"),
    gigawatt: u(1e9, "gigawatt"),
    gigawatts: u(1e9, "gigawatt"),
    hp: u(745.7, "horsepower"),
    horsepower: u(745.7, "horsepower"),
    "metric hp": u(735.499, "metric horsepower"),
    ps: u(735.499, "metric horsepower"),
    "btu/h": u(0.293071, "BTU per hour"),
  },
};

// ─── ANGLE (base: radian) ───────────────────────────────────
const angle: UnitCategory = {
  name: "angle",
  base: "radian",
  units: {
    rad: u(1, "radian"),
    radian: u(1, "radian"),
    radians: u(1, "radian"),
    deg: u(Math.PI / 180, "degree"),
    degree: u(Math.PI / 180, "degree"),
    degrees: u(Math.PI / 180, "degree"),
    "°": u(Math.PI / 180, "degree"),
    grad: u(Math.PI / 200, "gradian"),
    gradian: u(Math.PI / 200, "gradian"),
    gradians: u(Math.PI / 200, "gradian"),
    gon: u(Math.PI / 200, "gradian"),
    arcmin: u(Math.PI / 10800, "arcminute"),
    arcminute: u(Math.PI / 10800, "arcminute"),
    arcminutes: u(Math.PI / 10800, "arcminute"),
    "'": u(Math.PI / 10800, "arcminute"),
    arcsec: u(Math.PI / 648000, "arcsecond"),
    arcsecond: u(Math.PI / 648000, "arcsecond"),
    arcseconds: u(Math.PI / 648000, "arcsecond"),
    rev: u(2 * Math.PI, "revolution"),
    revolution: u(2 * Math.PI, "revolution"),
    revolutions: u(2 * Math.PI, "revolution"),
    turn: u(2 * Math.PI, "revolution"),
    turns: u(2 * Math.PI, "revolution"),
  },
};

// ─── FREQUENCY (base: hertz) ────────────────────────────────
const frequency: UnitCategory = {
  name: "frequency",
  base: "hertz",
  units: {
    hz: u(1, "hertz"),
    hertz: u(1, "hertz"),
    khz: u(1000, "kilohertz"),
    kilohertz: u(1000, "kilohertz"),
    mhz: u(1e6, "megahertz"),
    megahertz: u(1e6, "megahertz"),
    ghz: u(1e9, "gigahertz"),
    gigahertz: u(1e9, "gigahertz"),
    thz: u(1e12, "terahertz"),
    terahertz: u(1e12, "terahertz"),
    rpm: u(1 / 60, "RPM"),
  },
};

// ─── ELECTRIC CURRENT (base: ampere) ────────────────────────
const electricCurrent: UnitCategory = {
  name: "electric current",
  base: "ampere",
  units: {
    a: u(1, "ampere"),
    amp: u(1, "ampere"),
    amps: u(1, "ampere"),
    ampere: u(1, "ampere"),
    amperes: u(1, "ampere"),
    ma: u(0.001, "milliampere"),
    MA: u(1e6, "megaampere"),
    milliamp: u(0.001, "milliampere"),
    milliamps: u(0.001, "milliampere"),
    milliampere: u(0.001, "milliampere"),
    ka: u(1000, "kiloampere"),
    kiloamp: u(1000, "kiloampere"),
    kiloampere: u(1000, "kiloampere"),
    μa: u(1e-6, "microampere"),
    microamp: u(1e-6, "microampere"),
    microampere: u(1e-6, "microampere"),
  },
};

// ─── VOLTAGE (base: volt) ───────────────────────────────────
const voltage: UnitCategory = {
  name: "voltage",
  base: "volt",
  units: {
    v: u(1, "volt"),
    volt: u(1, "volt"),
    volts: u(1, "volt"),
    mv: u(0.001, "millivolt"),
    MV: u(1e6, "megavolt"),
    millivolt: u(0.001, "millivolt"),
    millivolts: u(0.001, "millivolt"),
    kv: u(1000, "kilovolt"),
    kilovolt: u(1000, "kilovolt"),
    kilovolts: u(1000, "kilovolt"),
    μv: u(1e-6, "microvolt"),
    microvolt: u(1e-6, "microvolt"),
    microvolts: u(1e-6, "microvolt"),
  },
};

// ─── FUEL ECONOMY (base: km per liter) ──────────────────────
const fuelEconomy: UnitCategory = {
  name: "fuel economy",
  base: "km per liter",
  units: {
    "km/l": u(1, "km per liter"),
    kmpl: u(1, "km per liter"),
    "km per liter": u(1, "km per liter"),
    // mpg (US) → km/l: 1 mpg ≈ 0.425144 km/l
    mpg: u(0.425144, "miles per gallon"),
    "miles per gallon": u(0.425144, "miles per gallon"),
    // mpg (UK) → km/l: 1 UK mpg ≈ 0.354006 km/l
    "mpg uk": u(0.354006, "miles per gallon (UK)"),
    "uk mpg": u(0.354006, "miles per gallon (UK)"),
    // l/100km is inverse — we handle specially
  },
};

// ─── ALL CATEGORIES ─────────────────────────────────────────

export const UNIT_CATEGORIES: UnitCategory[] = [
  length,
  mass,
  volume,
  area,
  temperature,
  speed,
  timeDuration,
  dataSize,
  pressure,
  energy,
  power,
  angle,
  frequency,
  electricCurrent,
  voltage,
  fuelEconomy,
];

/** Build a flat lookup: alias → { category, unitDef } */
export interface UnitLookupEntry {
  category: UnitCategory;
  key: string;
  def: UnitDef;
}

const _unitIndex = new Map<string, UnitLookupEntry>();

for (const cat of UNIT_CATEGORIES) {
  for (const [key, def] of Object.entries(cat.units)) {
    _unitIndex.set(key, { category: cat, key, def });
  }
}

export function lookupUnit(token: string): UnitLookupEntry | undefined {
  // Bay: preserve capital M where it distinguishes mega from milli.
  return _unitIndex.get(token.trim()) ?? _unitIndex.get(normalizeUnitToken(token));
}

/** Convert value from one unit to another within the same category */
export function convertUnit(value: number, from: UnitLookupEntry, to: UnitLookupEntry): number {
  if (from.category !== to.category) {
    throw new Error(`Cannot convert between ${from.category.name} and ${to.category.name}`);
  }

  // Bay: use Celsius directly so freezing points do not accumulate cancellation
  // error through a Kelvin intermediate (32 F must display as exactly 0 C).
  if (from.category.name === "temperature") {
    if (from.def.name === to.def.name) return value;
    const celsius = from.def.name === "fahrenheit" ? ((value - 32) * 5) / 9 : from.def.name === "kelvin" ? value - 273.15 : value;
    return to.def.name === "fahrenheit" ? (celsius * 9) / 5 + 32 : to.def.name === "kelvin" ? celsius + 273.15 : celsius;
  }

  // Standard factor-based conversion
  const baseValue = value * from.def.factor;
  return baseValue / to.def.factor;
}

function normalizeUnitToken(token: string): string {
  return token.toLowerCase().trim().replace(/\s+/g, " ").replace(/²/g, "2").replace(/³/g, "3");
}
