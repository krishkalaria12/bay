#!/bin/bash
# Packs a staged Linux app (scripts/linux/build-app.py) for release: the /opt/bay tree with its desktop integration, as
# a .tar.xz, .deb, .rpm, AppImage (with zsync updates) and the AUR bay-bin PKGBUILD, plus SHA256SUMS.
#
#   scripts/linux/release.sh --app dist/linux-app --version 1.4.0 [--output dist/linux-release] [--formats tar,deb,...]
#
# Formats default to all of tar,deb,rpm,appimage,aur; aur needs tar. Set BAY_GPG_KEY to sign every artifact and
# SHA256SUMS with detached ASCII signatures. Publishing is a separate step.
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
packaging="$repo/packaging/linux"
app="" version="" output="$repo/dist/linux-release" formats="tar,deb,rpm,appimage,aur"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) app=$2; shift 2 ;;
    --version) version=$2; shift 2 ;;
    --output) output=$2; shift 2 ;;
    --formats) formats=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$app" && -n "$version" ]] || { echo "usage: $0 --app DIR --version X.Y.Z [--output DIR] [--formats LIST]" >&2; exit 2; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be X.Y.Z: $version" >&2; exit 2; }
want() { [[ ",$formats," == *",$1,"* ]]; }
need() { command -v "$1" >/dev/null || { echo "$2 needs $1 on PATH" >&2; exit 1; }; }
want aur && ! want tar && { echo "the aur format needs tar" >&2; exit 2; }
want deb && need dpkg-deb deb
want rpm && need rpmbuild rpm
want appimage && need appimagetool appimage && need zsyncmake appimage
[[ -n "${BAY_GPG_KEY:-}" ]] && need gpg signing

python3 "$repo/scripts/linux/build-app.py" --verify "$app" >/dev/null
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$output"
artifacts=()

# The installed tree, shared by every format.
root="$work/root"
mkdir -p "$root/opt/bay" "$root/usr/bin" "$root/usr/share/applications" "$root/usr/share/metainfo" \
  "$root/etc/apparmor.d" "$root/etc/bay/native-messaging-hosts" "$root/etc/bay/policies/managed" "$root/etc/bay/policies/recommended"
cp -a "$app/." "$root/opt/bay/"
chmod 0755 "$root/opt/bay/bay-wrapper" "$root/opt/bay/chrome_sandbox"
ln -s /opt/bay/bay-wrapper "$root/usr/bin/bay"
install -m 0644 "$packaging/bay.desktop" "$root/usr/share/applications/bay.desktop"
install -m 0644 "$packaging/apparmor/bay" "$root/etc/apparmor.d/bay"
# The release date is the release notes' when they have one.
notes="$repo/release-notes/$version.md"
date=$( { [[ -f "$notes" ]] && sed -n 's/^date: *\([0-9-]*\)$/\1/p' "$notes"; } || true)
date=${date:-$(date -u +%Y-%m-%d)}
sed "s|</component>|  <releases>\n    <release version=\"$version\" date=\"$date\" />\n  </releases>\n</component>|" \
  "$packaging/in.krishkalaria.bay.metainfo.xml" >"$root/usr/share/metainfo/in.krishkalaria.bay.metainfo.xml"
# The Mac app's icon set: the small cut at 16 and 32, the full mark above (README › The icon).
icons="$repo/apps/browser/macos/Bay-macOS/Assets.xcassets/AppIcon.appiconset"
for pair in 16:icon_16x16_1x 32:icon_32x32_1x 64:icon_32x32_2x 128:icon_128x128_1x 256:icon_256x256_1x 512:icon_512x512_1x; do
  install -Dm 0644 "$icons/${pair#*:}.png" "$root/usr/share/icons/hicolor/${pair%%:*}x${pair%%:*}/apps/bay.png"
done
install -Dm 0644 "$repo/apps/browser/assets/app-icon.svg" "$root/usr/share/icons/hicolor/scalable/apps/bay.svg"

if want tar; then
  # Unpacks to bay-<version>/ holding opt/, usr/ and etc/: copy it to / or run opt/bay/bay-wrapper where it is. The
  # sandbox isn't setuid here; the AUR package sets it as root.
  tarball="$output/bay-$version-linux-x64.tar.xz"
  mv "$root" "$work/bay-$version"
  tar --sort=name --owner=0 --group=0 --numeric-owner -C "$work" -cJf "$tarball" "bay-$version"
  mv "$work/bay-$version" "$root"
  artifacts+=("$tarball")
fi

