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
    dependencies to supply (AndroidX and the like), so a missing one is a build error rather than a crash;
  * keeps only classes, service registrations and the engine's own packages' files in classes.jar. Other files there
    are the dependency jars' (licences, build properties), which the app's libraries also carry, and Gradle fails on
    two different copies of a Java resource;
  * moves resources out of the numbered folders Chromium's resource zips keep them in (res/0_res/layout/… becomes
    res/layout/…), which dist_aar copies as they are but an AAR can't have;
  * rewrites R.txt the way Gradle reads it. dist_aar joins its dependencies' R.txt files and sorts the lines, so a
    symbol two of them declare comes twice with different placeholder ids (attr layout 0x0 and 0x7f010001), which
    Gradle rejects, and a styleable's attribute indices (int styleable ActionBar_background) end up away from its
    array (int[] styleable ActionBar), where Gradle doesn't see them. The ids are placeholders that the app's build
    replaces, so each symbol is kept once and each styleable is followed by its attributes, numbered in order;
  * defines each attribute once per values folder. The AAR holds several libraries' values (Chromium's and AndroidX
    ones), and two of them can each define an attribute, at the top or in a styleable (layout, elevation). A library
    may define one only once, so the first definition stays, a later top-level one goes and a later one in a
    styleable becomes a reference to it.
"""
import argparse
import fnmatch
import io
import re
import struct
import sys
import xml.etree.ElementTree as ElementTree
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
    """Dotted packages whose R class (or nested R$type) is referenced but not defined. android.R is the platform's,
    which the app's SDK supplies: generating one would hide it."""
    packages = set()
    for name in referenced - defined:
        match = R_CLASS.match(name)
        if match:
            packages.add(match.group(1).rstrip("/").replace("/", "."))
    return sorted(packages - {"android"})


def app_supplied_packages(defined, referenced, excluded_globs):
    """Dotted packages of referenced classes matching the excluded globs, which the app must supply."""
    packages = set()
    for name in referenced - defined:
        if any(fnmatch.fnmatch(name, glob) for glob in excluded_globs) and "/" in name:
            packages.add(name.rsplit("/", 1)[0].replace("/", "."))
    return sorted(packages)


# Java resources kept in classes.jar besides classes: ServiceLoader registrations (Chromium's @ServiceImpl) and files
# under the engine's own packages.
KEPT_RESOURCES = ("META-INF/services/", "org/bay/", "org/chromium/", "org/jni_zero/")


def engine_jar(jar_bytes):
    """classes.jar without the dependency jars' other files."""
    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(jar_bytes)) as source, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as jar:
        for info in source.infolist():
            if info.filename.endswith(".class") or info.filename.startswith(KEPT_RESOURCES):
                jar.writestr(info, source.read(info))
    return output.getvalue()


NUMBERED_RES = re.compile(r"^res/\d+_res/")


def resource_path(name):
    """An AAR path with the resource zips' numbered folder removed."""
    return NUMBERED_RES.sub("res/", name)


def gradle_r_txt(r_txt):
    """R.txt with each symbol once and each styleable array followed by its attribute indices."""
    seen, lines, arrays, attributes = set(), [], [], []
    for line in r_txt.splitlines():
        parts = line.split()
        if len(parts) < 3 or tuple(parts[:3]) in seen:
            continue
        seen.add(tuple(parts[:3]))
        if parts[:2] == ["int[]", "styleable"]:
            arrays.append(parts[2])
        elif parts[:2] == ["int", "styleable"]:
            attributes.append(parts[2])
        else:
            lines.append(line)
    # An attribute belongs to the longest styleable its name starts with: ActionBarLayout_x is ActionBarLayout's.
    owned = {name: [] for name in arrays}
    by_length = sorted(arrays, key=len, reverse=True)
    for attribute in attributes:
        owner = next((name for name in by_length if attribute.startswith(name + "_")), None)
        if owner is None:
            raise ValueError(f"R.txt has {attribute} but no styleable it belongs to")
        owned[owner].append(attribute)
    for name in arrays:
        ids = ", ".join(["0x0"] * len(owned[name]))
        lines.append(f"int[] styleable {name} {{ {ids} }}" if ids else f"int[] styleable {name} {{ }}")
        lines.extend(f"int styleable {attribute} {index}" for index, attribute in enumerate(owned[name]))
    return "".join(f"{line}\n" for line in lines)


VALUES_XML = re.compile(r"^res/values[^/]*/[^/]+\.xml$")


def defined_attributes(root):
    """(element, parent styleable or None) for each attribute definition: an <attr> with a format or values."""
    for element in root:
        if element.tag == "attr" and (element.get("format") or len(element)):
            yield element, None
        elif element.tag == "declare-styleable":
            for child in element:
                if child.tag == "attr" and (child.get("format") or len(child)):
                    yield child, element


def single_attribute_definitions(files):
    """{path: new bytes} for the values files that repeat an attribute another file (or an earlier place) defines.

    files: [(path, bytes)] in the AAR's order."""
    defined, changed = set(), {}
    for path, data in files:
        folder = resource_path(path).rsplit("/", 1)[0]
        for prefix, uri in re.findall(rb'xmlns:(\w+)="([^"]+)"', data):
            ElementTree.register_namespace(prefix.decode(), uri.decode())
        root = ElementTree.fromstring(data)
        repeated = False
        for element, styleable in list(defined_attributes(root)):
            key = (folder, element.get("name"))
            if key not in defined:
                defined.add(key)
                continue
            repeated = True
            if styleable is None:
                root.remove(element)
            else:
                element.attrib.pop("format", None)
                for value in list(element):
                    element.remove(value)
        if repeated:
            changed[path] = ElementTree.tostring(root, encoding="utf-8", xml_declaration=True)
    return changed


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
            written = set()
            values = single_attribute_definitions([(info.filename, source.read(info)) for info in source.infolist()
                                                   if VALUES_XML.match(resource_path(info.filename))])
            for info in source.infolist():
                data = values.get(info.filename) or source.read(info)
                if info.filename == "classes.jar":
                    data = engine_jar(jar_bytes)
                elif info.filename == "R.txt":
                    data = gradle_r_txt(data.decode("utf-8")).encode("utf-8")
                info.filename = resource_path(info.filename)
                if info.filename in written:
                    raise ValueError(f"two resources would be {info.filename}")
                written.add(info.filename)
                target.writestr(info, data)
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
