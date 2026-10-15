# Rules for links from other apps

Settings > Links > Rules for links from other apps lets you add, edit, delete and reorder rules. The first matching rule wins. A rule can send a link to a space, Little Bay or a new window.

- `linear.app` matches that host and any path.
- `github.com/acme/*` matches paths under `/acme/` on that host.
- `*.example.com/*` matches subdomains. A plain host does not include subdomains.
- An optional `http://` or `https://` prefix restricts the scheme. Host matching ignores case; paths respect case. Query strings and fragments do not affect matching and are not supported in patterns.
- An optional source app uses its macOS bundle ID, such as `com.tinyspeck.slackmacgap` for Slack or `com.apple.mail` for Mail. If macOS does not identify the sender, only rules without an app restriction can match.

Unmatched links keep the existing Little Bay or new-tab preference and default space. A rule whose space is unavailable also uses this fallback. Multiple unmatched URLs still open in main-window tabs. Rules apply only to incoming desktop links, including cold launches, rather than links clicked within a page.

Rules persist in the session and sync when Settings sync is enabled. Their order travels as one record. Space destinations use stable sync profile IDs and resolve to the receiving Mac's local spaces. If a space is not on that Mac yet, its rule remains visible as unavailable until the profile is linked. Concurrent edits to the list follow the existing sync conflict policy.

## Debug browser with fake data

Start Metro and build the Debug app with `pnpm dev:app`. In another terminal:

```sh
pnpm --filter @bay/browser dev:links
```

This opens a separate disposable profile with Personal and Work spaces and offline sample links. It prints the profile location and `dev:links --send <profile> <url> [sourceApp]` commands for simulating incoming links in that exact instance, including fake Slack and Mail sources. Keep the command running while testing. Ctrl+C closes the playground and its local server. The installed browser's data is not used.

Run the small browser acceptance test against the Debug build:

```sh
pnpm --filter @bay/browser test:links build-dev/Build/Products/Debug/Bay.app
```

The test uses an offline server and its own profile, exercises a native cold-launch link, routing priority and source filters, all destinations, fallback behavior and persistence. It leaves its log and screenshots in the printed scratch directory and quits only its own test instance.

The focused unit tests cover wildcard matching, legacy sessions, persistence and rule sync between different local space IDs. They do not constitute a live sync test on two Macs.

## Browser research

[Arc's Air Traffic Control](https://resources.arc.net/hc/en-us/articles/22932014625431-Air-Traffic-Control-Automate-Your-Link-Routing) puts routes under Settings > Links, offers URL contains/equality matching and a fallback destination.

[Zen's merged Space Routing implementation](https://github.com/zen-browser/desktop/pull/13981) describes contains, equality and regular-expression routes, space destinations and a separate default for external links. Bay follows the Phase 2 host/path wildcard specification instead of introducing these additional match modes.
