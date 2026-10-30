# The libraries Bay's engine links or loads at run time (GTK, Qt and GPU stacks are loaded on demand), shared by the
# package in default.nix and the build shell, whose ldd check in build-app.py needs the same set.
pkgs:
let
  # nixpkgs is moving X11 libraries out of the xorg set and libgbm out of mesa; accept either location.
  x11 = name: legacy: pkgs.${name} or pkgs.xorg.${legacy};
in
with pkgs;
[
  alsa-lib
  at-spi2-atk
  at-spi2-core
  atk
  cairo
  cups
  dbus
  expat
  fontconfig
  freetype
  gdk-pixbuf
  glib
  gtk3
  gtk4
  harfbuzz
  krb5
  libcap
  libdrm
  (pkgs.libgbm or mesa)
  libglvnd
  libnotify
  libpulseaudio
  libsecret
  libva
  libxkbcommon
  nspr
  nss
  pango
  pciutils
  pipewire
  qt6.qtbase
  qt6.qtwayland
  stdenv.cc.cc.lib
  systemd
  vulkan-loader
  wayland
  zlib
  (x11 "libx11" "libX11")
  (x11 "libxcb" "libxcb")
  (x11 "libxcomposite" "libXcomposite")
  (x11 "libxcursor" "libXcursor")
  (x11 "libxdamage" "libXdamage")
  (x11 "libxext" "libXext")
  (x11 "libxfixes" "libXfixes")
  (x11 "libxi" "libXi")
  (x11 "libxrandr" "libXrandr")
  (x11 "libxrender" "libXrender")
  (x11 "libxscrnsaver" "libXScrnSaver")
  (x11 "libxshmfence" "libxshmfence")
  (x11 "libxtst" "libXtst")
]
# Chromium also builds a Qt 5 shim; Qt 5 is leaving nixpkgs, so it is linked only while nixpkgs still has it.
++ pkgs.lib.optional (pkgs ? libsForQt5) pkgs.libsForQt5.qtbase
