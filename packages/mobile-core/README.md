# bay-core

Bay mobile's shared Rust core, used by `apps/ios` and `apps/android` through UniFFI (plan: `docs/mobile-native-plan.html`).

- `crates/bay-core`: the library (`staticlib` for iOS, `cdylib` for Android). Export with `#[uniffi::export]`; names in `uniffi.toml`.
- `crates/uniffi-bindgen`: UniFFI's generator at the same version, run by the build scripts.
- `scripts/build-ios.sh`: writes `apple/lib/<platform>/libbay_core.a`, `apple/include/BayCoreFFI/` and `apple/Sources/BayCore.swift` (git-ignored).
- `strings/<locale>.json`: the app's words, served by `i18n`. Until the Expo app is retired, refresh them with `node scripts/import-expo-strings.mjs`.
- Android builds through `apps/android/core/bindings` (cargo-ndk + UniFFI Kotlin).

Use rustup's cargo (`~/.cargo/bin`). Before committing: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.
- `sync/`: phone ↔ computer sync, ported from `packages/sync/src/relay` and the Expo app's `src/sync`. Checked against the Mac's golden vector (`../sync/fixtures/golden.json`), a TypeScript pairing (`fixtures/pairing.json`), a TypeScript-built chain (`fixtures/scope-chain.json`) and the TypeScript phone's run (`fixtures/phone-sync.json`); each has a script in `scripts/` that writes it again.
- To try sync on a device without a Mac: `node scripts/stand-in-computer.mjs sync` publishes a computer's records on the real relay, `pair <CODE>` lets in the phone showing that code, `phrase` prints the chain's recovery phrase, and `clear` deletes the chain. Always clear when done.
