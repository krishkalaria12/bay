/**
 * At most `units` UTF-16 code units of `text`, never half of a surrogate pair: cutting a name or title on an emoji
 * leaves the emoji out rather than saving half of it as broken text. The native apps' core cuts the same way.
 */
export function sliceText(text: string, units: number): string {
  const cut = text.slice(0, units);

  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}
