# bay-core

Bay mobile's shared Rust core, used by `apps/ios` and `apps/android` through UniFFI (plan: `docs/mobile-native-plan.html`).

- `crates/bay-core`: the library (`staticlib` for iOS, `cdylib` for Android). Export with `#[uniffi::export]`; names in `uniffi.toml`.
- `crates/uniffi-bindgen`: UniFFI's generator at the same version, run by the build scripts.
- `scripts/build-ios.sh`: writes `apple/lib/<platform>/libbay_core.a`, `apple/include/BayCoreFFI/` and `apple/Sources/BayCore.swift` (git-ignored).
- `strings/<locale>.json`: the apps' words, served by `i18n`. Edit the JSON; it is the catalog.
- Android builds through `apps/android/core/bindings` (cargo-ndk + UniFFI Kotlin).

Use rustup's cargo (`~/.cargo/bin`). Before committing: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.
- `sync/`: phone ↔ computer sync, ported from `packages/sync/src/relay` and the Expo app's sync. Checked against the Mac's golden vector (`../sync/fixtures/golden.json`), a TypeScript pairing (`fixtures/pairing.json`), a TypeScript-built chain (`fixtures/scope-chain.json`) and the TypeScript phone's run (`fixtures/phone-sync.json`). The pairing and the chain come from `packages/sync`, and `scripts/pairing-vector.mjs` and `scripts/scope-vector.mjs` write them again; the phone's run was recorded before the Expo app was removed.
- To try sync on a device without a Mac: `node scripts/stand-in-computer.mjs sync` publishes a computer's records on the real relay, `pair <CODE>` lets in the phone showing that code, `phrase` prints the chain's recovery phrase, and `clear` deletes the chain. Always clear when done.
- `input/`: address input, IDN display, the calculator, emoji and quick-create rows, and the search field's suggestions, ported from `@bay/core` and the Expo app's address helpers. `data/units.json`, `data/emoji.json` and `data/bangs.txt` come from `@bay/core` through `node scripts/export-core-data.mjs`. `site_search.rs`, `bangs.rs` and `scope_suggest.rs` are the chip a site name or bang turns the field into, and the results that site gives.
- Fixtures: `fixtures/<suite>.jsonl` hold every distinct call the TypeScript code made in its tests, recorded before the Expo app was removed; `tests/<suite>_fixtures.rs` replays them against the Rust port. Nothing records them any more: when the core changes an answer on purpose, change the fixture with it.
