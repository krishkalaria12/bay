// https://learn.microsoft.com/windows/apps/design/iconography/segoe-fluent-icons-font
// Segoe Fluent Icons glyphs. Keep SF Symbol names at call sites so both desktops share the UI.
const glyphs: Record<string, number> = {
  "arrow.left": 0xe72b, "arrow.right": 0xe72a, "arrow.up": 0xe74a, "arrow.down": 0xe74b,
  "arrow.up.left": 0xe72b, "arrow.up.right": 0xe8a7, "arrow.up.forward": 0xe8a7,
  "arrow.clockwise": 0xe72c, "arrow.counterclockwise": 0xe72c,
  "arrow.uturn.backward": 0xe7a7, "arrow.triangle.2.circlepath": 0xe895,
  "arrow.triangle.pull": 0xe895, "arrow.triangle.swap": 0xe8ab, "arrow.down.circle": 0xe896,
  "checkmark": 0xe73e, "checkmark.circle": 0xe930, "checkmark.circle.fill": 0xe930,
  "chevron.left": 0xe76b, "chevron.right": 0xe76c, "chevron.down": 0xe70d,
  "chevron.up": 0xe70e, "chevron.up.chevron.down": 0xe8cb,
  "chevron.left.forwardslash.chevron.right": 0xe943,
  "plus": 0xe710, "minus": 0xe738, "xmark": 0xe711, "xmark.circle.fill": 0xe711,
  "ellipsis": 0xe712, "line.3.horizontal": 0xe700,
  "magnifyingglass": 0xe721, "globe": 0xe774, "house": 0xe80f, "house.fill": 0xe80f,
  "folder": 0xe8b7, "folder.fill": 0xe8b7, "doc": 0xe8a5, "doc.zipper": 0xf012,
  "square.on.square": 0xe8c8, "square.stack": 0xe8fd, "square.stack.3d.up": 0xe8fd,
  "rectangle.split.2x1": 0xe89f, "rectangle.inset.filled": 0xe737,
  "rectangle.inset.filled.and.person.filled": 0xe716,
  "macwindow": 0xe737, "display": 0xe7f4, "laptopcomputer": 0xe7f8,
  "macbook.and.iphone": 0xe772, "tv.and.mediabox": 0xeec0, "tv.and.mediabox.fill": 0xeec0,
  "clock": 0xe823, "clock.arrow.circlepath": 0xe81c,
  "lock": 0xe72e, "lock.fill": 0xe72e, "lock.open": 0xe785,
  "lock.open.trianglebadge.exclamationmark.fill": 0xe785,
  "person": 0xe77b, "person.fill": 0xe77b, "person.crop.circle": 0xe77b,
  "person.crop.circle.badge.plus": 0xe8fa,
  "pin": 0xe718, "pin.fill": 0xe718, "pin.slash": 0xe77a,
  "bookmark": 0xe734, "bookmark.fill": 0xe735, "star": 0xe734, "star.fill": 0xe735,
  "speaker.slash.fill": 0xe74f, "speaker.wave.2.fill": 0xe767,
  "bubble.left": 0xe8bd, "creditcard.fill": 0xe8c7, "pip.fill": 0xe8a7,
  "exclamationmark.circle.fill": 0xe783, "exclamationmark.triangle": 0xe7ba,
  "exclamationmark.triangle.fill": 0xe7ba, "exclamationmark.icloud": 0xf170,
  "paintpalette": 0xe790, "puzzlepiece.extension": 0xea86,
  "moon.zzz": 0xe708, "stethoscope": 0xe9d9, "wand.and.stars": 0xe7c1,
  "equal.circle": 0xe94e, "circle.fill": 0xea3b,
  "gearshape": 0xe713, "gearshape.fill": 0xe713, "trash": 0xe74d,
  // The window's caption buttons (CaptionButtons.tsx): Windows' own Chrome* glyphs, no SF Symbol counterpart.
  "window.minimize": 0xe921, "window.maximize": 0xe922, "window.restore": 0xe923, "window.close": 0xe8bb,
};

/** The help glyph is visible when a future symbol has no mapping yet. */
export const fluentSymbol = (name: string): string => String.fromCodePoint(glyphs[name] ?? 0xe897);
