//! On macOS: compiles the app's host glue (packages/chromium/ios/*.mm, the same files the React Native app's
//! BayNNCore pod builds) with the bridge (src/macos/bridge.mm), and links Chrome's framework built with
//! engine/nncore. `NNCORE_FRAMEWORK` names another framework than the staged one
//! (packages/chromium/scripts/stage-framework.sh writes it to apps/browser/build-nncore/NNCoreFramework).
//!
//! Without a framework (CI, a fresh checkout) it builds a stand-in engine that says what is missing, so the workspace
//! still checks, lints and tests.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const FRAMEWORK: &str = "Chromium Framework";
const SYSTEM_FRAMEWORKS: [&str; 7] = [
    "AppKit",
    "Foundation",
    "IOKit",
    "QuartzCore",
    "Security",
    "UniformTypeIdentifiers",
    "WebKit",
];

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=NNCORE_FRAMEWORK");
    println!("cargo:rustc-check-cfg=cfg(bay_engine_stub)");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let manifest =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let repo = manifest.join("../../..");

    let framework = env::var_os("NNCORE_FRAMEWORK")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            repo.join(format!(
                "apps/browser/build-nncore/NNCoreFramework/{FRAMEWORK}.framework"
            ))
        });
    let binary = framework.join(FRAMEWORK);
    println!("cargo:rerun-if-changed={}", binary.display());
    if !binary.exists() {
        println!(
            "cargo:warning=no NNCore framework at {}: building without the engine (packages/chromium/scripts/stage-framework.sh, or set NNCORE_FRAMEWORK)",
            framework.display()
        );
        println!("cargo:rustc-cfg=bay_engine_stub");
        return;
    }

    let glue = repo.join("packages/chromium/ios");
    let mut sources = files(&glue, "mm");
    sources.push(manifest.join("src/macos/bridge.mm"));
    for file in sources.iter().chain(&files(&glue, "h")) {
        println!("cargo:rerun-if-changed={}", file.display());
    }

    let mut build = cc::Build::new();
    build
        .cpp(true)
        .files(&sources)
        .include(manifest.join("include"))
        .include(&glue)
        .include(repo.join("engine/nncore/src/bay/core/public"))
        .include(repo.join("packages/adblock/include"))
        .include(repo.join("packages/rust/bay-lists/include"))
        .include(repo.join("packages/rust/bay-switches/include"))
        .include(repo.join("packages/rust/bay-plugins/include"))
        .flag("-fobjc-arc")
        .flag("-std=c++20")
        .flag("-mmacosx-version-min=14.0")
        .warnings(false);
    if env::var("PROFILE").as_deref() == Ok("debug") {
        build.define("DEBUG", "1");
    }
    build.compile("bay_engine_mac");

    if let Some(dir) = framework.parent() {
        println!("cargo:rustc-link-search=framework={}", dir.display());
    }
    println!("cargo:rustc-link-lib=framework={FRAMEWORK}");
    for system in SYSTEM_FRAMEWORKS {
        println!("cargo:rustc-link-lib=framework={system}");
    }
}

fn files(dir: &Path, extension: &str) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|ext| ext == extension))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}
