# The Linux engine and app build on NixOS: `nix-shell packaging/linux/nix/shell.nix`, then the commands in
# docs/linux-building.md. Chromium downloads prebuilt host tools (clang, gn, siso, node, CIPD's Python) that expect
# /lib64/ld-linux-x86-64.so.2 and libraries under /usr/lib; this shell gives them that layout. Target libraries still
# come from Chromium's pinned Debian sysroot, so the engine matches the other distros' builds.
{
  pkgs ? import <nixpkgs> { },
}:
(pkgs.buildFHSEnv {
  name = "bay-build";
  targetPkgs =
    p:
    with p;
    [
      bash
      binutils
      bison
      bzip2
      cacert
      coreutils
      curl
      diffutils
      file
      findutils
      flex
      gawk
      git
      gnugrep
      gnupatch
      gnused
      gnutar
      gperf
      gzip
      libffi
      libxml2
      ncurses
      nodejs_24
      openssl
      perl
      pkg-config
      procps
      python3
      sqlite
      unzip
      util-linux
      which
      xz
      zip
      zstd
    ]
    ++ import ./libraries.nix p;
  # pkg-config files for the native package tests (OpenSSL, SQLite, NSS, GLib, libsecret).
  extraOutputsToInstall = [ "dev" ];
  profile = ''
    export LANG=''${LANG:-C.UTF-8}
    # pnpm comes from Corepack at the version package.json pins.
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    mkdir -p "$HOME/.cache/bay-build/bin"
    corepack enable --install-directory "$HOME/.cache/bay-build/bin" pnpm
    export PATH="$HOME/.cache/bay-build/bin:$PATH"
  '';
  runScript = "bash";
}).env
