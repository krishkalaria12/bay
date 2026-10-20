# Extension import runtime regression

Run after rebuilding Chromium/NNCore and embedding the resulting framework in
Bay.app:

```sh
node engine/chromium/tests/extension-import/run.mjs --app /absolute/path/to/Bay.app
```

The runner compiles one small Objective-C probe, copies and ad-hoc signs the app,
and launches only that copy with fresh temporary data directories. It never
builds Chromium or changes the supplied app or existing browser profiles.
The copied app must have a usable bundled JavaScript bundle; the probe itself
does not require Metro or the app's JavaScript test harness.

Checks cover refusal to snapshot a live source database, merge without replacing
existing destination keys, source files remaining unchanged, restored storage
being visible on the first background execution, idempotent retries, disabled and
pinned state, and a real quota failure after registration. The quota test proves
that the failure retains the installed path, the hold survives a process restart,
explicit enable cannot bypass it, and a later retry resumes settings restoration
before activation. Each source/target shutdown must be graceful, so a forced
termination cannot produce a passing persistence result.

An optional online check downloads a real signed Web Store extension, verifies
its original ID and store installation/update mode, and verifies that unknown
original permissions keep it disabled for review, including after hydration and
a process restart. Supply an extension that
requires permissions, for example:

```sh
node engine/chromium/tests/extension-import/run.mjs --app /absolute/path/to/Bay.app \
  --store-id eimadpbcbfnmbkopoojfekhnkhdbieeh
```

Each local engine call has a 45-second deadline; the optional store call has a
160-second deadline, covering the engine's two-minute download timeout. Each
app launch is bounded by the shared instance helper. Test artifacts are retained
in the printed temporary directory for diagnosis. The shared instance helper
quits only processes whose executable and start time match the test instance.

This harness requires macOS, Node 22+, Xcode's `xcrun clang`, `codesign`, and the
rebuilt framework. It has not been compiled or run against the new framework
as part of this change. It does not simulate a forged store publisher proof;
the production installer still enforces that proof and its expected ID.
