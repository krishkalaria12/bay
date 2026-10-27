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
are unsupported. NixOS needs an environment capable of running Chromium's
downloaded Linux tools. A successful build does not establish runtime compatibility
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

For other hosts, follow the distro notes in the pinned checkout's
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