if want deb; then
  deb="$work/deb"
  cp -a "$root" "$deb"
  chmod 4755 "$deb/opt/bay/chrome_sandbox"
  mkdir -p "$deb/DEBIAN"
  install -m 0755 "$packaging/deb/postinst" "$packaging/deb/prerm" "$deb/DEBIAN/"
  echo /etc/apparmor.d/bay >"$deb/DEBIAN/conffiles"
  # Chrome's own .deb dependencies, unversioned until the engine's glibc floor is measured (engine-lock.json).
  cat >"$deb/DEBIAN/control" <<EOF
Package: bay
Version: $version
Architecture: amd64
Maintainer: Krish Kalaria <https://github.com/krishkalaria12>
Installed-Size: $(du -sk "$deb" | cut -f1)
Depends: ca-certificates, fonts-liberation, libasound2, libatk-bridge2.0-0, libatk1.0-0, libatspi2.0-0, libc6, libcairo2, libcups2, libdbus-1-3, libdrm2, libexpat1, libgbm1, libglib2.0-0, libgtk-3-0 | libgtk-4-1, libnspr4, libnss3, libpango-1.0-0, libsecret-1-0, libudev1, libvulkan1, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxkbcommon0, libxrandr2, xdg-utils
Provides: www-browser, gnome-www-browser
Section: web
Priority: optional
Homepage: https://bay.krishkalaria.in
Description: A fast browser with your tabs in a sidebar
 Bay is a browser built around a sidebar, on Chromium: spaces, pinned tabs and
 folders, Peek and Split View, a command bar, and built-in ad blocking.
EOF
  dpkg-deb --root-owner-group -Zxz --build "$deb" "$output/bay_${version}_amd64.deb" >/dev/null
  artifacts+=("$output/bay_${version}_amd64.deb")
fi

if want rpm; then
  sed "s/@VERSION@/$version/" "$packaging/rpm/bay.spec.in" >"$work/bay.spec"
  rpmbuild -bb --quiet --define "_topdir $work/rpmbuild" --define "_rpmdir $work/rpms" --define "bay_root $root" \
    --define "_build_name_fmt %%{NAME}-%%{VERSION}-%%{RELEASE}.%%{ARCH}.rpm" "$work/bay.spec"
  cp "$work/rpms/bay-$version-1.x86_64.rpm" "$output/"
  artifacts+=("$output/bay-$version-1.x86_64.rpm")
fi

if want appimage; then
  # AppRun starts opt/bay/bay-wrapper inside the image; the image's name starts "Bay" so AppRun's AppArmor profile
  # (/tmp/.mount_Bay*) matches its mount.
  appdir="$work/Bay.AppDir"
  mkdir -p "$appdir"
  cp -a "$root/opt" "$root/usr" "$appdir/"
  rm "$appdir/usr/bin/bay"
  install -m 0755 "$packaging/AppRun" "$appdir/AppRun"
  sed -e 's|^Exec=/usr/bin/bay|Exec=bay|' -e '/^TryExec=/d' "$packaging/bay.desktop" >"$appdir/bay.desktop"
  cp "$root/usr/share/icons/hicolor/256x256/apps/bay.png" "$appdir/bay.png"
  ln -s bay.png "$appdir/.DirIcon"
  image="$output/Bay-$version-x86_64.AppImage"
  (cd "$output" && ARCH=x86_64 appimagetool --no-appstream -u "gh-releases-zsync|krishkalaria12|bay|latest|Bay-*-x86_64.AppImage.zsync" \
    "$appdir" "$image" >/dev/null)
  artifacts+=("$image" "$image.zsync")
fi

if want aur; then
  mkdir -p "$output/aur"
  sed -e "s/@VERSION@/$version/" -e "s/@SHA256@/$(sha256sum "$tarball" | cut -d' ' -f1)/" "$packaging/aur/PKGBUILD.in" >"$output/aur/PKGBUILD"
  if command -v makepkg >/dev/null; then (cd "$output/aur" && makepkg --printsrcinfo >.SRCINFO); fi
fi

(cd "$output" && sha256sum "${artifacts[@]##*/}" >SHA256SUMS)
if [[ -n "${BAY_GPG_KEY:-}" ]]; then
  for file in "${artifacts[@]}" "$output/SHA256SUMS"; do
    gpg --batch --yes --local-user "$BAY_GPG_KEY" --armor --detach-sign --output "$file.asc" "$file"
  done
fi
printf '%s\n' "${artifacts[@]}" "$output/SHA256SUMS"
