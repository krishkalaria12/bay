# Releases

- Package macOS DMGs with LZMA: `-format ULMO -imagekey udif-chunk-size=8192`.
- Strip local Chromium symbols with `strip -x` on the private release copy before final signing and notarization. Retain matching unstripped binaries outside the app; verify UUIDs and exports remain unchanged. Never strip shared engine outputs, caches or installed apps.
- Preserve browser features and resources. Validate the signed candidate and Sparkle update before shipping; size reductions must not remove locales, codecs or GPU fallbacks.
