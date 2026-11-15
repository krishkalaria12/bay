/**
 * What an import adds, decided before anything is written: the bookmark drafts that aren't in Bay yet, and what the
 * export held that Bay leaves where it is. Pure, so Node's tests check it.
 */
import { bookmarkLinks } from "../store/bookmarks.ts";
import type { BookmarkDraft } from "../store/bookmarks.ts";
import type { Bookmarks } from "../store/types.ts";
import type { ImportedBookmark } from "./exports.ts";

/** What the export held that stays in it. */
export interface ExportNotes {
  /** It had passwords (a CSV, or a file named for them). */
  passwords: boolean;
  /** It had payment cards. */
  cards: boolean;
  /** Bookmark or history files too large to read. */
  tooLarge: string[];
}

/** What the native side left in the archive, read for what it means to the user. */
export function exportNotes(listing: { skipped: readonly string[]; tooLarge: readonly string[] }): ExportNotes {
  return {
    passwords: listing.skipped.some((name) => /password|\.csv$/i.test(name)),
    cards: listing.skipped.some((name) => /card|payment/i.test(name)),
    tooLarge: [...listing.tooLarge],
  };
}

/**
 * The imported tree as drafts, without the pages Bay has bookmarked already (anywhere) or that the export names
 * twice. A folder left empty by that is left out too.
 */
export function bookmarkDrafts(root: ImportedBookmark, existing: Bookmarks): BookmarkDraft[] {
  const seen = new Set(bookmarkLinks(existing).map((link) => link.url));

  const draft = (node: ImportedBookmark): BookmarkDraft | null => {
    if (node.url) {
      if (seen.has(node.url)) return null;
      seen.add(node.url);
      const link: BookmarkDraft = { title: node.title, url: node.url };

      if (node.addedAt) link.addedAt = node.addedAt;

      return link;
    }

    const children = (node.children ?? []).flatMap((child) => draft(child) ?? []);

    if (!children.length) return null;
    const folder: BookmarkDraft = { title: node.title, children };

    if (node.addedAt) folder.addedAt = node.addedAt;

    return folder;
  };

  return (root.children ?? []).flatMap((child) => draft(child) ?? []);
}

/** How many links drafts hold. */
export const draftLinkCount = (drafts: readonly BookmarkDraft[]): number =>
  drafts.reduce((sum, draft) => sum + (draft.url !== undefined ? 1 : draftLinkCount(draft.children ?? [])), 0);
