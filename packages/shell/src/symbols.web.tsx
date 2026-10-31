import { createElement, type ReactNode } from "react";
import { symbolNodes, type SymbolNode } from "./lucideSymbols.web";
export { fluentSymbol } from "./fluentGlyphs.web";

const aliases: Record<string, string> = {
  "arrow.up.forward": "arrow.up.right",
  "arrow.triangle.pull": "arrow.triangle.2.circlepath",
  "arrow.triangle.swap": "arrow.triangle.2.circlepath",
  "square.stack.3d.up": "square.stack",
  "macbook.and.iphone": "laptopcomputer",
  "doc.plaintext": "doc",
  clear: "xmark.square",
  "globe.americas": "globe",
  puzzlepiece: "puzzlepiece.extension",
  "lock.open.trianglebadge.exclamationmark": "lock.open",
  "circle.slash": "nosign",
};
/** How an SF Symbol's `.fill` variant draws: listed parts solid (all when none are listed), or one part solid with the
 *  others cut out of it, as SF Symbols' filled badges are. Any other `.fill` name draws its outline. */
type Fill = { solid?: readonly number[] } | { knockout: number };
const SOLID: Fill = {};
const BADGE: Fill = { knockout: 0 };
const fills: Record<string, Fill> = {
  "arrow.down.circle": BADGE,
  "arrow.right.circle": BADGE,
  "arrow.uturn.backward.circle": BADGE,
  "checkmark.circle": BADGE,
  "checkmark.seal": BADGE,
  "dollarsign.circle": BADGE,
  "ellipsis.circle": BADGE,
  "equal.circle": BADGE,
  "exclamationmark.circle": BADGE,
  "exclamationmark.triangle": BADGE,
  "info.circle": BADGE,
  "minus.circle": BADGE,
  "person.crop.circle": BADGE,
  "questionmark.circle": BADGE,
  "stop.circle": BADGE,
  "xmark.circle": BADGE,
  "play.circle": { knockout: 1 },
  camera: BADGE,
  creditcard: BADGE,
  house: { knockout: 1 },
  key: BADGE,
  photo: BADGE,
  tag: BADGE,
  terminal: { knockout: 2 },
  tv: { knockout: 1 },
  "backward.end": { solid: [0] },
  "forward.end": { solid: [1] },
  "moon.stars": { solid: [2] },
  "person.2": { solid: [0, 3] },
  "speaker.slash": { solid: [0] },
  "speaker.wave.2": { solid: [0] },
  "speaker.wave.3": { solid: [0] },
  crown: { solid: [0] },
  gearshape: { knockout: 0 },
  leaf: { solid: [0] },
  lock: { solid: [0] },
  mic: { solid: [2] },
  pin: { solid: [1] },
  backward: SOLID,
  bolt: SOLID,
  bookmark: SOLID,
  cloud: SOLID,
  drop: SOLID,
  flag: SOLID,
  flame: SOLID,
  folder: SOLID,
  forward: SOLID,
  heart: SOLID,
  moon: SOLID,
  pause: SOLID,
  person: SOLID,
  play: SOLID,
  "puzzlepiece.extension": SOLID,
  shield: SOLID,
  star: SOLID,
  video: SOLID,
};

const SOLID_PAINT = { fill: "currentColor" };

const draw = (nodes: readonly SymbolNode[], key: string, paint?: (index: number) => object) =>
  nodes.map(([tag, attributes], index) => createElement(tag, { key: key + index, ...attributes, ...paint?.(index) }));

/** One part filled, the others cut out of it through a mask, so the window shows through them. */
function drawKnockout(nodes: readonly SymbolNode[], solid: number, maskId: string): ReactNode {
  const holes = nodes.filter((_, index) => index !== solid);
  return [
    createElement(
      "mask",
      { key: "m", id: maskId, maskUnits: "userSpaceOnUse", x: -4, y: -4, width: 32, height: 32 },
      createElement("rect", { x: -4, y: -4, width: 32, height: 32, fill: "white", stroke: "none" }),
      draw(holes, "h", () => ({ fill: "none", stroke: "black" })),
    ),
    createElement(
      "g",
      { key: "k", mask: `url(#${maskId})` },
      draw([nodes[solid]!], "k", () => SOLID_PAINT),
    ),
  ];
}

/** Lucide outlines under SF Symbol names, for hosts without Windows' icon font; `maskId` is unique per drawn symbol. */
export function svgSymbol(name: string, maskId: string): ReactNode {
  const filled = name.endsWith(".fill");
  const base = filled ? name.slice(0, -".fill".length) : name;
  const key = aliases[base] ?? base;
  const nodes = symbolNodes[key] ?? symbolNodes["exclamationmark.circle"]!;
  // A dot: always solid.
  if (key === "circle") return draw(nodes, "c", () => SOLID_PAINT);
  const fill = filled ? fills[key] : undefined;
  if (!fill) return draw(nodes, "o");
  if ("knockout" in fill) return drawKnockout(nodes, fill.knockout, maskId);
  const solid = fill.solid;
  return draw(nodes, "s", (index) => (!solid || solid.includes(index) ? SOLID_PAINT : {}));
}
