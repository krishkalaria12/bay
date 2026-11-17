# bay-core

Bay mobile's shared Rust core, used by `apps/ios` and `apps/android` through UniFFI (plan: `docs/mobile-native-plan.html`).

- `crates/bay-core`: the library (`staticlib` for iOS, `cdylib` for Android). Export with `#[uniffi::export]`; names in `uniffi.toml`.
- `crates/uniffi-bindgen`: UniFFI's generator at the same version, run by the build scripts.
- `scripts/build-ios.sh`: writes `apple/lib/<platform>/libbay_core.a`, `apple/include/BayCoreFFI/` and `apple/Sources/BayCore.swift` (git-ignored).
- `strings/<locale>.json`: the app's words, served by `i18n`. Until the Expo app is retired, refresh them with `node scripts/import-expo-strings.mjs`.
- Android builds through `apps/android/core/bindings` (cargo-ndk + UniFFI Kotlin).

Use rustup's cargo (`~/.cargo/bin`). Before committing: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.
