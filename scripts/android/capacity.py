#!/usr/bin/env python3
"""Measure what an Android engine build needs from a runner (gate A in docs/android-chromium-plan.html).

  capacity.py sample --dir REPORT --path /engine        # background: peak memory, swap, disk and inodes
  capacity.py snapshot --dir REPORT --path /engine --label synced [--size NAME=DIR ...]

The sampler rewrites peaks.json every tick, so the peaks survive a stage that is stopped. Snapshots append one JSON
line each to snapshots.jsonl. Both go up with the stage's logs as an artifact.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time


def memory():
    fields = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        name, value = line.split(":", 1)
        fields[name] = int(value.split()[0]) * 1024
    return {
        "memoryUsed": fields["MemTotal"] - fields["MemAvailable"],
        "memoryTotal": fields["MemTotal"],
        "swapUsed": fields["SwapTotal"] - fields["SwapFree"],
    }


def disk(path):
    status = os.statvfs(path)
    return {
        "diskUsed": (status.f_blocks - status.f_bfree) * status.f_frsize,
        "diskFree": status.f_bavail * status.f_frsize,
        "diskTotal": status.f_blocks * status.f_frsize,
        "inodesUsed": status.f_files - status.f_ffree,
        "inodesFree": status.f_favail,
    }


def write_atomically(path: Path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def sample(directory: Path, path: str, interval: float):
    directory.mkdir(parents=True, exist_ok=True)
    peaks = {}
    while True:
        current = {**memory(), **disk(path)}
        for name in ("memoryUsed", "swapUsed", "diskUsed", "inodesUsed"):
            peaks[name] = max(peaks.get(name, 0), current[name])
        for name, lowest in (("diskFree", "minDiskFree"), ("inodesFree", "minInodesFree")):
            peaks[lowest] = min(peaks.get(lowest, current[name]), current[name])
        peaks.update(memoryTotal=current["memoryTotal"], diskTotal=current["diskTotal"],
                     updatedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        write_atomically(directory / "peaks.json", peaks)
        time.sleep(interval)


def size_of(directory: str):
    result = subprocess.run(["du", "-sb", directory], capture_output=True, text=True)
    return int(result.stdout.split()[0]) if result.returncode == 0 and result.stdout else None


def snapshot(directory: Path, path: str, label: str, sizes: list[str]):
    directory.mkdir(parents=True, exist_ok=True)
    entry = {"label": label, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **memory(), **disk(path)}
    for item in sizes:
        name, _, target = item.partition("=")
        entry[f"size:{name}"] = size_of(target) if Path(target).exists() else None
    with (directory / "snapshots.jsonl").open("a") as stream:
        stream.write(json.dumps(entry) + "\n")
    gib = 2**30
    print(f"capacity {label}: disk used {entry['diskUsed'] / gib:.1f} GiB, free {entry['diskFree'] / gib:.1f} GiB, "
          f"inodes used {entry['inodesUsed']:,}, memory used {entry['memoryUsed'] / gib:.1f} GiB"
          + "".join(f", {key[5:]} {value / gib:.1f} GiB" for key, value in entry.items()
                    if key.startswith("size:") and value is not None), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("sample", "snapshot"))
    parser.add_argument("--dir", required=True, type=Path)
    parser.add_argument("--path", default="/")
    parser.add_argument("--label")
    parser.add_argument("--size", action="append", default=[], help="NAME=DIRECTORY to measure with du")
    parser.add_argument("--interval", type=float, default=20)
    args = parser.parse_args()
    if args.command == "sample":
        sample(args.dir, args.path, args.interval)
    else:
        if not args.label:
            parser.error("snapshot needs --label")
        snapshot(args.dir, args.path, args.label, args.size)


if __name__ == "__main__":
    main()
