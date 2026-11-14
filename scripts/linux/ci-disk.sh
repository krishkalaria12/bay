#!/bin/bash
# Gives a free GitHub Ubuntu runner one large volume for the engine build at $1 (default /engine).
#
# The runner's root disk starts with about 20 GB free and its second disk (/mnt) with about 70 GB; Chromium's source,
# output and the saved build state need more than either. This removes preinstalled toolchains the build never uses,
# then joins the free space of both disks into one ext4 volume with LVM, as loop files on each.
set -euo pipefail

mountpoint=${1:-/engine}
gib=$((1024 * 1024 * 1024))
df -h / /mnt 2>/dev/null || true

# Toolchains and images Chromium's build doesn't use. hostedtoolcache keeps the Python and Node setup actions install.
sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /usr/local/.ghcup /opt/hostedtoolcache/CodeQL \
  /usr/local/share/boost /usr/share/swift /usr/local/share/powershell /usr/local/julia* /opt/az /opt/microsoft \
  /opt/google /usr/lib/jvm /usr/local/share/chromium /usr/local/aws-cli /usr/local/aws-sam-cli /opt/pipx
sudo docker system prune --all --force >/dev/null 2>&1 || true

command -v pvcreate >/dev/null || { sudo apt-get update -q && sudo apt-get install -y -q lvm2; }

available() { df --output=avail -B1 "$1" | tail -1; }
devices=()
add_disk() {  # add_disk <directory> <bytes to leave free>
  local size=$(( ($(available "$1") - $2) / gib * gib ))
  if (( size < 4 * gib )); then return; fi
  sudo fallocate -l "$size" "$1/bay-engine.img"
  devices+=("$(sudo losetup --find --show "$1/bay-engine.img")")
}
# Leave room on / for apt, the toolchains the build installs, logs and the workspace.
add_disk / $((10 * gib))
if mountpoint -q /mnt && [[ $(stat -c %d /mnt) != $(stat -c %d /) ]]; then
  add_disk /mnt $((2 * gib))
fi
(( ${#devices[@]} )) || { echo "no free space for the engine volume" >&2; exit 1; }

sudo pvcreate -q "${devices[@]}"
sudo vgcreate -q bay "${devices[@]}"
sudo lvcreate -q -l 100%FREE -n engine bay
sudo mkfs.ext4 -q -m 0 -E lazy_itable_init=1,lazy_journal_init=1,nodiscard /dev/bay/engine
sudo mkdir -p "$mountpoint"
sudo mount -o noatime /dev/bay/engine "$mountpoint"
sudo chown "$(id -u):$(id -g)" "$mountpoint"
df -h / /mnt "$mountpoint" 2>/dev/null || true
