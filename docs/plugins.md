# Bay plugins

A plugin is a folder with a `manifest.json` and a script. Settings › Plugins › Add Plugin… copies the folder into
Bay's plugins folder, says what the plugin may do, and turns it on. Changing the original folder changes nothing until
you add it again (which updates it in place).

[`plugins/hello-bay`](plugins/hello-bay) uses every part of the format; start from a copy of it.

## Where it runs

Each plugin runs in a web page of its own: WebKit's on the Mac, a `chrome-untrusted://bay-plugin/` frame of Bay's own
document on Windows and Linux. Either way it's a renderer process apart from Bay and from your pages, sandboxed into a
unique origin, under a content security policy that allows only the plugin's own files: no network, no frames, no
workers, no storage of its own. Everything else goes through `bay`, which Bay checks against the manifest.

The page loads Bay's runtime and then the manifest's `main` script. There's no DOM to show; register handlers at the
top level, and Bay runs them when the person uses what the plugin adds.

## manifest.json

```json
{
  "manifestVersion": 1,
  "id": "hello-bay",
  "name": "Hello Bay",
  "version": "1.0.0",
  "description": "What it does, in a sentence.",
  "author": "You",
  "main": "main.js",
  "permissions": { "hosts": ["https://api.github.com"], "tabs": true, "links": false },
  "settings": [],
  "contributes": {}
}
```

- `id`: 2 to 40 lowercase letters, digits and dashes, from a letter. It's also the folder's name once added.
- `main`: the script, relative to the folder (`main.js` when left out).
- `permissions.hosts`: the origins `bay.fetch` may reach, like `https://api.example.com` or `https://*.example.com:8443`
  (a wildcard takes the domain and its subdomains). Only https, except `http://localhost` and `127.0.0.1`.
- `permissions.tabs`: commands get the address and title of the page they run on (never a private window's).
- `permissions.links`: the plugin may decide where links from other apps open.

Fields Bay doesn't know are refused, so a typo shows in Settings rather than doing nothing. Bay's own manifest check is
`packages/rust/bay-plugins/src/manifest.rs`.

### settings

Each is `{ "key", "title", "type", "description"?, "default"? }`, shown in the plugin's Details in Settings.

| type | value |
| --- | --- |
| `text` | a line of text |
| `secret` | text kept in the system's keychain (the Keychain, Credential Manager, the desktop keyring); never has a default |
| `toggle` | true or false |
| `choice` | one of `options: [{ "value", "title" }]` |

### contributes

| field | each one | what it is |
| --- | --- | --- |
| `commands` | `{ id, title, icon?, keywords?, needs?: "page" }` | Command bar entries; `needs: "page"` shows it only on a web page |
| `toolbar` | `{ id, title, icon?, command }` or `{ id, title, icon?, view }` | Toolbar buttons that run a command or open a sidebar view |
| `tabMenu` | `{ id, title, command }` | Tab menu items that run a command on that tab |
| `sidebarViews` | `{ id, title, icon? }` | A panel beside the page with a list the plugin fills |
| `liveSources` | `{ id, name, kind: "pullRequests" \| "documents", site? }` | Sources for live folders, chosen in a folder's menu |
| `themes` | `{ id, name, colors: ["#RRGGBB", …] }` | One to three colours, offered in a space's theme editor |

Icons are symbol names, like `star`, `tray.full` or `hand.wave`. Up to 20 of each.

## The `bay` object

Everything is a promise; a call Bay refuses rejects with the reason.

| call | does |
| --- | --- |
| `bay.commands.on(id, async ({ source, tab }) => …)` | Runs when the person runs command `id`. `tab` is `{ url, title }` with `permissions.tabs`, else null |
| `bay.liveSources.on(id, async () => items)` | Answers a live folder's refresh: up to 200 `{ id, url, title, subtitle?, icon?, updatedAt? }` |
| `bay.liveSources.refresh(id)` | Asks the folders showing source `id` to refresh now |
| `bay.views.set(id, items)` | Fills sidebar view `id`: up to 200 `{ id, title, subtitle?, icon?, url? }` |
| `bay.views.onSelect(id, async ({ item }) => …)` | Runs when the person chooses an item without a `url` (one with a `url` opens it) |
| `bay.toolbar.set(id, { badge?, title? })` | Changes a button's badge (four characters at most) or title |
| `bay.links.decide(async ({ url, sourceApp, spaces }) => …)` | With `permissions.links`: answer `{ space }` (an id or a name), `{ littleBay: true }`, `{ newWindow: true }` or null. A plugin has 400 ms |
| `bay.fetch(url, { method?, headers?, body? })` | A request to a listed host, without your cookies; answers like `fetch` (`ok`, `status`, `headers.get`, `text()`, `json()`). Text bodies up to 5 MB |
| `bay.tabs.open(url, { background? })` | Opens a tab, only while a command or item the person chose runs |
| `bay.tabs.active()` | With `permissions.tabs`: the page in the front window |
| `bay.settings.get()` | The plugin's settings, secrets included |
| `bay.settings.onChange(listener)` | Called with the settings when the person changes one |
| `bay.storage.get(key)`, `bay.storage.set(key, value)` | A small JSON store of the plugin's own: 64 KB a value, 1 MB in all; `null` deletes |
| `bay.notify(message)` | A system notification, at most every ten seconds |

A handler that takes longer than 30 seconds is stopped. Uncaught errors show as the plugin's last error in Settings.

## Limits

A plugin's folder holds at most 500 files and 25 MB, each file at most 10 MB, and no links. Hidden files (`.git`) are
left out when it's added. Bay can turn plugins off for a release with a kill switch (the feature `plugins`, signed by
`scripts/release/sign-switches.mjs`).
