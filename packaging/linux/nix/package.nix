# Bay from its release tarball, patched to run on NixOS without an FHS layer. This is the nixpkgs package
# (pkgs/by-name/ba/bay-browser/package.nix): scripts/linux/release.sh --formats nixpkgs writes it with the release's version and
# hash. default.nix builds the same package from a local tarball instead.
#
# The executables get the Nix loader and every library path, and the wrapper adds the same paths for libraries Chromium
# loads at run time (GTK, Qt, VA-API, Vulkan and the host's GPU drivers). The sandbox uses unprivileged user namespaces,
# which NixOS allows by default, so chrome-sandbox stays an ordinary file. The libraries are libraries.nix's.
{
  lib,
  stdenv,
  fetchurl,
  makeWrapper,
  jq,
  patchelf,
  wrapGAppsHook3,
  addDriverRunpath,
  glibc,
  nix-update-script,
  gsettings-desktop-schemas,
  alsa-lib,
  at-spi2-atk,
  at-spi2-core,
  atk,
  cairo,
  cups,
  dbus,
  expat,
  fontconfig,
  freetype,
  gdk-pixbuf,
  glib,
  gtk3,
  gtk4,
  harfbuzz,
  krb5,
  libcap,
  libdrm,
  libgbm,
  libglvnd,
  libnotify,
  libpulseaudio,
  libsecret,
  libva,
  libxkbcommon,
  nspr,
  nss,
  pango,
  pciutils,
  pipewire,
  qt6,
  systemd,
  vulkan-loader,
  wayland,
  zlib,
  libx11,
  libxcb,
  libxcomposite,
  libxcursor,
  libxdamage,
  libxext,
  libxfixes,
  libxi,
  libxrandr,
  libxrender,
  libxscrnsaver,
  libxshmfence,
  libxtst,
  # Chromium also builds a Qt 5 shim; Qt 5 is leaving nixpkgs, so the shim is kept only while nixpkgs still has it.
  libsForQt5 ? null,
}:
let
  app = "${placeholder "out"}/libexec/bay";
  libraries = [
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
    libgbm
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
    libx11
    libxcb
    libxcomposite
    libxcursor
    libxdamage
    libxext
    libxfixes
    libxi
    libxrandr
    libxrender
    libxscrnsaver
    libxshmfence
    libxtst
  ]
  ++ lib.optional (libsForQt5 != null) libsForQt5.qtbase;
  # The bundled libraries (libEGL, libGLESv2, libvulkan, libvk_swiftshader) win over the system's, as in bay-wrapper.
  libraryPath = "${app}:${lib.makeLibraryPath libraries}:${addDriverRunpath.driverLink}/lib";
in
stdenv.mkDerivation (finalAttrs: {
  pname = "bay-browser";
  version = "@VERSION@";

  src = fetchurl {
    url = "https://github.com/krishkalaria12/bay/releases/download/v${finalAttrs.version}/bay-${finalAttrs.version}-linux-x64.tar.xz";
    hash = "@HASH@";
  };

  nativeBuildInputs = [
    makeWrapper
    jq
    patchelf
    wrapGAppsHook3
  ];
  # Only for wrapGAppsHook3's schema and icon paths. The engine's libraries reach it through the rpath and wrapper
  # below; as build inputs, Qt 5 and Qt 6 together would trip nixpkgs' Qt hooks.
  buildInputs = [
    glib
    gsettings-desktop-schemas
    gtk3
  ];

  dontConfigure = true;
  dontBuild = true;
  # Release binaries are already split from their symbols; the rpath set below must stay whole.
  dontStrip = true;
  dontPatchELF = true;
  dontWrapGApps = true;
  dontWrapQtApps = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/libexec $out/share
    cp -a opt/bay ${app}
    cp -a usr/share/applications usr/share/icons usr/share/metainfo $out/share/
    rm ${app}/bay-wrapper
    ${lib.optionalString (libsForQt5 == null) "rm -f ${app}/libqt5_shim.so ${app}/libqt5_shim.so.TOC"}
    interpreter=$(cat $NIX_CC/nix-support/dynamic-linker)
    for executable in bay chrome_crashpad_handler chrome-sandbox; do
      patchelf --set-interpreter "$interpreter" --set-rpath "${libraryPath}" ${app}/$executable
    done
    if [ -f ${app}/bay-cli/bay ]; then
      patchelf --set-interpreter "$interpreter" --set-rpath "${libraryPath}" ${app}/bay-cli/bay
      # The in-app CLI installer verifies these bytes before installing the command.
      digest=$(sha256sum ${app}/bay-cli/bay | cut -d' ' -f1)
      jq --arg digest "$digest" '.sha256 = $digest' ${app}/bay-cli/manifest.json > cli-manifest.json
      mv cli-manifest.json ${app}/bay-cli/manifest.json
    fi
    find ${app} -type f \( -name '*.so' -o -name '*.so.*' \) -exec patchelf --set-rpath "${libraryPath}" {} \;
    substituteInPlace $out/share/applications/bay.desktop --replace-fail /usr/bin/bay $out/bin/bay
    runHook postInstall
  '';

  postFixup = ''
    # CHROME_WRAPPER names this launcher when Bay relaunches itself or registers as the default browser.
    makeWrapper ${app}/bay $out/bin/bay \
      "''${gappsWrapperArgs[@]}" \
      --set CHROME_WRAPPER $out/bin/bay \
      --prefix LD_LIBRARY_PATH : "${libraryPath}" \
      --prefix QT_PLUGIN_PATH : "${
        lib.makeSearchPath qt6.qtbase.qtPluginPrefix [
          qt6.qtbase
          qt6.qtwayland
        ]
      }"
  '';

  # build-app.py's guard, on the patched files: every ELF file's libraries resolve without LD_LIBRARY_PATH.
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    missing=$(find ${app} -type f | while read -r file; do
      head -c4 "$file" | grep -q ELF || continue
      ${glibc.bin}/bin/ldd "$file" | sed -n "s|^\s*\(.*\) => not found|$file: \1|p"
    done)
    if [ -n "$missing" ]; then
      echo "unresolved libraries:"; echo "$missing"; exit 1
    fi
    $out/bin/bay --version
    if [ -f ${app}/bay-cli/bay ]; then
      ${app}/bay-cli/bay --version
    fi
    runHook postInstallCheck
  '';

  passthru.updateScript = nix-update-script { };

  meta = {
    description = "Fast browser with your tabs in a sidebar";
    homepage = "https://baybrowser.in";
    downloadPage = "https://github.com/krishkalaria12/bay/releases";
    license = lib.licenses.asl20;
    # Add yourself to maintainers/maintainer-list.nix in the same pull request.
    maintainers = [ ];
    mainProgram = "bay";
    platforms = [ "x86_64-linux" ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
})
