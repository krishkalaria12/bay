# Nested pinned folders

Phase 2's "Folders inside folders" item supports five folder levels, recursive folding and previews, tree destination menus, and dragging tabs or whole folder subtrees between levels. Folder menus offer New Folder Inside and Move Out of Folder. Removing a folder promotes its children and keeps its tabs pinned.

Moves support Cmd+Z while the sidebar owns focus. Clicking into a page or text field restores that editor's normal Undo. Undo restores placement and source group membership without rolling back navigation or newly opened tabs.

## Browser references

Reviewed on 15 October 2026:

- [Arc's folder documentation](https://resources.arc.net/hc/en-us/articles/19228419623447-Folders-Stash-Similar-Tabs-Together) describes sidebar folders, context menu actions, dragging tabs into folders, and collapsed-folder previews.
- [Zen's release notes](https://zen-browser.app/release-notes/) document folder expansion behavior and syncing folders across devices.

Bay retains its existing folder appearance and active-tab preview behavior. The five-level limit comes from Bay's feature plan.

## Storage, sync and import

`PinnedFolder.parentId` is optional; existing folders remain roots. Hydration repairs missing parents, cross-space parents, cycles and excessive depth without dropping tabs. Empty folders can carry a `beforeId` anchor so their position survives moves, import, restart and sync.

Sync extends existing pinned-tab and pinned-group records with optional folder metadata and row ordering. Updated devices reconstruct the tree. Older clients can read the same records as flat pinned groups and pinned tabs, keeping every tab visible. This compatibility path has automated adapter coverage; it has not been exercised on two physical Macs with different released builds.

Arc imports retain nested folders and mixed tab/folder ordering, including empty folders. Levels deeper than five put their tabs in the fifth-level folder. Iterative traversal handles deep or cyclic source trees.

## Run the tests

From the repository root:

```sh
pnpm --filter @bay/browser test
pnpm --filter @bay/import test
pnpm --filter @bay/browser typecheck
pnpm --filter @bay/shell typecheck
pnpm --filter @bay/browser compiler:check
```

For the native acceptance test, start Metro with `pnpm dev` and build the Debug app with `pnpm dev:app`. Then run:

```sh
pnpm --filter @bay/browser test:folders \
  build-dev/Build/Products/Debug/Bay.app /tmp/bay-folder-check
```

This launches and quits its own hidden browser instance. The directory retains `fixture.json`, screenshots, the isolated profile, `nested-folders.log` and `results.json`. The checks cover rendering, mixed and empty sibling ordering, native folding, tree menus, dragging, native Cmd+Z, independent page text Undo, invalid moves, and restart persistence.

## Open fake data in Debug Bay

With Metro running and the Debug app built:

```sh
pnpm --filter @bay/browser dev:folders
```

This opens a separate visible Debug instance named "Folder playground", with five levels of fake folders, an empty child, a second root, and editable offline pages. It prints its temporary profile directory and leaves the user's normal profile alone. Quit that instance normally when finished.
