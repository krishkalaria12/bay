# Browser extension import

The Extensions option imports user-installed extensions into each destination engine profile. Arc spaces receive the extensions from their source profile. Firefox and Zen add-ons are profile-wide.

## Chromium

Chrome Web Store extensions use the engine's `nn_extensions_import` call. It downloads the signed CRX, validates its Web Store publisher proof and expected identity, and installs it through Chromium's normal installer and updater.

New installations stay disabled through a persistent import hold until settings restoration finishes. Source-disabled extensions stay disabled. Store packages with new or unverifiable permissions remain disabled for permission review. Existing completed installations and their settings are preserved on retries.

`storage.local` and `storage.sync` settings are read from a private LevelDB clone. The source database must be closed so the importer can take its exclusive lock. The source is never opened for recovery or rewritten. Destination settings use Chromium's quota and sync storage wrappers; existing keys win. An interrupted import stays disabled and can be retried from the same source profile.

Developer and off-store unpacked extensions keep owned local copies. They have no Web Store automatic updates. IndexedDB, extension-origin localStorage, managed policy data, and session storage are not migrated.

## Firefox and Zen

Add-ons are discovered from `extensions.json` and profile-owned XPI packages. Exact publisher-verified addon IDs select the Chromium counterparts of Dark Reader, Bitwarden, and Privacy Badger. Those versions use the normal signed store installation path. Names are never used for matching.

Other XPIs pass conservative compatibility checks. Eligible MV3 scripts and content-only or worker-compatible nonpersistent MV2 add-ons become local MV3 extensions with stable identities. The adapter preserves supported permissions and supplies equivalent `getBrowserInfo`, `menus`, `browserAction`, and `extension.getURL` behavior.

Unsupported permissions, containers, request-body filtering, Firefox sidebar APIs, persistent or DOM-based backgrounds, and removed legacy APIs produce specific rejection reasons. Static screening cannot establish compatibility for arbitrary JavaScript, remote services, or every add-on.

Converted add-ons do not receive automatic Firefox updates. Firefox's extension storage is not migrated, including when a publisher's Chromium counterpart is installed.

## Build and validation

The engine requires `engine/patches/chromium-extension-import.patch` and the owned `nn_extension_import` source. Rebuild the Chromium framework before testing the complete install and settings path. The native bridge checks the export and reports a clear error on older engines.

Focused validation:

```sh
pnpm --filter @bay/import test
bash packages/import/scripts/native-writer-tests/run.sh
pnpm --filter @bay/browser test
pnpm --filter @bay/import typecheck
pnpm --filter @bay/browser typecheck
```

The native writer test compiles real import sources against the bridge headers with mocked engine callbacks. It verifies orchestration and file ownership. Live engine tests are needed to verify package rejection, hydration before execution, updates, and recovery after interruption.

After rebuilding and embedding the engine framework, run the isolated
[engine runtime regression](../../engine/chromium/tests/extension-import/README.md):

```sh
node engine/chromium/tests/extension-import/run.mjs --app /absolute/path/to/Bay.app
```

That harness requires the new engine export. It covers settings before background
execution, live-source locking, existing destination values, disabled/pinned state,
and failed hydration plus recovery across a process restart. Its optional
`--store-id` check downloads a real signed store package and checks that unknown
permissions remain disabled across restart. The harness has been checked for
syntax; these new-engine runtime assertions await the framework rebuild.

The Firefox adapter can also be exercised on an existing compatible engine in an
isolated Debug app instance. Start Metro in one terminal, then run the script in
another:

```sh
pnpm --filter @bay/browser dev --port 8091
METRO_PORT=8091 node packages/import/scripts/firefox-runtime.mjs /absolute/path/to/Debug/Bay.app
```

This Firefox check verifies the converted adapter runtime with temporary profiles.
It does not require the new import export or verify engine storage hydration.
