# adblock

Brave's [adblock-rust](https://github.com/brave/adblock-rust) 0.13.5 from crates.io (MPL-2.0, `adblock/LICENSE`), used
through `[patch.crates-io]` in `../Cargo.toml`. One change: `Engine::deserialize_shared` reads a serialized engine's
rules in place instead of copying them to the heap, so a mapped `engine.dat` costs no dirty memory. It's confined to
`src/flatbuffers/unsafe_tools.rs`, `src/engine.rs` and `HEADER_PREFIX_LENGTH`'s visibility in `src/data_format/mod.rs`.

To update: take the new version's crate, reapply that change, and drop `.cargo-ok`, `.cargo_vcs_info.json`,
`.gitattributes`, `Cargo.toml.orig`, `Cargo.lock` and `rust-toolchain.toml`.
