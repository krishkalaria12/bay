import type { ImportKind } from "@bay/import";
import { tensionSpring } from "../../lib/springs";

export const KINDS: { kind: ImportKind; title: string; icon: string }[] = [
  { kind: "bookmarks", title: "Bookmarks", icon: "bookmark" },
  { kind: "history", title: "History", icon: "clock" },
  { kind: "passwords", title: "Passwords", icon: "key" },
  { kind: "cookies", title: "Cookies (stay signed in)", icon: "person.badge.key" },
  { kind: "autofill", title: "Addresses and cards", icon: "creditcard" },
  { kind: "extensions", title: "Extensions", icon: "puzzlepiece.extension" },
  { kind: "tabs", title: "Tabs", icon: "square.on.square" },
  { kind: "spaces", title: "Spaces", icon: "square.stack" },
  { kind: "pinnedTabs", title: "Pinned tabs", icon: "pin" },
  { kind: "favorites", title: "Favorites", icon: "star" },
];

// The kinds a Chromium-family browser encrypts with its keychain key ("<Browser> Safe Storage").
export const ENCRYPTED: ImportKind[] = ["passwords", "cookies", "autofill"];

// Linux's basic store needs no keyring. Its native reader imports v10 and
// reports locked v11 rows in the result, preserving every selected category.
export function kindsWithoutUnlock(kinds: Set<ImportKind>, basicStore: boolean): Set<ImportKind> {
  const wanted = new Set(kinds);
  if (!basicStore) {
    wanted.delete("passwords");
    wanted.delete("cookies");
  }
  return wanted;
}

export const DIA_NOT_SHARED = "Custom tab names, colours, spaces and folders stay in Dia: its AppleScript doesn't share them.";

// How long the finished progress list stays before the summary.
export const DONE_DELAY_MS = 700;
// Dia launched from here gets this long to open a window before an empty read counts.
export const DIA_LAUNCH_MS = 15_000;
export const DIA_POLL_MS = 1500;

// Animated's old springs: tension 160 and 120, friction 5.
export const CHECK_SPRING = tensionSpring(160, 5);
export const SUCCESS_SPRING = tensionSpring(120, 5);
