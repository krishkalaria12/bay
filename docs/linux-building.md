# Building Bay on Linux

Use `feat/linux`. The shared driver builds a native x86-64 Linux engine with
Chromium's pinned Debian Bullseye sysroot. Windows and macOS engine trees cannot
be reused. Put the engine root on a Linux filesystem at a path without spaces.
Allow at least 150 GB of free disk for source, output and packaging. With limited
RAM, provision swap and start with `--jobs 2`.

## Host dependencies

Ubuntu and Debian are the initial build hosts. Other glibc distributions can use
the same sysroot and driver, but Bay has not completed native build or runtime
validation on Fedora, Arch or openSUSE. Alpine's musl environment and Linux ARM64
are unsupported. NixOS builds in Bay's Nix shell (see [NixOS](#nixos)). A
successful build does not establish runtime compatibility
on every distro; the minimum glibc version remains unmeasured in the engine lock.

Install Python 3.10 or later, Git, CA certificates, GNU patch, pkg-config, binutils
including `ar`, tar, xz, and zstd using your host's package manager. Example base
tool installs, before downloading Chromium:

```sh
# Ubuntu / Debian
sudo apt install git python3 ca-certificates patch pkg-config binutils tar xz-utils zstd file lsb-release

# Fedora
sudo dnf install git python3 ca-certificates patch pkgconf-pkg-config binutils tar xz zstd file

# Arch
sudo pacman -S --needed git python ca-certificates patch pkgconf binutils tar xz zstd file

# openSUSE
sudo zypper install git python3 ca-certificates patch pkg-config binutils tar xz zstd file
```

These are base tools, not a complete distro build dependency list. On Ubuntu or
Debian, after downloading the source, use its own dependency installer:

```sh
sudo "$BAY_ENGINE_ROOT/chromium_git/chromium/src/build/install-build-deps.sh" \
  --no-arm --no-chromeos-fonts
```

