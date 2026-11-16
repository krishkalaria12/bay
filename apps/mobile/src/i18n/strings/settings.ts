// The strings of the Settings screen (src/settings): its search, its pages' names, the line under each page's name, the
// words a search finds a page by, and the rows and notes the earlier sheet didn't have.

export const settings = {
  "settings.search.placeholder": "Search",
  "settings.search.clear": "Clear search",
  "settings.search.empty": "No settings found",

  // The pages' names, where the earlier sheet had none.
  "settings.page.general": "General",
  "settings.page.search": "Search",
  "settings.page.tabs": "Tabs",
  "settings.page.passwords": "Passwords",
  "settings.page.customEngine": "Custom search engine",

  // A page's one line under its name.
  "settings.blurb.general": "How Bay opens, the links it takes and how you move between pages.",
  "settings.blurb.search": "What the search field searches with, and what it asks for as you type.",
  "settings.blurb.appearance": "Bay's light or dark look, the start page behind it and how big pages are.",
  "settings.blurb.tabs": "When quiet tabs go to the archive, and when Bay starts afresh.",
  "settings.blurb.privacy": "Ads and trackers, private tabs and what Bay keeps on this phone.",
  "settings.blurb.passwords": "Sign-ins Bay saved on this phone, and nowhere else.",
  "settings.blurb.youtube": "A quieter YouTube, with Brave's lists.",
  "settings.blurb.about": "A free, open-source browser for your phone and your Mac.",
  "settings.blurb.defaultBrowser": "The browser that links from other apps open in.",

  // Words a page is found by besides its own: lower case, separated by spaces, in this language.
  "settings.keywords.general": "browser default links apps language swipe gestures back forward pull refresh keyboard launch welcome",
  "settings.keywords.search": "engine google duckduckgo bing custom suggestions address field",
  "settings.keywords.appearance": "theme light dark mode wallpaper background photo zoom text size look",
  "settings.keywords.tabs": "archive inactive old start page export share",
  "settings.keywords.privacy": "ads trackers blocker blocking content amp private lock face fingerprint passcode clear data cookies",
  "settings.keywords.passwords": "logins sign in passwords passkeys saved accounts",
  "settings.keywords.youtube": "shorts comments suggestions videos",
  "settings.keywords.about": "version licences licenses source code credits privacy policy",
  "settings.keywords.bookmarks": "favourites favorites saved",
  "settings.keywords.history": "visited pages recent browsing",
  "settings.keywords.downloads": "files saved",
  "settings.keywords.import": "chrome safari firefox brave arc export file move",
  "settings.keywords.report": "bug crash error problem help feedback",

  "settings.search.engineNote": "Type an address to open a page, or words to search with {engine}.",
  "settings.showWelcome.note": "Bay's first pages once more, from its name to the search field. Your tabs stay as they are.",
  "settings.passwords.none": "No saved passwords",

  // Default browser, now a page of its own.
  "settings.default.yes": "Bay",
  "settings.default.no": "Not yet",
  "settings.default.isDefault": "Links from other apps open in Bay, as a new tab.",
  "settings.default.howIos": "Choose Bay in Settings › Apps › Default Apps › Browser App, and links from other apps open here as a new tab.",
  "settings.default.howAndroid": "Choose Bay as your phone's browser app, and links from other apps open here as a new tab.",
  "settings.default.make": "Make Bay the default",

  // Site Settings, after Yab's.
  "site.secure": "Connection is secure",
  "site.notSecure": "Not secure",
  "site.secure.detail": "Pages here travel encrypted, and the site proved who it is.",
  "site.notSecure.detail": "Pages here travel unencrypted: don't type a password or a card number.",
  "site.downloaded": "Downloaded here",
  "site.blockingHere": "Blocking here",
  "site.bayHere": "Here",
  "site.settings": "Bay Settings",
  "site.zoom.reset": "Back to Bay's {size}%",
} as const;

/** The Settings strings every other locale gives, key for key. */
export type SettingsStrings = Record<keyof typeof settings, string>;
