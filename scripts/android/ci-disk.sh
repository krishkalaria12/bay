#!/bin/bash
# Gives a GitHub Ubuntu runner one large volume for the Android engine build at $1 (default /engine).
#
# The runner's root disk and its second disk (/mnt) are each too small for Chromium's Android source, output and saved
# build state. This removes preinstalled tools the build never uses, then joins the free space of both disks into one
# ext4 volume with LVM, as loop files on each. How much it frees depends on the runner image, so the build measures it
# (scripts/android/capacity.py) rather than assuming a size.
#
# Adapted from the Linux branch's scripts/linux/ci-disk.sh. The runner's Android SDK (/usr/local/lib/android) and JDKs
# (/usr/lib/jvm) go on purpose: the pinned Chromium checkout brings its own SDK, NDK and JDK through DEPS
# (third_party/android_sdk, android_toolchain, jdk), and the build must use those exact versions, not the image's.
set -euo pipefail

mountpoint=${1:-/engine}
gib=$((1024 * 1024 * 1024))
df -h / /mnt 2>/dev/null || true

# hostedtoolcache keeps the Python and Node the setup actions install.
sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /usr/local/.ghcup /opt/hostedtoolcache/CodeQL \
  /usr/local/share/boost /usr/share/swift /usr/local/share/powershell /usr/local/julia* /opt/az /opt/microsoft \
  /opt/google /usr/lib/jvm /usr/local/share/chromium /usr/local/aws-cli /usr/local/aws-sam-cli /opt/pipx
sudo docker system prune --all --force >/dev/null 2>&1 || true

command -v pvcreate >/dev/null || { sudo apt-get update -q && sudo apt-get install -y -q lvm2; }

available() { df --output=avail -B1 "$1" | tail -1; }
devices=()
add_disk() { # add_disk <directory> <bytes to leave free>
  local size=$((($(available "$1") - $2) / gib * gib))
  if ((size < 4 * gib)); then return; fi
  sudo fallocate -l "$size" "$1/bay-engine.img"
  devices+=("$(sudo losetup --find --show "$1/bay-engine.img")")
}
# Leave room on / for apt, the build dependencies, logs and the workspace.
add_disk / $((10 * gib))
if mountpoint -q /mnt && [[ $(stat -c %d /mnt) != $(stat -c %d /) ]]; then
  add_disk /mnt $((2 * gib))
fi
((${#devices[@]})) || {
  echo "no free space for the engine volume" >&2
  exit 1
}

sudo pvcreate -q "${devices[@]}"
sudo vgcreate -q bay "${devices[@]}"
sudo lvcreate -q -l 100%FREE -n engine bay
# Chromium's tree is millions of small files: one inode per 8 KB rather than ext4's default 16 KB.
sudo mkfs.ext4 -q -m 0 -i 8192 -E lazy_itable_init=1,lazy_journal_init=1,nodiscard /dev/bay/engine
sudo mkdir -p "$mountpoint"
sudo mount -o noatime /dev/bay/engine "$mountpoint"
sudo chown "$(id -u):$(id -g)" "$mountpoint"
df -h / /mnt "$mountpoint" 2>/dev/null || true
df -i "$mountpoint"
