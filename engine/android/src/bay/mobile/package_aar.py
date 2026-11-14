#!/usr/bin/env python3
# Copyright 2026 Bay authors.
# Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.
"""Finishes bay-engine.aar from the dist_aar output.

dist_aar packs classes, native libraries, resources and the manifest, but not assets, and Chromium's Java refers to
R classes (org.chromium.ui.R, …) that Chromium only generates when it builds a whole APK. So this:

  * adds the engine's data files (its resource pack, ICU data, V8 snapshot) under assets/;
  * writes bay-engine/r-packages.txt: each package whose R class the engine's code uses and the AAR doesn't contain.
    The app's Gradle build generates those classes from the AAR's R.txt (apps/mobile/modules/bay-engine);
  * writes bay-engine/app-classes.txt: the packages of classes the engine uses but the AAR leaves for the app's own
    dependencies to supply (AndroidX and the like), so a missing one is a build error rather than a crash.
"""
import argparse
import fnmatch
import io
import re
import struct
import sys
import zipfile

R_CLASS = re.compile(r"^((?:[A-Za-z_][\w$]*/)+)R(?:\$[a-z_]+)?$")


def referenced_classes(class_bytes):
    """Class names (internal form, a/b/C) in a class file's constant pool."""
    if class_bytes[:4] != b"\xca\xfe\xba\xbe":
        return set()
    count = struct.unpack(">H", class_bytes[8:10])[0]
    utf8 = {}
    class_indexes = []
    offset = 10
    index = 1
    while index < count:
        tag = class_bytes[offset]
        offset += 1
        if tag == 1:  # Utf8
            length = struct.unpack(">H", class_bytes[offset:offset + 2])[0]
            utf8[index] = class_bytes[offset + 2:offset + 2 + length].decode("utf-8", "replace")
            offset += 2 + length
        elif tag == 7:  # Class
            class_indexes.append(struct.unpack(">H", class_bytes[offset:offset + 2])[0])
            offset += 2
        elif tag in (8, 16, 19, 20):  # String, MethodType, Module, Package
            offset += 2
        elif tag == 15:  # MethodHandle
            offset += 3
        elif tag in (3, 4, 9, 10, 11, 12, 17, 18):  # Integer, Float, refs, NameAndType, Dynamic, InvokeDynamic
            offset += 4
        elif tag in (5, 6):  # Long, Double take two slots
            offset += 8
            index += 1
        else:
            raise ValueError(f"unknown constant pool tag {tag}")
        index += 1
    names = set()
    for i in class_indexes:
        name = utf8.get(i, "")
        while name.startswith("["):
            name = name[1:]
        if name.startswith("L") and name.endswith(";"):
            name = name[1:-1]
        if name:
            names.add(name)
    return names


def scan_jar(jar_bytes):
    """(classes the jar defines, classes it refers to)."""
    defined, referenced = set(), set()
    with zipfile.ZipFile(io.BytesIO(jar_bytes)) as jar:
        for info in jar.infolist():
            if not info.filename.endswith(".class"):
                continue
            defined.add(info.filename[:-len(".class")])
            referenced |= referenced_classes(jar.read(info))
    return defined, referenced


def missing_r_packages(defined, referenced):
    """Dotted packages whose R class (or nested R$type) is referenced but not defined."""
    packages = set()
    for name in referenced - defined:
        match = R_CLASS.match(name)
        if match:
            packages.add(match.group(1).rstrip("/").replace("/", "."))
    return sorted(packages)


def app_supplied_packages(defined, referenced, excluded_globs):
    """Dotted packages of referenced classes matching the excluded globs, which the app must supply."""
    packages = set()
    for name in referenced - defined:
        if any(fnmatch.fnmatch(name, glob) for glob in excluded_globs) and "/" in name:
            packages.add(name.rsplit("/", 1)[0].replace("/", "."))
    return sorted(packages)


def parse_gn_list(value):
    value = value.strip()
    if not value.startswith("["):
        return [value] if value else []
    return [item.strip().strip('"') for item in value[1:-1].split(",") if item.strip()]


def package(base_aar, output, assets, excluded_globs):
    with zipfile.ZipFile(base_aar) as source:
        jar_bytes = source.read("classes.jar")
        defined, referenced = scan_jar(jar_bytes)
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
            for info in source.infolist():
                target.writestr(info, source.read(info))
            for path, name in assets:
                # Stored: the engine maps these straight out of the APK, so the app must keep them uncompressed too.
                target.write(path, f"assets/{name}", compress_type=zipfile.ZIP_STORED)
            target.writestr("bay-engine/r-packages.txt",
                            "".join(f"{name}\n" for name in missing_r_packages(defined, referenced)))
            target.writestr("bay-engine/app-classes.txt",
                            "".join(f"{name}\n"
                                    for name in app_supplied_packages(defined, referenced, excluded_globs)))


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-aar", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--asset", action="append", default=[], help="PATH:NAME, stored as assets/NAME")
    parser.add_argument("--excluded-classes", default="[]", help="GN list of class globs the app supplies")
    args = parser.parse_args(argv)
    assets = []
    for item in args.asset:
        path, _, name = item.rpartition(":")
        if not path or not name:
            parser.error(f"--asset needs PATH:NAME, got {item}")
        assets.append((path, name))
    package(args.base_aar, args.output, assets, parse_gn_list(args.excluded_classes))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
