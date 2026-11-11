// The strings the chrome shows: the bar's buttons and their labels, and the sheet's own chrome. The icons themselves
// are drawn, not written, so they have no strings here.

export const chrome = {
  // The bar (BrowserBar.types.ts, BrowserBar.ios.tsx, BrowserBar.android.tsx).
  "bar.archive": "Archive",
  "bar.search": "Search",
  "bar.newTab": "New tab",
  "bar.settings": "Settings",
  "bar.tabs": "Tabs",
  "bar.tabsOpen": "Tabs, {count} open",
  "bar.searchOrEnter": "Search or enter address, {site}",
  "bar.searchOrEnterInsecure": "Search or enter address, not secure, {site}",
  "bar.more": "More",

  // The sheet's chrome (PanelSheetShared.tsx).
  "sheet.back": "Back",
  "sheet.close": "Close {title}",
  "sheet.selected": "Selected",
};

/** Every locale's slice carries exactly these keys, so a missing translation is a type error. */
export type ChromeStrings = Record<keyof typeof chrome, string>;