On NixOS, skip both: the Nix shell below provides these tools. For other hosts,
follow the distro notes in the pinned checkout's
`docs/linux/build_instructions.md` for the remaining dependencies.
Chromium's downloaded host binaries still
require compatible host libraries, even though target libraries use a sysroot.
See also [Chromium's Linux build instructions](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/build_instructions.md).

The driver never runs a host package manager or sudo. It bootstraps pinned
depot_tools during download. Before GN generation it checks `pkg-config`, `ar`,
`tar` and `xz`, verifies the pinned sysroot, and extracts SHA-256-pinned Bullseye
libsecret development/runtime packages into that sysroot. This uses `ar` and
`tar` on every distro; `dpkg` is not required. Packages are cached under
`$BAY_ENGINE_ROOT/libsecret-packages`. It also generates missing CEF paths.

## NixOS

Chromium downloads prebuilt host tools (clang, gn, siso, Node and CIPD's
Python) that expect `/lib64/ld-linux-x86-64.so.2` and libraries under
`/usr/lib`. NixOS has neither, so the driver refuses to start there until
`packaging/linux/nix/shell.nix` provides them. That shell is a `buildFHSEnv`:
a bubblewrap namespace over the host's filesystem, not a container. It has every
base tool above, Node 24, pnpm through Corepack at the version `package.json`
pins, and the libraries `build-app.py`'s ldd check needs. Target libraries
still come from Chromium's pinned Debian sysroot, so the engine is the same one
other distros build.

```bash
git clone -b feat/linux https://github.com/krishkalaria12/bay.git ~/bay
cd ~/bay
nix-shell packaging/linux/nix/shell.nix
```

Run every command in the next sections inside that shell, from `~/bay`; skip
`install-build-deps.sh`. The shell starts an interactive Bash and ignores
`nix-shell --run`. If NixOS uses flakes without channels, add
`-I nixpkgs=flake:nixpkgs`. Bubblewrap needs unprivileged user namespaces,
which NixOS allows unless `security.allowUserNamespaces` is off.

Package only the tarball, which needs no `dpkg-deb` or `rpmbuild`:

```bash
scripts/linux/release.sh --app dist/linux-app --version 0.0.1 --output dist/linux-release --formats tar
```

Then leave the shell. `packaging/linux/nix/default.nix` turns the tarball into a
Nix package that runs without the shell: it sets the Nix loader and library
paths on the executables, and wraps `bin/bay` with the paths for libraries
Chromium loads at run time (GTK, Qt 6, VA-API, Vulkan and the host GPU drivers
in `/run/opengl-driver`). Its install check fails the build if any ELF file has
an unresolved library.

```bash
nix-build packaging/linux/nix --arg tarball ./dist/linux-release/bay-0.0.1-linux-x64.tar.xz
./result/bin/bay
```

To install it, add it to `environment.systemPackages` in `configuration.nix`:

```nix
(import /home/you/bay/packaging/linux/nix {
  inherit pkgs;
  tarball = /home/you/bay/dist/linux-release/bay-0.0.1-linux-x64.tar.xz;
})
```

The installed `bay.desktop` points at the package's `bin/bay`. Running from
`./result` has no desktop entry in the XDG data directories, so Set as Default
explains that it's missing. The sandbox uses unprivileged user namespaces;
`chrome-sandbox` isn't setuid, as in the tarball. Check `chrome://sandbox` and
`chrome://gpu` after the first launch.

## Download, prepare and build

Run these commands in Bash from the Bay checkout. Node and pnpm are needed for
the app's JavaScript build; use the versions declared by the repo.

```bash
export BAY="$PWD"
export BAY_ENGINE_ROOT="$HOME/chromium-build"
export CB="$BAY_ENGINE_ROOT"
mkdir -p "$CB/logs"
set -o pipefail

python3 scripts/engine.py --platform linux download 2>&1 | tee "$CB/logs/download.log"
# Install the host dependencies described above before preparation.
python3 scripts/engine.py --platform linux prepare 2>&1 | tee "$CB/logs/prepare.log"
python3 scripts/engine.py --platform linux build --jobs 2 2>&1 | tee "$CB/logs/build.log"
```

Run each stage only after the previous one exits successfully. An interrupted
download can be retried with the same download command. Linux sync uses one job
to reduce server rate limiting, including on the initial checkout. A retry runs
sync and hooks before CEF automation, since that automation can otherwise skip
an incomplete dependency sync when `src` already exists. HTTP 429 may still
require waiting before retrying. No automatic reset or clean is performed.
Download refuses a tree with Bay preparation state or build output. Once prepared,
use prepare/build for incremental updates.

Preparation retains completed CEF, ungoogled and domain steps. The patch runner
recognizes an earlier patch even when a later patch rewrites its files. A failed
ungoogled run may have partially changed files; inspect its report at
`$CB/logs/ungoogled-patches.tsv` rather than resetting or deleting the checkout.

## Updating an existing Linux checkout

Let an active build finish before changing the repo. Build stamps describe the
repo at completion. `git pull` updates only the checked-out branch from its
upstream; it does not merge `main` into `feat/linux` or update both local branches.

```bash
cd "$BAY"
git status --short
git switch feat/linux
git pull --ff-only origin feat/linux
set -o pipefail
python3 scripts/engine.py --platform linux prepare 2>&1 | tee "$CB/logs/prepare.log"
python3 scripts/engine.py --platform linux build --jobs 2 2>&1 | tee "$CB/logs/build.log"
```

If you used the one-off Ubuntu recovery scripts, they changed files in your Bay
checkout. Preserve those edits before pulling, for example with
`git stash push -u -m linux-build-recovery`, then pull. The branch now includes
the recovery fixes, so do not blindly restore the old script versions over it.
Retain the stash until the updated prepare/build succeeds. No fresh Chromium
download is needed. The build reuses compatible existing output, though header
changes can cause substantial recompilation.

Archive only after a successful build:

```sh
python3 scripts/engine.py --platform linux archive
```

Keep the sandbox enabled, locales, media codecs and GPU fallbacks intact. App
packaging, sandbox setup and GNOME/KDE runtime testing are separate release gates.
