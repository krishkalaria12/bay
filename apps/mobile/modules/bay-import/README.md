# Bay import (mobile)

A phone's browsers keep their data in their own sandbox, so Bay imports from the files they export: Safari's
export (Settings → Apps → Safari → Export), Google Takeout's Chrome archive, and any bookmarks HTML file.

This module only does what JavaScript shouldn't:

- `readExport(path)` unpacks an archive into the cache and returns the files Bay reads: bookmark pages (`.html`)
  and history files (`History*.json`, `BrowserHistory.json`). Everything else, passwords and cards included,
  stays in the archive and is only named. A file that isn't an archive is returned as it is.
- `discardExport()` deletes what was unpacked.
- `installedBrowsers()` lists the apps that open any web address (Android). iOS finds browsers by URL scheme in
  JavaScript instead, against `LSApplicationQueriesSchemes` in `app.json`.

The parsing itself is shared TypeScript in `src/import/exports.ts`. Both platforms follow the same rules
(`ios/BayExport.swift`, `android/.../BayImportModule.kt`): at most 64 files of 64 MB each, ZIP64 included.
Rebuild both dev clients after changing it.
