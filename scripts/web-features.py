#!/usr/bin/env python3
"""The web features map (engine/web-features.json): every way a page reaches its browser, each one covered.

  python3 scripts/web-features.py check --src <chromium/src>   stop if the map and that Chromium disagree
  python3 scripts/web-features.py checklist                    the release checklist the map names, to go through

A row is one WebContentsDelegate method (content/public/browser/web_contents_delegate.h), one blink::PermissionType
(third_party/blink/public/common/permissions/permission_utils.h), or an extra (choosers, payments, sharing,
credentials…) that reaches the browser some other way. Its value says what covers it:

  check:<name>      an acceptance check (packages/chromium/scripts/acceptance.mjs), which must exist
  checklist: <line> a line of the release checklist, done by hand before a release (docs/releasing.md)
  default: <why>    Chrome's own handling, with nothing of Bay's in the way
  n/a: <why>        no desktop page reaches it

`check` fails when Chromium has a method or permission the map lacks, the map has one Chromium no longer does, a row
says nothing of these, or a check it names doesn't exist. The engine builds run it before compiling
(scripts/engine.py, engine/patches/build/05-build.sh).
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
MAP = REPO / "engine/web-features.json"
ACCEPTANCE = REPO / "packages/chromium/scripts/acceptance.mjs"
DELEGATE_HEADER = "content/public/browser/web_contents_delegate.h"
PERMISSION_HEADER = "third_party/blink/public/common/permissions/permission_utils.h"
KINDS = ("check:", "checklist:", "default:", "n/a:")


def strip_comments(text: str) -> str:
    return re.sub(r"/\*.*?\*/", "", re.sub(r"//[^\n]*", "", text), flags=re.S)


def delegate_methods(header: str) -> list[str]:
    """The virtual methods of WebContentsDelegate, in order, without its destructor."""
    body = strip_comments(header)
    start = body.find("class CONTENT_EXPORT WebContentsDelegate")
    if start < 0:
        raise ValueError("no WebContentsDelegate class in the header")
    names: list[str] = []
    for name in re.findall(r"\bvirtual\s+[^;{(]*?\b(~?[A-Z]\w*)\s*\(", body[start:]):
        if not name.startswith("~") and name != "WebContentsDelegate" and name not in names:
            names.append(name)
    return names


def permission_types(header: str) -> list[str]:
    """The names of blink::PermissionType's values, without its bounds (MIN_VALUE, MAX_VALUE, NUM)."""
    body = strip_comments(header)
    match = re.search(r"enum\s+class\s+PermissionType\s*\{(.*?)\};", body, re.S)
    if not match:
        raise ValueError("no PermissionType enum in the header")
    names = re.findall(r"\b([A-Z][A-Z0-9_]*)\s*=", match.group(1))
    return [n for n in names if n not in ("MIN_VALUE", "MAX_VALUE", "NUM")]


def acceptance_checks(source: str) -> set[str]:
    return set(re.findall(r"""\bcheck\("([a-z0-9-]+)\"""", source))


def problems(table: dict, methods: list[str], permissions: list[str], checks: set[str]) -> list[str]:
    found: list[str] = []
    for section, names in (("delegate", methods), ("permissions", permissions)):
        rows = table.get(section, {})
        for name in names:
            if name not in rows:
                found.append(f"{section}.{name}: new in this Chromium; add a row saying what covers it")
        for name in rows:
            if name not in names:
                found.append(f"{section}.{name}: this Chromium no longer has it; remove the row")
    for section in ("delegate", "permissions", "extras"):
        for name, value in table.get(section, {}).items():
            if not isinstance(value, str) or not value.startswith(KINDS):
                found.append(f"{section}.{name}: say check:, checklist:, default: or n/a:")
            elif value.startswith("check:") and value[len("check:"):] not in checks:
                found.append(f"{section}.{name}: no acceptance check named {value[len('check:'):]}")
            elif not value.startswith("check:") and not value.split(":", 1)[1].strip():
                found.append(f"{section}.{name}: say why")
    return found


def checklist(table: dict) -> list[tuple[str, list[str]]]:
    """Each checklist line once, with the rows it covers."""
    lines: dict[str, list[str]] = {}
    for section in ("delegate", "permissions", "extras"):
        for name, value in table.get(section, {}).items():
            if isinstance(value, str) and value.startswith("checklist:"):
                lines.setdefault(value[len("checklist:"):].strip(), []).append(name)
    return sorted(lines.items())


def check(src: pathlib.Path) -> int:
    table = json.loads(MAP.read_text(encoding="utf-8"))
    methods = delegate_methods((src / DELEGATE_HEADER).read_text(encoding="utf-8"))
    permissions = permission_types((src / PERMISSION_HEADER).read_text(encoding="utf-8"))
    found = problems(table, methods, permissions, acceptance_checks(ACCEPTANCE.read_text(encoding="utf-8")))
    for line in found:
        print(f"web-features: {line}", file=sys.stderr)
    if found:
        print(f"web-features: {MAP.relative_to(REPO)} doesn't match {src}", file=sys.stderr)
        return 1
    print(f"web-features: {len(methods)} delegate methods and {len(permissions)} permissions, each covered")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    check_parser = commands.add_parser("check", help="compare the map with a Chromium checkout")
    check_parser.add_argument("--src", required=True, type=pathlib.Path, help="the chromium/src the engine builds")
    commands.add_parser("checklist", help="print the release checklist")
    args = parser.parse_args(argv)
    if args.command == "check":
        return check(args.src)
    for line, rows in checklist(json.loads(MAP.read_text(encoding="utf-8"))):
        print(f"[ ] {line}\n      ({', '.join(rows)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
