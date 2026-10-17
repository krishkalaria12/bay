import { SYMBOL_PREFIX } from "../lib/constants";

// The colour each symbol of the icon sets is drawn in (IconGrid.tsx, profiles/icons.tsx), as an app icon has one: a
// house orange, a leaf green. macOS's system colours, [light, dark]: deepened where they'd fade on a light sidebar
// (yellow, mint), brightened where they'd sink into a dark one (indigo).

const RED = ["#FF3B30", "#FF453A"];
const ORANGE = ["#FF9500", "#FF9F0A"];
const YELLOW = ["#F4B400", "#FFD60A"];
const GREEN = ["#34C759", "#30D158"];
const MINT = ["#00B8A9", "#63E6E2"];
const TEAL = ["#30B0C7", "#40C8E0"];
const BLUE = ["#007AFF", "#0A84FF"];
const INDIGO = ["#5856D6", "#7D7AFF"];
const PURPLE = ["#AF52DE", "#BF5AF2"];
const PINK = ["#FF2D55", "#FF375F"];
const BROWN = ["#A2845E", "#AC8E68"];
const GRAY = ["#8E8E93", "#98989D"];

const BY_COLOR: [string[], string[]][] = [
  [RED, ["heart", "flame", "pin", "alarm", "cross.case", "stethoscope", "gift", "ladybug", "target", "exclamationmark.triangle", "film", "mic"]],
  [
    ORANGE,
    [
      "house",
      "cart",
      "bag",
      "fork.knife",
      "beach.umbrella",
      "figure.run",
      "basketball",
      "sportscourt",
      "bird",
      "fish",
      "flask",
      "testtube.2",
      "tray",
      "shippingbox",
      "archivebox",
    ],
  ],
  [YELLOW, ["star", "bolt", "sun.max", "lightbulb", "crown", "trophy", "sparkles", "folder", "key", "tag", "bookmark", "pencil"]],
  [
    GREEN,
    [
      "leaf",
      "tree",
      "banknote",
      "dollarsign.circle",
      "chart.line.uptrend.xyaxis",
      "checkmark.circle",
      "checklist",
      "mountain.2",
      "soccerball",
      "bicycle",
      "dumbbell",
      "phone",
      "map",
    ],
  ],
  [MINT, ["drop", "globe.americas", "chart.pie", "chart.bar", "list.bullet"]],
  [TEAL, ["snowflake", "cloud", "airplane", "car", "server.rack", "cpu", "terminal", "safari"]],
  [
    BLUE,
    [
      "globe",
      "envelope",
      "bubble.left",
      "bubble.left.and.bubble.right",
      "calendar",
      "doc.text",
      "newspaper",
      "creditcard",
      "link",
      "magnifyingglass",
      "shield",
      "lock",
      "person",
      "person.2",
      "questionmark.circle",
      "eye",
      "video",
      "tv",
    ],
  ],
  [
    INDIGO,
    [
      "moon",
      "moon.stars",
      "graduationcap",
      "building.2",
      "chevron.left.forwardslash.chevron.right",
      "laptopcomputer",
      "desktopcomputer",
      "keyboard",
      "atom",
      "brain",
      "brain.head.profile",
      "gamecontroller",
      "headphones",
    ],
  ],
  [
    PURPLE,
    ["paintpalette", "paintbrush", "paintbrush.pointed", "music.note", "guitars", "camera", "photo", "puzzlepiece", "books.vertical", "book", "book.closed"],
  ],
  [PINK, ["figure.2.and.child.holdinghands", "cat", "flag", "wineglass"]],
  [BROWN, ["briefcase", "cup.and.saucer", "hammer", "pawprint", "dog", "ant"]],
  [GRAY, ["wrench.and.screwdriver", "gearshape", "clock"]],
];

const COLORS = new Map(BY_COLOR.flatMap(([color, names]) => names.map((name) => [name, color] as const)));

/** The symbol's colour (`house.fill` takes `house`'s) in the light or dark appearance, or undefined for one outside the sets. */
export function symbolColor(name: string, dark: boolean): string | undefined {
  return (COLORS.get(name) ?? COLORS.get(name.replace(/\.fill$/, "")))?.[dark ? 1 : 0];
}

/** An icon's colour: its symbol's, if it's a symbol of the sets (emoji bring their own). */
export const iconColor = (icon: string | null | undefined, dark: boolean) =>
  icon?.startsWith(SYMBOL_PREFIX) ? symbolColor(icon.slice(SYMBOL_PREFIX.length), dark) : undefined;
