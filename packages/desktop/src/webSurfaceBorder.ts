/**
 * A Surface's border colours as CSS. macOS strokes `borderColors` as a gradient from top to bottom; a CSS border has one
 * colour a side, so the sides take the blend. With no colour the border stays clear, as on macOS: left unset, the
 * browser draws it black.
 */
/** The CSS a surface's border takes: one colour, or one per side. */
export type SurfaceBorderColors = Record<string, string>;

export function surfaceBorderColors(borderColor: string | undefined, borderColors: readonly string[] | undefined): SurfaceBorderColors {
  const top = borderColors?.[0];
  const bottom = borderColors?.at(-1);

  // oxlint-disable-next-line anti-slop/no-known-value-widening -- The table is a lookup by name, so its open shape is the point.
  if (!top || !bottom) return { borderColor: borderColor ?? "transparent" };
  const side = `color-mix(in srgb, ${top}, ${bottom})`;

  // oxlint-disable-next-line anti-slop/no-known-value-widening -- The table is a lookup by name, so its open shape is the point.
  return { borderTopColor: top, borderRightColor: side, borderBottomColor: bottom, borderLeftColor: side };
}
