/** A tab found in exported text: its address and, when the line names it, its title. */
export interface ImportedTab {
  url: string;
  title: string;
}

// Anything that starts a link; the address's own characters are validated by URL below.
const LINK = /https?:\/\/[^\s<>"'`]+/gi;
const TITLE_LIMIT = 300;
const TRAILING_PUNCTUATION = /[.,;:!?'"`]+$/;

/**
 * Finds the links in text exported from another browser (Arc Search shares a tab list as text). Lines may carry a
 * title before the link or markdown around it; everything that isn't an HTTP(S) link is ignored. Links are
 * deduplicated in the order they appear, so a page named twice opens as one tab.
 */
export function importedTabs(text: string): ImportedTab[] {
  const seen = new Set<string>();
  const tabs: ImportedTab[] = [];

  for (const line of text.split(/\r?\n/)) {
    for (const match of line.matchAll(LINK)) {
      const url = webAddress(match[0]);

      if (!url || seen.has(url)) continue;
      seen.add(url);
      tabs.push({ url, title: titleBefore(line, match.index ?? 0) });
    }
  }

  return tabs;
}

/** The canonical address, or null when it isn't an HTTP(S) URL with a host and no credentials. */
function webAddress(value: string): string | null {
  const trimmed = value.replace(TRAILING_PUNCTUATION, "").replace(/[)\]}]+$/, "");

  try {
    const url = new URL(trimmed);

    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;

    return url.href;
  } catch {
    return null;
  }
}

/** The text a line puts before its link, without bullets, numbering or markdown. */
function titleBefore(line: string, index: number): string {
  const title = line
    .slice(0, index)
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/[[(]\s*$/, "")
    .replace(/\]\s*$/, "")
    .replace(/^\[+/, "")
    .replace(/^[\s\-–—:|]+/, "")
    .replace(/[\s\-–—:|]+$/, "")
    .trim();

  return title.slice(0, TITLE_LIMIT);
}
