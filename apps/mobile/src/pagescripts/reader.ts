import { ARTICLE_HELPERS } from "./article.ts";
import { READABILITY } from "./vendor.generated.ts";

// Reader: the page's article (Mozilla's Readability) typeset in a full-page layer of the page itself, in a closed
// shadow root the page's CSS and scripts can't reach. Settings are CSS variables, so changing them doesn't rebuild it.
// Runs on both engines through runPageScript; state lives under Symbol.for("bay.reader").

export type ReaderThemeId = "light" | "paper" | "sepia" | "mint" | "gray" | "dark" | "black";
export type ReaderFont = "serif" | "sans" | "mono";

export interface ReaderSettings {
  theme: ReaderThemeId;
  font: ReaderFont;
  /** Body text size in CSS pixels. */
  size: number;
}

export const READER_THEMES: readonly { id: ReaderThemeId; name: string; background: string; text: string; muted: string; link: string }[] = [
  { id: "light", name: "Light", background: "#FFFFFF", text: "#1C1C1E", muted: "#6B6B70", link: "#0A66C2" },
  { id: "paper", name: "Paper", background: "#F7F4EC", text: "#26231E", muted: "#7A7466", link: "#8A4B12" },
  { id: "sepia", name: "Sepia", background: "#F1E3C6", text: "#3B2F20", muted: "#7D6A4E", link: "#8C4A16" },
  { id: "mint", name: "Mint", background: "#E7F2EA", text: "#1E2B23", muted: "#5E7366", link: "#1D6B4A" },
  { id: "gray", name: "Gray", background: "#4A4C50", text: "#F1F1F2", muted: "#C2C3C6", link: "#9CC8FF" },
  { id: "dark", name: "Dark", background: "#1C1C1E", text: "#E8E8EA", muted: "#9A9AA0", link: "#7FB7FF" },
  { id: "black", name: "Black", background: "#000000", text: "#D9D9DB", muted: "#8E8E93", link: "#7FB7FF" },
];

export const READER_FONTS: readonly { id: ReaderFont; name: string; family: string }[] = [
  { id: "serif", name: "Serif", family: '"New York", ui-serif, Georgia, "Noto Serif", serif' },
  { id: "sans", name: "Sans", family: 'ui-sans-serif, -apple-system, system-ui, Roboto, "Helvetica Neue", sans-serif' },
  { id: "mono", name: "Mono", family: 'ui-monospace, "SF Mono", Menlo, "Roboto Mono", monospace' },
];

export const DEFAULT_READER: ReaderSettings = { theme: "paper", font: "serif", size: 19 };
export const READER_SIZES = { min: 14, max: 28, step: 1 } as const;

function variables(settings: ReaderSettings): Record<string, string> {
  const theme = READER_THEMES.find((entry) => entry.id === settings.theme) ?? READER_THEMES[0]!;
  const font = READER_FONTS.find((entry) => entry.id === settings.font) ?? READER_FONTS[0]!;
  const size = Number.isFinite(settings.size) ? Math.min(READER_SIZES.max, Math.max(READER_SIZES.min, Math.round(settings.size))) : DEFAULT_READER.size;
  return {
    "--bay-bg": theme.background,
    "--bay-text": theme.text,
    "--bay-muted": theme.muted,
    "--bay-link": theme.link,
    "--bay-font": font.family,
    "--bay-size": `${size}px`,
  };
}

const STYLE = [
  ":host{all:initial;position:fixed;inset:0;z-index:2147483647;display:block;overflow-y:auto;-webkit-overflow-scrolling:touch;background:var(--bay-bg);}",
  "main{box-sizing:border-box;max-width:680px;margin:0 auto;padding:28px 22px 160px;color:var(--bay-text);font-family:var(--bay-font);font-size:var(--bay-size);line-height:1.6;-webkit-text-size-adjust:100%;}",
  ".site{font:600 13px/1.4 ui-sans-serif,-apple-system,system-ui,Roboto,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:var(--bay-muted);margin:0 0 10px;}",
  "h1.title{font-size:1.65em;line-height:1.2;margin:0 0 10px;}",
  ".byline{color:var(--bay-muted);font-size:.85em;margin:0 0 26px;}",
  "a{color:var(--bay-link);}",
  "img,video,figure,picture,svg{max-width:100%;height:auto;}",
  "figure{margin:1.4em 0;}figcaption{color:var(--bay-muted);font-size:.8em;}",
  "pre,code{font-family:ui-monospace,Menlo,monospace;font-size:.85em;}pre{overflow-x:auto;padding:12px;border-radius:10px;background:color-mix(in srgb,var(--bay-text) 7%,transparent);}",
  "blockquote{margin:1.2em 0;padding-left:1em;border-left:3px solid color-mix(in srgb,var(--bay-text) 25%,transparent);color:var(--bay-muted);}",
  "table{border-collapse:collapse;max-width:100%;display:block;overflow-x:auto;}td,th{border:1px solid color-mix(in srgb,var(--bay-text) 15%,transparent);padding:6px 8px;}",
  "h2,h3,h4{line-height:1.3;}",
].join("");

/** Opens Reader; resolves `{ ok: true, title }`, or `{ ok: false }` when the page has no article. */
export function openReaderScript(settings: ReaderSettings): string {
  return `
const state = (window[Symbol.for("bay.reader")] ??= {});
state.Readability ??= ${READABILITY};
if (state.host && state.host.isConnected) {
  for (const [name, value] of Object.entries(${JSON.stringify(variables(settings))})) state.host.style.setProperty(name, value);
  return { ok: true, title: state.title };
}
${ARTICLE_HELPERS}
const article = new state.Readability(clonePage(), { charThreshold: 400 }).parse();
if (!article || !article.content || article.length < 200) return { ok: false };
if (state.close) state.close();
const host = document.createElement("bay-reader");
const root = host.attachShadow({ mode: "closed" });
const style = document.createElement("style");
style.textContent = ${JSON.stringify(STYLE)};
const main = document.createElement("main");
const site = document.createElement("p");
site.className = "site";
site.textContent = article.siteName || location.hostname.replace(/^www\\./, "");
const title = document.createElement("h1");
title.className = "title";
title.textContent = article.title || document.title;
const byline = document.createElement("p");
byline.className = "byline";
byline.textContent = article.byline || "";
const body = safeArticle(article.content);
main.append(site, title, byline, body);
root.append(style, main);
for (const [name, value] of Object.entries(${JSON.stringify(variables(settings))})) host.style.setProperty(name, value);
const overflow = document.documentElement.style.getPropertyValue("overflow");
const priority = document.documentElement.style.getPropertyPriority("overflow");
document.documentElement.style.overflow = "hidden";
document.documentElement.append(host);
state.host = host;
state.title = title.textContent;
state.close = () => {
  host.remove();
  if (overflow) document.documentElement.style.setProperty("overflow", overflow, priority);
  else document.documentElement.style.removeProperty("overflow");
  state.host = null;
  state.close = null;
};
return { ok: true, title: title.textContent };
`;
}

export function updateReaderScript(settings: ReaderSettings): string {
  return `
const state = window[Symbol.for("bay.reader")];
if (!state || !state.host || !state.host.isConnected) return false;
for (const [name, value] of Object.entries(${JSON.stringify(variables(settings))})) state.host.style.setProperty(name, value);
return true;
`;
}

export const CLOSE_READER_SCRIPT = `
const state = window[Symbol.for("bay.reader")];
if (state && state.close) state.close();
return true;
`;
