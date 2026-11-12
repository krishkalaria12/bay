// The strings the browser itself shows: the start page, the search card, the tab switcher, the mini player, the find
// bar, the reader and the reading tools. Every other slice has its own file; the keys are flat and shared.

export const browser = {
  // Start page (StartPage.tsx, BrowserScreen.tsx).
  "start.tapToSearch": "Tap to search",
  "start.openSite": "Open {name}",
  "start.longPressToUnpin": "Long press to unpin",
  "start.morning": "Good morning",
  "start.afternoon": "Good afternoon",
  "start.evening": "Good evening",
  "start.recent": "Recent",

  // Search card (SearchCard.tsx).
  "search.close": "Close search",
  "search.placeholder": "Search or enter address",
  "search.clear": "Clear",
  "search.listening": "Listening",
  "search.voice": "Voice search",
  "search.private": "Private",
  "search.privateNotice": "You're browsing privately. Nothing you open here is saved.",
  "search.pasteAndGo": "Paste and Go",
  "search.fillIn": "Fill in {title}",
  "search.switchToTab": "Switch to tab · {address}",
  "search.withEngine": "Search {engine}",

  // Tab switcher (TabSwitcher.tsx).
  "tabs.one": "1 tab",
  "tabs.count": "{count} tabs",
  "tabs.archiveAll": "Archive all",
  "tabs.archiveAllCount": "Archive all {count} tabs",
  "tabs.all": "All",
  "tabs.private": "Private",
  "tabs.locked": "Locked",
  "tabs.newTab": "New tab",
  "tabs.closeLabel": "Close {title}",
  "tabs.openLabel": "Open {title}",
  "tabs.swipeToClose": "Swipe up to close",

  // Mini player (MiniPlayer.tsx).
  "player.playing": "playing",
  "player.paused": "paused",
  "player.goToTab": "Go to tab",
  "player.backTen": "Back ten seconds",
  "player.forwardTen": "Forward ten seconds",
  "player.play": "Play",
  "player.pause": "Pause",
  "player.pictureInPicture": "Picture in picture",
  "player.stopAndClose": "Stop and close",

  // Find bar (FindBar.tsx).
  "find.placeholder": "Find on page",
  "find.noMatches": "No matches",
  "find.matchCount": "{index} of {count}",
  "find.previous": "Previous match",
  "find.next": "Next match",
  "find.done": "Done",

  // Load failures (pageErrors.ts, PageError.tsx).
  "pageError.offline.title": "You're offline",
  "pageError.offline.detail": "Check your connection and try again.",
  "pageError.notFound.title": "Can't find this site",
  "pageError.notFound.detail": "Check the address for typos.",
  "pageError.timeout.title": "This site took too long",
  "pageError.timeout.detail": "It may be busy or down. Try again in a moment.",
  "pageError.refused.title": "This site refused to connect",
  "pageError.refused.detail": "It may be down, or blocked on this network.",
  "pageError.certificate.title": "This connection isn't private",
  "pageError.certificate.detail": "Bay stopped loading because the site's certificate isn't valid.",
  "pageError.unknown.title": "Can't open this page",
  "pageError.tryAgain": "Try again",

  // Reader (ReaderPanel.tsx, pagescripts/reader.ts).
  "reader.title": "Reader",
  "reader.exit": "Exit Reader",
  "reader.textSize": "Text size",
  "reader.smaller": "Smaller",
  "reader.larger": "Larger",
  "reader.font": "Font",
  "reader.theme": "Theme",
  "reader.fontSerif": "Serif",
  "reader.fontSans": "Sans",
  "reader.fontMono": "Mono",
  "reader.themeLight": "Light",
  "reader.themePaper": "Paper",
  "reader.themeSepia": "Sepia",
  "reader.themeMint": "Mint",
  "reader.themeGray": "Gray",
  "reader.themeDark": "Dark",
  "reader.themeBlack": "Black",

  // The picker's card and its notices (useReadingTools.tsx).
  "picker.inspectHint": "Tap an element to inspect it.",
  "picker.hideHint": "Tap an element to hide it.",
  "picker.linksClosed": "Links don't open while you pick.",
  "picker.parent": "Parent",
  "picker.details": "Details",
  "picker.hide": "Hide",
  "picker.undo": "Undo",
  "picker.resetSite": "Reset site",
  "picker.done": "Done",
  "notice.noArticle": "No article found on this page.",
  "notice.markdownCopied": "Markdown copied.",
  "notice.copiedForAgent": "Copied for a coding agent.",
  "notice.noParent": "No larger element to select.",
  "notice.unlockFirst": "Unlock private tabs first.",
  "notice.pageNotReady": "The page isn't ready.",
  "notice.pageChanged": "The page changed.",

  // The download's toast (useDownloads.tsx).
  "downloadToast.downloaded": "Downloaded {filename}",
  "downloadToast.open": "Open",
  "downloadToast.openLabel": "Open {filename}",
  "downloadToast.showAll": "{filename}, {status}. Show downloads",

  // The browser's own toasts (BrowserScreen.tsx).
  "toast.linkCopied": "Link copied",
  "toast.tabArchived": "Tab archived",
  "toast.undo": "Undo",
  "toast.unpinned": "Unpinned",
  "toast.pinned": "Pinned",
  "toast.linksAlreadyHere": "Those links are already here",
  "toast.openedTab": "Opened {count} tab",
  "toast.openedTabs": "Opened {count} tabs",
  "toast.archivedTab": "Archived {count} tab",
  "toast.archivedTabs": "Archived {count} tabs",
  "toast.oneTabArchived": "1 tab archived",
  "toast.tabsArchived": "{count} tabs archived",
  "toast.somethingWrong": "Something went wrong.",
  "toast.savedToPhotos": "Saved to your photo library",
  "toast.savedToDownloads": "Saved in Downloads",
  "toast.imageNotSaved": "The image couldn't be saved",
  "toast.fileNotOpened": "Couldn't open the file.",

  // The private lock (PrivateLock.tsx, BrowserScreen.tsx).
  "lock.title": "Private tabs are locked",
  "lock.unlock": "Unlock",
  "lock.prompt": "Unlock private tabs",

  // Where a card sits in the tab switcher, read out with it (TabSwitcher.tsx).
  "tabs.position": "Tab {index} of {count}",
  "tabs.privatePosition": "Private tab {index} of {count}",
};

/** Every locale's slice carries exactly these keys, so a missing translation is a type error. */
export type BrowserStrings = Record<keyof typeof browser, string>;
