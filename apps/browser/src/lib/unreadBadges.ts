// Unread counts on favorites (the pinned tiles), as Arc badged Slack, X, Gmail and Google Calendar in its Favorites:
// read from the page's title, which these sites keep up to date ("Inbox (3) - … - Gmail", "(2) Home / X"). A sleeping
// tab keeps the title it last had, so its count stays until the page says otherwise. A site that marks new messages
// without a number ("* Slack", "• Discord") gets a dot: never a number the title didn't give.

export type Unread = { count: number } | { dot: true };

type SitePattern = { hosts: RegExp; count?: RegExp; dot?: RegExp };

// The number is the first capture; "1,234" and "1.234" are thousands. Checked in order; the first site whose host
// matches decides, else the general "(3) Title" that most sites (X, LinkedIn, WhatsApp, Facebook, Teams) use.
const SITES: SitePattern[] = [
  // "Inbox (3) - me@gmail.com - Gmail", "Inbox (1,234) - …" (in any language); another label's count is that label's.
  { hosts: /^mail\.google\.com$/, count: /^[^()-]+\((\d[\d,.]*)\) - / },
  // "(3) Slack | …"; "* Slack | …" with unread channels, "! Slack | …" with a mention.
  { hosts: /(^|\.)slack\.com$/, count: /^\((\d[\d,.]*)\+?\)\s/, dot: /^[*!•]\s/ },
  // "(3) Discord | …"; "• Discord | …" with unread servers.
  { hosts: /(^|\.)discord\.com$/, count: /^\((\d[\d,.]*)\+?\)\s/, dot: /^•\s/ },
  // Outlook: "Mail - Name - Outlook" and "(3) Mail - …" in its newer client; "Inbox (3) - …" in the older one.
  { hosts: /^outlook\.(office|office365|live)\.com$/, count: /^(?:\((\d[\d,.]*)\)\s|Inbox \((\d[\d,.]*)\))/ },
];

const GENERAL = /^\((\d[\d,.]*)\+?\)\s/;

function hostOf(url: string): string | null {
  const m = /^https?:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(url);
  return m ? m[1]!.toLowerCase().replace(/^www\./, "") : null;
}

const parseCount = (text: string | undefined) => (text ? Number(text.replace(/[,.]/g, "")) : NaN);

/** What a tab's title says is waiting on its site, or null: nothing, or not a page that says. */
export function unreadFromTitle(url: string, title: string): Unread | null {
  const host = hostOf(url);
  if (!host || !title) return null;
  const text = title.trim();
  const site = SITES.find((s) => s.hosts.test(host));
  const match = (site ? site.count : GENERAL)?.exec(text);
  if (match) {
    const count = parseCount(match.slice(1).find((g) => g !== undefined));
    if (Number.isFinite(count) && count > 0) return { count };
    if (count === 0) return null;
  }
  if (site?.dot?.test(text)) return { dot: true };
  return null;
}

/** As the badge shows it: "999+" past three digits. */
export const unreadLabel = (count: number) => (count > 999 ? "999+" : String(count));
