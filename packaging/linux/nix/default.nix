# Bay from a release tarball (scripts/linux/release.sh --formats tar), patched to run on NixOS without an FHS layer:
#
#   nix-build packaging/linux/nix --arg tarball ./dist/linux-release/bay-1.4.0-linux-x64.tar.xz
#
# The executables get the Nix loader and every library path, and the wrapper adds the same paths for libraries Chromium
# loads at run time (GTK, Qt, VA-API, Vulkan and the host's GPU drivers). The sandbox uses unprivileged user namespaces,
# which NixOS allows by default, so chrome-sandbox stays an ordinary file.
{
  pkgs ? import <nixpkgs> { },
  tarball,
}:
let
  inherit (pkgs) lib;
  libraries = import ./libraries.nix pkgs;
  match = builtins.match "bay-([0-9]+\\.[0-9]+\\.[0-9]+)-linux-x64\\.tar\\.xz" (
    baseNameOf (toString tarball)
  );
  app = "${placeholder "out"}/libexec/bay";
  # The bundled libraries (libEGL, libGLESv2, libvulkan, libvk_swiftshader) win over the system's, as in bay-wrapper.
  libraryPath = "${app}:${lib.makeLibraryPath libraries}:${pkgs.addDriverRunpath.driverLink}/lib";
in
assert lib.assertMsg (
  match != null
) "tarball must be a release tarball named bay-X.Y.Z-linux-x64.tar.xz";
pkgs.stdenv.mkDerivation {
  pname = "bay";
  version = builtins.head match;
  src = tarball;

  nativeBuildInputs = with pkgs; [
    makeWrapper
    patchelf
    wrapGAppsHook3
  ];
  # Only for wrapGAppsHook3's schema and icon paths. The engine's libraries reach it through the rpath and wrapper
  # below; as build inputs, Qt 5 and Qt 6 together would trip nixpkgs' Qt hooks.
  buildInputs = with pkgs; [
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
    interpreter=$(cat $NIX_CC/nix-support/dynamic-linker)
    for executable in bay chrome_crashpad_handler chrome-sandbox; do
      patchelf --set-interpreter "$interpreter" --set-rpath "${libraryPath}" ${app}/$executable
    done
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
        lib.makeSearchPath pkgs.qt6.qtbase.qtPluginPrefix [
          pkgs.qt6.qtbase
          pkgs.qt6.qtwayland
        ]
      }"
  '';

  # build-app.py's guard, on the patched files: every ELF file's libraries resolve without LD_LIBRARY_PATH.
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    missing=$(find ${app} -type f | while read -r file; do
      head -c4 "$file" | grep -q ELF || continue
      ${pkgs.glibc.bin}/bin/ldd "$file" | sed -n "s|^\s*\(.*\) => not found|$file: \1|p"
    done)
    if [ -n "$missing" ]; then
      echo "unresolved libraries:"; echo "$missing"; exit 1
    fi
    runHook postInstallCheck
  '';

  meta = {
    description = "A fast browser with your tabs in a sidebar";
    homepage = "https://github.com/krishkalaria12/bay";
    license = lib.licenses.asl20;
    mainProgram = "bay";
    platforms = [ "x86_64-linux" ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
