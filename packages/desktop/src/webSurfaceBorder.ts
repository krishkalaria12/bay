/**
 * A Surface's border colours as CSS. macOS strokes `borderColors` as a gradient from top to bottom; a CSS border has one
 * colour a side, so the sides take the blend. With no colour the border stays clear, as on macOS: left unset, the
 * browser draws it black.
 */
export function surfaceBorderColors(borderColor: string | undefined, borderColors: readonly string[] | undefined): Record<string, string> {
  const top = borderColors?.[0];
  const bottom = borderColors?.at(-1);
  if (!top || !bottom) return { borderColor: borderColor ?? "transparent" };
  const side = `color-mix(in srgb, ${top}, ${bottom})`;
  return { borderTopColor: top, borderRightColor: side, borderBottomColor: bottom, borderLeftColor: side };
}
