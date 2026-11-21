# Bay from a release tarball (scripts/linux/release.sh --formats tar), patched to run on NixOS without an FHS layer:
#
#   nix-build packaging/linux/nix --arg tarball ./dist/linux-release/bay-1.4.0-linux-x64.tar.xz
#
# It's package.nix, the nixpkgs package, with the local tarball in place of the release download.
{
  pkgs ? import <nixpkgs> { },
  tarball,
}:
let
  match = builtins.match "bay-([0-9]+\\.[0-9]+\\.[0-9]+)-linux-x64\\.tar\\.xz" (
    baseNameOf (toString tarball)
  );
in
assert pkgs.lib.assertMsg (
  match != null
) "tarball must be a release tarball named bay-X.Y.Z-linux-x64.tar.xz";
(pkgs.callPackage ./package.nix { }).overrideAttrs {
  version = builtins.head match;
  src = tarball;
}
