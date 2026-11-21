#!/bin/bash
# Publishes the Linux packages scripts/linux/release.sh wrote (the linux-build workflow's bay-linux-packages):
#
#   1. signs the .rpm, then every artifact and the checksums, and adds them to the GitHub release v<version>, which the
#      Mac release has already published;
#   2. rebuilds the signed APT and RPM repositories and the AppImage update file on the prerelease linux-repo. The
#      packages stay on v<version>: apps/web/public/_redirects serves both at https://baybrowser.in/linux/;
#   3. pushes bay-bin to the AUR;
#   4. uploads the snap to the Snap Store's stable channel, when SNAPCRAFT_STORE_CREDENTIALS is set and there's a snap.
#
# Flathub and nixpkgs update through pull requests: after the first, by hand, their bots open one for each release
# (release.sh's flatpak and nixpkgs folders hold the files).
#
#   scripts/linux/publish.sh --packages dist/linux-release --version X.Y.Z [--dry-run]
#
# BAY_GPG_KEY names the signing key in gpg's keyring. AUR_SSH_KEY is the file holding the AUR account's private key.
# Everything goes in <packages>/publish first; --dry-run stops there, uploads nothing and needs neither gh nor the AUR
# key. A repository lists only the newest release, as Chrome's does.
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
github=${GITHUB_REPOSITORY:-krishkalaria12/bay}
site=https://baybrowser.in/linux
packages="" version="" dry=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --packages) packages=$2; shift 2 ;;
    --version) version=$2; shift 2 ;;
    --dry-run) dry=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
