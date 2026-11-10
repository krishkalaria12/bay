# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop (MIT, see `LICENSE`)
- Commit: `13909c9e07590f5a85d93c62712259fe14a883f7`, plugin version 0.1.2
- Copied from: `skills/install-anti-slop/assets/anti-slop/`, identical to upstream's `src/` without its test files
- Installed at: `tools/oxlint/anti-slop/`, entry point `index.ts`
- Companion dependency: `@oxlint/plugins`, pinned to the same exact version as `oxlint`; upgrade them together

## Intentional deviations

- The optional Effect rule group (`effect/`) is left out: no Bay package depends on `effect` directly.
- `LICENSE` is added here from the upstream repository root.

This is vendored code: Bay owns it. Change the rules here when they don't fit, and record the change above.
