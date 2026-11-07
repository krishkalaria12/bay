// https://learn.microsoft.com/windows/apps/design/iconography/segoe-fluent-icons-font
// Windows' own caption glyphs for the caption buttons the app draws there. Every other symbol is Lucide's.
const glyphs: Record<string, number> = {
  "window.minimize": 0xe921,
  "window.maximize": 0xe922,
  "window.restore": 0xe923,
  "window.close": 0xe8bb,
};

export const fluentSymbol = (name: string): string => String.fromCodePoint(glyphs[name] ?? 0xe897);