die() { echo "publish: $*" >&2; exit 1; }
[[ -n "$packages" && -n "$version" ]] || { echo "usage: $0 --packages DIR --version X.Y.Z [--dry-run]" >&2; exit 2; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be X.Y.Z: $version" >&2; exit 2; }
[[ -n "${BAY_GPG_KEY:-}" ]] || die "set BAY_GPG_KEY to the signing key"
for tool in gpg rpmsign apt-ftparchive createrepo_c gzip python3; do
  command -v "$tool" >/dev/null || die "needs $tool on PATH"
done
if [[ $dry == false ]]; then
  command -v gh >/dev/null || die "needs gh on PATH"
  [[ -f "${AUR_SSH_KEY:-}" ]] || die "set AUR_SSH_KEY to the AUR account's private key file"
fi

tag="v$version"
packages=$(cd "$packages" && pwd)
deb="bay_${version}_amd64.deb" rpm="bay-$version-1.x86_64.rpm" image="Bay-$version-x86_64.AppImage"
for file in SHA256SUMS "$deb" "$rpm" "bay-$version-linux-x64.tar.xz" "$image" "$image.zsync" aur/PKGBUILD aur/.SRCINFO; do
  [[ -f "$packages/$file" ]] || die "$packages has no $file: build it with release.sh --version $version"
done
grep -qxF $'\tpkgver = '"$version" "$packages/aur/.SRCINFO" || die "aur/.SRCINFO isn't for $version"
if [[ $dry == false ]]; then
  gh release view "$tag" -R "$github" >/dev/null 2>&1 || die "there is no release $tag: Linux adds its packages to the Mac release, so publish that first"
fi
sign() { gpg --batch --yes --local-user "$BAY_GPG_KEY" --digest-algo SHA512 "$@"; }

out="$packages/publish"
rm -rf "$out"
mkdir -p "$out/release" "$out/repo"
# What release.sh checksummed: the packages, the AppImage's own zsync file and any NixOS closure with its README.
artifacts=()
while read -r _ name; do artifacts+=("$name"); done <"$packages/SHA256SUMS"
for name in "${artifacts[@]}"; do cp "$packages/$name" "$out/release/"; done

# dnf and zypper check each package's own signature (gpgcheck) as well as the repository's.
# Ubuntu's rpm looks for gpg2.
rpmsign --define "__gpg $(command -v gpg)" --define "_gpg_name $BAY_GPG_KEY" --define "_gpg_digest_algo sha512" \
  --addsign "$out/release/$rpm" >/dev/null
sums="bay-$version-linux-SHA256SUMS"
(cd "$out/release" && sha256sum "${artifacts[@]}" >"$sums")
for name in "${artifacts[@]}" "$sums"; do
  sign --armor --detach-sign --output "$out/release/$name.asc" "$out/release/$name"
done

gpg --export --export-options export-minimal "$BAY_GPG_KEY" >"$out/repo/bay.gpg"
gpg --armor --export --export-options export-minimal "$BAY_GPG_KEY" >"$out/repo/bay.asc"
[[ -s "$out/repo/bay.gpg" ]] || die "gpg has no public key for $BAY_GPG_KEY"

# APT, as a flat repository: deb [signed-by=/usr/share/keyrings/bay.gpg] https://baybrowser.in/linux/apt ./
# Its Filename is pool/v<version>/<deb>, which the site redirects to the release's asset.
apt="$out/apt"
mkdir -p "$apt/pool/$tag"
cp "$out/release/$deb" "$apt/pool/$tag/"
(
  cd "$apt"
  apt-ftparchive packages pool >Packages
  gzip -9kn Packages
  # Written beside the directory, or its own empty file would be hashed into it.
  apt-ftparchive -o APT::FTPArchive::Release::Origin=Bay -o APT::FTPArchive::Release::Label=Bay \
    -o APT::FTPArchive::Release::Suite=stable -o APT::FTPArchive::Release::Codename=stable \
    -o APT::FTPArchive::Release::Architectures=amd64 \
    -o "APT::FTPArchive::Release::Description=Bay, a browser with your tabs in a sidebar" release . >"$out/Release"
)
mv "$out/Release" "$apt/Release"
sign --clearsign --output "$apt/InRelease" "$apt/Release"
sign --armor --detach-sign --output "$apt/Release.gpg" "$apt/Release"
cp "$apt"/{Packages,Packages.gz,Release,InRelease,Release.gpg} "$out/repo/"

# RPM, for dnf and zypper: baseurl https://baybrowser.in/linux/rpm, packages at pool/v<version>/<rpm> as above.
rpmrepo="$out/rpm"
mkdir -p "$rpmrepo/pool/$tag"
cp "$out/release/$rpm" "$rpmrepo/pool/$tag/"
createrepo_c --quiet --no-database --general-compress-type=gz "$rpmrepo" >/dev/null
sign --armor --detach-sign --output "$rpmrepo/repodata/repomd.xml.asc" "$rpmrepo/repodata/repomd.xml"
# zypper offers to import the key it finds beside the metadata.
cp "$out/repo/bay.asc" "$rpmrepo/repodata/repomd.xml.key"
cp "$rpmrepo"/repodata/* "$out/repo/"
cat >"$out/repo/bay.repo" <<EOF
[bay]
name=Bay
baseurl=$site/rpm
type=rpm-md
enabled=1
autorefresh=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=$site/bay.asc
EOF

# The AppImage's update file: release.sh's, made for the image beside it, pointed at this release's image instead.
python3 - "$packages/$image.zsync" "$out/repo/Bay-x86_64.AppImage.zsync" \
  "https://github.com/$github/releases/download/$tag/$image" <<'EOF'
import sys
source, target, url = sys.argv[1:]
data = open(source, "rb").read()
header, blank, body = data.partition(b"\n\n")
lines = header.split(b"\n")
urls = [i for i, line in enumerate(lines) if line.startswith(b"URL: ")]
if not blank or len(urls) != 1:
    sys.exit(f"{source} isn't a zsync file with one URL")
lines[urls[0]] = b"URL: " + url.encode()
open(target, "wb").write(b"\n".join(lines) + blank + body)
EOF

if [[ $dry == true ]]; then
  echo "Dry run: nothing uploaded. For $tag:"
  ls "$out/release"
  echo "For linux-repo:"
  ls "$out/repo"
  echo "For the AUR (bay-bin):"
  ls -A "$packages/aur"
  exit 0
fi

gh release upload "$tag" -R "$github" --clobber "$out/release"/*

if ! gh release view linux-repo -R "$github" >/dev/null 2>&1; then
  gh release create linux-repo -R "$github" --prerelease --latest=false --target "${GITHUB_SHA:-$(git -C "$repo" rev-parse HEAD)}" \
    --title "Bay for Linux: package repositories" \
    --notes "The APT and RPM repositories and the AppImage update file, served at $site/. The packages themselves are on each release. Setup: https://github.com/$github/blob/main/docs/linux-install.md"
fi
# Each index before the file that names it, so a client mid-update sees the old set or the new one: hashed RPM
# metadata, then Packages, then the signed Release and repomd.xml.
(
  cd "$out/repo"
  gh release upload linux-repo -R "$github" --clobber bay.gpg bay.asc bay.repo ./*-primary.xml.gz ./*-filelists.xml.gz \
    ./*-other.xml.gz Packages Packages.gz
  gh release upload linux-repo -R "$github" --clobber Release Release.gpg InRelease repomd.xml repomd.xml.asc repomd.xml.key \
    Bay-x86_64.AppImage.zsync
)
# createrepo_c names its metadata by hash, so the last release's is left over.
current=$(ls "$out/repo")
gh release view linux-repo -R "$github" --json assets --jq '.assets[].name' | while read -r asset; do
  if [[ "$asset" =~ -(primary|filelists|other)\.xml\.gz$ ]] && ! grep -qxF "$asset" <<<"$current"; then
    gh release delete-asset linux-repo "$asset" -R "$github" --yes
  fi
done

# The AUR's own host key (wiki.archlinux.org/title/AUR_submission_guidelines), not whatever answers first.
aur=$(mktemp -d)
trap 'rm -rf "$aur"' EXIT
echo "aur.archlinux.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEuBKrPzbawxA/k2g6NcyV5jmqwJ2s+zpgZGZ7tpLIcN" >"$aur/known_hosts"
export GIT_SSH_COMMAND="ssh -i $AUR_SSH_KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$aur/known_hosts -o StrictHostKeyChecking=yes"
git clone -q ssh://aur@aur.archlinux.org/bay-bin.git "$aur/bay-bin"
cp "$packages/aur/PKGBUILD" "$packages/aur/.SRCINFO" "$aur/bay-bin/"
cd "$aur/bay-bin"
git add PKGBUILD .SRCINFO
if git diff --cached --quiet; then
  echo "The AUR already has bay-bin $version"
else
  git -c user.name="Krish Kalaria" -c user.email="krishkalaria12@users.noreply.github.com" commit -q -m "bay-bin $version"
  git push -q origin HEAD:master
fi
cd "$packages"
snap="bay_${version}_amd64.snap"
if [[ -n "${SNAPCRAFT_STORE_CREDENTIALS:-}" && -f "$snap" ]]; then
  snapcraft upload --release=stable "$snap"
elif [[ -f "$snap" ]]; then
  echo "SNAPCRAFT_STORE_CREDENTIALS isn't set: the snap wasn't uploaded"
fi
echo "Published Bay $version for Linux"
