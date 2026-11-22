# Linux packages

Bay for Linux x64 installs to `/opt/bay`: the `bay` executable with Chromium's runtime beside it, the React UI in
`bay-ui/`, and `bay-wrapper`, which `/usr/bin/bay` links to. One staged tree becomes every package.

## Build

The engine archive comes from `python scripts/engine.py --platform linux archive` (see `docs/engine-cli.md`). Take its
SHA-256 from trusted release configuration, not from a file beside the download.

```sh
python3 scripts/linux/build-app.py --engine-archive bay-engine-….tar.zst --sha256 <trusted-sha256> --output dist/linux-app
scripts/linux/release.sh --app dist/linux-app --version 1.4.0 --output dist/linux-release
```

`build-app.py` checks the archive's checksum and manifest against this checkout's engine pin, builds the web UI
(`--skip-web-build` takes an existing export), stages the app and refuses it if any ELF file has a library the loader
can't find. `--verify DIR` rechecks a staged app.

`release.sh` writes, by default (`--formats tar,deb,rpm,appimage,aur`):

| Artifact | For | Notes |
|---|---|---|
| `bay-<version>-linux-x64.tar.xz` | any distro, and the AUR package's source | unpacks to `bay-<version>/` with `opt/`, `usr/`, `etc/`; the sandbox isn't setuid |
| `bay-browser_<version>_amd64.deb` | Debian, Ubuntu | browser alternatives and the AppArmor profile in `postinst` |
| `bay-browser-<version>-1.x86_64.rpm` | Fedora, openSUSE | bundled libraries are neither provided nor required |
| `Bay-<version>-x86_64.AppImage` and `.zsync` | anywhere | updates through zsync from `baybrowser.in/linux/Bay-x86_64.AppImage.zsync`, which each release points at its image |
| `aur/PKGBUILD`, `aur/.SRCINFO` | Arch (`bay-browser-bin`) | from `aur/PKGBUILD.in`, with the tarball's checksum; `.SRCINFO` is written in `makepkg --printsrcinfo`'s layout without makepkg |
| `bay-<version>-nixos-x64.nar.zst` and `.README` | NixOS | add `nix` to `--formats`; contains the patched package and every Nix runtime dependency, with import/install commands |
| `flatpak/` (add `flatpak`) | Flathub | the `flathub/in.krishkalaria.bay` repository's files for this release: the manifest (`flatpak/in.krishkalaria.bay.yaml.in`) with the tarball's URL and checksum, its launcher, cobalt's config and `flathub.json` |
| `nixpkgs/package.nix` (add `nixpkgs`) | nixpkgs | `nix/package.nix` with the version and the tarball's hash, for `pkgs/by-name/ba/bay-browser` |
| `bay-browser_<version>_amd64.snap` (add `snap`) | Snap Store | from `snap/snapcraft.yaml.in`; needs `snapcraft`, and `SNAPCRAFT`/`BAY_SNAPCRAFT_ARGS` to pack on the host as CI does |
| `SHA256SUMS` | | every artifact |

Set `BAY_GPG_KEY` to a key ID to sign every artifact and `SHA256SUMS` with detached `.asc` signatures.
`scripts/linux/publish.sh` publishes them: it signs the `.rpm` and every file, adds them to the GitHub release, rebuilds
the APT and RPM repositories and pushes `bay-browser-bin` to the AUR (`docs/releasing.md` › Linux). Users install with
`docs/linux-install.md`.

Each format needs its tool: `dpkg-deb` (Arch: `dpkg`), `rpmbuild` (`rpm-tools`), `appimagetool` and `zsyncmake`
(AUR `appimagetool-bin`, `zsync`).
`publish.sh` needs `gpg`, `rpmsign` (`rpm`), `apt-ftparchive` (`apt-utils`) and `createrepo_c`.
The optional `nix` format also needs `tar`, `nix-build`, `nix-store` and `zstd`.
CI includes it and pins nixpkgs to a nixos-26.05 revision. Local builds use
`<nixpkgs>` from `NIX_PATH`. The package's install check verifies that every ELF
dependency resolves, including the bundled CLI and both Chromium Qt shims.

```sh
scripts/linux/release.sh --app dist/linux-app --version 1.4.0 --formats tar,nix
```

The NixOS archive is a complete store export, not an unpackable application
folder. Follow its `.README` to import it into `/nix/store` and install Bay in
your profile. For a declarative NixOS configuration or a build from the ordinary
tarball, use `nix/default.nix` as described in `docs/linux-building.md`.

## What's installed

- `/opt/bay/chrome-sandbox` is setuid root in the .deb, .rpm and AUR package, the fallback for kernels without
  unprivileged user namespaces. Nothing turns the sandbox off. The Flatpak has no setuid sandbox: zypak runs Chromium's
  through Flatpak's own. Neither has the snap: its `browser-support` plug with `allow-sandbox` gives it user namespaces.
- `/etc/apparmor.d/bay` (`apparmor/bay`) lets `/opt/bay/bay` create user namespaces where AppArmor restricts them (Ubuntu
  23.10 and later) and confines nothing else. The AppImage can't install it, and its mount point changes each launch, so
  `AppRun` prints a profile for AppImage mounts and the commands to install it.
- `bay.desktop` registers the web MIME types and the New Window and New Private Window actions. Its `StartupWMClass`
  and the AppStream ID `in.krishkalaria.bay` match the engine's branding.
- Icons come from the Mac app's icon set, the small cut at 16 and 32 px, plus `app-icon.svg` as the scalable icon.
- `/etc/bay/native-messaging-hosts` and `/etc/bay/policies/{managed,recommended}` are the engine's system paths.

## Tests

```sh
python -m unittest discover -s scripts/linux -p 'test_*.py' -v
```

They use fixture engine archives, so they need no engine build. A format whose tool is missing is skipped. CI
(`linux-checks.yml`) runs them on Ubuntu with `rpm` installed, so the .deb and .rpm paths run there. Installing,
launching, setting Bay as the default browser, updating and uninstalling on clean VMs is stage 2's T7, once there is a
real engine archive.
