// One place for the facts the pages and their metadata repeat.
export const site = {
  name: "Bay",
  // The production origin; astro.config.mjs `site`, public/robots.txt and public/llms.txt repeat it.
  url: "https://bay.krishkalaria.in",
  // Under 60 characters: what Bay is, then what it brings.
  title: "Bay: a beautiful, fast browser for Mac",
  // Around 155 characters, the answer first.
  description:
    "Bay is a beautiful, fast browser for Mac with everything you loved about Arc: the sidebar, spaces, pinned tabs, folders, Peek and Split View, on Chrome’s engine.",
  downloadUrl: "/download",
  requirement: "macOS 14 Sonoma or later",
} as const;

const id = (name: string) => `${site.url}/#${name}`;
export const ids = { org: id("organization"), site: id("website"), app: id("app") };

/** What Bay keeps from Arc, by the name Arc gave it. The home page and the switching guide both list it. */
export const fromArc = [
  ["The sidebar", "The sidebar", "Tabs down the side: favorites on top, pinned tabs under them, today’s below."],
  ["Spaces", "Spaces", "Each with its own icon, theme and profile, so sign-ins stay apart. Swipe between them."],
  ["Favorites", "Favorites", "The tiles above the sidebar, in every window."],
  ["Pinned tabs", "Pinned tabs", "Kept open, a click away, never closed by tidying."],
  ["Folders", "Folders", "Tabs grouped under a name, opened in place."],
  ["Archive", "Old tabs put away", "Unused tabs leave after a time you set for each space, and stay searchable."],
  ["Peek", "Peek", "A link opens over the page; keep it as a tab or put it beside the page."],
  ["Split View", "Split View", "Two tabs side by side in one tab."],
  ["Little Arc", "Little Bay", "Links from Slack, Mail or Discord open in a small window."],
  ["Command Bar", "Command bar", "Addresses, searches, open tabs and the ones put away."],
] as const;

export const faqs = [
  {
    q: "Does Bay have Arc’s features?",
    a: "Yes. Bay is its own browser, and it brings what people loved about Arc: the sidebar, spaces, pinned tabs, folders, Peek, Split View and a little window for links from other apps. It imports your Arc spaces, pinned tabs and favorites, so you can pick up where you left off.",
  },
  {
    q: "Is Bay made by The Browser Company?",
    a: "No. Bay is an independent browser and isn’t affiliated with The Browser Company or Arc.",
  },
  {
    q: "Is Bay built on Chromium?",
    a: "Yes. Bay runs on Chrome’s own framework, so pages render, sign in and behave exactly as they do in Chrome. The window, sidebar and everything you touch are Bay’s.",
  },
  {
    q: "Do my Chrome extensions work?",
    a: "They do. Install them from the Chrome Web Store; their buttons sit in the toolbar and side panels open beside the page.",
  },
  {
    q: "Can I bring my tabs over from Arc?",
    a: "Bay imports Arc’s spaces, tabs, pinned tabs, folders and favorites, plus bookmarks, history and passwords. It also imports from Chrome, Safari, Firefox and Dia.",
  },
  {
    q: "What happens to tabs I haven’t looked at in a while?",
    a: "Bay puts them away after a time you choose for each space, say twelve hours for work and a week for home. They stay one search away, never lost.",
  },
  {
    q: "Which Macs does Bay run on?",
    a: "Any Mac running macOS 14 Sonoma or later.",
  },
  {
    q: "Does Bay sync between my Macs?",
    a: "Yes, with encryption you hold the key to: your data is sealed into files in a folder you choose, like one in iCloud Drive, and only your devices can read it.",
  },
] as const;

export const faqPage = (list: readonly { q: string; a: string }[], url: string) => ({
  "@type": "FAQPage",
  "@id": `${url}#faq`,
  mainEntity: list.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
});

/**
 * The nodes every page shares, linked by @id: who makes Bay, the site, and the app. No offers or rating on the app:
 * the page shows neither, and Google only marks up what the page shows.
 */
export const graph = [
  {
    "@type": "Organization",
    "@id": ids.org,
    name: site.name,
    url: site.url,
    logo: { "@type": "ImageObject", url: `${site.url}/icon-512.png`, width: 512, height: 512 },
  },
  {
    "@type": "WebSite",
    "@id": ids.site,
    name: site.name,
    url: site.url,
    description: site.description,
    inLanguage: "en",
    publisher: { "@id": ids.org },
  },
  {
    "@type": "SoftwareApplication",
    "@id": ids.app,
    name: site.name,
    alternateName: "Bay browser",
    description: site.description,
    url: site.url,
    image: `${site.url}/og.png`,
    applicationCategory: "BrowserApplication",
    operatingSystem: "macOS 14 or later",
    downloadUrl: new URL(site.downloadUrl, site.url).href,
    publisher: { "@id": ids.org },
    featureList: fromArc.map(([, bay]) => bay).join(", "),
  },
];
